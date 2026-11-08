# BTI Cash Round – Rotation Management System (v1.0)

Node.js + Express app, glassy mobile-first UI, spreadsheet-style database.

## Quick start
```
npm install
npm run demo        # http://localhost:3000  (demo data: Cycle 1 complete, Cycle 2 awaiting draw)
npm test            # 35 unit + API tests
```
Demo logins (change before real use): admin `kimera@example.com` / `Admin@1234`; members `M002`…`M010` / `Member@1234`; auditor `auditor@example.com` / `Member@1234`.

## Database: Google Sheets (or local CSV sheets)
Each table is a tab (Members, Cycles, DrawResults, Contributions, Payouts, Notifications, Announcements, AuditLogs, Config, IdempotencyKeys).
* **Google Sheets**: create a spreadsheet, a Google Cloud service account, share the sheet with its e-mail (Editor), `npm i googleapis`, then set `SHEET_ID` and `GOOGLE_SERVICE_ACCOUNT_JSON`. Tabs are created automatically.
* **Local mode** (default): one CSV per tab in `data/` – opens in Excel, imports into Sheets.
* Microsoft Access was not used: it needs Windows/ODBC and cannot run on a Linux host.

## Production settings
`JWT_SECRET` (required), `ADMIN_EMAIL`/`ADMIN_PASSWORD`/`ADMIN_NAME` (first treasurer when no demo data), `PORT`, `DATA_DIR`, optional `AT_USERNAME`/`AT_API_KEY` (Africa's Talking SMS; otherwise notifications are logged as "simulated").
Deploy on Render/Railway as a Node web service (`npm start`), HTTPS is provided by the host. **Backups:** with Sheets use File → Version history plus a nightly copy (Apps Script `makeCopy`); in CSV mode copy `data/` nightly.

## Business rules implemented
Draw: crypto `randomInt` Fisher–Yates; commit-reveal (hash published first, salt revealed on lock); redraw allowed only before lock; override = swap of two unpaid positions with mandatory reason, audit-logged, announced; verification recomputes hash. Payouts: in order, idempotency key, unique (cycle,month) and (cycle,position), blocked if contributions are missing unless a reason is logged. Close requires contributions = payouts. Mid-cycle policy: new members join the next cycle; unpaid members cannot be deactivated mid-cycle. Group size and amount are configurable. Audit log is hash-chained.

## Treasurer quick manual
1. **Cycle** tab → Create next cycle → Run random draw → review → Confirm & lock (members are notified).
2. **Record** tab → pick member, Save contribution (works offline; syncs later). Payout → Confirm payout when all paid.
3. After month 10: **Cycle** → Close & archive. **Reports** → CSV/PDF.

## Known limits / open questions
Password login only (OTP not built); WhatsApp channel not built (SMS hook only); Google Sheets backend verified against a mock, not a live sheet; truncating the audit log tail is detectable only by comparing the published head hash; penalty rule is a flat % when paid after due day.
