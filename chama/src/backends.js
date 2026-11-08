'use strict';
const fs = require('fs');
const path = require('path');
const { TABLES } = require('./schema');

// ---- serialisation helpers shared by both backends ----
function toCell(type, v) {
  if (v === null || v === undefined) return '';
  if (type === 'j') return JSON.stringify(v);
  return String(v);
}
function fromCell(type, v) {
  if (v === '' || v === undefined || v === null) return type === 'n' ? null : type === 'j' ? null : '';
  if (type === 'n') return Number(v);
  if (type === 'j') return JSON.parse(v);
  return String(v);
}
function rowsToMatrix(table, rows) {
  const cols = Object.keys(TABLES[table].cols);
  return [cols, ...rows.map(r => cols.map(c => toCell(TABLES[table].cols[c], r[c])))];
}
function matrixToRows(table, matrix) {
  if (!matrix || matrix.length < 2) return [];
  const header = matrix[0];
  const types = TABLES[table].cols;
  return matrix.slice(1).filter(r => r.some(x => x !== '')).map(r => {
    const o = {};
    for (const c of Object.keys(types)) {
      const i = header.indexOf(c);
      o[c] = fromCell(types[c], i >= 0 ? r[i] : '');
    }
    return o;
  });
}

// ---- CSV (RFC 4180) ----
function toCsv(matrix) {
  return matrix.map(r => r.map(c => /[",\n\r]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c).join(',')).join('\r\n') + '\r\n';
}
function parseCsv(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(f); f = ''; }
    else if (ch === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (ch === '\r') { /* skip */ }
    else f += ch;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows;
}

// Local spreadsheet-style backend: one CSV per tab (opens in Excel / imports into Google Sheets).
class CsvBackend {
  constructor(dir) { this.dir = dir; fs.mkdirSync(dir, { recursive: true }); }
  load() {
    const out = {};
    for (const t of Object.keys(TABLES)) {
      const f = path.join(this.dir, t + '.csv');
      out[t] = fs.existsSync(f) ? matrixToRows(t, parseCsv(fs.readFileSync(f, 'utf8'))) : [];
    }
    return out;
  }
  save(table, rows) {
    const f = path.join(this.dir, table + '.csv');
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, toCsv(rowsToMatrix(table, rows)));
    fs.renameSync(tmp, f); // atomic replace
  }
}

// In-memory backend (tests).
class MemoryBackend {
  constructor() { this.data = {}; }
  load() { const o = {}; for (const t of Object.keys(TABLES)) o[t] = structuredClone(this.data[t] || []); return o; }
  save(table, rows) { this.data[table] = structuredClone(rows); }
}

// Google Sheets backend. `sheets` is a googleapis sheets v4 client (injectable for tests).
// Each table is a tab in the spreadsheet; row 1 is the header.
class SheetsBackend {
  constructor({ spreadsheetId, sheets }) { this.id = spreadsheetId; this.sheets = sheets; }
  static async create({ spreadsheetId, serviceAccountJson }) {
    const { google } = require('googleapis'); // npm i googleapis
    const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(serviceAccountJson), scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    const b = new SheetsBackend({ spreadsheetId, sheets: google.sheets({ version: 'v4', auth }) });
    await b.ensureTabs();
    return b;
  }
  async ensureTabs() {
    const meta = await this.sheets.spreadsheets.get({ spreadsheetId: this.id });
    const have = new Set(meta.data.sheets.map(s => s.properties.title));
    const requests = Object.keys(TABLES).filter(t => !have.has(t)).map(title => ({ addSheet: { properties: { title } } }));
    if (requests.length) await this.sheets.spreadsheets.batchUpdate({ spreadsheetId: this.id, requestBody: { requests } });
  }
  load() { throw new Error('SheetsBackend is async: use `new Store(backend, await backend.loadAsync())`'); }
  async loadAsync() {
    const tabs = Object.keys(TABLES);
    const res = await this.sheets.spreadsheets.values.batchGet({ spreadsheetId: this.id, ranges: tabs, valueRenderOption: 'UNFORMATTED_VALUE' });
    const out = {};
    res.data.valueRanges.forEach((vr, i) => { out[tabs[i]] = matrixToRows(tabs[i], (vr.values || []).map(r => r.map(x => (x === null || x === undefined ? '' : String(x))))); });
    return out;
  }
  async save(table, rows) {
    await this.sheets.spreadsheets.values.clear({ spreadsheetId: this.id, range: table });
    await this.sheets.spreadsheets.values.update({ spreadsheetId: this.id, range: `${table}!A1`, valueInputOption: 'RAW', requestBody: { values: rowsToMatrix(table, rows) } });
  }
}

module.exports = { CsvBackend, MemoryBackend, SheetsBackend, toCsv, parseCsv, rowsToMatrix, matrixToRows };
