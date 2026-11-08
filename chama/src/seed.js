'use strict';
const { Service, hashPassword, addMonths, sha } = require('./service');

const NAMES = [
  ['Kimera Ian', 'admin', '0701000001'], ['Nakato Sarah', 'member', '0701000002'], ['Okello David', 'member', '0701000003'],
  ['Namukasa Grace', 'member', '0701000004'], ['Mugisha Peter', 'member', '0701000005'], ['Atim Joyce', 'member', '0701000006'],
  ['Ssemwogerere Paul', 'member', '0701000007'], ['Achieng Ruth', 'member', '0701000008'], ['Byaruhanga Moses', 'member', '0701000009'],
  ['Tumusiime Esther', 'member', '0701000010'],
];
// Cycle 1 payout order (historical, as agreed before the system existed)
const CYCLE1_ORDER = [4, 9, 2, 7, 1, 10, 5, 3, 8, 6];

function seedDemo(store, { adminPassword = 'Admin@1234', memberPassword = 'Member@1234', auditor = true } = {}) {
  const svc = new Service(store);
  const admin = { id: 1 };
  store.transaction(() => {
    NAMES.forEach(([name, role, phone], i) => store.insert('Members', {
      member_code: 'M' + String(i + 1).padStart(3, '0'), name, phone, email: name.split(' ')[0].toLowerCase() + '@example.com', role, participates: 1,
      status: 'active', join_date: '2025-12-01', password_hash: hashPassword(role === 'admin' ? adminPassword : memberPassword), created_at: new Date().toISOString(),
    }));
    if (auditor) store.insert('Members', { member_code: 'A001', name: 'Auditor Read-Only', phone: '0701000099', email: 'auditor@example.com', role: 'auditor', participates: 0, status: 'active', join_date: '2025-12-01', password_hash: hashPassword(memberPassword), created_at: new Date().toISOString() });

    // ---- Cycle 1: complete ----
    const c1 = store.insert('Cycles', { cycle_number: 1, start_month: '2026-01', end_month: '2026-10', status: 'closed', group_size: 10, amount: 50000, current_month: 11, draw_hash: sha('cycle1-legacy'), draw_salt: 'legacy', created_by: 1, created_at: '2025-12-28T08:00:00.000Z', locked_at: '2025-12-30T08:00:00.000Z', closed_at: '2026-10-28T08:00:00.000Z' });
    CYCLE1_ORDER.forEach((mid, i) => store.insert('DrawResults', { cycle_id: c1.id, member_id: mid, position: i + 1, original_position: i + 1, drawn_at: '2025-12-30T08:00:00.000Z', proof_hash: sha(`legacy|${mid}|${i + 1}`) }));
    for (let m = 1; m <= 10; m++) {
      const ym = addMonths('2026-01', m - 1);
      for (let mid = 1; mid <= 10; mid++) store.insert('Contributions', { cycle_id: c1.id, member_id: mid, month_no: m, amount: 50000, penalty: 0, method: mid % 2 ? 'mobile_money' : 'cash', status: 'paid', paid_at: `${ym}-0${1 + (mid % 4)}`, recorded_by: 1, client_ref: null, created_at: `${ym}-01T08:00:00.000Z` });
      store.insert('Payouts', { cycle_id: c1.id, member_id: CYCLE1_ORDER[m - 1], month_no: m, position: m, amount: 500000, method: 'mobile_money', paid_at: `${ym}-10`, receipt_no: `RCPT-C1-M${String(m).padStart(2, '0')}-LEGACY`, recorded_by: 1, status: 'settled', note: '' });
    }
    svc.audit(admin, 'cycle.import', 'Cycles', c1.id, 'Imported completed Cycle 1 (historical records)', null, { cycle_number: 1, payouts: 10 });
    svc.announce({ title: 'Cycle 1 completed', body: 'All 10 members have received their payout. Cycle 2 is next, with a fresh random draw.', kind: 'auto' }, admin);
    // ---- Cycle 2: created, draw pending ----
    svc.createCycle({}, admin);
  });
  return svc;
}
module.exports = { seedDemo };
