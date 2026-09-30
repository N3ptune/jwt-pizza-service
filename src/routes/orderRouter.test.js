const request = require('supertest');
const app = require('../service');
const { createAdminUser, registerDiner, login, randomName } = require('../testHelpers');

let adminToken;
let dinerToken;
let franchiseId;
let storeId;
let menuItem;

beforeAll(async () => {
  const admin = await createAdminUser();
  adminToken = await login(admin);
  ({ token: dinerToken } = await registerDiner());

  const franchise = await request(app)
    .post('/api/franchise')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ name: randomName(), admins: [{ email: admin.email }] });
  franchiseId = franchise.body.id;
  const store = await request(app).post(`/api/franchise/${franchiseId}/store`).set('Authorization', `Bearer ${adminToken}`).send({ name: randomName() });
  storeId = store.body.id;

  const title = randomName();
  const menu = await request(app)
    .put('/api/order/menu')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ title, description: 'test pizza', image: 'pizza1.png', price: 0.0001 });
  menuItem = menu.body.find((m) => m.title === title);
});

afterEach(() => {
  jest.restoreAllMocks();
});

// Stand in for the pizza factory so tests don't place real orders.
function mockFactory(ok, body) {
  jest.spyOn(global, 'fetch').mockResolvedValue({ ok, json: async () => body });
}

function newOrder() {
  return { franchiseId, storeId, items: [{ menuId: menuItem.id, description: menuItem.title, price: 0.0001 }] };
}

test('get menu', async () => {
  const res = await request(app).get('/api/order/menu');
  expect(res.status).toBe(200);
  expect(res.body).toEqual(expect.arrayContaining([expect.objectContaining({ id: menuItem.id, title: menuItem.title })]));
});

test('diner cannot add menu item', async () => {
  const res = await request(app).put('/api/order/menu').set('Authorization', `Bearer ${dinerToken}`).send({ title: 'x', description: 'x', image: 'x', price: 1 });
  expect(res.status).toBe(403);
});

test('create order and list orders', async () => {
  mockFactory(true, { reportUrl: 'http://report', jwt: 'factoryjwt' });
  const order = newOrder();
  const res = await request(app).post('/api/order').set('Authorization', `Bearer ${dinerToken}`).send(order);
  expect(res.status).toBe(200);
  expect(res.body.order).toMatchObject(order);
  expect(res.body.jwt).toBe('factoryjwt');

  const list = await request(app).get('/api/order').set('Authorization', `Bearer ${dinerToken}`);
  expect(list.status).toBe(200);
  expect(list.body.orders.length).toBeGreaterThan(0);
  expect(list.body.orders[0].items.length).toBe(1);
});

test('factory failure returns 500', async () => {
  mockFactory(false, { reportUrl: 'http://report' });
  const res = await request(app).post('/api/order').set('Authorization', `Bearer ${dinerToken}`).send(newOrder());
  expect(res.status).toBe(500);
  expect(res.body.message).toBe('Failed to fulfill order at factory');
});

test('order with unknown menu item fails', async () => {
  const order = { franchiseId, storeId, items: [{ menuId: -1, description: 'nope', price: 1 }] };
  const res = await request(app).post('/api/order').set('Authorization', `Bearer ${dinerToken}`).send(order);
  expect(res.status).toBe(500);
});
