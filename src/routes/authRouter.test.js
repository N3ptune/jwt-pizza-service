const request = require('supertest');
const app = require('../service');
const { registerDiner } = require('../testHelpers');

const jwtPattern = /^[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*$/;

test('register', async () => {
  const { user, token } = await registerDiner();
  expect(token).toMatch(jwtPattern);
  expect(user.roles).toEqual([{ role: 'diner' }]);
});

test('register requires name, email, and password', async () => {
  const res = await request(app).post('/api/auth').send({ email: 'x@test.com' });
  expect(res.status).toBe(400);
});

test('login', async () => {
  const { user } = await registerDiner();
  const res = await request(app).put('/api/auth').send({ email: user.email, password: user.password });
  expect(res.status).toBe(200);
  expect(res.body.token).toMatch(jwtPattern);
  expect(res.body.user).toMatchObject({ id: user.id, name: user.name, email: user.email });
});

test('login with bad password fails', async () => {
  const { user } = await registerDiner();
  const res = await request(app).put('/api/auth').send({ email: user.email, password: 'wrong' });
  expect(res.status).toBe(404);
});

test('logout', async () => {
  const { token } = await registerDiner();
  const res = await request(app).delete('/api/auth').set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body.message).toBe('logout successful');

  const after = await request(app).get('/api/user/me').set('Authorization', `Bearer ${token}`);
  expect(after.status).toBe(401);
});

test('logout without token is unauthorized', async () => {
  const res = await request(app).delete('/api/auth');
  expect(res.status).toBe(401);
});

test('garbage token is treated as unauthenticated', async () => {
  const res = await request(app).get('/api/user/me').set('Authorization', 'Bearer not.a.token');
  expect(res.status).toBe(401);
});
