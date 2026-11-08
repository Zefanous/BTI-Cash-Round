'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { Service, hashPassword, verifyPassword, addMonths } = require('../src/service');
const { Store, ConflictError } = require('../src/store');
const { MemoryBackend, CsvBackend, SheetsBackend, toCsv, parseCsv } = require('../src/backends');
const { sign, verify } = require('../src/auth');
const { seedDemo } = require('../src/seed');

test('draw: shuffle returns a permutation of 1..n (no duplicates)', () => {
  for (let n = 2; n <= 30; n++) {
    const a = Service.shuffle(n);
    assert.deepEqual([...a].sort((x, y) => x - y), Array.from({ length: n }, (_, i) => i + 1));
  }
});

test('draw fairness: each member lands in each position ~uniformly (chi-square, 60,000 draws)', () => {
  const N = 10, T = 60000, counts = Array.from({ length: N }, () => new Array(N).fill(0));
  for (let t = 0; t < T; t++) Service.shuffle(N).forEach((pos, member) => counts[member][pos - 1]++);
  const exp = T / N;
  let worst = 0;
  for (const row of counts) { const chi = row.reduce((s, o) => s + (o - exp) ** 2 / exp, 0); worst = Math.max(worst, chi); }
  console.log(`    worst chi-square over 10 members = ${worst.toFixed(2)} (df=9, critical p=0.001 is 27.88)`);
  assert.ok(worst < 27.88, 'distribution deviates from uniform');
  // Also: every pair-of-position check, first position share ~10%
  for (let m = 0; m < N; m++) assert.ok(Math.abs(counts[m][0] / T - 0.1) < 0.01);
});

test('draw uses CSPRNG: Math.random is never called', () => {
  const orig = Math.random; let calls = 0; Math.random = () => { calls++; return 0.5; };
  try { Service.shuffle(10); } finally { Math.random = orig; }
  assert.equal(calls, 0);
});

test('draw hash changes if any position or the salt is altered (tamper evident)', () => {
  const a = [{ member_id: 1, position: 1 }, { member_id: 2, position: 2 }];
  const h = Service.drawHash(2, a, 'salt');
  assert.equal(h, Service.drawHash(2, [...a].reverse(), 'salt'), 'order-independent');
  assert.notEqual(h, Service.drawHash(2, [{ member_id: 1, position: 2 }, { member_id: 2, position: 1 }], 'salt'));
  assert.notEqual(h, Service.drawHash(2, a, 'salt2'));
  assert.notEqual(h, Service.drawHash(3, a, 'salt'));
});

test('passwords are salted scrypt hashes and verify correctly', () => {
  const h = hashPassword('Secret#123');
  assert.ok(h.startsWith('scrypt$'));
  assert.notEqual(h, hashPassword('Secret#123'));
  assert.ok(verifyPassword('Secret#123', h));
  assert.ok(!verifyPassword('secret#123', h));
  assert.ok(!verifyPassword('x', 'garbage'));
});

test('JWT: valid, tampered, wrong secret and expired tokens', () => {
  const t = sign({ sub: 1 }, 's');
  assert.equal(verify(t, 's').sub, 1);
  assert.equal(verify(t, 'other'), null);
  const [h, p, s] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ sub: 2, exp: 9e9 })).toString('base64url');
  assert.equal(verify(`${h}.${forged}.${s}`, 's'), null);
  assert.equal(verify(sign({ sub: 1 }, 's', -10), 's'), null);
  assert.equal(verify('abc', 's'), null);
});

test('month arithmetic crosses year boundaries', () => {
  assert.equal(addMonths('2026-11', 1), '2026-12');
  assert.equal(addMonths('2026-11', 2), '2027-01');
  assert.equal(addMonths('2026-01', 9), '2026-10');
});

test('store: unique constraints (cycle,position), (cycle,member), (cycle,month) enforced', () => {
  const s = new Store(new MemoryBackend());
  s.insert('DrawResults', { cycle_id: 1, member_id: 1, position: 1 });
  assert.throws(() => s.insert('DrawResults', { cycle_id: 1, member_id: 2, position: 1 }), ConflictError);
  assert.throws(() => s.insert('DrawResults', { cycle_id: 1, member_id: 1, position: 2 }), ConflictError);
  s.insert('DrawResults', { cycle_id: 2, member_id: 1, position: 1 }); // other cycle OK
  s.insert('Payouts', { cycle_id: 1, month_no: 1, position: 1, receipt_no: 'A' });
  assert.throws(() => s.insert('Payouts', { cycle_id: 1, month_no: 1, position: 2, receipt_no: 'B' }), ConflictError);
  assert.throws(() => s.insert('Payouts', { cycle_id: 1, month_no: 2, position: 1, receipt_no: 'C' }), ConflictError);
});

test('store: transaction rolls back every change on failure and writes nothing', () => {
  const be = new MemoryBackend(); const s = new Store(be);
  s.insert('Members', { member_code: 'X', name: 'A' });
  assert.throws(() => s.transaction(() => { s.insert('Members', { member_code: 'Y', name: 'B' }); s.insert('Members', { member_code: 'X', name: 'dup' }); }));
  assert.equal(s.count('Members'), 1);
  assert.equal(s.get('Members', 2), null);
});

test('store: afterCommit hooks do not run when the transaction rolls back', () => {
  const s = new Store(new MemoryBackend()); let ran = 0;
  assert.throws(() => s.transaction(() => { s.afterCommit(() => ran++); throw new Error('x'); }));
  assert.equal(ran, 0);
  s.transaction(() => { s.afterCommit(() => ran++); });
  assert.equal(ran, 1);
});

test('CSV: round-trips commas, quotes, newlines and unicode', () => {
  const m = [['a', 'b'], ['x,y', 'he said "hi"'], ['line1\nline2', 'Nakató ✓']];
  assert.deepEqual(parseCsv(toCsv(m)), m);
});

test('CsvBackend: data persists across restart (types preserved incl. JSON columns)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chama-'));
  const s1 = new Store(new CsvBackend(dir));
  seedDemo(s1); await s1.flushed();
  const s2 = new Store(new CsvBackend(dir));
  assert.equal(s2.count('Members'), 11);
  assert.equal(s2.count('Payouts'), 10);
  assert.deepEqual(s2.all('AuditLogs'), s1.all('AuditLogs'));
  assert.equal(typeof s2.get('Cycles', 1).group_size, 'number');
  assert.ok(fs.existsSync(path.join(dir, 'Members.csv')));
  fs.rmSync(dir, { recursive: true });
});

test('SheetsBackend: writes header+rows per tab and reloads identically (mock Google API)', async () => {
  const tabs = {};
  const fake = { spreadsheets: {
    get: async () => ({ data: { sheets: [] } }), batchUpdate: async ({ requestBody }) => { requestBody.requests.forEach(r => { tabs[r.addSheet.properties.title] = []; }); },
    values: {
      clear: async ({ range }) => { tabs[range] = []; },
      update: async ({ range, requestBody }) => { tabs[range.split('!')[0]] = requestBody.values; },
      batchGet: async ({ ranges }) => ({ data: { valueRanges: ranges.map(r => ({ values: (tabs[r] || []).map(row => row.map(c => (/^-?\d+(\.\d+)?$/.test(c) ? Number(c) : c))) })) } }),
    } } };
  const be = new SheetsBackend({ spreadsheetId: 'abc', sheets: fake });
  await be.ensureTabs();
  assert.equal(Object.keys(tabs).length, 10);
  const s = new Store(be, new MemoryBackend().load()); seedDemo(s); await s.flushed();
  assert.deepEqual(tabs.Members[0].slice(0, 3), ['id', 'member_code', 'name']);
  assert.equal(tabs.Members.length, 12);
  const s2 = new Store(be, await be.loadAsync());
  assert.equal(s2.count('Contributions'), 100);
  assert.deepEqual(s2.all('AuditLogs'), s.all('AuditLogs'));
});

test('audit log is hash-chained: editing, deleting or re-ordering a row is detected', () => {
  const s = new Store(new MemoryBackend()); seedDemo(s);
  const svc = new Service(s);
  assert.equal(svc.verifyAudit().valid, true);
  s.t.AuditLogs[0].summary = 'tampered';
  const r = svc.verifyAudit(); assert.equal(r.valid, false); assert.equal(r.broken_at, s.t.AuditLogs[0].id);
  const s2 = new Store(new MemoryBackend()); seedDemo(s2); const svc2 = new Service(s2);
  const headBefore = svc2.verifyAudit().head;
  s2.t.AuditLogs.splice(0, 1); // delete an entry from the start/middle of the chain
  assert.equal(svc2.verifyAudit().valid, false);
  // Truncating the *tail* leaves a self-consistent chain, but the published head hash no longer matches:
  const s3 = new Store(new MemoryBackend()); seedDemo(s3); const svc3 = new Service(s3);
  s3.t.AuditLogs.pop();
  assert.equal(svc3.verifyAudit().valid, true);
  assert.notEqual(svc3.verifyAudit().head, headBefore);
});

test('seed: Cycle 1 is complete and reconciles (5,000,000 in = 5,000,000 out); Cycle 2 is created awaiting draw', () => {
  const s = new Store(new MemoryBackend()); const svc = seedDemo(s);
  assert.deepEqual(svc.reconcile(1), { contributions: 5000000, payouts: 5000000, balanced: true, difference: 0 });
  assert.equal(s.get('Cycles', 1).status, 'closed');
  const c2 = s.get('Cycles', 2); assert.equal(c2.cycle_number, 2); assert.equal(c2.status, 'draft'); assert.equal(c2.group_size, 10);
  assert.equal(new Set(s.find('DrawResults', r => r.cycle_id === 1).map(r => r.member_id)).size, 10);
});
