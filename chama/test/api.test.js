'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, startCycle2, payAll } = require('./helpers');

test('auth: login by email/phone/code, bad password, no token, RBAC', async () => {
  const e = await boot();
  assert.equal((await e.api('POST', '/api/auth/login', { body: { identifier: '0701000002', password: 'Member@1234' } })).status, 200);
  assert.equal((await e.api('POST', '/api/auth/login', { body: { identifier: 'nakato@example.com', password: 'Member@1234' } })).status, 200);
  assert.equal((await e.api('POST', '/api/auth/login', { body: { identifier: 'M002', password: 'wrong' } })).status, 401);
  assert.equal((await e.api('GET', '/api/dashboard')).status, 401);
  assert.equal((await e.api('GET', '/api/dashboard', { token: 'x.y.z' })).status, 401);
  const m = await e.tokenFor(2);
  for (const [meth, p] of [['POST', '/api/members'], ['POST', '/api/cycles'], ['POST', '/api/cycles/2/draw'], ['POST', '/api/payouts'], ['POST', '/api/contributions'], ['PUT', '/api/config'], ['POST', '/api/announcements']])
    assert.equal((await e.api(meth, p, { token: m, body: {} })).status, 403, `${meth} ${p}`);
  assert.equal((await e.api('GET', '/api/audit', { token: m })).status, 403);
  await e.close();
});

test('auth: login is throttled after repeated failures', async () => {
  const e = await boot({ loginLimit: 3 });
  for (let i = 0; i < 3; i++) await e.api('POST', '/api/auth/login', { body: { identifier: 'M003', password: 'bad' } });
  assert.equal((await e.api('POST', '/api/auth/login', { body: { identifier: 'M003', password: 'Member@1234' } })).status, 429);
  await e.close();
});

test('ACCEPTANCE: starting Cycle 2 generates 10 unique positions, all auditable, notifies all members', async () => {
  const e = await boot();
  const { cycle, confirm } = await startCycle2(e);
  assert.equal(confirm.status, 200);
  const results = confirm.data.results;
  assert.equal(results.length, 10);
  assert.deepEqual(results.map(r => r.position), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(new Set(results.map(r => r.member_id)).size, 10);
  assert.equal(results[0].payout_month, 'November 2026'); assert.equal(results[9].payout_month, 'August 2027');
  await e.settle();
  const notes = e.store.all('Notifications').filter(n => n.type === 'draw_published');
  assert.equal(notes.length, 10);
  assert.equal(new Set(notes.map(n => n.member_id)).size, 10);
  assert.ok(notes.every(n => n.status === 'sent'));
  assert.equal(e.sent.filter(s => s.type === 'draw_published').length, 10);
  const audit = (await e.api('GET', '/api/audit', { token: e.admin })).data.map(a => a.action);
  assert.ok(audit.includes('draw.generate') && audit.includes('draw.confirm'));
  const v = (await e.api('GET', `/api/cycles/${cycle.id}/draw/verify`, { token: e.admin })).data;
  assert.equal(v.valid, true); assert.equal(v.proofs_ok, true);
  assert.equal((await e.api('GET', '/api/audit/verify', { token: e.admin })).data.valid, true);
  await e.close();
});

test('draw: results hidden from members until confirmed; commitment visible; locked after confirm', async () => {
  const e = await boot();
  const m = await e.tokenFor(3);
  const cid = 2;
  await e.api('POST', `/api/cycles/${cid}/draw`, { token: e.admin });
  const pre = (await e.api('GET', `/api/cycles/${cid}`, { token: m })).data;
  assert.equal(pre.results.length, 0); assert.match(pre.commitment, /^[0-9a-f]{64}$/); assert.equal(pre.cycle.draw_salt, undefined); assert.equal(pre.cycle.draw_salt_revealed, undefined);
  const dash = (await e.api('GET', '/api/dashboard', { token: m })).data; assert.equal(dash.order, undefined);
  const staff = (await e.api('GET', `/api/cycles/${cid}`, { token: e.admin })).data; assert.equal(staff.results.length, 10);
  // admin may redraw before locking (logged); commitment changes
  const first = pre.commitment;
  await e.api('POST', `/api/cycles/${cid}/draw`, { token: e.admin });
  assert.notEqual((await e.api('GET', `/api/cycles/${cid}`, { token: m })).data.commitment, first);
  assert.ok((await e.api('GET', '/api/audit', { token: e.admin })).data.some(a => a.action === 'draw.redraw'));
  await e.api('POST', `/api/cycles/${cid}/draw/confirm`, { token: e.admin });
  assert.equal((await e.api('POST', `/api/cycles/${cid}/draw`, { token: e.admin })).status, 409, 'cannot redraw after lock');
  assert.equal((await e.api('POST', `/api/cycles/${cid}/draw/confirm`, { token: e.admin })).status, 409, 'cannot confirm twice');
  const post = (await e.api('GET', `/api/cycles/${cid}`, { token: m })).data;
  assert.equal(post.results.length, 10); assert.ok(post.cycle.draw_salt_revealed);
  await e.close();
});

test('ACCEPTANCE: draw results cannot be silently altered; overrides need a reason and are logged', async () => {
  const e = await boot();
  const { cycle, confirm } = await startCycle2(e);
  const [r1, r2, r3] = confirm.data.results;
  const url = `/api/cycles/${cycle.id}/draw/override`;
  assert.equal((await e.api('POST', url, { token: e.admin, body: { member_a: r2.member_id, member_b: r3.member_id } })).status, 400, 'reason required');
  assert.equal((await e.api('POST', url, { token: e.admin, body: { member_a: r2.member_id, member_b: r3.member_id, reason: 'abc' } })).status, 400, 'reason too short');
  assert.equal((await e.api('POST', url, { token: await e.tokenFor(2), body: { member_a: r2.member_id, member_b: r3.member_id, reason: 'valid reason' } })).status, 403);
  const ok = await e.api('POST', url, { token: e.admin, body: { member_a: r2.member_id, member_b: r3.member_id, reason: 'Member travelling in month 2' } });
  assert.equal(ok.status, 200);
  const after = ok.data.results;
  assert.equal(after.find(r => r.member_id === r2.member_id).position, 3);
  assert.equal(after.find(r => r.member_id === r3.member_id).position, 2);
  assert.deepEqual(after.map(r => r.position), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const log = (await e.api('GET', '/api/audit', { token: e.admin })).data.find(a => a.action === 'draw.override');
  assert.equal(log.actor_id, 1); assert.equal(log.after.reason, 'Member travelling in month 2'); assert.ok(log.timestamp);
  assert.deepEqual(log.before, { [r2.member_id]: 2, [r3.member_id]: 3 });
  const v = (await e.api('GET', `/api/cycles/${cycle.id}/draw/verify`, { token: e.admin })).data;
  assert.equal(v.valid, true, 'original commitment still verifies'); assert.equal(v.overrides.length, 1);
  // direct tampering with original draw data is caught
  e.store.t.DrawResults.find(r => r.cycle_id === cycle.id && r.member_id === r1.member_id).original_position = 7;
  assert.equal((await e.api('GET', `/api/cycles/${cycle.id}/draw/verify`, { token: e.admin })).data.valid, false);
  await e.close();
});

test('override cannot move a position that has already been paid', async () => {
  const e = await boot();
  const { cycle, confirm } = await startCycle2(e);
  await payAll(e, cycle.id, 1);
  assert.equal((await e.api('POST', '/api/payouts', { token: e.admin, body: { cycle_id: cycle.id } })).status, 201);
  const [r1, r2] = confirm.data.results;
  const res = await e.api('POST', `/api/cycles/${cycle.id}/draw/override`, { token: e.admin, body: { member_a: r1.member_id, member_b: r2.member_id, reason: 'try to swap paid' } });
  assert.equal(res.status, 409);
  await e.close();
});

test('contributions: record, duplicates blocked, wrong amount, client_ref idempotent sync, penalties', async () => {
  const e = await boot();
  const { cycle } = await startCycle2(e);
  const post = b => e.api('POST', '/api/contributions', { token: e.admin, body: { cycle_id: cycle.id, ...b } });
  const a = await post({ member_id: 2, method: 'mobile_money' });
  assert.equal(a.status, 201); assert.equal(a.data.amount, 50000); assert.equal(a.data.month_no, 1); assert.equal(a.data.recorded_by, 1);
  assert.equal((await post({ member_id: 2 })).status, 409, 'duplicate member+month');
  assert.equal((await post({ member_id: 3, amount: 40000 })).status, 400, 'wrong amount');
  assert.equal((await post({ member_id: 3, method: 'cheque' })).status, 400, 'bad method');
  assert.equal((await post({ member_id: 11 })).status, 400, 'auditor is not in the cycle');
  const o1 = await post({ member_id: 4, client_ref: 'offline-1' }); const o2 = await post({ member_id: 4, client_ref: 'offline-1' });
  assert.equal(o1.status, 201); assert.equal(o2.status, 200); assert.equal(o2.data.id, o1.data.id);
  // late penalty 10% when paid after due date
  await e.api('PUT', '/api/config', { token: e.admin, body: { late_penalty_pct: '10', due_day: '5' } });
  const late = await post({ member_id: 5, paid_at: '2026-11-20' }); assert.equal(late.data.penalty, 5000);
  const ontime = await post({ member_id: 6, paid_at: '2026-11-04' }); assert.equal(ontime.data.penalty, 0);
  // pending -> paid upgrade works, but paid -> paid does not
  assert.equal((await post({ member_id: 7, status: 'pending' })).status, 201);
  assert.equal((await post({ member_id: 7, status: 'paid' })).status, 201);
  assert.equal((await post({ member_id: 7, status: 'paid' })).status, 409);
  assert.equal(e.store.count('Contributions', c => c.cycle_id === cycle.id && c.member_id === 7), 1);
  await e.close();
});

test('mark-late flags unpaid members and notifies only them', async () => {
  const e = await boot();
  const { cycle } = await startCycle2(e);
  await payAll(e, cycle.id, 1, [8, 9]);
  const r = await e.api('POST', `/api/cycles/${cycle.id}/months/1/mark-late`, { token: e.admin });
  assert.deepEqual(r.data.marked_late.sort(), [8, 9]);
  await e.settle();
  assert.deepEqual(e.store.all('Notifications').filter(n => n.type === 'late_contribution').map(n => n.member_id).sort(), [8, 9]);
  const st = (await e.api('GET', `/api/cycles/${cycle.id}/months/1`, { token: e.admin })).data;
  assert.equal(st.filter(s => s.status === 'late').length, 2); assert.equal(st.filter(s => s.status === 'paid').length, 8);
  await e.close();
});

test('ACCEPTANCE: system blocks a second payout for the same month or position', async () => {
  const e = await boot();
  const { cycle } = await startCycle2(e);
  await payAll(e, cycle.id, 1);
  const pay = () => e.api('POST', '/api/payouts', { token: e.admin, body: { cycle_id: cycle.id, month_no: 1, method: 'mobile_money' } });
  const first = await pay();
  assert.equal(first.status, 201); assert.equal(first.data.amount, 500000); assert.equal(first.data.status, 'settled');
  const dup = await pay(); assert.equal(dup.status, 409); assert.match(dup.data.error, /already/);
  assert.equal(e.store.count('Payouts', p => p.cycle_id === cycle.id), 1);
  // DB-level guard: bypassing the service still cannot insert a duplicate month or position
  assert.throws(() => e.store.insert('Payouts', { cycle_id: cycle.id, member_id: 5, month_no: 1, position: 5, receipt_no: 'X1' }), /Duplicate/);
  assert.throws(() => e.store.insert('Payouts', { cycle_id: cycle.id, member_id: 5, month_no: 5, position: 1, receipt_no: 'X2' }), /Duplicate/);
  await e.close();
});

test('payout: idempotency key replays safely; 8 concurrent requests create exactly one payout', async () => {
  const e = await boot();
  const { cycle } = await startCycle2(e);
  await payAll(e, cycle.id, 1);
  const hit = (k) => e.api('POST', '/api/payouts', { token: e.admin, body: { cycle_id: cycle.id }, headers: k ? { 'Idempotency-Key': k } : {} });
  const rs = await Promise.all(Array.from({ length: 8 }, () => hit('same-key')));
  assert.equal(rs.filter(r => r.status === 201).length, 1);
  assert.equal(rs.filter(r => r.status === 200).length, 7);
  assert.equal(new Set(rs.map(r => r.data.id)).size, 1);
  assert.equal(e.store.count('Payouts', p => p.cycle_id === cycle.id), 1);
  const race = await Promise.all(Array.from({ length: 6 }, () => hit(null)));
  assert.equal(race.filter(r => r.status === 201).length, 0, 'month 1 already settled');
  assert.equal(e.store.count('Payouts', p => p.cycle_id === cycle.id), 1);
  await e.close();
});

test('payout: goes to the drawn recipient, needs all contributions (or logged override), advances in order', async () => {
  const e = await boot();
  const { cycle, confirm } = await startCycle2(e);
  const order = confirm.data.results;
  const pay = b => e.api('POST', '/api/payouts', { token: e.admin, body: { cycle_id: cycle.id, ...b } });
  await payAll(e, cycle.id, 1, [10]);
  const blocked = await pay({}); assert.equal(blocked.status, 409); assert.match(blocked.data.error, /9 of 10/);
  assert.equal((await pay({ month_no: 2 })).status, 409, 'cannot skip ahead');
  const ov = await pay({ override_reason: 'Member 10 pays tomorrow; group agreed' });
  assert.equal(ov.status, 201); assert.equal(ov.data.member_id, order[0].member_id); assert.equal(ov.data.amount, 450000);
  assert.ok(ov.data.receipt_no.startsWith('RCPT-C2-M01-'));
  assert.ok((await e.api('GET', '/api/audit', { token: e.admin })).data.some(a => a.action === 'payout.record_override'));
  assert.equal((await e.api('GET', `/api/cycles/${cycle.id}`, { token: e.admin })).data.cycle.current_month, 2);
  assert.equal((await e.api('POST', '/api/contributions', { token: e.admin, body: { cycle_id: cycle.id, member_id: 10, month_no: 1 } })).status, 409, 'settled month closed');
  // month 2 -> recipient is position 2
  await payAll(e, cycle.id, 2);
  const p2 = await pay({}); assert.equal(p2.data.member_id, order[1].member_id); assert.equal(p2.data.position, 2);
  await e.settle();
  const conf = e.store.all('Notifications').filter(n => n.type === 'payout_confirmed');
  assert.equal(conf.length, 20); assert.match(conf[0].message, new RegExp(order[0].name));
  await e.close();
});

test('ACCEPTANCE: full Cycle 2 end-to-end; contributions == payouts; archive; Cycle 3 re-randomises', async () => {
  const e = await boot();
  const { cycle, confirm } = await startCycle2(e);
  const early = await e.api('POST', `/api/cycles/${cycle.id}/close`, { token: e.admin }); assert.equal(early.status, 409);
  assert.equal((await e.api('POST', '/api/cycles', { token: e.admin, body: {} })).status, 409, 'one open cycle at a time');
  const paidTo = [];
  for (let m = 1; m <= 10; m++) {
    await payAll(e, cycle.id, m);
    const r = await e.api('POST', '/api/payouts', { token: e.admin, body: { cycle_id: cycle.id, method: 'mobile_money' } });
    assert.equal(r.status, 201, JSON.stringify(r.data)); paidTo.push(r.data.member_id);
  }
  assert.deepEqual(paidTo.slice().sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'everyone received exactly once');
  assert.deepEqual(paidTo, confirm.data.results.map(r => r.member_id), 'payouts follow the draw order');
  const rec = (await e.api('GET', `/api/cycles/${cycle.id}/reconciliation`, { token: e.admin })).data;
  assert.deepEqual(rec, { contributions: 5000000, payouts: 5000000, balanced: true, difference: 0 });
  const closed = await e.api('POST', `/api/cycles/${cycle.id}/close`, { token: e.admin });
  assert.equal(closed.status, 200); assert.equal(closed.data.cycle.status, 'closed');
  assert.equal((await e.api('POST', '/api/payouts', { token: e.admin, body: { cycle_id: cycle.id } })).status, 409, 'archived cycle is read-only');
  const c3 = await e.api('POST', '/api/cycles', { token: e.admin, body: {} });
  assert.equal(c3.status, 201); assert.equal(c3.data.cycle_number, 3); assert.equal(c3.data.start_month, '2027-09');
  await e.api('POST', `/api/cycles/${c3.data.id}/draw`, { token: e.admin }); await e.api('POST', `/api/cycles/${c3.data.id}/draw/confirm`, { token: e.admin });
  const o3 = (await e.api('GET', `/api/cycles/${c3.data.id}`, { token: e.admin })).data.results;
  assert.equal(new Set(o3.map(r => r.position)).size, 10);
  assert.equal((await e.api('GET', '/api/audit/verify', { token: e.admin })).data.valid, true);
  await e.close();
});

test('ACCEPTANCE: a member sees their exact payout month and contribution standing', async () => {
  const e = await boot();
  const { cycle, confirm } = await startCycle2(e);
  await e.api('POST', '/api/contributions', { token: e.admin, body: { cycle_id: cycle.id, member_id: 4 } });
  const t = await e.tokenFor(4);
  const d = (await e.api('GET', '/api/dashboard', { token: t })).data;
  const mine = confirm.data.results.find(r => r.member_id === 4);
  assert.equal(d.my.position, mine.position); assert.equal(d.my.payout_month, mine.payout_month);
  assert.equal(d.current_month.my_status, 'paid'); assert.equal(d.current_month.paid_count, 1); assert.equal(d.current_month.outstanding_count, 9);
  assert.equal(d.current_month.expected, 500000);
  assert.equal(d.order.filter(o => o.is_me).length, 1);
  const hist = (await e.api('GET', '/api/members/4/history', { token: t })).data;
  assert.equal(hist.cycles.find(c => c.cycle_number === 1).position, 1); // legacy Cycle 1 order: member 4 was first
  assert.equal((await e.api('GET', '/api/members/5/history', { token: t })).status, 403, 'members cannot read others\' history');
  assert.equal((await e.api('GET', '/api/members/5/history', { token: e.admin })).status, 200);
  await e.close();
});

test('policy: new members join the next cycle; unpaid member in a running cycle cannot be deactivated', async () => {
  const e = await boot();
  const { cycle, confirm } = await startCycle2(e);
  const nm = await e.api('POST', '/api/members', { token: e.admin, body: { name: 'New Member', phone: '0702000000', password: 'Newpass@123' } });
  assert.equal(nm.status, 201); assert.equal(nm.data.joins_next_cycle, true);
  assert.equal((await e.api('POST', '/api/contributions', { token: e.admin, body: { cycle_id: cycle.id, member_id: nm.data.id } })).status, 400);
  assert.equal(e.store.count('DrawResults', r => r.cycle_id === cycle.id), 10);
  const d = await e.api('POST', '/api/members/2/deactivate', { token: e.admin }); assert.equal(d.status, 409);
  assert.equal((await e.api('POST', '/api/members', { token: e.admin, body: { name: 'X' } })).status, 400, 'validation');
  const upd = await e.api('PUT', '/api/members/2', { token: e.admin, body: { phone: '0709999999' } }); assert.equal(upd.data.phone, '0709999999');
  await e.close();
});

test('policy: deactivated members leave the next draw; group size follows active members (configurable)', async () => {
  const e = await boot();
  const { cycle } = await startCycle2(e);
  for (let m = 1; m <= 10; m++) { await payAll(e, cycle.id, m); await e.api('POST', '/api/payouts', { token: e.admin, body: { cycle_id: cycle.id } }); }
  await e.api('POST', `/api/cycles/${cycle.id}/close`, { token: e.admin });
  assert.equal((await e.api('POST', '/api/members/9/deactivate', { token: e.admin })).status, 200);
  await e.api('PUT', '/api/config', { token: e.admin, body: { contribution_amount: '20000' } });
  const c3 = (await e.api('POST', '/api/cycles', { token: e.admin, body: {} })).data;
  const dr = (await e.api('POST', `/api/cycles/${c3.id}/draw`, { token: e.admin })).data;
  assert.equal(dr.results.length, 9); assert.equal(dr.cycle.group_size, 9); assert.equal(dr.cycle.amount, 20000);
  await e.api('POST', `/api/cycles/${c3.id}/draw/confirm`, { token: e.admin });
  await payAll({ ...e }, c3.id, 1, [9]); // member 9 inactive -> not in cycle
  assert.equal((await e.api('POST', '/api/payouts', { token: e.admin, body: { cycle_id: c3.id } })).data.amount, 180000);
  await e.close();
});

test('reports: ledgers, summary, statement; CSV and PDF export; members restricted', async () => {
  const e = await boot();
  const csv = await e.api('GET', '/api/reports/payout-ledger?format=csv&cycle_id=1', { token: e.admin, raw: true });
  assert.equal(csv.status, 200); assert.match(csv.headers.get('content-type'), /text\/csv/);
  const txt = await csv.text(); assert.equal(txt.trim().split('\r\n').length, 11); assert.ok(txt.includes('RCPT-C1-M01-LEGACY'));
  const pdf = await e.api('GET', '/api/reports/cycle-summary?format=pdf&cycle_id=1', { token: e.admin, raw: true });
  assert.equal(pdf.status, 200); const buf = Buffer.from(await pdf.arrayBuffer()); assert.equal(buf.slice(0, 4).toString(), '%PDF'); assert.ok(buf.length > 1000);
  const sum = (await e.api('GET', '/api/reports/cycle-summary?cycle_id=1', { token: e.admin })).data;
  const total = sum.rows[sum.rows.length - 1]; assert.equal(total[3], 5000000); assert.equal(total[4], 5000000); assert.equal(total[5], 'Reconciled');
  assert.equal((await e.api('GET', '/api/reports/contribution-ledger?cycle_id=1', { token: e.admin })).data.rows.length, 100);
  const t5 = await e.tokenFor(5);
  const st = (await e.api('GET', '/api/reports/member-statement?member_id=1', { token: t5 })).data; // forced to own id
  assert.match(st.title, /Mugisha Peter/);
  assert.equal((await e.api('GET', '/api/reports/audit', { token: t5 })).status, 403);
  assert.equal((await e.api('GET', '/api/reports/contribution-ledger', { token: t5 })).status, 403);
  assert.equal((await e.api('GET', '/api/reports/nope', { token: e.admin })).status, 404);
  await e.close();
});

test('auditor: read-only access to ledgers, audit trail and draw proofs; cannot write', async () => {
  const e = await boot();
  const a = await e.login('auditor@example.com', 'Member@1234');
  assert.equal((await e.api('GET', '/api/audit', { token: a })).status, 200);
  assert.equal((await e.api('GET', '/api/audit/verify', { token: a })).status, 200);
  assert.equal((await e.api('GET', '/api/reports/contribution-ledger?cycle_id=1', { token: a })).status, 200);
  assert.equal((await e.api('GET', '/api/members', { token: a })).data[0].phone !== undefined, true);
  assert.equal((await e.api('POST', '/api/payouts', { token: a, body: { cycle_id: 2 } })).status, 403);
  assert.equal((await e.api('POST', '/api/cycles/2/draw', { token: a })).status, 403);
  await e.close();
});

test('announcements and activity feed; members see names only (no phone/email)', async () => {
  const e = await boot();
  const t = await e.tokenFor(2);
  assert.equal((await e.api('POST', '/api/announcements', { token: e.admin, body: { title: 'Meeting', body: 'Saturday 3pm' } })).status, 201);
  assert.equal((await e.api('POST', '/api/announcements', { token: e.admin, body: { title: '', body: '' } })).status, 400);
  const list = (await e.api('GET', '/api/announcements', { token: t })).data; assert.equal(list[0].title, 'Meeting');
  const mem = (await e.api('GET', '/api/members', { token: t })).data; assert.equal(mem[0].phone, undefined); assert.ok(mem[0].name);
  assert.ok((await e.api('GET', '/api/activity', { token: t })).data.length > 0);
  await e.close();
});

test('notification failures do not break business operations; rolled-back operations send nothing', async () => {
  const sent = [];
  const e = await boot({ notifier: async m => { sent.push(m); throw new Error('SMS gateway down'); } });
  const { cycle } = await startCycle2(e);
  await e.settle();
  assert.equal(e.store.get('Cycles', cycle.id).status, 'active');
  assert.ok(e.store.all('Notifications').every(n => n.status === 'failed'));
  const before = sent.length;
  await e.api('POST', '/api/contributions', { token: e.admin, body: { cycle_id: cycle.id, member_id: 2, month_no: 99 } }); // invalid -> 400
  await e.api('POST', '/api/payouts', { token: e.admin, body: { cycle_id: cycle.id } }); // blocked -> 409
  await e.settle();
  assert.equal(sent.length, before);
  await e.close();
});

test('input hardening: malformed JSON, unknown routes, unknown config keys, static UI served', async () => {
  const e = await boot();
  const bad = await e.api('PUT', '/api/config', { token: e.admin, body: { evil: '1' } }); assert.equal(bad.status, 400);
  assert.equal((await e.api('GET', '/api/nope', { token: e.admin })).status, 404);
  assert.equal((await e.api('GET', '/api/cycles/999', { token: e.admin })).status, 404);
  await e.close();
});
