const os = require('os');
const config = require('./config.js');

// ---------------------------------------------------------------------------
// In-memory metric state
//
// Counters are cumulative (monotonic) so Grafana can compute per-minute rates
// with rate()/increase(). Latencies are averaged over each reporting period and
// then reset, so they are reported as gauges.
// ---------------------------------------------------------------------------
const ACTIVE_USER_WINDOW_MS = 5 * 60 * 1000;
const TRACKED_METHODS = ['GET', 'POST', 'PUT', 'DELETE'];

const state = {
  requests: Object.fromEntries(TRACKED_METHODS.map((m) => [m, 0])),
  responses: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 },
  auth: { success: 0, failure: 0 },
  activeUsers: new Map(), // userId -> last seen timestamp
  pizza: { sold: 0, failures: 0, revenue: 0 },
  latency: { request: newAverage(), pizza: newAverage() },
};

function newAverage() {
  return { total: 0, count: 0 };
}

function averageAndReset(avg) {
  const value = avg.count ? avg.total / avg.count : 0;
  avg.total = 0;
  avg.count = 0;
  return value;
}

// ---------------------------------------------------------------------------
// Recording API
// ---------------------------------------------------------------------------

// Express middleware: records request counts, latency, auth attempts and active
// users. Must be registered after setAuthUser so req.user is populated.
function requestTracker(req, res, next) {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    const method = req.method.toUpperCase();
    const path = req.originalUrl.split('?')[0];

    if (method in state.requests) {
      state.requests[method]++;
    }
    const statusClass = `${Math.floor(res.statusCode / 100)}xx`;
    if (statusClass in state.responses) {
      state.responses[statusClass]++;
    }
    state.latency.request.total += elapsedMs;
    state.latency.request.count++;

    const isAuthEndpoint = path === '/api/auth';
    // Register (POST) and login (PUT) are authentication attempts.
    if (isAuthEndpoint && (method === 'PUT' || method === 'POST')) {
      authAttempt(res.statusCode < 400);
    }

    if (req.user?.id !== undefined) {
      if (isAuthEndpoint && method === 'DELETE' && res.statusCode < 400) {
        state.activeUsers.delete(req.user.id);
      } else {
        state.activeUsers.set(req.user.id, Date.now());
      }
    }
  });

  next();
}

function authAttempt(success) {
  state.auth[success ? 'success' : 'failure']++;
}

// Called by the order router after the pizza factory responds.
function pizzaPurchase(success, latencyMs, price, quantity) {
  state.latency.pizza.total += latencyMs;
  state.latency.pizza.count++;
  if (success) {
    state.pizza.sold += quantity;
    state.pizza.revenue += price;
  } else {
    state.pizza.failures++;
  }
}

// ---------------------------------------------------------------------------
// System metrics
// ---------------------------------------------------------------------------
function getCpuUsagePercentage() {
  const cpuUsage = os.loadavg()[0] / os.cpus().length;
  return Number((cpuUsage * 100).toFixed(2));
}

function getMemoryUsagePercentage() {
  const totalMemory = os.totalmem();
  const usedMemory = totalMemory - os.freemem();
  return Number(((usedMemory / totalMemory) * 100).toFixed(2));
}

function countActiveUsers(now = Date.now()) {
  for (const [userId, lastSeen] of state.activeUsers) {
    if (now - lastSeen > ACTIVE_USER_WINDOW_MS) {
      state.activeUsers.delete(userId);
    }
  }
  return state.activeUsers.size;
}

// ---------------------------------------------------------------------------
// OTLP payload construction
// ---------------------------------------------------------------------------
class OtelMetricBuilder {
  constructor(source) {
    this.source = source;
    this.metrics = [];
    this.timeUnixNano = `${Date.now()}000000`;
  }

  dataPoint(value, attributes, double = !Number.isInteger(value)) {
    const attrs = { source: this.source, ...attributes };
    return {
      [double ? 'asDouble' : 'asInt']: value,
      timeUnixNano: this.timeUnixNano,
      attributes: Object.entries(attrs).map(([key, v]) => ({ key, value: { stringValue: String(v) } })),
    };
  }

  // points: array of [value, attributes]
  sum(name, points, double = false) {
    this.metrics.push({
      name,
      unit: '',
      sum: {
        dataPoints: points.map(([value, attrs]) => this.dataPoint(value, attrs, double || undefined)),
        aggregationTemporality: 'AGGREGATION_TEMPORALITY_CUMULATIVE',
        isMonotonic: true,
      },
    });
    return this;
  }

  gauge(name, value, attributes) {
    this.metrics.push({ name, unit: '', gauge: { dataPoints: [this.dataPoint(value, attributes)] } });
    return this;
  }

  toJSON() {
    return { resourceMetrics: [{ scopeMetrics: [{ metrics: this.metrics }] }] };
  }
}

function buildMetrics(source) {
  const b = new OtelMetricBuilder(source);

  b.sum('http_requests', TRACKED_METHODS.map((method) => [state.requests[method], { method }]));
  b.sum('http_responses', Object.entries(state.responses).map(([status, count]) => [count, { status }]));
  b.gauge('request_latency', averageAndReset(state.latency.request));

  b.sum('auth_attempts', [
    [state.auth.success, { status: 'success' }],
    [state.auth.failure, { status: 'failure' }],
  ]);
  b.gauge('active_users', countActiveUsers());

  b.gauge('cpu_usage', getCpuUsagePercentage());
  b.gauge('memory_usage', getMemoryUsagePercentage());

  b.sum('pizzas_sold', [[state.pizza.sold]]);
  b.sum('pizza_creation_failures', [[state.pizza.failures]]);
  // Always a double so revenue keeps its fractional bitcoin values.
  b.sum('revenue', [[state.pizza.revenue]], true);
  b.gauge('pizza_creation_latency', averageAndReset(state.latency.pizza));

  return b.toJSON();
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
async function sendMetricsToGrafana(metricsConfig = config.metrics) {
  const body = buildMetrics(metricsConfig.source);
  const res = await fetch(metricsConfig.endpointUrl, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      Authorization: `Basic ${Buffer.from(`${metricsConfig.accountId}:${metricsConfig.apiKey}`).toString('base64')}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    console.log(`Failed to push metrics to Grafana: ${res.status} ${await res.text()}`);
  }
  return res.ok;
}

function sendMetricsPeriodically(period = 10000, metricsConfig = config.metrics) {
  if (!metricsConfig?.endpointUrl || !metricsConfig?.apiKey) {
    console.log('Metrics not configured; skipping Grafana reporting');
    return null;
  }
  const timer = setInterval(() => {
    sendMetricsToGrafana(metricsConfig).catch((error) => console.log('Error sending metrics', error.message));
  }, period);
  timer.unref();
  return timer;
}

module.exports = {
  requestTracker,
  authAttempt,
  pizzaPurchase,
  buildMetrics,
  sendMetricsToGrafana,
  sendMetricsPeriodically,
  getCpuUsagePercentage,
  getMemoryUsagePercentage,
};
