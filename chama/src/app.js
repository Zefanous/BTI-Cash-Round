'use strict';
const express = require('express');
const path = require('path');
const PDFDocument = require('pdfkit');
const { Service, HttpError, verifyPassword } = require('./service');
const { sign, verify } = require('./auth');
const { toCsv } = require('./backends');

function createApp(store, { secret = process.env.JWT_SECRET, notifier, loginLimit = 10 } = {}) {
  if (!secret) throw new Error('JWT_SECRET is required');
  const svc = new Service(store, { notifier });
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cache-Control': req.path.startsWith('/api') ? 'no-store' : 'no-cache' });
    next();
  });

  const wrap = fn => (req, res, next) => { try { const r = fn(req, res); if (r && r.then) r.then(null, next); } catch (e) { next(e); } };
  const auth = (...roles) => (req, res, next) => {
    const h = req.get('authorization') || '';
    const p = verify(h.startsWith('Bearer ') ? h.slice(7) : req.query.token, secret);
    if (!p) return res.status(401).json({ error: 'Sign in required' });
    const u = store.get('Members', p.sub);
    if (!u || u.status !== 'active') return res.status(401).json({ error: 'Account inactive' });
    if (roles.length && !roles.includes(u.role)) return res.status(403).json({ error: 'You do not have permission for this action' });
    req.user = u; next();
  };
  const ADMIN = 'admin', AUD = 'auditor', ANY = [];

  // ---- login with simple in-memory throttling ----
  const attempts = new Map();
  app.post('/api/auth/login', wrap((req, res) => {
    const id = String(req.body.identifier || '').trim().toLowerCase();
    const a = attempts.get(id) || { n: 0, t: Date.now() };
    if (Date.now() - a.t > 15 * 60e3) { a.n = 0; a.t = Date.now(); }
    if (a.n >= loginLimit) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    const norm = s => String(s || '').replace(/[\s-]/g, '').toLowerCase();
    const u = store.one('Members', m => m.status === 'active' && (m.email === id || norm(m.phone) === norm(id) || m.member_code.toLowerCase() === id));
    if (!u || !verifyPassword(String(req.body.password || ''), u.password_hash)) { a.n++; attempts.set(id, a); return res.status(401).json({ error: 'Invalid credentials' }); }
    attempts.delete(id);
    res.json({ token: sign({ sub: u.id, role: u.role }, secret), user: svc.publicMember(u, true) });
  }));
  app.get('/api/auth/me', auth(), wrap((req, res) => res.json(svc.publicMember(req.user, true))));
  app.post('/api/auth/change-password', auth(), wrap((req, res) => {
    const { current, next } = req.body;
    if (!verifyPassword(String(current || ''), req.user.password_hash)) throw new HttpError(400, 'Current password is incorrect');
    if (String(next || '').length < 8) throw new HttpError(400, 'New password must be at least 8 characters');
    svc.updateMember(req.user.id, { password: next }, req.user);
    res.json({ ok: true });
  }));

  // ---- config ----
  app.get('/api/config', auth(), wrap((req, res) => res.json(svc.config())));
  app.put('/api/config', auth(ADMIN), wrap((req, res) => res.json(svc.setConfig(req.body, req.user))));

  // ---- members ----
  app.get('/api/members', auth(), wrap((req, res) => res.json(svc.listMembers(req.user.role !== 'member'))));
  app.post('/api/members', auth(ADMIN), wrap((req, res) => res.status(201).json(svc.createMember(req.body, req.user))));
  app.put('/api/members/:id', auth(ADMIN), wrap((req, res) => res.json(svc.updateMember(Number(req.params.id), req.body, req.user))));
  app.post('/api/members/:id/deactivate', auth(ADMIN), wrap((req, res) => res.json(svc.setMemberStatus(Number(req.params.id), 'inactive', req.user))));
  app.post('/api/members/:id/activate', auth(ADMIN), wrap((req, res) => res.json(svc.setMemberStatus(Number(req.params.id), 'active', req.user))));
  app.get('/api/members/:id/history', auth(), wrap((req, res) => {
    const id = Number(req.params.id);
    if (req.user.role === 'member' && req.user.id !== id) throw new HttpError(403, 'You can only view your own history');
    res.json(svc.memberHistory(id));
  }));

  // ---- cycles & draw ----
  const cid = req => Number(req.params.id);
  app.get('/api/cycles', auth(), wrap((req, res) => res.json(svc.listCycles())));
  app.post('/api/cycles', auth(ADMIN), wrap((req, res) => res.status(201).json(svc.createCycle(req.body || {}, req.user))));
  app.get('/api/cycles/:id', auth(), wrap((req, res) => {
    const c = svc.cycle(cid(req));
    const revealed = c.status === 'active' || c.status === 'closed';
    const staff = req.user.role !== 'member';
    res.json({ cycle: svc.publicCycle(c), results: revealed || (staff && c.status === 'drawn') ? svc.drawResults(c.id) : [], locked: revealed, commitment: c.draw_hash });
  }));
  app.post('/api/cycles/:id/draw', auth(ADMIN), wrap((req, res) => res.json(svc.runDraw(cid(req), req.user))));
  app.post('/api/cycles/:id/draw/confirm', auth(ADMIN), wrap((req, res) => res.json(svc.confirmDraw(cid(req), req.user))));
  app.post('/api/cycles/:id/draw/override', auth(ADMIN), wrap((req, res) => res.json(svc.overrideDraw(cid(req), req.body, req.user))));
  app.get('/api/cycles/:id/draw/verify', auth(), wrap((req, res) => res.json(svc.verifyDraw(cid(req)))));
  app.post('/api/cycles/:id/close', auth(ADMIN), wrap((req, res) => res.json(svc.closeCycle(cid(req), req.user))));
  app.post('/api/cycles/:id/months/:n/mark-late', auth(ADMIN), wrap((req, res) => res.json(svc.markLate(cid(req), Number(req.params.n), req.user))));
  app.get('/api/cycles/:id/months/:n', auth(), wrap((req, res) => res.json(svc.monthStatus(cid(req), Number(req.params.n)))));
  app.get('/api/cycles/:id/reconciliation', auth(), wrap((req, res) => res.json(svc.reconcile(cid(req)))));

  // ---- contributions & payouts ----
  app.get('/api/contributions', auth(), wrap((req, res) => {
    const f = { ...req.query };
    if (req.user.role === 'member') f.member_id = req.user.id;
    res.json(svc.listContributions(f));
  }));
  app.post('/api/contributions', auth(ADMIN), wrap((req, res) => {
    const r = svc.recordContribution(req.body, req.user);
    res.status(r.duplicate ? 200 : 201).json(r);
  }));
  app.get('/api/payouts', auth(), wrap((req, res) => res.json(svc.listPayouts(req.query))));
  app.post('/api/payouts', auth(ADMIN), wrap((req, res) => {
    const key = req.get('idempotency-key') || req.body.idempotency_key;
    const r = svc.recordPayout(req.body, req.user, key);
    res.status(r.duplicate ? 200 : 201).json(r);
  }));

  // ---- dashboard, announcements, activity ----
  app.get('/api/dashboard', auth(), wrap((req, res) => res.json(svc.dashboard(req.user))));
  app.get('/api/announcements', auth(), wrap((req, res) => res.json(svc.announcements())));
  app.post('/api/announcements', auth(ADMIN), wrap((req, res) => res.status(201).json(svc.announce(req.body, req.user))));
  app.get('/api/activity', auth(), wrap((req, res) => res.json(svc.activity())));
  app.get('/api/notifications', auth(ADMIN, AUD), wrap((req, res) => res.json(store.all('Notifications').reverse().slice(0, 200))));

  // ---- audit ----
  app.get('/api/audit', auth(ADMIN, AUD), wrap((req, res) => res.json(store.all('AuditLogs').reverse().slice(0, 500))));
  app.get('/api/audit/verify', auth(ADMIN, AUD), wrap((req, res) => res.json(svc.verifyAudit())));

  // ---- reports (json / csv / pdf) ----
  app.get('/api/reports/:type', auth(), wrap((req, res) => {
    const { type } = req.params;
    const f = { ...req.query };
    if (req.user.role === 'member') {
      if (!['member-statement', 'cycle-summary', 'payout-ledger'].includes(type)) throw new HttpError(403, 'Not available for members');
      if (type === 'member-statement') f.member_id = req.user.id;
    }
    if (type === 'audit' && req.user.role === 'member') throw new HttpError(403, 'Not available for members');
    const rep = svc.report(type, f);
    const fmt = req.query.format || 'json';
    const fname = `${type}-${new Date().toISOString().slice(0, 10)}`;
    if (fmt === 'csv') {
      res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${fname}.csv"` });
      return res.send('﻿' + toCsv([rep.head, ...rep.rows.map(r => r.map(c => String(c ?? '')))]));
    }
    if (fmt === 'pdf') {
      res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${fname}.pdf"` });
      const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape' });
      doc.pipe(res);
      doc.fontSize(16).text(svc.config().group_name, { continued: false });
      doc.fontSize(12).text(rep.title).fontSize(8).fillColor('#666').text(`Generated ${new Date().toISOString()}`).fillColor('#000').moveDown();
      const w = (doc.page.width - 80) / rep.head.length;
      const row = (cells, bold) => {
        if (doc.y > doc.page.height - 60) doc.addPage();
        const y = doc.y; doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
        cells.forEach((c, i) => doc.text(String(c ?? ''), 40 + i * w, y, { width: w - 4, height: 12, ellipsis: true, lineBreak: false }));
        doc.y = y + 14;
        doc.moveTo(40, doc.y - 2).lineTo(doc.page.width - 40, doc.y - 2).strokeColor('#ddd').stroke();
      };
      row(rep.head, true); rep.rows.forEach(r => row(r, false));
      return doc.end();
    }
    res.json(rep);
  }));

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    const status = err.status || 500;
    if (status === 500) console.error(err);
    res.status(status).json({ error: status === 500 ? 'Internal error' : err.message });
  });
  app.service = svc;
  return app;
}
module.exports = { createApp };
