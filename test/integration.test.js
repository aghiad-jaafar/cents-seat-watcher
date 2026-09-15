/**
 * End-to-end test: runs the real entry point against a local HTTP server
 * serving a mutated copy of the captured calendar page.
 *
 * This exercises fetch -> parse -> diff -> filter -> format -> state write,
 * and in particular proves the property the whole design rests on: an alert
 * fires once on the transition, and the next run is silent.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ENTRY = path.join(ROOT, 'src', 'index.js');
const FIXTURE = fs.readFileSync(path.join(HERE, 'fixtures', 'cents-2026-09-15.html'), 'utf8');

/**
 * Flip a CENT@HOME row from NOT LONGER AVAILABLE to AVAILABLE SEATS, the way
 * the real page would when someone cancels.
 */
function withFreedHomeSeat(html) {
  const closedCell =
    '<td class="center">---</td><td class="center"><span style="color: Crimson;font-weight:bold;text-decoration: underline;" title=\'seats are fully booked, you cannot book the test\'>NOT LONGER AVAILABLE</span></td>';
  const openCell =
    '<td class="center">7</td><td class="center"><a href="https://testcisia.it/studenti_tolc/login_sso.php"><span style="color: LimeGreen;font-weight:bold;text-decoration: underline;" title=\'registrations are open, you can book your test\'>AVAILABLE SEATS</span></a></td>';

  // Must stay inside a single <tr>: searching the raw string would happily
  // land on a CENT@UNI row further down the page.
  for (const match of html.matchAll(/<tr[^>]*>[\s\S]*?<\/tr>/g)) {
    if (!match[0].includes('CENT@HOME') || !match[0].includes(closedCell)) continue;
    const freed = match[0].replace(closedCell, openCell);
    return html.slice(0, match.index) + freed + html.slice(match.index + match[0].length);
  }
  throw new Error('fixture must contain a fully-booked CENT@HOME row to free up');
}

async function startServer(getBody) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getBody());
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, url: `http://127.0.0.1:${server.address().port}/calendario.php` };
}

test('end to end: alerts once when a seat frees up, then stays quiet', async (t) => {
  let body = FIXTURE;
  const { server, url } = await startServer(() => body);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cents-e2e-'));

  t.after(async () => {
    server.close();
    await once(server, 'close');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const configPath = path.join(dir, 'config.json');
  const statePath = path.join(dir, 'seen.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      calendars: [{ name: 'CEnT-S', url }],
      filter: { formats: ['CENT@HOME'], universities: [], cities: [] },
      alertOnNewDate: true,
      alertOnSeatIncrease: true,
      alertOnClose: false,
      heartbeatHours: 24,
    }),
  );

  const exec = () =>
    run(process.execPath, [ENTRY, '--once'], {
      env: {
        ...process.env,
        WATCHER_CONFIG: configPath,
        WATCHER_STATE: statePath,
        // Deliberately no Telegram credentials: the run logs instead of sending.
        TELEGRAM_BOT_TOKEN: '',
        TELEGRAM_CHAT_ID: '',
        SMTP_USER: '',
      },
    });

  // 1. First run seeds the baseline and must not alert on the existing calendar.
  const seed = await exec();
  assert.match(seed.stdout, /first run - adopting 26 rows/);
  assert.match(seed.stdout, /0 change\(s\), 0 alert\(s\)/);
  assert.ok(fs.existsSync(statePath), 'baseline must be persisted');

  const seeded = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(Object.keys(seeded.calendars['CEnT-S'].rows).length, 26);

  // 2. A CENT@HOME seat frees up -> exactly one alert.
  body = withFreedHomeSeat(FIXTURE);
  const freed = await exec();
  assert.match(freed.stdout, /1 change\(s\), 1 alert\(s\)/);

  // 3. Nothing changed since -> silence. This is the dedup guarantee.
  const quiet = await exec();
  assert.match(quiet.stdout, /0 change\(s\), 0 alert\(s\)/);
});

test('end to end: a CENT@UNI seat is tracked but filtered out of alerts', async (t) => {
  let body = FIXTURE;
  const { server, url } = await startServer(() => body);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cents-e2e-'));

  t.after(async () => {
    server.close();
    await once(server, 'close');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const configPath = path.join(dir, 'config.json');
  const statePath = path.join(dir, 'seen.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      calendars: [{ name: 'CEnT-S', url }],
      filter: { formats: ['CENT@HOME'], universities: [], cities: [] },
      heartbeatHours: 0,
    }),
  );

  const exec = () =>
    run(process.execPath, [ENTRY, '--once'], {
      env: { ...process.env, WATCHER_CONFIG: configPath, WATCHER_STATE: statePath, TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '' },
    });

  await exec();

  // Close a CENT@UNI session that is currently open: a real change, but not one
  // that matches the CENT@HOME filter.
  body = FIXTURE.replace(
    '<a href="https://testcisia.it/studenti_tolc/login_sso.php" target=\'_blank\'><span style="color: LimeGreen;font-weight:bold;text-decoration: underline;" title=\'registrations are open, you can book your test\'>AVAILABLE SEATS</span></a>',
    '<span style="color: Crimson;font-weight:bold;text-decoration: underline;" title=\'seats are fully booked, you cannot book the test\'>NOT LONGER AVAILABLE</span>',
  );

  const changed = await exec();
  assert.match(changed.stdout, /1 change\(s\), 0 alert\(s\)/);
});

test('end to end: a broken page fails loudly and preserves the baseline', async (t) => {
  let body = FIXTURE;
  const { server, url } = await startServer(() => body);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cents-e2e-'));

  t.after(async () => {
    server.close();
    await once(server, 'close');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const configPath = path.join(dir, 'config.json');
  const statePath = path.join(dir, 'seen.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({ calendars: [{ name: 'CEnT-S', url }], filter: {}, heartbeatHours: 0 }),
  );

  const env = { ...process.env, WATCHER_CONFIG: configPath, WATCHER_STATE: statePath, TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '' };
  await run(process.execPath, [ENTRY, '--once'], { env });
  const before = fs.readFileSync(statePath, 'utf8');

  // The site starts serving a maintenance page instead of the calendar.
  body = '<html><body><h1>Servizio temporaneamente non disponibile</h1></body></html>'.padEnd(600, ' ');

  const failed = await run(process.execPath, [ENTRY, '--once'], { env }).catch((e) => e);
  assert.equal(failed.code, 1, 'a broken page must fail the run so GitHub emails you');

  const after = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const beforeRows = JSON.parse(before).calendars['CEnT-S'].rows;
  assert.deepEqual(
    after.calendars['CEnT-S'].rows,
    beforeRows,
    'the baseline must survive a failed fetch, or the next run floods with false alerts',
  );
  assert.equal(after.consecutiveFailures, 1);
});
