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

describe('list users', () => {
  test('unauthorized', async () => {
    const res = await request(app).get('/api/user');
    expect(res.status).toBe(401);
  });

  test('forbidden for non-admin', async () => {
    const { token } = await registerDiner();
    const res = await request(app).get('/api/user').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  test('admin gets users with name, email, and roles', async () => {
    const adminToken = await login(await createAdminUser());
    const { user } = await registerDiner();
    const res = await request(app).get(`/api/user?name=*`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.users)).toBe(true);
    expect(typeof res.body.more).toBe('boolean');
    const first = res.body.users[0];
    expect(first).toHaveProperty('id');
    expect(first).toHaveProperty('name');
    expect(first).toHaveProperty('email');
    expect(first).toHaveProperty('roles');
    expect(first).not.toHaveProperty('password');
    expect(user.id).toBeDefined();
  });

  test('paginates', async () => {
    const adminToken = await login(await createAdminUser());
    await registerDiner();
    await registerDiner();
    const page0 = await request(app).get('/api/user?page=0&limit=1').set('Authorization', `Bearer ${adminToken}`);
    expect(page0.status).toBe(200);
    expect(page0.body.users.length).toBe(1);
    expect(page0.body.more).toBe(true);

    const page1 = await request(app).get('/api/user?page=1&limit=1').set('Authorization', `Bearer ${adminToken}`);
    expect(page1.body.users.length).toBe(1);
    expect(page1.body.users[0].id).not.toBe(page0.body.users[0].id);
  });

  test('filters by name', async () => {
    const adminToken = await login(await createAdminUser());
    const { user, token } = await registerDiner();
    const uniqueName = randomName();
    await request(app).put(`/api/user/${user.id}`).set('Authorization', `Bearer ${token}`).send({ name: uniqueName, email: user.email });

    const res = await request(app).get(`/api/user?name=*${uniqueName}*`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.users).toEqual([{ id: user.id, name: uniqueName, email: user.email, roles: [{ role: 'diner' }] }]);
    expect(res.body.more).toBe(false);
  });
});

describe('delete user', () => {
  test('unauthorized', async () => {
    const res = await request(app).delete('/api/user/1');
    expect(res.status).toBe(401);
  });

  test('forbidden for non-admin', async () => {
    const { token } = await registerDiner();
    const { user: other } = await registerDiner();
    const res = await request(app).delete(`/api/user/${other.id}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  test('admin deletes a user', async () => {
    const adminToken = await login(await createAdminUser());
    const { user } = await registerDiner();
    const res = await request(app).delete(`/api/user/${user.id}`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);

    const loginRes = await request(app).put('/api/auth').send({ email: user.email, password: user.password });
    expect(loginRes.status).toBe(404);

    const list = await request(app).get(`/api/user?name=${user.name}&limit=1000`).set('Authorization', `Bearer ${adminToken}`);
    expect(list.body.users.find((u) => u.id === user.id)).toBeUndefined();
  });
});
