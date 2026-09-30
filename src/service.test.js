const request = require('supertest');
const app = require('./service');
const version = require('./version.json');
const { DB } = require('./database/database.js');

// These tests never touch the database, so wait for its setup to finish before Jest tears down.
beforeAll(() => DB.initialized);

test('root returns welcome and version', async () => {
  const res = await request(app).get('/');
  expect(res.status).toBe(200);
  expect(res.body.message).toBe('welcome to JWT Pizza');
  expect(res.body.version).toBe(version.version);
});

test('docs lists endpoints', async () => {
  const res = await request(app).get('/api/docs');
  expect(res.status).toBe(200);
  expect(res.body.endpoints.length).toBeGreaterThan(0);
  expect(res.body.config.factory).toBeDefined();
});

test('unknown endpoint returns 404', async () => {
  const res = await request(app).get('/api/nope');
  expect(res.status).toBe(404);
  expect(res.body.message).toBe('unknown endpoint');
});

test('sets CORS headers', async () => {
  const res = await request(app).get('/').set('Origin', 'http://example.com');
  expect(res.headers['access-control-allow-origin']).toBe('http://example.com');
});
