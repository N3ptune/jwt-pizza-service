const request = require('supertest');
const express = require('express');
const { Logger } = require('./logger.js');

const testConfig = { source: 'test', endpointUrl: 'http://loki.test/push', accountId: '42', apiKey: 'key' };

let logger;
let fetchMock;

beforeEach(() => {
  logger = new Logger(testConfig);
  logger.start(60000, false);
  fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true });
});

afterEach(() => {
  logger.stop();
  jest.restoreAllMocks();
});

// Flushes the logger and returns every logged entry as { labels, data }.
async function flushed() {
  await logger.flush();
  if (!fetchMock.mock.calls.length) return [];
  const body = JSON.parse(fetchMock.mock.calls.at(-1)[1].body);
  return body.streams.flatMap((s) => s.values.map(([, line]) => ({ labels: s.stream, data: JSON.parse(line) })));
}

function testApp() {
  const app = express();
  app.use(express.json());
  app.use(logger.httpLogger);
  app.use((req, res, next) => {
    if (req.headers.authorization) req.user = { id: 3, name: 'pizza diner', email: 'd@jwt.com', roles: [] };
    next();
  });
  app.post('/api/auth', (req, res) => {
    logger.dbLogger('SELECT *\n   FROM user WHERE email=?');
    res.json({ user: { id: 3 }, token: 'secret-token' });
  });
  app.get('/api/order', (req, res) => {
    logger.factoryLogger({ diner: { id: 3 }, order: {} }, { reportUrl: 'http://r', jwt: 'factory-jwt' }, 200);
    res.status(404).send('not here');
  });
  app.get('/boom', () => {
    throw new Error('kaboom');
  });
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    logger.exceptionLogger(err, req);
    res.status(500).json({ message: err.message });
  });
  return app;
}

test('logs HTTP requests with sanitized bodies and labels', async () => {
  await request(testApp()).post('/api/auth').send({ email: 'd@jwt.com', password: 'diner' });

  const entries = await flushed();
  const http = entries.find((e) => e.labels.type === 'http');
  expect(http.labels).toEqual({ component: 'test', level: 'info', type: 'http' });
  expect(http.data).toMatchObject({ method: 'POST', path: '/api/auth', statusCode: 200, authorized: false });
  expect(http.data.reqBody).toEqual({ email: 'd@jwt.com', password: '*****' });
  expect(http.data.resBody.token).toBe('*****');

  const [url, options] = fetchMock.mock.calls[0];
  expect(url).toBe(testConfig.endpointUrl);
  expect(options.headers.Authorization).toBe('Bearer 42:key');
});

test('logs DB queries with the requesting user and normalized SQL', async () => {
  await request(testApp()).post('/api/auth').set('Authorization', 'Bearer abc').send({});

  const db = (await flushed()).find((e) => e.labels.type === 'db');
  expect(db.data.sql).toBe('SELECT * FROM user WHERE email=?');
  expect(db.data.user).toEqual({ id: 3, name: 'pizza diner', email: 'd@jwt.com' });
});

test('logs factory calls and warns on 4xx responses', async () => {
  await request(testApp()).get('/api/order').set('Authorization', 'Bearer abc');

  const entries = await flushed();
  const factory = entries.find((e) => e.labels.type === 'factory');
  expect(factory.data.user.id).toBe(3);
  expect(factory.data.resBody).toEqual({ reportUrl: 'http://r', jwt: '*****' });
  const http = entries.find((e) => e.labels.type === 'http');
  expect(http.labels.level).toBe('warn');
  expect(http.data).toMatchObject({ authorized: true, resBody: 'not here' });
});

test('logs unhandled exceptions as errors', async () => {
  await request(testApp()).get('/boom');

  const entries = await flushed();
  const ex = entries.find((e) => e.labels.type === 'exception');
  expect(ex.labels.level).toBe('error');
  expect(ex.data).toMatchObject({ message: 'kaboom', statusCode: 500, path: '/boom' });
  expect(entries.find((e) => e.labels.type === 'http').labels.level).toBe('error');

  logger.exceptionLogger('plain failure');
  expect((await flushed())[0].data.message).toBe('plain failure');
});

test('sanitize masks nested secrets, JSON strings, and bearer tokens', () => {
  expect(logger.sanitize({ a: [{ apiKey: 'k', ok: 1 }], s: '{"password":"p"}', h: 'Bearer abc.def', n: null })).toEqual({
    a: [{ apiKey: '*****', ok: 1 }],
    s: '{"password":"*****"}',
    h: 'Bearer *****',
    n: null,
  });
  expect(logger.sanitize('{not json')).toBe('{not json');
});

test('drops events when not started and skips start when unconfigured', async () => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  const idle = new Logger(testConfig);
  idle.log('info', 'http', {});
  expect(idle.queue).toHaveLength(0);
  expect(new Logger({}).start()).toBeNull();

  await logger.flush();
  expect(fetchMock).not.toHaveBeenCalled();
});

test('reports Grafana failures without throwing', async () => {
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  fetchMock.mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'denied' });
  logger.log('info', 'http', {});
  await logger.flush();
  expect(log).toHaveBeenCalledWith('Failed to send log to Grafana: 401 denied');

  fetchMock.mockRejectedValueOnce(new Error('offline'));
  logger.log('info', 'http', {});
  await logger.flush();
  expect(log).toHaveBeenCalledWith('Error sending log to Grafana:', 'offline');
});
