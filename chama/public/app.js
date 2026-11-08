'use strict';
// Cash Round – single-page client. All user-supplied text goes through esc() before being placed in HTML.
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => Number(n || 0).toLocaleString('en-UG');
const safe = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }, del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } } };

let token = safe.get('token'), me = null, view = 'home', cache = {};
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());

function toast(msg, err) { const t = $('#toast'); t.textContent = msg; t.className = 'show' + (err ? ' err' : ''); clearTimeout(toast.t); toast.t = setTimeout(() => { t.className = ''; }, 3500); }

async function api(method, path, body, extraHeaders) {
  const res = await fetch('/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...extraHeaders }, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch { /* non-json */ }
  if (res.status === 401 && token) { logout(true); throw new Error('Session expired'); }
  if (!res.ok) throw new Error((data && data.error) || 'Request failed');
  return data;
}
async function download(path, name) {
  const res = await fetch('/api' + path, { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) return toast('Download failed', true);
  const url = URL.createObjectURL(await res.blob()); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
}
const act = async (fn, ok) => { try { const r = await fn(); if (ok) toast(ok); return r; } catch (e) { toast(e.message, true); } };

function logout(silent) { token = null; me = null; safe.del('token'); render(); if (!silent) toast('Signed out'); }

// ---------- offline queue for contributions ----------
const queue = () => { try { return JSON.parse(safe.get('queue') || '[]'); } catch { return []; } };
const saveQueue = q => safe.set('queue', JSON.stringify(q));
async function syncQueue() {
  const q = queue(); if (!q.length || !token) return;
  const left = [];
  for (const item of q) { try { await api('POST', '/contributions', item); } catch (e) { if (/Failed to fetch|NetworkError|Load failed/i.test(e.message)) left.push(item); else if (!/already/i.test(e.message)) { toast('Sync skipped: ' + e.message, true); } } }
  saveQueue(left);
  if (left.length < q.length) { toast(`Synced ${q.length - left.length} offline entr${q.length - left.length > 1 ? 'ies' : 'y'}`); if (view === 'record') render(); }
}
window.addEventListener('online', syncQueue);

// ---------- shell ----------
const isStaff = () => me && me.role !== 'member';
const isAdmin = () => me && me.role === 'admin';
function tabs() {
  const t = [['home', 'Home'], ['order', 'Order'], ['notices', 'Notices']];
  if (isAdmin()) t.splice(1, 0, ['record', 'Record'], ['cycle', 'Cycle'], ['members', 'Members']);
  t.push(['reports', 'Reports']);
  if (isStaff()) t.push(['audit', 'Audit']);
  return t;
}
function shell(inner) {
  return `<div class="top"><div class="brand"><div class="logo">₵</div><div><h1>${esc(cache.group || 'Cash Round')}</h1><div class="mute small">${esc(me.name)} · ${esc(me.role)}</div></div></div>
  <button class="btn" onclick="logout()">Sign out</button></div>
  <nav class="nav">${tabs().map(([k, l]) => `<button class="${view === k ? 'on' : ''}" onclick="go('${k}')">${l}</button>`).join('')}</nav>${inner}`;
}
window.go = v => { view = v; render(); window.scrollTo(0, 0); };
window.logout = logout;

async function render() {
  const app = $('#app');
  if (!token) return (app.innerHTML = loginView());
  try {
    if (!me) me = await api('GET', '/auth/me');
    const fn = views[view] || views.home;
    app.innerHTML = shell('<div class="glass mute">Loading…</div>');
    app.innerHTML = shell(await fn());
    bind();
  } catch (e) { if (token) { app.innerHTML = shell(`<div class="glass">${esc(e.message)}</div>`); } }
}

function loginView() {
  return `<form class="glass login" id="login"><div class="brand" style="margin-bottom:14px"><div class="logo">₵</div><div><h1>Cash Round</h1><div class="mute small">Rotation savings group</div></div></div>
  <label for="lid">Email, phone or member code</label><input id="lid" autocomplete="username" required>
  <label for="lpw">Password</label><input id="lpw" type="password" autocomplete="current-password" required>
  <div class="actions"><button class="btn pri" style="width:100%">Sign in</button></div></form>`;
}
document.addEventListener('submit', async e => {
  if (e.target.getAttribute('id') !== 'login') return;
  e.preventDefault();
  const r = await act(() => api('POST', '/auth/login', { identifier: $('#lid').value, password: $('#lpw').value }));
  if (r) { token = r.token; safe.set('token', token); me = r.user; view = 'home'; syncQueue(); render(); }
});

const chip = (s) => `<span class="chip ${({ paid: 'ok', settled: 'ok', active: 'ok', closed: 'acc', late: 'bad', pending: 'warn', drawn: 'warn', draft: 'warn', inactive: 'bad' })[s] || ''}">${esc(s)}</span>`;
const opts = (list, sel) => list.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(sel) ? ' selected' : ''}>${esc(l)}</option>`).join('');
const methodOpts = sel => opts([['cash', 'Cash'], ['mobile_money', 'Mobile money'], ['bank', 'Bank']], sel);

// ---------- views ----------
const views = {};

views.home = async () => {
  const d = await api('GET', '/dashboard'); cache.group = d.group;
  const c = d.cycle;
  let h = '';
  if (!c) return '<div class="glass">No cycle yet.</div>';
  h += `<div class="glass hero"><div><div class="mute small">Cycle ${c.cycle_number} · ${esc(c.start_label)} – ${esc(c.end_label)}</div>
    ${d.my ? `<div class="big">#${d.my.position}</div><div>Your payout month: <b>${esc(d.my.payout_month)}</b> ${d.my.received ? chip('settled') : ''}</div>` : `<div class="big" style="font-size:26px">${d.cycle.revealed ? 'Not in this cycle' : 'Awaiting draw'}</div>`}</div>
    <div style="margin-left:auto">${chip(c.status)}</div></div>`;
  if (!c.revealed) return h + `<div class="glass"><h2>Draw not published yet</h2><p class="mute">${esc(d.pending_message || '')}</p>${c.draw_hash ? `<p class="small mute">Commitment hash (published before reveal):</p><div class="mono small">${esc(c.draw_hash)}</div>` : ''}</div>`;
  const cm = d.current_month;
  if (cm) {
    const pct = Math.round(cm.collected / cm.expected * 100);
    h += `<div class="glass"><h2>This month: ${esc(cm.label)}</h2>
      <div class="stat"><div><span class="mute small">Receives</span><b>${esc(cm.recipient.name)}</b></div><div><span class="mute small">Collected</span><b>${money(cm.collected)}</b></div><div><span class="mute small">Due by</span><b>${esc(cm.due_date)}</b></div></div>
      <div class="bar" style="margin:12px 0 6px"><i style="width:${pct}%"></i></div>
      <div class="small mute">${cm.paid_count} paid · ${cm.outstanding_count} outstanding · your status: ${cm.my_status ? chip(cm.my_status) : '—'}</div>
      <h3>Contribution status</h3>${cm.members.map(m => `<div class="row"><div class="grow">${esc(m.name)}</div>${chip(m.status)}</div>`).join('')}</div>`;
  }
  h += `<div class="glass"><h2>Latest announcements</h2>${d.announcements.map(a => `<div class="row"><div class="grow"><b>${esc(a.title)}</b><div class="small mute">${esc(a.body)}</div></div></div>`).join('') || '<span class="mute">None</span>'}</div>`;
  return h;
};

views.order = async () => {
  const d = await api('GET', '/dashboard'); cache.group = d.group;
  if (!d.order) return '<div class="glass"><h2>Payout order</h2><p class="mute">Order is published once the draw is confirmed.</p></div>';
  const v = await api('GET', `/cycles/${d.cycle.id}/draw/verify`);
  return `<div class="glass"><h2>Cycle ${d.cycle.cycle_number} payout schedule</h2>
    ${d.order.map(o => `<div class="row ${o.is_current ? 'cur' : ''} ${o.is_me ? 'me' : ''} ${o.paid ? 'done' : ''}"><div class="pos">${o.position}</div><div class="grow"><b>${esc(o.name)}</b>${o.is_me ? ' <span class="chip acc">you</span>' : ''}<div class="small mute">${esc(o.payout_month)}</div></div>${o.paid ? chip('settled') : o.is_current ? chip('active') : ''}</div>`).join('')}</div>
    <div class="glass"><h2>Draw proof</h2><p class="small mute">Anyone can recompute this hash from the final order and the revealed salt.</p>
    <div>Status: ${v.valid ? '<span class="chip ok">verified</span>' : '<span class="chip bad">MISMATCH</span>'}${v.overrides && v.overrides.length ? ` <span class="chip warn">${v.overrides.length} override(s)</span>` : ''}</div>
    <h3>Commitment</h3><div class="mono small">${esc(v.commitment)}</div>
    ${v.salt ? `<h3>Salt</h3><div class="mono small">${esc(v.salt)}</div>` : ''}
    ${(v.overrides || []).map(o => `<div class="small" style="margin-top:8px">⚠ ${esc(o.at.slice(0, 10))}: ${esc(o.reason)}</div>`).join('')}</div>`;
};

views.record = async () => {
  const [d, members] = await Promise.all([api('GET', '/dashboard'), api('GET', '/members')]);
  cache.group = d.group;
  const c = d.cycle; const q = queue(); if (c) cache.cycleId = c.id;
  if (!c || c.status !== 'active' || !d.current_month) return '<div class="glass"><h2>Record</h2><p class="mute">There is no running cycle. Open the Cycle tab to run the draw.</p></div>';
  const cm = d.current_month;
  const unpaid = cm.members.filter(m => m.status !== 'paid');
  return `${q.length ? `<div class="glass"><span class="chip warn">${q.length} offline entr${q.length > 1 ? 'ies' : 'y'} waiting</span> <button class="btn" onclick="syncNow()">Sync now</button></div>` : ''}
  <div class="glass"><h2>Record contribution · Month ${cm.month_no}</h2>
  <form id="fc" class="frm"><div><label>Member</label><select name="member_id">${opts(unpaid.map(m => [m.member_id, m.name]))}</select></div>
  <div><label>Amount</label><input name="amount" type="number" value="${c.amount}" min="1"></div>
  <div><label>Method</label><select name="method">${methodOpts('cash')}</select></div>
  <div><label>Date paid</label><input name="paid_at" type="date" value="${new Date().toISOString().slice(0, 10)}"></div></form>
  <div class="actions"><button class="btn pri" onclick="saveContribution()" ${unpaid.length ? '' : 'disabled'}>Save contribution</button><button class="btn" onclick="markLate()">Mark outstanding as late</button></div>
  <h3>Month status (${cm.paid_count}/${c.group_size} paid)</h3>${cm.members.map(m => `<div class="row"><div class="grow">${esc(m.name)}</div>${chip(m.status)}</div>`).join('')}</div>
  <div class="glass"><h2>Record payout · ${esc(cm.label)}</h2>
  <p>Recipient: <b>${esc(cm.recipient.name)}</b> · Amount: <b>${money(cm.collected)}</b> ${esc(d.currency)}</p>
  <form id="fp" class="frm"><div><label>Method</label><select name="method">${methodOpts('mobile_money')}</select></div><div><label>Receipt no. (optional)</label><input name="receipt_no" placeholder="auto-generated"></div>
  ${cm.outstanding_count ? `<div style="grid-column:1/-1"><label>Override reason (needed because ${cm.outstanding_count} contribution(s) are outstanding)</label><input name="override_reason" placeholder="e.g. group agreed to pay early"></div>` : ''}</form>
  <div class="actions"><button class="btn pri" onclick="savePayout()">Confirm payout</button></div></div>`;
};
let payoutKey = null;
window.syncNow = async () => { await syncQueue(); render(); };
window.saveContribution = async () => {
  const f = Object.fromEntries(new FormData($('#fc')));
  const body = { cycle_id: cache.cycleId, member_id: Number(f.member_id), amount: Number(f.amount), method: f.method, paid_at: f.paid_at, client_ref: uid() };
  try { await api('POST', '/contributions', body); toast('Contribution saved'); render(); }
  catch (e) {
    if (/Failed to fetch|NetworkError|Load failed/i.test(e.message)) { const q = queue(); q.push(body); saveQueue(q); toast('Offline: saved on this device, will sync automatically'); render(); }
    else toast(e.message, true);
  }
};
window.markLate = async () => { const d = await api('GET', '/dashboard'); if (!confirm('Mark all outstanding members as late and notify them?')) return; if (await act(() => api('POST', `/cycles/${d.cycle.id}/months/${d.current_month.month_no}/mark-late`), 'Marked as late')) render(); };
window.savePayout = async () => {
  const f = Object.fromEntries(new FormData($('#fp'))); const d = await api('GET', '/dashboard');
  if (!confirm('Confirm payout? This cannot be undone.')) return;
  payoutKey = payoutKey || uid(); // same key on retry => no double payout
  const r = await act(() => api('POST', '/payouts', { cycle_id: d.cycle.id, ...f }, { 'Idempotency-Key': payoutKey }));
  if (r) { payoutKey = null; toast(`Payout recorded · ${r.receipt_no}`); render(); } else if (!navigator.onLine === false) payoutKey = null;
};

views.cycle = async () => {
  const [cycles, members] = await Promise.all([api('GET', '/cycles'), api('GET', '/members')]);
  const cur = cycles.find(c => c.status !== 'closed');
  let h = '';
  if (cur) {
    const det = await api('GET', `/cycles/${cur.id}`);
    h += `<div class="glass"><div class="top" style="margin:0"><h2>Cycle ${cur.cycle_number} ${chip(cur.status)}</h2><span class="small mute">${esc(cur.start_label)} – ${esc(cur.end_label)}</span></div>
      <p class="small mute">${cur.status === 'draft' ? 'Run the random draw. Results stay hidden from members and only a commitment hash is published until you confirm.' : cur.status === 'drawn' ? 'Review the draw, then confirm to lock it and notify everyone. You may redraw until confirmed.' : 'Draw is locked.'}</p>`;
    if (det.commitment) h += `<h3>Commitment hash</h3><div class="mono small">${esc(det.commitment)}</div>`;
    if (det.results.length) h += `<h3>Positions</h3>${det.results.map(r => `<div class="row"><div class="pos">${r.position}</div><div class="grow">${esc(r.name)}<div class="small mute">${esc(r.payout_month)}</div></div></div>`).join('')}`;
    h += '<div class="actions">';
    if (cur.status === 'draft') h += `<button class="btn pri" onclick="runDraw(${cur.id})">🎲 Run random draw (${cur.group_size} members)</button>`;
    if (cur.status === 'drawn') h += `<button class="btn" onclick="runDraw(${cur.id})">Redraw</button><button class="btn pri" onclick="confirmDraw(${cur.id})">Confirm &amp; lock draw</button>`;
    if (cur.status === 'active') h += `<button class="btn" onclick="closeCycle(${cur.id})">Close &amp; archive cycle</button>`;
    h += '</div></div>';
    if (cur.status === 'active') {
      h += `<div class="glass"><h2>Override (swap two positions)</h2><p class="small mute">Allowed only for positions not yet paid. A reason is mandatory and is recorded in the audit trail and announced.</p>
      <form id="fo" class="frm"><div><label>Member A</label><select name="member_a">${opts(det.results.map(r => [r.member_id, `#${r.position} ${r.name}`]))}</select></div>
      <div><label>Member B</label><select name="member_b">${opts(det.results.map(r => [r.member_id, `#${r.position} ${r.name}`]), det.results[1] && det.results[1].member_id)}</select></div>
      <div style="grid-column:1/-1"><label>Reason (required)</label><input name="reason" required minlength="5"></div></form>
      <div class="actions"><button class="btn dng" onclick="override(${cur.id})">Apply override</button></div></div>`;
    }
  } else {
    h += `<div class="glass"><h2>No open cycle</h2><p class="mute">Cycle ${Math.max(...cycles.map(c => c.cycle_number), 0) + 1} will use all active members and the current contribution amount.</p>
      <form id="fn" class="frm"><div><label>Start month</label><input name="start_month" type="month"></div></form>
      <div class="actions"><button class="btn pri" onclick="newCycle()">Create next cycle</button></div></div>`;
  }
  h += `<div class="glass"><h2>All cycles</h2>${cycles.map(c => `<div class="row"><div class="grow"><b>Cycle ${c.cycle_number}</b><div class="small mute">${esc(c.start_label)} – ${esc(c.end_label)} · ${c.group_size} members · ${money(c.amount)} each</div></div>${chip(c.status)}</div>`).join('')}</div>`;
  return h;
};
window.runDraw = async id => { if (await act(() => api('POST', `/cycles/${id}/draw`), 'Draw generated – review before confirming')) render(); };
window.confirmDraw = async id => { if (!confirm('Lock the draw and notify all members? This cannot be redrawn afterwards.')) return; if (await act(() => api('POST', `/cycles/${id}/draw/confirm`), 'Draw locked and members notified')) render(); };
window.closeCycle = async id => { if (!confirm('Close and archive this cycle?')) return; if (await act(() => api('POST', `/cycles/${id}/close`), 'Cycle closed and archived')) render(); };
window.newCycle = async () => { const f = Object.fromEntries(new FormData($('#fn'))); if (await act(() => api('POST', '/cycles', f.start_month ? f : {}), 'Cycle created')) render(); };
window.override = async id => { const f = Object.fromEntries(new FormData($('#fo'))); if (await act(() => api('POST', `/cycles/${id}/draw/override`, f), 'Override applied and logged')) render(); };

views.members = async () => {
  const list = await api('GET', '/members');
  return `<div class="glass"><h2>Members</h2>${list.map(m => `<div class="row"><div class="pos">${esc(m.member_code.slice(-2))}</div><div class="grow"><b>${esc(m.name)}</b> <span class="small mute">${esc(m.role)}${m.participates ? '' : ' · not in rotation'}</span><div class="small mute">${esc(m.phone)} · ${esc(m.email)}</div></div>${chip(m.status)}
    <button class="btn" onclick="toggleMember(${m.id},'${m.status === 'active' ? 'deactivate' : 'activate'}')">${m.status === 'active' ? 'Deactivate' : 'Activate'}</button></div>`).join('')}</div>
  <div class="glass"><h2>Register member</h2><form id="fm" class="frm"><div><label>Full name</label><input name="name" required></div><div><label>Phone</label><input name="phone" inputmode="tel"></div><div><label>Email</label><input name="email" type="email"></div>
  <div><label>Role</label><select name="role">${opts([['member', 'Member'], ['admin', 'Admin / Treasurer'], ['auditor', 'Auditor (read-only)']])}</select></div><div><label>Temporary password</label><input name="password" minlength="8" placeholder="min 8 characters"></div></form>
  <p class="small mute">Policy: members added during a running cycle join the next cycle's draw.</p><div class="actions"><button class="btn pri" onclick="addMember()">Register</button></div></div>`;
};
window.toggleMember = async (id, a) => { if (await act(() => api('POST', `/members/${id}/${a}`), 'Updated')) render(); };
window.addMember = async () => {
  const f = Object.fromEntries(new FormData($('#fm'))); if (!f.password) delete f.password; if (f.role === 'auditor') f.participates = false;
  const r = await act(() => api('POST', '/members', f)); if (r) { toast(r.joins_next_cycle ? 'Registered – joins next cycle' : 'Member registered'); render(); }
};

views.notices = async () => {
  const [ann, act_] = await Promise.all([api('GET', '/announcements'), api('GET', '/activity')]);
  return `${isAdmin() ? `<div class="glass"><h2>Post announcement</h2><form id="fa"><label>Title</label><input name="title" required><label>Message</label><textarea name="body" rows="3" required></textarea></form><div class="actions"><button class="btn pri" onclick="postAnn()">Post</button></div></div>` : ''}
  <div class="glass"><h2>Announcement board</h2>${ann.map(a => `<div class="row"><div class="grow"><b>${esc(a.title)}</b><div class="small mute">${esc(a.body)}</div><div class="small mute">${esc(a.created_at.slice(0, 10))}</div></div></div>`).join('') || '<span class="mute">Nothing yet</span>'}</div>
  <div class="glass"><h2>Activity feed</h2>${act_.map(a => `<div class="row"><div class="grow small">${esc(a.summary)}<div class="mute">${esc(a.at.replace('T', ' ').slice(0, 16))}</div></div></div>`).join('')}</div>`;
};
window.postAnn = async () => { const f = Object.fromEntries(new FormData($('#fa'))); if (await act(() => api('POST', '/announcements', f), 'Posted')) render(); };

views.reports = async () => {
  const [cycles, members] = await Promise.all([api('GET', '/cycles'), api('GET', '/members')]);
  const btn = (t, q, n) => `<button class="btn" onclick="dl('${t}','${q}','csv')">CSV</button> <button class="btn" onclick="dl('${t}','${q}','pdf')">PDF</button>`;
  const cyc = `<select id="rc">${opts(cycles.map(c => [c.id, 'Cycle ' + c.cycle_number]), (cycles.find(c => c.status === 'active') || cycles[0] || {}).id)}</select>`;
  const rows = [['cycle-summary', 'Cycle summary', 'Per-member totals and reconciliation'], ['payout-ledger', 'Payout ledger', 'Every payout with receipt'], ['member-statement', 'My statement', 'Your contributions and payouts']];
  if (isStaff()) rows.splice(1, 0, ['contribution-ledger', 'Contribution ledger', 'All contributions']);
  return `<div class="glass"><h2>Reports</h2><label>Cycle</label>${cyc}
  ${rows.map(([t, n, d]) => `<div class="row"><div class="grow"><b>${n}</b><div class="small mute">${d}</div></div>${btn(t)}</div>`).join('')}
  ${isStaff() ? `<h3>Member statement</h3><div class="row"><select id="rm">${opts(members.map(m => [m.id, m.name]))}</select><button class="btn" onclick="dl('member-statement','m','csv')">CSV</button><button class="btn" onclick="dl('member-statement','m','pdf')">PDF</button></div>
  <div class="row"><div class="grow"><b>Audit trail</b></div><button class="btn" onclick="dl('audit','','csv')">CSV</button><button class="btn" onclick="dl('audit','','pdf')">PDF</button></div>` : ''}</div>`;
};
window.dl = (type, q, fmt) => {
  const cid = $('#rc') && $('#rc').value; let qs = `format=${fmt}&cycle_id=${cid}`;
  if (q === 'm' && $('#rm')) qs += `&member_id=${$('#rm').value}`; else if (type === 'member-statement') qs += `&member_id=${me.id}`;
  download(`/reports/${type}?${qs}`, `${type}.${fmt}`);
};

views.audit = async () => {
  const [log, v] = await Promise.all([api('GET', '/audit'), api('GET', '/audit/verify')]);
  return `<div class="glass"><div class="top" style="margin:0"><h2>Audit trail</h2>${v.valid ? `<span class="chip ok">chain intact · ${v.entries} entries</span>` : `<span class="chip bad">TAMPERING at entry ${v.broken_at}</span>`}</div>
  <p class="small mute">Head hash: <span class="mono">${esc(v.head || '')}</span></p><div class="tw"><table><tr><th>#</th><th>When</th><th>Actor</th><th>Action</th><th>Details</th></tr>
  ${log.map(l => `<tr><td>${l.id}</td><td>${esc(l.timestamp.replace('T', ' ').slice(0, 16))}</td><td>${l.actor_id}</td><td>${esc(l.action)}</td><td>${esc(l.summary)}</td></tr>`).join('')}</table></div></div>`;
};

function bind() { /* inline handlers are used; nothing else to bind */ }
render();
if (token) syncQueue();
