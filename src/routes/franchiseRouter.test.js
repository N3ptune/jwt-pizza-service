const request = require('supertest');
const app = require('../service');
const { createAdminUser, registerDiner, login, randomName } = require('../testHelpers');

let admin;
let adminToken;

beforeAll(async () => {
  admin = await createAdminUser();
  adminToken = await login(admin);
});

async function createFranchise(adminEmail = admin.email) {
  const res = await request(app)
    .post('/api/franchise')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name: randomName(), admins: [{ email: adminEmail }] });
  return res.body;
}

test('admin creates franchise', async () => {
  const name = randomName();
  const res = await request(app)
    .post('/api/franchise')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name, admins: [{ email: admin.email }] });
  expect(res.status).toBe(200);
  expect(res.body.name).toBe(name);
  expect(res.body.admins[0].id).toBe(admin.id);
});

test('create franchise with unknown admin fails', async () => {
  const res = await request(app)
    .post('/api/franchise')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name: randomName(), admins: [{ email: `${randomName()}@nobody.com` }] });
  expect(res.status).toBe(404);
});

test('diner cannot create franchise', async () => {
  const { token } = await registerDiner();
  const res = await request(app).post('/api/franchise').set('Authorization', `Bearer ${token}`).send({ name: randomName(), admins: [] });
  expect(res.status).toBe(403);
});

test('list franchises', async () => {
  const franchise = await createFranchise();
  const res = await request(app).get(`/api/franchise?page=0&limit=10&name=${franchise.name}`);
  expect(res.status).toBe(200);
  expect(res.body.franchises[0].name).toBe(franchise.name);
  expect(res.body.franchises[0].stores).toEqual([]);
  expect(res.body.more).toBe(false);
});

test('list franchises as admin includes admins, with paging', async () => {
  await createFranchise();
  await createFranchise();
  const res = await request(app).get('/api/franchise?page=0&limit=1&name=*').set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.franchises.length).toBe(1);
  expect(res.body.franchises[0].admins).toBeDefined();
  expect(res.body.more).toBe(true);
});

test('get user franchises', async () => {
  const { user, token } = await registerDiner();
  const franchise = await createFranchise(user.email);

  const own = await request(app).get(`/api/franchise/${user.id}`).set('Authorization', `Bearer ${token}`);
  expect(own.status).toBe(200);
  expect(own.body.map((f) => f.id)).toContain(franchise.id);

  const asAdmin = await request(app).get(`/api/franchise/${user.id}`).set('Authorization', `Bearer ${adminToken}`);
  expect(asAdmin.body.map((f) => f.id)).toContain(franchise.id);
});

test('user with no franchises gets empty list', async () => {
  const { user, token } = await registerDiner();
  const res = await request(app).get(`/api/franchise/${user.id}`).set('Authorization', `Bearer ${token}`);
  expect(res.body).toEqual([]);
});

test('cannot see franchises of another user', async () => {
  const { token } = await registerDiner();
  const res = await request(app).get(`/api/franchise/${admin.id}`).set('Authorization', `Bearer ${token}`);
  expect(res.body).toEqual([]);
});

test('create and delete store', async () => {
  const franchise = await createFranchise();
  const storeName = randomName();
  const created = await request(app)
    .post(`/api/franchise/${franchise.id}/store`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name: storeName });
  expect(created.status).toBe(200);
  expect(created.body).toMatchObject({ franchiseId: franchise.id, name: storeName });

  const deleted = await request(app).delete(`/api/franchise/${franchise.id}/store/${created.body.id}`).set('Authorization', `Bearer ${adminToken}`);
  expect(deleted.status).toBe(200);
  expect(deleted.body.message).toBe('store deleted');
});

test('diner cannot create or delete store', async () => {
  const franchise = await createFranchise();
  const { token } = await registerDiner();
  const create = await request(app).post(`/api/franchise/${franchise.id}/store`).set('Authorization', `Bearer ${token}`).send({ name: 'x' });
  expect(create.status).toBe(403);
  const del = await request(app).delete(`/api/franchise/${franchise.id}/store/1`).set('Authorization', `Bearer ${token}`);
  expect(del.status).toBe(403);
});

test('delete franchise', async () => {
  const franchise = await createFranchise();
  const res = await request(app).delete(`/api/franchise/${franchise.id}`).set('Authorization', `Bearer ${adminToken}`);
  expect(res.status).toBe(200);
  expect(res.body.message).toBe('franchise deleted');
});
