'use strict';
const path = require('path');
const crypto = require('crypto');
const { Store } = require('./store');
const { CsvBackend, SheetsBackend } = require('./backends');
const { createApp } = require('./app');
const { seedDemo } = require('./seed');
const { Service, hashPassword } = require('./service');

// SMS via Africa's Talking when configured; otherwise notifications are recorded as "simulated".
async function notifier({ channel, to, message }) {
  if (channel !== 'sms' || !process.env.AT_API_KEY || !process.env.AT_USERNAME) return { status: 'simulated' };
  const phone = String(to).startsWith('0') ? '+256' + String(to).slice(1) : to;
  const host = process.env.AT_USERNAME === 'sandbox' ? 'api.sandbox.africastalking.com' : 'api.africastalking.com';
  const r = await fetch(`https://${host}/version1/messaging`, {
    method: 'POST', headers: { apiKey: process.env.AT_API_KEY, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: process.env.AT_USERNAME, to: phone, message }),
  });
  return { status: r.ok ? 'sent' : 'failed' };
}

(async () => {
  let store;
  if (process.env.SHEET_ID && process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    const backend = await SheetsBackend.create({ spreadsheetId: process.env.SHEET_ID, serviceAccountJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON });
    store = new Store(backend, await backend.loadAsync());
    console.log('Database: Google Sheets', process.env.SHEET_ID);
  } else {
    const dir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
    store = new Store(new CsvBackend(dir));
    console.log('Database: local spreadsheet files (CSV) in', dir);
  }
  const secret = process.env.JWT_SECRET || (console.warn('JWT_SECRET not set: using a temporary secret (sessions end on restart)'), crypto.randomBytes(32).toString('hex'));
  if (store.count('Members') === 0) {
    if (process.env.SEED_DEMO === '1') { seedDemo(store); console.log('Demo data loaded: admin@ kimera@example.com / Admin@1234'); }
    else if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
      const svc = new Service(store);
      svc.createMember({ name: process.env.ADMIN_NAME || 'Treasurer', email: process.env.ADMIN_EMAIL, phone: process.env.ADMIN_PHONE || '', role: 'admin', password: process.env.ADMIN_PASSWORD });
    } else console.warn('No members yet: set SEED_DEMO=1 or ADMIN_EMAIL/ADMIN_PASSWORD');
  }
  const app = createApp(store, { secret, notifier });
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Chama running on http://localhost:${port}`));
})().catch(e => {
  const g = e && e.response && e.response.data && e.response.data.error;
  const code = (g && g.code) || e.code, msg = (g && g.message) || e.message;
  console.error('STARTUP FAILED:', code, msg);
  if (code === 403 || /permission/i.test(msg)) console.error('HINT: share the Google Sheet with the service account email as Editor, and enable the Google Sheets API for the project.');
  else if (code === 404 || /not found/i.test(msg)) console.error('HINT: SHEET_ID is wrong. Use only the part between /d/ and /edit in the sheet address.');
  else if (/JSON|private_key|invalid_grant|client_email/i.test(msg)) console.error('HINT: GOOGLE_SERVICE_ACCOUNT_JSON must be the full contents of the downloaded key file, starting with { and ending with }.');
  else if (/googleapis/i.test(msg)) console.error('HINT: run npm install googleapis (it should install automatically).');
  process.exit(1);
});
