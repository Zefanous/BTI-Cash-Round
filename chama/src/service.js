'use strict';
const crypto = require('crypto');
const { ConflictError } = require('./store');

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = m => new HttpError(400, m);
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const now = () => new Date().toISOString();
const today = () => now().slice(0, 10);

// ---------- passwords ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${crypto.scryptSync(pw, salt, 32).toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [alg, salt, hash] = String(stored || '').split('$');
  if (alg !== 'scrypt') return false;
  const a = Buffer.from(crypto.scryptSync(pw, salt, 32).toString('hex'));
  const b = Buffer.from(hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- month helpers ----------
function addMonths(ym, n) { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); }
function monthLabel(ym) { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }); }

const DEFAULT_CONFIG = {
  group_name: 'BTI Cash Round Group', currency: 'UGX', contribution_amount: '50000', due_day: '5',
  late_penalty_pct: '0', notify_channel: 'sms', payout_method: 'mobile_money',
};
const METHODS = ['cash', 'mobile_money', 'bank'];

class Service {
  constructor(store, { notifier } = {}) {
    this.s = store;
    this.notifier = notifier || (async () => ({ status: 'simulated' }));
    for (const [k, v] of Object.entries(DEFAULT_CONFIG)) if (!this.s.one('Config', r => r.key === k)) this.s.insert('Config', { key: k, value: v });
  }

  // ================= config =================
  config() { const o = {}; for (const r of this.s.all('Config')) o[r.key] = r.value; return o; }
  setConfig(patch, actor) {
    return this.s.transaction(() => {
      const before = this.config();
      for (const [k, v] of Object.entries(patch)) {
        if (!(k in DEFAULT_CONFIG)) throw bad(`Unknown setting: ${k}`);
        if (['contribution_amount', 'due_day', 'late_penalty_pct'].includes(k) && !(Number(v) >= 0)) throw bad(`${k} must be a non-negative number`);
        const row = this.s.one('Config', r => r.key === k);
        this.s.update('Config', row.id, { value: String(v) });
      }
      this.audit(actor, 'config.update', 'Config', 0, 'Settings changed', before, this.config());
      return this.config();
    });
  }

  // ================= audit (hash-chained, tamper-evident) =================
  audit(actor, action, entity, entityId, summary, before, after) {
    const last = this.s.all('AuditLogs').pop();
    const prev = last ? last.hash : 'GENESIS';
    const ts = now();
    const actorId = actor ? actor.id : 0;
    const payload = JSON.stringify([prev, actorId, action, entity, entityId, summary, before ?? null, after ?? null, ts]);
    return this.s.insert('AuditLogs', { actor_id: actorId, action, entity, entity_id: entityId, summary, before: before ?? null, after: after ?? null, timestamp: ts, prev_hash: prev, hash: sha(payload) });
  }
  verifyAudit() {
    let prev = 'GENESIS';
    for (const l of this.s.all('AuditLogs')) {
      const h = sha(JSON.stringify([prev, l.actor_id, l.action, l.entity, l.entity_id, l.summary, l.before ?? null, l.after ?? null, l.timestamp]));
      if (l.prev_hash !== prev || l.hash !== h) return { valid: false, broken_at: l.id, entries: this.s.count('AuditLogs') };
      prev = l.hash;
    }
    return { valid: true, entries: this.s.count('AuditLogs'), head: prev };
  }

  // ================= members =================
  publicMember(m, full) {
    const o = { id: m.id, member_code: m.member_code, name: m.name, status: m.status, role: m.role, participates: !!m.participates };
    if (full) Object.assign(o, { phone: m.phone, email: m.email, join_date: m.join_date });
    return o;
  }
  listMembers(full) { return this.s.all('Members').map(m => this.publicMember(m, full)); }
  createMember(d, actor) {
    const name = String(d.name || '').trim();
    if (name.length < 2) throw bad('Name is required');
    if (!d.phone && !d.email) throw bad('Phone or email is required');
    const role = d.role || 'member';
    if (!['admin', 'member', 'auditor'].includes(role)) throw bad('Invalid role');
    return this.s.transaction(() => {
      const next = this.s.all('Members').length + 1;
      const row = this.s.insert('Members', {
        member_code: d.member_code || 'M' + String(next).padStart(3, '0'), name, phone: d.phone || '', email: (d.email || '').toLowerCase(),
        role, participates: d.participates === false || d.participates === 0 ? 0 : 1, status: 'active', join_date: d.join_date || today(),
        password_hash: hashPassword(d.password || crypto.randomBytes(6).toString('hex')), created_at: now(),
      });
      const active = this.s.one('Cycles', c => c.status === 'active' || c.status === 'drawn');
      this.audit(actor, 'member.create', 'Members', row.id, `Registered ${name}`, null, this.publicMember(row, true));
      return { ...this.publicMember(row, true), joins_next_cycle: !!(active && row.participates) };
    });
  }
  updateMember(id, d, actor) {
    const m = this.s.get('Members', id); if (!m) throw new HttpError(404, 'Member not found');
    const patch = {};
    for (const k of ['name', 'phone', 'email', 'member_code', 'join_date']) if (d[k] !== undefined) patch[k] = k === 'email' ? String(d[k]).toLowerCase() : d[k];
    if (d.role !== undefined) { if (!['admin', 'member', 'auditor'].includes(d.role)) throw bad('Invalid role'); patch.role = d.role; }
    if (d.participates !== undefined) patch.participates = d.participates ? 1 : 0;
    if (d.password) patch.password_hash = hashPassword(d.password);
    return this.s.transaction(() => {
      const row = this.s.update('Members', id, patch);
      this.audit(actor, 'member.update', 'Members', id, `Edited ${m.name}`, this.publicMember(m, true), this.publicMember(row, true));
      return this.publicMember(row, true);
    });
  }
  setMemberStatus(id, status, actor) {
    const m = this.s.get('Members', id); if (!m) throw new HttpError(404, 'Member not found');
    if (status === 'inactive') {
      const cyc = this.s.one('Cycles', c => c.status === 'active' || c.status === 'drawn');
      if (cyc) {
        const dr = this.s.one('DrawResults', r => r.cycle_id === cyc.id && r.member_id === id);
        const paid = dr && this.s.one('Payouts', p => p.cycle_id === cyc.id && p.member_id === id);
        if (dr && !paid) throw new ConflictError('Member is in the running cycle and has not yet received their payout. Deactivate after the cycle closes (policy: membership changes take effect next cycle).');
      }
    }
    return this.s.transaction(() => {
      const row = this.s.update('Members', id, { status });
      this.audit(actor, `member.${status === 'active' ? 'activate' : 'deactivate'}`, 'Members', id, `${m.name} set ${status}`, { status: m.status }, { status });
      return this.publicMember(row, true);
    });
  }
  memberHistory(id) {
    const m = this.s.get('Members', id); if (!m) throw new HttpError(404, 'Member not found');
    const cycles = this.s.all('Cycles');
    const draws = this.s.find('DrawResults', r => r.member_id === id);
    const out = cycles.map(c => {
      const d = draws.find(x => x.cycle_id === c.id);
      const revealed = c.status === 'active' || c.status === 'closed';
      const contribs = this.s.find('Contributions', x => x.cycle_id === c.id && x.member_id === id).sort((a, b) => a.month_no - b.month_no);
      const payout = this.s.one('Payouts', p => p.cycle_id === c.id && p.member_id === id);
      return { cycle_id: c.id, cycle_number: c.cycle_number, status: c.status, position: d && revealed ? d.position : null,
        payout_month: d && revealed ? monthLabel(addMonths(c.start_month, d.position - 1)) : null,
        contributions: contribs, total_contributed: contribs.filter(x => x.status === 'paid').reduce((a, x) => a + x.amount, 0), payout };
    }).filter(c => c.position !== null || c.contributions.length || c.payout);
    return { member: this.publicMember(m, true), cycles: out };
  }

  // ================= cycles =================
  cycle(id) { const c = this.s.get('Cycles', id); if (!c) throw new HttpError(404, 'Cycle not found'); return c; }
  publicCycle(c, role) {
    const o = { ...c }; delete o.draw_salt;
    if (c.status === 'closed' || c.status === 'active') o.draw_salt_revealed = c.draw_salt; // reveal only after lock
    o.start_label = monthLabel(c.start_month); o.end_label = monthLabel(c.end_month);
    return o;
  }
  listCycles() { return this.s.all('Cycles').sort((a, b) => b.cycle_number - a.cycle_number).map(c => this.publicCycle(c)); }
  currentCycle() { return this.s.one('Cycles', c => c.status !== 'closed'); }
  createCycle(d, actor) {
    return this.s.transaction(() => {
      if (this.s.one('Cycles', c => c.status !== 'closed')) throw new ConflictError('Close the running cycle before creating a new one');
      const all = this.s.all('Cycles');
      const num = all.reduce((m, c) => Math.max(m, c.cycle_number), 0) + 1;
      const last = all.sort((a, b) => b.cycle_number - a.cycle_number)[0];
      const start = d.start_month || (last ? addMonths(last.end_month, 1) : today().slice(0, 7));
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(start)) throw bad('start_month must be YYYY-MM');
      const cfg = this.config();
      const size = this.eligibleMembers().length;
      const c = this.s.insert('Cycles', { cycle_number: num, start_month: start, end_month: addMonths(start, Math.max(size, 1) - 1), status: 'draft', group_size: size, amount: Number(cfg.contribution_amount), current_month: 0, created_by: actor.id, created_at: now() });
      this.audit(actor, 'cycle.create', 'Cycles', c.id, `Created Cycle ${num}`, null, this.publicCycle(c));
      return this.publicCycle(c);
    });
  }
  eligibleMembers() { return this.s.find('Members', m => m.status === 'active' && m.participates); }

  // ---- draw engine: CSPRNG Fisher-Yates + commit-reveal ----
  static shuffle(n, randInt = crypto.randomInt) {
    const a = Array.from({ length: n }, (_, i) => i + 1);
    for (let i = n - 1; i > 0; i--) { const j = randInt(0, i + 1); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
  static drawHash(cycleNumber, assignments, salt) {
    const body = [...assignments].sort((a, b) => a.member_id - b.member_id).map(a => `${a.member_id}:${a.position}`).join(',');
    return sha(`${cycleNumber}|${body}|${salt}`);
  }
  runDraw(cycleId, actor, randInt) {
    return this.s.transaction(() => {
      const c = this.cycle(cycleId);
      if (c.status !== 'draft' && c.status !== 'drawn') throw new ConflictError('Draw is locked for this cycle');
      const members = this.eligibleMembers();
      if (members.length < 2) throw bad('At least 2 active participating members are needed for a draw');
      const wasRedraw = c.status === 'drawn';
      for (const r of this.s.find('DrawResults', r => r.cycle_id === cycleId)) this._deleteRow('DrawResults', r.id);
      const positions = Service.shuffle(members.length, randInt);
      const ts = now();
      const salt = crypto.randomBytes(24).toString('hex');
      const assignments = members.map((m, i) => ({ member_id: m.id, position: positions[i] }));
      const hash = Service.drawHash(c.cycle_number, assignments, salt);
      for (const a of assignments) this.s.insert('DrawResults', { cycle_id: cycleId, member_id: a.member_id, position: a.position, original_position: a.position, drawn_at: ts, proof_hash: sha(`${hash}|${a.member_id}|${a.position}`) });
      const upd = this.s.update('Cycles', cycleId, { status: 'drawn', draw_hash: hash, draw_salt: salt, group_size: members.length, end_month: addMonths(c.start_month, members.length - 1), amount: Number(this.config().contribution_amount) });
      this.audit(actor, wasRedraw ? 'draw.redraw' : 'draw.generate', 'Cycles', cycleId, `${wasRedraw ? 'Re-drew' : 'Drew'} Cycle ${c.cycle_number}; commitment ${hash.slice(0, 16)}…`, null, { draw_hash: hash, drawn_at: ts, members: members.length });
      return this.drawPreview(cycleId, upd);
    });
  }
  _deleteRow(t, id) { const i = this.s.t[t].findIndex(r => r.id === id); this.s.t[t].splice(i, 1); this.s._touch(t); }
  drawResults(cycleId) {
    const c = this.cycle(cycleId);
    return this.s.find('DrawResults', r => r.cycle_id === cycleId).sort((a, b) => a.position - b.position).map(r => {
      const m = this.s.get('Members', r.member_id);
      return { position: r.position, original_position: r.original_position, member_id: r.member_id, member_code: m.member_code, name: m.name, payout_month: monthLabel(addMonths(c.start_month, r.position - 1)), drawn_at: r.drawn_at, proof_hash: r.proof_hash };
    });
  }
  drawPreview(cycleId, c) { c = c || this.cycle(cycleId); return { cycle: this.publicCycle(c), results: this.drawResults(cycleId), locked: false, commitment: c.draw_hash }; }
  confirmDraw(cycleId, actor) {
    return this.s.transaction(() => {
      const c = this.cycle(cycleId);
      if (c.status !== 'drawn') throw new ConflictError(c.status === 'draft' ? 'Run the draw first' : 'Draw already confirmed and locked');
      const upd = this.s.update('Cycles', cycleId, { status: 'active', current_month: 1, locked_at: now() });
      const results = this.drawResults(cycleId);
      this.audit(actor, 'draw.confirm', 'Cycles', cycleId, `Locked draw for Cycle ${c.cycle_number}`, null, { draw_hash: c.draw_hash, results: results.map(r => ({ member_id: r.member_id, position: r.position })) });
      const lines = results.map(r => `${r.position}. ${r.name} (${r.payout_month})`).join('; ');
      this.announce({ title: `Cycle ${c.cycle_number} draw results`, body: `Positions: ${lines}. Verification hash: ${c.draw_hash}`, kind: 'auto' }, actor);
      this.notify('draw_published', results.map(r => r.member_id), `Cycle ${c.cycle_number} has started. Your payout position is shown in the app. Draw hash ${c.draw_hash.slice(0, 12)}`, (m) => {
        const r = results.find(x => x.member_id === m); return `Cycle ${c.cycle_number} has started. Your payout is #${r.position} (${r.payout_month}). Draw hash ${c.draw_hash.slice(0, 12)}`;
      });
      this.notify('payout_reminder', this._contributors(cycleId), '', () => `Reminder: Month 1 contribution of ${upd.amount} is due; ${results[0].name} receives this month.`);
      return { cycle: this.publicCycle(upd), results, locked: true };
    });
  }
  overrideDraw(cycleId, d, actor) {
    const reason = String(d.reason || '').trim();
    if (reason.length < 5) throw bad('A reason (min 5 characters) is required for an override');
    const a = Number(d.member_a), b = Number(d.member_b);
    if (!a || !b || a === b) throw bad('Choose two different members to swap');
    return this.s.transaction(() => {
      const c = this.cycle(cycleId);
      if (c.status !== 'active') throw new ConflictError('Overrides apply only to a locked, running cycle');
      const ra = this.s.one('DrawResults', r => r.cycle_id === cycleId && r.member_id === a);
      const rb = this.s.one('DrawResults', r => r.cycle_id === cycleId && r.member_id === b);
      if (!ra || !rb) throw bad('Both members must be in this cycle\'s draw');
      for (const r of [ra, rb]) if (r.position < c.current_month || this.s.one('Payouts', p => p.cycle_id === cycleId && p.position === r.position)) throw new ConflictError('Cannot swap a position that has already been paid out');
      const before = { [a]: ra.position, [b]: rb.position };
      this.s.update('DrawResults', ra.id, { position: -1 }); // temp slot avoids unique clash
      this.s.update('DrawResults', rb.id, { position: before[a] });
      this.s.update('DrawResults', ra.id, { position: before[b] });
      const after = { [a]: before[b], [b]: before[a] };
      this.audit(actor, 'draw.override', 'Cycles', cycleId, `OVERRIDE swapped positions: ${reason}`, before, { positions: after, reason });
      const mm = x => this.s.get('Members', x).name;
      this.announce({ title: `Draw override – Cycle ${c.cycle_number}`, body: `${mm(a)} and ${mm(b)} swapped payout positions. Reason: ${reason}`, kind: 'auto' }, actor);
      this.notify('draw_override', [a, b], '', (m) => `Your payout position changed to #${after[m]} (reason: ${reason})`);
      return { results: this.drawResults(cycleId) };
    });
  }
  verifyDraw(cycleId) {
    const c = this.cycle(cycleId);
    if (!c.draw_hash) return { valid: false, reason: 'No draw yet' };
    const revealed = c.status === 'active' || c.status === 'closed';
    const rows = this.s.find('DrawResults', r => r.cycle_id === cycleId);
    const overrides = this.s.find('AuditLogs', l => l.action === 'draw.override' && l.entity_id === cycleId).map(l => ({ at: l.timestamp, actor_id: l.actor_id, reason: l.after && l.after.reason, before: l.before, after: l.after && l.after.positions }));
    if (!revealed) return { valid: true, revealed: false, commitment: c.draw_hash, note: 'Results are hidden until the draw is confirmed' };
    const recomputed = Service.drawHash(c.cycle_number, rows.map(r => ({ member_id: r.member_id, position: r.original_position })), c.draw_salt);
    const proofsOk = rows.every(r => r.proof_hash === sha(`${c.draw_hash}|${r.member_id}|${r.original_position}`));
    const unique = new Set(rows.map(r => r.position)).size === rows.length && rows.every(r => r.position >= 1 && r.position <= rows.length);
    return { valid: recomputed === c.draw_hash && proofsOk && unique, revealed: true, commitment: c.draw_hash, recomputed, proofs_ok: proofsOk, positions_unique: unique, overrides, salt: c.draw_salt };
  }
  _contributors(cycleId) { return this.s.find('DrawResults', r => r.cycle_id === cycleId).map(r => r.member_id); }

  // ================= contributions =================
  dueDate(c, monthNo) { const ym = addMonths(c.start_month, monthNo - 1); return `${ym}-${String(Math.min(Number(this.config().due_day) || 1, 28)).padStart(2, '0')}`; }
  recordContribution(d, actor) {
    return this.s.transaction(() => {
      const c = this.cycle(Number(d.cycle_id));
      if (c.status !== 'active') throw new ConflictError('Cycle is not running');
      const memberId = Number(d.member_id);
      if (!this.s.one('DrawResults', r => r.cycle_id === c.id && r.member_id === memberId)) throw bad('Member is not part of this cycle');
      const month = Number(d.month_no || c.current_month);
      if (!Number.isInteger(month) || month < 1 || month > c.group_size) throw bad('Invalid month');
      if (this.s.one('Payouts', p => p.cycle_id === c.id && p.month_no === month)) throw new ConflictError('This month is already settled; contributions are closed');
      const status = d.status || 'paid';
      if (!['paid', 'pending', 'late'].includes(status)) throw bad('Invalid status');
      const method = d.method || 'cash';
      if (!METHODS.includes(method)) throw bad('Invalid method');
      const amount = d.amount === undefined || d.amount === '' ? c.amount : Number(d.amount);
      if (!(amount > 0) || !Number.isFinite(amount)) throw bad('Amount must be positive');
      if (status === 'paid' && amount !== c.amount) throw bad(`Contribution must equal ${c.amount} (partial payments are recorded as pending)`);
      if (d.client_ref) { const dup = this.s.one('Contributions', x => x.client_ref === d.client_ref); if (dup) return { ...dup, duplicate: true }; }
      const paidAt = status === 'paid' ? (d.paid_at || today()) : null;
      const pct = Number(this.config().late_penalty_pct) || 0;
      const penalty = status === 'paid' && pct > 0 && paidAt > this.dueDate(c, month) ? Math.round(amount * pct / 100) : 0;
      const existing = this.s.one('Contributions', x => x.cycle_id === c.id && x.member_id === memberId && x.month_no === month);
      let row;
      if (existing) {
        if (existing.status === 'paid') throw new ConflictError('Contribution already recorded as paid for this member and month');
        row = this.s.update('Contributions', existing.id, { amount: status === 'paid' ? amount : existing.amount, penalty, method, status, paid_at: paidAt, recorded_by: actor.id, client_ref: d.client_ref || existing.client_ref });
      } else {
        row = this.s.insert('Contributions', { cycle_id: c.id, member_id: memberId, month_no: month, amount, penalty, method, status, paid_at: paidAt, recorded_by: actor.id, client_ref: d.client_ref || null, created_at: now() });
      }
      const m = this.s.get('Members', memberId);
      this.audit(actor, 'contribution.record', 'Contributions', row.id, `${m.name}: month ${month} ${status} (${amount})`, existing || null, row);
      if (status === 'late') this.notify('late_contribution', [memberId], '', () => `Your contribution for month ${month} is late. Please pay ${c.amount} soon.`);
      return row;
    });
  }
  markLate(cycleId, monthNo, actor) {
    return this.s.transaction(() => {
      const c = this.cycle(cycleId);
      if (c.status !== 'active') throw new ConflictError('Cycle is not running');
      const out = [];
      for (const mid of this._contributors(cycleId)) {
        const ex = this.s.one('Contributions', x => x.cycle_id === cycleId && x.member_id === mid && x.month_no === monthNo);
        if (ex && ex.status === 'paid') continue;
        const row = ex ? this.s.update('Contributions', ex.id, { status: 'late' })
          : this.s.insert('Contributions', { cycle_id: cycleId, member_id: mid, month_no: monthNo, amount: c.amount, penalty: 0, method: 'cash', status: 'late', paid_at: null, recorded_by: actor.id, client_ref: null, created_at: now() });
        out.push(row.member_id);
      }
      this.audit(actor, 'contribution.mark_late', 'Cycles', cycleId, `Marked ${out.length} late for month ${monthNo}`, null, { members: out });
      if (out.length) this.notify('late_contribution', out, '', () => `Your contribution for month ${monthNo} is late. Please pay ${c.amount} soon.`);
      return { marked_late: out };
    });
  }
  monthStatus(cycleId, monthNo) {
    const c = this.cycle(cycleId);
    return this._contributors(cycleId).map(mid => {
      const m = this.s.get('Members', mid);
      const x = this.s.one('Contributions', r => r.cycle_id === cycleId && r.member_id === mid && r.month_no === monthNo);
      return { member_id: mid, name: m.name, member_code: m.member_code, status: x ? x.status : 'pending', amount: x ? x.amount : c.amount, method: x ? x.method : null, paid_at: x ? x.paid_at : null };
    });
  }
  listContributions(f) {
    return this.s.find('Contributions', x => (!f.cycle_id || x.cycle_id === Number(f.cycle_id)) && (!f.month_no || x.month_no === Number(f.month_no)) && (!f.member_id || x.member_id === Number(f.member_id)))
      .map(x => ({ ...x, member_name: (this.s.get('Members', x.member_id) || {}).name }));
  }

  // ================= payouts =================
  recordPayout(d, actor, idemKey) {
    return this.s.transaction(() => {
      if (idemKey) {
        const k = this.s.one('IdempotencyKeys', r => r.key === idemKey);
        if (k) return { ...this.s.get('Payouts', k.result_id), duplicate: true };
      }
      const c = this.cycle(Number(d.cycle_id));
      if (c.status !== 'active') throw new ConflictError('Cycle is not running');
      const month = Number(d.month_no || c.current_month);
      if (this.s.one('Payouts', p => p.cycle_id === c.id && p.month_no === month)) throw new ConflictError(`A payout for month ${month} has already been recorded`);
      if (month !== c.current_month) throw new ConflictError(`Payouts must be recorded in order; the current month is ${c.current_month}`);
      const dr = this.s.one('DrawResults', r => r.cycle_id === c.id && r.position === month);
      if (!dr) throw bad('No member holds this position');
      if (this.s.one('Payouts', p => p.cycle_id === c.id && p.position === dr.position)) throw new ConflictError(`Position ${dr.position} has already been paid`);
      const paid = this.s.find('Contributions', x => x.cycle_id === c.id && x.month_no === month && x.status === 'paid');
      const reason = String(d.override_reason || '').trim();
      if (paid.length < c.group_size) {
        if (reason.length < 5) throw new ConflictError(`Only ${paid.length} of ${c.group_size} contributions are paid. Collect the rest, or provide an override reason.`);
      }
      const method = d.method || this.config().payout_method;
      if (!METHODS.includes(method)) throw bad('Invalid method');
      const amount = paid.reduce((a, x) => a + x.amount, 0);
      const receipt = (d.receipt_no && String(d.receipt_no).trim()) || `RCPT-C${c.cycle_number}-M${String(month).padStart(2, '0')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
      const row = this.s.insert('Payouts', { cycle_id: c.id, member_id: dr.member_id, month_no: month, position: dr.position, amount, method, paid_at: d.paid_at || today(), receipt_no: receipt, recorded_by: actor.id, status: 'settled', note: reason || '' });
      if (idemKey) this.s.insert('IdempotencyKeys', { key: idemKey, result_id: row.id, created_at: now() });
      this.s.update('Cycles', c.id, { current_month: Math.min(month + 1, c.group_size + 1) });
      const m = this.s.get('Members', dr.member_id);
      this.audit(actor, reason ? 'payout.record_override' : 'payout.record', 'Payouts', row.id, `${m.name} received ${amount} for month ${month}${reason ? ' (override: ' + reason + ')' : ''}`, null, row);
      const label = monthLabel(addMonths(c.start_month, month - 1));
      this.announce({ title: `Payout confirmed – ${label}`, body: `${m.name} received ${amount} UGX for Month ${month} (${label}). Receipt ${receipt}.`, kind: 'auto' }, actor);
      this.notify('payout_confirmed', this._contributors(c.id), `${m.name} received ${amount} for Month ${month} (${label}). Receipt ${receipt}`);
      if (month < c.group_size) {
        const next = this.s.one('DrawResults', r => r.cycle_id === c.id && r.position === month + 1);
        this.notify('payout_reminder', this._contributors(c.id), `Reminder: month ${month + 1} contribution of ${c.amount} is due; ${this.s.get('Members', next.member_id).name} receives this month.`);
      }
      return row;
    });
  }
  listPayouts(f) {
    return this.s.find('Payouts', p => !f.cycle_id || p.cycle_id === Number(f.cycle_id)).sort((a, b) => a.cycle_id - b.cycle_id || a.month_no - b.month_no)
      .map(p => ({ ...p, member_name: (this.s.get('Members', p.member_id) || {}).name }));
  }
  reconcile(cycleId) {
    const contrib = this.s.find('Contributions', x => x.cycle_id === cycleId && x.status === 'paid').reduce((a, x) => a + x.amount, 0);
    const pay = this.s.find('Payouts', p => p.cycle_id === cycleId).reduce((a, p) => a + p.amount, 0);
    return { contributions: contrib, payouts: pay, balanced: contrib === pay, difference: contrib - pay };
  }
  closeCycle(cycleId, actor) {
    return this.s.transaction(() => {
      const c = this.cycle(cycleId);
      if (c.status !== 'active') throw new ConflictError('Only a running cycle can be closed');
      const n = this.s.count('Payouts', p => p.cycle_id === cycleId);
      if (n < c.group_size) throw new ConflictError(`${c.group_size - n} payout(s) still outstanding`);
      const rec = this.reconcile(cycleId);
      if (!rec.balanced) throw new ConflictError(`Contributions (${rec.contributions}) and payouts (${rec.payouts}) do not reconcile`);
      const upd = this.s.update('Cycles', cycleId, { status: 'closed', closed_at: now() });
      this.audit(actor, 'cycle.close', 'Cycles', cycleId, `Closed and archived Cycle ${c.cycle_number}`, { status: 'active' }, { status: 'closed', reconciliation: rec });
      this.announce({ title: `Cycle ${c.cycle_number} completed`, body: `All ${c.group_size} payouts are done. Total paid out: ${rec.payouts} UGX. Cycle archived.`, kind: 'auto' }, actor);
      return { cycle: this.publicCycle(upd), reconciliation: rec };
    });
  }

  // ================= notifications & announcements =================
  // msgOrFn: fixed message string OR per-member function. Persisted in the same transaction, sent after.
  notify(type, memberIds, msg, perMember) {
    const channel = this.config().notify_channel;
    const ids = [...new Set(memberIds)];
    for (const mid of ids) {
      const m = this.s.get('Members', mid); if (!m || m.status !== 'active' && type !== 'payout_confirmed') continue;
      const message = typeof perMember === 'function' ? perMember(mid) : msg;
      if (!message) continue;
      const row = this.s.insert('Notifications', { member_id: mid, type, channel, message, sent_at: now(), status: 'queued' });
      this.s.afterCommit(() => {
        Promise.resolve().then(() => this.notifier({ channel, to: channel === 'email' ? m.email : m.phone, message, type }))
          .then(r => this.s.update('Notifications', row.id, { status: (r && r.status) || 'sent' }))
          .catch(() => { try { this.s.update('Notifications', row.id, { status: 'failed' }); } catch (_) { /* ignore */ } });
      });
    }
  }
  announce(d, actor) {
    if (!String(d.title || '').trim() || !String(d.body || '').trim()) throw bad('Title and message are required');
    const row = this.s.insert('Announcements', { title: d.title.trim(), body: d.body.trim(), kind: d.kind || 'manual', created_by: actor ? actor.id : 0, created_at: now() });
    if (row.kind === 'manual') this.audit(actor, 'announcement.create', 'Announcements', row.id, `Posted: ${row.title}`, null, row);
    return row;
  }
  announcements() { return this.s.all('Announcements').reverse(); }
  activity(limit = 30) {
    const show = ['draw.confirm', 'draw.override', 'payout.record', 'payout.record_override', 'cycle.create', 'cycle.close', 'contribution.record', 'member.create'];
    return this.s.all('AuditLogs').filter(l => show.includes(l.action)).reverse().slice(0, limit).map(l => ({ at: l.timestamp, action: l.action, summary: l.summary }));
  }

  // ================= dashboard / reports =================
  dashboard(user) {
    const cfg = this.config();
    const c = this.currentCycle() || this.s.all('Cycles').sort((a, b) => b.cycle_number - a.cycle_number)[0] || null;
    const out = { group: cfg.group_name, currency: cfg.currency, me: this.publicMember(this.s.get('Members', user.id), true), cycle: null, announcements: this.announcements().slice(0, 5) };
    if (!c) return out;
    out.cycle = this.publicCycle(c);
    const revealed = c.status === 'active' || c.status === 'closed';
    out.cycle.revealed = revealed;
    if (!revealed) { out.pending_message = c.status === 'drawn' ? 'The draw has been generated and is awaiting confirmation by the treasurer.' : 'The draw for this cycle has not been held yet.'; return out; }
    const order = this.drawResults(c.id);
    const payouts = this.s.find('Payouts', p => p.cycle_id === c.id);
    out.order = order.map(r => ({ ...r, paid: payouts.some(p => p.position === r.position), is_current: c.status === 'active' && r.position === c.current_month, is_me: r.member_id === user.id }));
    const mine = order.find(r => r.member_id === user.id);
    out.my = mine ? { position: mine.position, payout_month: mine.payout_month, received: payouts.some(p => p.member_id === user.id), contributions: this.s.find('Contributions', x => x.cycle_id === c.id && x.member_id === user.id).sort((a, b) => a.month_no - b.month_no) } : null;
    if (c.status === 'active' && c.current_month <= c.group_size) {
      const cm = c.current_month;
      const status = this.monthStatus(c.id, cm);
      const rec = order.find(r => r.position === cm);
      out.current_month = { month_no: cm, label: monthLabel(addMonths(c.start_month, cm - 1)), due_date: this.dueDate(c, cm), recipient: { member_id: rec.member_id, name: rec.name }, expected: c.amount * c.group_size,
        collected: status.filter(s => s.status === 'paid').reduce((a, s) => a + s.amount, 0), paid_count: status.filter(s => s.status === 'paid').length, outstanding_count: status.filter(s => s.status !== 'paid').length, members: status,
        my_status: (status.find(s => s.member_id === user.id) || {}).status || null };
    }
    out.reconciliation = this.reconcile(c.id);
    return out;
  }

  report(type, f) {
    const cfg = this.config();
    const cur = cfg.currency;
    if (type === 'contribution-ledger') {
      const rows = this.listContributions(f).sort((a, b) => a.cycle_id - b.cycle_id || a.month_no - b.month_no || a.member_id - b.member_id);
      return { title: 'Contribution Ledger', head: ['Cycle', 'Month', 'Member', 'Amount', 'Penalty', 'Method', 'Status', 'Paid at'], rows: rows.map(x => [this.s.get('Cycles', x.cycle_id).cycle_number, x.month_no, x.member_name, x.amount, x.penalty, x.method, x.status, x.paid_at || '']) };
    }
    if (type === 'payout-ledger') {
      const rows = this.listPayouts(f);
      return { title: 'Payout Ledger', head: ['Cycle', 'Month', 'Position', 'Recipient', 'Amount', 'Method', 'Paid at', 'Receipt', 'Status'], rows: rows.map(p => [this.s.get('Cycles', p.cycle_id).cycle_number, p.month_no, p.position, p.member_name, p.amount, p.method, p.paid_at, p.receipt_no, p.status]) };
    }
    if (type === 'cycle-summary') {
      const c = this.cycle(Number(f.cycle_id));
      const rows = this.drawResults(c.id).map(r => {
        const contrib = this.s.find('Contributions', x => x.cycle_id === c.id && x.member_id === r.member_id && x.status === 'paid').reduce((a, x) => a + x.amount, 0);
        const p = this.s.one('Payouts', x => x.cycle_id === c.id && x.member_id === r.member_id);
        return [r.position, r.name, r.payout_month, contrib, p ? p.amount : 0, p ? p.paid_at : 'pending'];
      });
      const rec = this.reconcile(c.id);
      rows.push(['', 'TOTAL', '', rec.contributions, rec.payouts, rec.balanced ? 'Reconciled' : `Difference ${rec.difference}`]);
      return { title: `Cycle ${c.cycle_number} Summary (${c.status})`, head: ['Position', 'Member', 'Payout month', `Contributed (${cur})`, `Received (${cur})`, 'Paid on'], rows };
    }
    if (type === 'member-statement') {
      const h = this.memberHistory(Number(f.member_id));
      const rows = [];
      for (const c of h.cycles) {
        for (const x of c.contributions) rows.push([c.cycle_number, 'Contribution', `Month ${x.month_no}`, x.amount, x.status, x.paid_at || '']);
        if (c.payout) rows.push([c.cycle_number, 'Payout', `Month ${c.payout.month_no}`, c.payout.amount, c.payout.status, c.payout.paid_at]);
      }
      return { title: `Statement – ${h.member.name}`, head: ['Cycle', 'Type', 'Month', `Amount (${cur})`, 'Status', 'Date'], rows };
    }
    if (type === 'audit') {
      return { title: 'Audit Trail', head: ['#', 'When', 'Actor', 'Action', 'Summary'], rows: this.s.all('AuditLogs').map(l => [l.id, l.timestamp, l.actor_id, l.action, l.summary]) };
    }
    throw new HttpError(404, 'Unknown report');
  }
}

module.exports = { Service, HttpError, hashPassword, verifyPassword, addMonths, monthLabel, sha, METHODS };
