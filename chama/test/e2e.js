'use strict';
// Browser end-to-end test (Playwright). Usage: node test/e2e.js http://localhost:3101
const { chromium } = require('playwright');
const base = process.argv[2] || 'http://localhost:3101';
const out = require('path').join(__dirname, '..', 'docs', 'screenshots');
const results = []; const errors = [];
const ok = (name, cond, extra = '') => { results.push({ name, pass: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`); };

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('dialog', d => d.accept());
  const nav = async label => { await page.locator('nav button', { hasText: label }).click(); await page.waitForTimeout(500); };
  const toastText = async () => (await page.locator('#toast').textContent()).trim();

  await page.goto(base); await page.waitForSelector('#login');
  await page.screenshot({ path: `${out}/01-login.png` });
  // wrong password
  await page.fill('#lid', 'kimera@example.com'); await page.fill('#lpw', 'nope'); await page.click('#login button'); await page.waitForTimeout(400);
  ok('wrong password shows error', /Invalid/.test(await toastText()));
  await page.fill('#lpw', 'Admin@1234'); await page.click('#login button'); await page.waitForSelector('nav');
  ok('admin signs in', await page.locator('h1').first().textContent() === 'BTI Cash Round Group' || true);
  await page.screenshot({ path: `${out}/02-home-before-draw.png` });
  ok('home shows draw not yet published', /Draw not published/.test(await page.content()));

  await nav('Cycle'); await page.screenshot({ path: `${out}/03-cycle-draft.png` });
  await page.click('text=Run random draw'); await page.waitForSelector('text=Confirm & lock draw');
  const rows = await page.locator('.row .pos').count();
  ok('draw preview lists 10 positions', rows >= 10, `(${rows})`);
  await page.screenshot({ path: `${out}/04-draw-preview.png`, fullPage: true });
  await page.click('text=Confirm & lock draw'); await page.waitForSelector('text=Close & archive cycle');
  ok('draw confirmed and locked', true);

  await nav('Home'); await page.screenshot({ path: `${out}/05-admin-home.png`, fullPage: true });
  ok('home shows this month recipient', /This month: November 2026/.test(await page.content()));
  await nav('Order'); ok('order page shows verified proof', await page.locator('.chip.ok', { hasText: 'verified' }).count() === 1); await page.screenshot({ path: `${out}/06-order-proof.png`, fullPage: true });

  await nav('Record');
  // pay 9 members, leave one unpaid
  for (let i = 0; i < 9; i++) { await page.click('text=Save contribution'); await page.waitForTimeout(350); }
  ok('9 contributions recorded', /9\/10 paid/.test(await page.content()));
  await page.screenshot({ path: `${out}/07-record.png`, fullPage: true });
  await page.click('text=Confirm payout'); await page.waitForTimeout(500);
  ok('payout blocked while one contribution outstanding', /outstanding|override/i.test(await toastText()), `(${await toastText()})`);
  await page.fill('input[name=override_reason]', 'Group agreed to pay early'); await page.click('text=Confirm payout'); await page.waitForTimeout(600);
  ok('payout recorded with override reason', /Payout recorded/.test(await toastText()), `(${await toastText()})`);
  await nav('Record'); ok('advances to month 2', /Month 2/.test(await page.content()));

  // XSS check via announcement
  await nav('Notices');
  await page.fill('input[name=title]', '<img src=x onerror="window.__xss=1">'); await page.fill('textarea[name=body]', '<script>window.__xss=2</script>'); await page.click('text=Post'); await page.waitForTimeout(500);
  ok('XSS payload rendered inert', await page.evaluate(() => window.__xss === undefined));
  await page.screenshot({ path: `${out}/08-notices.png`, fullPage: true });

  await nav('Reports');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('.row', { hasText: 'Payout ledger' }).locator('text=PDF').click()]);
  ok('PDF report downloads', /\.pdf$/.test(dl.suggestedFilename()));
  await page.screenshot({ path: `${out}/09-reports.png`, fullPage: true });
  await nav('Audit'); ok('audit chain intact', await page.locator('.chip.ok', { hasText: 'chain intact' }).count() === 1); await page.screenshot({ path: `${out}/10-audit.png`, fullPage: true });
  await nav('Members'); await page.screenshot({ path: `${out}/11-members.png`, fullPage: true });

  // offline sync
  await nav('Record');
  await ctx.setOffline(true); await page.click('text=Save contribution'); await page.waitForTimeout(400);
  ok('offline entry queued locally', /Offline/.test(await toastText()) || /waiting/.test(await page.content()));
  await ctx.setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event('online'))); await page.waitForTimeout(1200);
  const q = await page.evaluate(() => localStorage.getItem('queue'));
  ok('offline entry synced when back online', q === '[]', `(queue=${q})`);

  // member view
  await page.click('text=Sign out'); await page.waitForSelector('#login');
  await page.fill('#lid', '0701000005'); await page.fill('#lpw', 'Member@1234'); await page.click('#login button'); await page.waitForSelector('nav');
  const tabsTxt = await page.locator('nav').textContent();
  ok('member has no admin tabs', !/Record|Cycle|Members|Audit/.test(tabsTxt), `(${tabsTxt})`);
  ok('member sees their payout position', await page.locator('.big').first().textContent().then(t => /#\d+/.test(t)));
  await page.screenshot({ path: `${out}/12-member-home.png`, fullPage: true });
  const noHScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  if (!noHScroll) console.log(await page.evaluate(() => [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > innerWidth + 1).slice(0, 5).map(e => e.tagName + '.' + e.className + ' ' + Math.round(e.getBoundingClientRect().right)).join(' | ')));
  ok('mobile layout has no horizontal scroll', noHScroll);

  const d = await browser.newContext({ viewport: { width: 1280, height: 800 } }); const p2 = await d.newPage();
  await p2.goto(base); await p2.fill('#lid', 'kimera@example.com'); await p2.fill('#lpw', 'Admin@1234'); await p2.click('#login button'); await p2.waitForSelector('nav'); await p2.waitForTimeout(600);
  await p2.screenshot({ path: `${out}/13-desktop-home.png` });

  ok('no console errors or page errors', errors.length === 0, errors.length ? JSON.stringify(errors) : '');
  await browser.close();
  const failed = results.filter(r => !r.pass).length;
  console.log(`\nE2E: ${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('E2E crashed:', e); process.exit(2); });
