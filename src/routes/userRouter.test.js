const request = require('supertest');
const app = require('../service');
const { createAdminUser, registerDiner, login, randomName } = require('../testHelpers');

test('get me', async () => {
  const { user, token } = await registerDiner();
  const res = await request(app).get('/api/user/me').set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ id: user.id, email: user.email });
});

test('update own user', async () => {
  const { user, token } = await registerDiner();
  const newName = randomName();
  const newEmail = `${randomName()}@test.com`;
  const res = await request(app)
    .put(`/api/user/${user.id}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ name: newName, email: newEmail, password: 'b' });
  expect(res.status).toBe(200);
  expect(res.body.user).toMatchObject({ id: user.id, name: newName, email: newEmail });
  expect(res.body.token).toBeDefined();
});

test('cannot update another user', async () => {
  const { token } = await registerDiner();
  const { user: other } = await registerDiner();
  const res = await request(app).put(`/api/user/${other.id}`).set('Authorization', `Bearer ${token}`).send({ name: 'hacked' });
  expect(res.status).toBe(403);
});

test('admin can update another user', async () => {
  const admin = await createAdminUser();
  const adminToken = await login(admin);
  const { user } = await registerDiner();
  const res = await request(app).put(`/api/user/${user.id}`).set('Authorization', `Bearer ${adminToken}`).send({ email: user.email });
  expect(res.status).toBe(200);
  expect(res.body.user.id).toBe(user.id);
});

test('delete user is not implemented', async () => {
  const { user, token } = await registerDiner();
  const res = await request(app).delete(`/api/user/${user.id}`).set('Authorization', `Bearer ${token}`);
  expect(res.body.message).toBe('not implemented');
});

test('list users is not implemented', async () => {
  const { token } = await registerDiner();
  const res = await request(app).get('/api/user').set('Authorization', `Bearer ${token}`);
  expect(res.body).toEqual({ message: 'not implemented', users: [], more: false });
});
