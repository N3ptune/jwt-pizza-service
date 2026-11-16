const { AsyncLocalStorage } = require('async_hooks');
const config = require('./config.js');

// Request context lets DB and factory logs report the user who made the
// request without passing `req` through the application code.
const requestContext = new AsyncLocalStorage();

// Any property with one of these names is masked wherever it appears.
const SENSITIVE_KEYS = new Set(['password', 'token', 'jwt', 'apikey', 'authorization', 'jwtsecret']);
const MASK = '*****';

const FLUSH_INTERVAL_MS = 1000;
const MAX_QUEUE = 5000;

class Logger {
  constructor(loggingConfig = config.logging) {
    this.config = loggingConfig;
    this.queue = [];
    this.timer = null;
  }

  // ---------------------------------------------------------------------------
  // Express middleware: logs every HTTP request when the response finishes.
  // ---------------------------------------------------------------------------
  httpLogger = (req, res, next) => {
    const send = res.send;
    res.send = (resBody) => {
      res.locals.logResBody = resBody;
      res.send = send;
      return res.send(resBody);
    };

    res.on('finish', () => {
      this.log(this.statusToLogLevel(res.statusCode), 'http', {
        method: req.method,
        path: req.originalUrl,
        statusCode: res.statusCode,
        authorized: !!req.headers.authorization,
        user: this.userOf(req),
        reqBody: req.body,
        resBody: this.parseBody(res.locals.logResBody),
      });
    });

    requestContext.run({ req }, next);
  };

  // Called by DB.query for every SQL statement. Only the SQL text (with ?
  // placeholders) is logged; parameter values may hold passwords or tokens.
  dbLogger(sql) {
    this.log('info', 'db', { sql: sql.replace(/\s+/g, ' ').trim(), user: this.currentUser() });
  }

  // Called after each request to the pizza factory.
  factoryLogger(reqBody, resBody, statusCode) {
    this.log(this.statusToLogLevel(statusCode), 'factory', {
      url: `${config.factory.url}/api/order`,
      statusCode,
      user: this.currentUser(),
      reqBody,
      resBody,
    });
  }

  // Called by the Express error handler and process-level handlers.
  exceptionLogger(err, req) {
    this.log('error', 'exception', {
      message: err?.message ?? String(err),
      statusCode: err?.statusCode ?? 500,
      stack: err?.stack,
      method: req?.method,
      path: req?.originalUrl,
      user: req ? this.userOf(req) : this.currentUser(),
    });
  }

  // ---------------------------------------------------------------------------
  // Core logging
  // ---------------------------------------------------------------------------
  log(level, type, logData) {
    if (!this.timer) return; // Not started (e.g. unit tests): drop the event.
    if (this.queue.length >= MAX_QUEUE) this.queue.shift();
    this.queue.push({
      labels: { component: this.config.source, level, type },
      value: [this.nowString(), JSON.stringify(this.sanitize(logData))],
    });
  }

  statusToLogLevel(statusCode) {
    if (statusCode >= 500) return 'error';
    if (statusCode >= 400) return 'warn';
    return 'info';
  }

  nowString() {
    return (BigInt(Date.now()) * 1000000n).toString();
  }

  userOf(req) {
    return req.user ? { id: req.user.id, name: req.user.name, email: req.user.email } : undefined;
  }

  currentUser() {
    const req = requestContext.getStore()?.req;
    return req ? this.userOf(req) : undefined;
  }

  parseBody(body) {
    if (typeof body !== 'string') return body;
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }

  // Deep copy of data with sensitive fields masked. Strings that look like
  // JSON are sanitized too, and bearer tokens embedded in text are masked.
  sanitize(data) {
    if (Array.isArray(data)) return data.map((v) => this.sanitize(v));
    if (data && typeof data === 'object') {
      return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, SENSITIVE_KEYS.has(k.toLowerCase()) ? MASK : this.sanitize(v)]));
    }
    if (typeof data === 'string') {
      const trimmed = data.trim();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        const parsed = this.parseBody(trimmed);
        if (typeof parsed !== 'string') return JSON.stringify(this.sanitize(parsed));
      }
      return data.replace(/Bearer\s+[\w.:-]+/gi, `Bearer ${MASK}`);
    }
    return data;
  }

  // ---------------------------------------------------------------------------
  // Shipping to Grafana Loki
  // ---------------------------------------------------------------------------
  start(period = FLUSH_INTERVAL_MS, watchProcess = true) {
    if (!this.config?.endpointUrl || !this.config?.apiKey) {
      console.log('Logging not configured; skipping Grafana logging');
      return null;
    }
    this.timer = setInterval(() => this.flush(), period);
    this.timer.unref();

    if (watchProcess) {
      process.on('unhandledRejection', (reason) => this.exceptionLogger(reason));
      process.on('uncaughtException', (err) => {
        this.exceptionLogger(err);
        this.flush().finally(() => process.exit(1));
      });
    }
    return this.timer;
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async flush() {
    if (this.queue.length === 0) return;
    const events = this.queue.splice(0);

    // Group values into one Loki stream per unique label set.
    const streams = new Map();
    for (const { labels, value } of events) {
      const key = JSON.stringify(labels);
      if (!streams.has(key)) streams.set(key, { stream: labels, values: [] });
      streams.get(key).values.push(value);
    }
    await this.sendLogToGrafana({ streams: [...streams.values()] });
  }

  async sendLogToGrafana(event) {
    try {
      const res = await fetch(this.config.endpointUrl, {
        method: 'post',
        body: JSON.stringify(event),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.accountId}:${this.config.apiKey}`,
        },
      });
      if (!res.ok) console.log(`Failed to send log to Grafana: ${res.status} ${await res.text()}`);
    } catch (err) {
      console.log('Error sending log to Grafana:', err.message);
    }
  }
}

module.exports = new Logger();
module.exports.Logger = Logger;
