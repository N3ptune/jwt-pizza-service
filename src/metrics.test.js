const request = require('supertest');
const express = require('express');
const metrics = require('./metrics.js');

const testConfig = { source: 'test', endpointUrl: 'http://grafana.test/otlp', accountId: '123', apiKey: 'key' };

function findMetric(body, name) {
  return body.resourceMetrics[0].scopeMetrics[0].metrics.find((m) => m.name === name);
}

function points(metric) {
  return (metric.sum ?? metric.gauge).dataPoints;
}

function attr(point, key) {
  return point.attributes.find((a) => a.key === key)?.value.stringValue;
}

function valueOf(point) {
  return point.asInt ?? point.asDouble;
}

function pointWith(metric, key, value) {
  return points(metric).find((p) => attr(p, key) === value);
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('requestTracker records requests, auth attempts, and active users', async () => {
  const app = express();
  app.use((req, res, next) => {
    if (req.headers['x-user']) req.user = { id: Number(req.headers['x-user']) };
    next();
  });
  app.use(metrics.requestTracker);
  app.put('/api/auth', (req, res) => res.status(req.headers['x-fail'] ? 404 : 200).end());
  app.delete('/api/auth', (req, res) => res.end());
  app.get('/api/thing', (req, res) => res.end());

  const before = metrics.buildMetrics('test');
  const getBefore = valueOf(pointWith(findMetric(before, 'http_requests'), 'method', 'GET'));
  const successBefore = valueOf(pointWith(findMetric(before, 'auth_attempts'), 'status', 'success'));
  const failureBefore = valueOf(pointWith(findMetric(before, 'auth_attempts'), 'status', 'failure'));

  await request(app).get('/api/thing').set('x-user', '7');
  await request(app).get('/api/thing').set('x-user', '8');
  await request(app).put('/api/auth');
  await request(app).put('/api/auth').set('x-fail', '1');
  await request(app).delete('/api/auth').set('x-user', '8');

  const after = metrics.buildMetrics('test');
  expect(valueOf(pointWith(findMetric(after, 'http_requests'), 'method', 'GET'))).toBe(getBefore + 2);
  expect(valueOf(pointWith(findMetric(after, 'auth_attempts'), 'status', 'success'))).toBe(successBefore + 1);
  expect(valueOf(pointWith(findMetric(after, 'auth_attempts'), 'status', 'failure'))).toBe(failureBefore + 1);
  expect(valueOf(points(findMetric(after, 'active_users'))[0])).toBe(1);
  expect(valueOf(points(findMetric(after, 'request_latency'))[0])).toBeGreaterThanOrEqual(0);
  expect(attr(points(findMetric(after, 'http_requests'))[0], 'source')).toBe('test');
});

test('pizzaPurchase records sales, failures, revenue, and latency', () => {
  const before = metrics.buildMetrics('test');
  const soldBefore = valueOf(points(findMetric(before, 'pizzas_sold'))[0]);
  const failBefore = valueOf(points(findMetric(before, 'pizza_creation_failures'))[0]);
  const revenueBefore = valueOf(points(findMetric(before, 'revenue'))[0]);

  metrics.pizzaPurchase(true, 100, 0.05, 2);
  metrics.pizzaPurchase(false, 300, 0.5, 25);

  const after = metrics.buildMetrics('test');
  expect(valueOf(points(findMetric(after, 'pizzas_sold'))[0])).toBe(soldBefore + 2);
  expect(valueOf(points(findMetric(after, 'pizza_creation_failures'))[0])).toBe(failBefore + 1);
  expect(points(findMetric(after, 'revenue'))[0].asDouble).toBeCloseTo(revenueBefore + 0.05);
  expect(valueOf(points(findMetric(after, 'pizza_creation_latency'))[0])).toBe(200);

  // Latency averages reset after each report.
  expect(valueOf(points(findMetric(metrics.buildMetrics('test'), 'pizza_creation_latency'))[0])).toBe(0);
});

test('system metrics are percentages', () => {
  expect(metrics.getCpuUsagePercentage()).toBeGreaterThanOrEqual(0);
  const mem = metrics.getMemoryUsagePercentage();
  expect(mem).toBeGreaterThan(0);
  expect(mem).toBeLessThanOrEqual(100);
});

test('sendMetricsToGrafana posts OTLP JSON with credentials', async () => {
  const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true });
  expect(await metrics.sendMetricsToGrafana(testConfig)).toBe(true);

  const [url, options] = fetchMock.mock.calls[0];
  expect(url).toBe(testConfig.endpointUrl);
  expect(options.headers.Authorization).toBe(`Basic ${Buffer.from('123:key').toString('base64')}`);
  expect(JSON.parse(options.body).resourceMetrics).toBeDefined();
});

test('sendMetricsToGrafana reports failures', async () => {
  jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 401, text: async () => 'denied' });
  jest.spyOn(console, 'log').mockImplementation(() => {});
  expect(await metrics.sendMetricsToGrafana(testConfig)).toBe(false);
});

test('sendMetricsPeriodically sends on an interval and skips when unconfigured', async () => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  expect(metrics.sendMetricsPeriodically(1000, {})).toBeNull();

  jest.useFakeTimers();
  const fetchMock = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('offline'));
  const timer = metrics.sendMetricsPeriodically(1000, testConfig);
  jest.advanceTimersByTime(1000);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  clearInterval(timer);
  jest.useRealTimers();
});
