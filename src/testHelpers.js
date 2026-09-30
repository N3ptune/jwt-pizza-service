const request = require('supertest');
const app = require('./service');
const { Role, DB } = require('./database/database.js');

function randomName() {
  return Math.random().toString(36).substring(2, 12);
}

async function createAdminUser() {
  const password = 'toomanysecrets';
  const user = await DB.addUser({ name: randomName(), email: `${randomName()}@admin.com`, password, roles: [{ role: Role.Admin }] });
  return { ...user, password };
}

async function registerDiner() {
  const user = { name: 'pizza diner', email: `${randomName()}@test.com`, password: 'a' };
  const res = await request(app).post('/api/auth').send(user);
  return { user: { ...res.body.user, password: user.password }, token: res.body.token };
}

async function login(user) {
  const res = await request(app).put('/api/auth').send({ email: user.email, password: user.password });
  return res.body.token;
}

module.exports = { randomName, createAdminUser, registerDiner, login };
