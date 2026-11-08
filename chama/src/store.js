'use strict';
const { TABLES } = require('./schema');

class ConflictError extends Error { constructor(msg) { super(msg); this.name = 'ConflictError'; this.status = 409; } }

// Table store with unique-constraint enforcement and all-or-nothing transactions.
// Node is single-threaded and every mutation is synchronous, so a transaction is atomic:
// on any throw the touched tables roll back and nothing is written to the backend.
class Store {
  constructor(backend, preloaded) {
    this.backend = backend;
    this.t = preloaded || backend.load();
    this.dirty = new Set();
    this.depth = 0;
    this.hooks = [];
    this.queue = Promise.resolve();
    this.saveErrors = [];
  }
  all(t) { return structuredClone(this.t[t]); }
  get(t, id) { const r = this.t[t].find(x => x.id === id); return r ? structuredClone(r) : null; }
  find(t, fn) { return this.t[t].filter(fn).map(r => structuredClone(r)); }
  one(t, fn) { const r = this.t[t].find(fn); return r ? structuredClone(r) : null; }
  count(t, fn) { return fn ? this.t[t].filter(fn).length : this.t[t].length; }

  _checkUnique(t, row, ignoreId) {
    for (const cols of TABLES[t].unique) {
      if (cols.some(c => row[c] === null || row[c] === undefined || row[c] === '')) continue;
      const clash = this.t[t].find(r => r.id !== ignoreId && cols.every(c => r[c] === row[c]));
      if (clash) throw new ConflictError(`Duplicate ${t} record: (${cols.join(', ')}) already exists`);
    }
  }
  insert(t, data) {
    const row = {};
    for (const c of Object.keys(TABLES[t].cols)) row[c] = data[c] === undefined ? null : data[c];
    row.id = this.t[t].reduce((m, r) => Math.max(m, r.id), 0) + 1;
    this._checkUnique(t, row, null);
    this.t[t].push(row);
    this._touch(t);
    return structuredClone(row);
  }
  update(t, id, patch) {
    const i = this.t[t].findIndex(r => r.id === id);
    if (i < 0) throw Object.assign(new Error(`${t} #${id} not found`), { status: 404 });
    const next = { ...this.t[t][i], ...patch, id };
    this._checkUnique(t, next, id);
    this.t[t][i] = next;
    this._touch(t);
    return structuredClone(next);
  }
  _touch(t) { this.dirty.add(t); if (this.depth === 0) this._flush(); }

  // Run side effects (e.g. sending SMS) only after the outermost transaction commits.
  afterCommit(cb) { if (this.depth === 0) cb(); else this.hooks.push(cb); }

  transaction(fn) {
    if (this.depth > 0) return fn(); // nested: join the outer transaction
    const snap = structuredClone(this.t);
    this.depth++;
    this.hooks = [];
    let r;
    try {
      r = fn();
    } catch (e) {
      this.depth--;
      this.t = snap;
      this.dirty.clear();
      this.hooks = [];
      throw e;
    }
    this.depth--;
    this._flush();
    const hooks = this.hooks; this.hooks = [];
    hooks.forEach(h => { try { h(); } catch (e) { console.error('afterCommit hook failed', e.message); } });
    return r;
  }
  _flush() {
    const tables = [...this.dirty]; this.dirty.clear();
    for (const t of tables) {
      const rows = structuredClone(this.t[t]);
      this.queue = this.queue.then(() => this.backend.save(t, rows)).catch(e => { this.saveErrors.push(e); console.error('Persist failed for', t, e.message); });
    }
  }
  flushed() { return this.queue; }
}

module.exports = { Store, ConflictError };
