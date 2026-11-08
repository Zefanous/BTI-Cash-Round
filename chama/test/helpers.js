'use strict';
const { Store } = require('../src/store');
const { MemoryBackend } = require('../src/backends');
const { createApp } = require('../src/app');
const { seedDemo } = require('../src/seed');

async function boot({ notifier, loginLimit } = {}) {
  const sent = [];
  const store = new Store(new MemoryBackend());
  seedDemo(store);
  const app = createApp(store, { secret: 'test-secret', notifier: notifier || (async m => { sent.push(m); return { status: 'sent' }; }), loginLimit });
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, path, { token, body, headers, raw } = {}) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    if (raw) return res;
    let data = null; try { data = await res.json(); } catch (_) { /* none */ }
    return { status: res.status, data };
  };
  const login = async (id, pw) => (await api('POST', '/api/auth/login', { body: { identifier: id, password: pw } })).data.token;
  const admin = await login('kimera@example.com', 'Admin@1234');
  const tokenFor = n => login('M' + String(n).padStart(3, '0'), 'Member@1234');
  const close = () => new Promise(r => { server.close(r); server.closeAllConnections(); });
  const settle = () => new Promise(r => setTimeout(r, 30)).then(() => store.flushed());
  return { store, app, api, admin, login, tokenFor, close, sent, svc: app.service, settle };
}

// start cycle 2: draw + confirm
async function startCycle2(env) {
  const { api, admin } = env;
  const cycles = (await api('GET', '/api/cycles', { token: admin })).data;
  const c = cycles.find(x => x.status === 'draft');
  await api('POST', `/api/cycles/${c.id}/draw`, { token: admin });
  const conf = await api('POST', `/api/cycles/${c.id}/draw/confirm`, { token: admin });
  return { cycle: c, confirm: conf };
}
async function payAll(env, cycleId, month, except = []) {
  for (let m = 1; m <= 10; m++) if (!except.includes(m)) {
    const r = await env.api('POST', '/api/contributions', { token: env.admin, body: { cycle_id: cycleId, member_id: m, month_no: month, method: 'cash' } });
    if (r.status !== 201) throw new Error('contribution failed ' + JSON.stringify(r.data));
  }
}
module.exports = { boot, startCycle2, payAll };
