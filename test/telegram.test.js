/**
 * Exercises the real sendTelegram request against a local stub of the Bot API,
 * so the notification path is covered without needing a live bot token.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

import { sendTelegram, telegramConfigured } from '../src/notify/telegram.js';
import { formatTelegram, formatSampleAlert } from '../src/format.js';
import { EVENT } from '../src/diff.js';
import { AVAILABILITY } from '../src/parse.js';

/** Stub Bot API that records what it received. */
async function startStub({ status = 200, payload = { ok: true, result: {} } } = {}) {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      received.push({ url: req.url, method: req.method, body: JSON.parse(body || '{}') });
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, received, base: `http://127.0.0.1:${server.address().port}` };
}

function envFor(base) {
  return { TELEGRAM_BOT_TOKEN: '123456:FAKE-TOKEN', TELEGRAM_CHAT_ID: '99887766', TELEGRAM_API_BASE: base };
}

test('telegramConfigured requires both token and chat id', () => {
  assert.equal(telegramConfigured({}), false);
  assert.equal(telegramConfigured({ TELEGRAM_BOT_TOKEN: 'x' }), false);
  assert.equal(telegramConfigured({ TELEGRAM_CHAT_ID: 'y' }), false);
  assert.equal(telegramConfigured({ TELEGRAM_BOT_TOKEN: 'x', TELEGRAM_CHAT_ID: 'y' }), true);
});

test('sends a well-formed sendMessage request', async (t) => {
  const { server, received, base } = await startStub();
  t.after(async () => {
    server.close();
    await once(server, 'close');
  });

  const sent = await sendTelegram('<b>hello</b>', { env: envFor(base) });

  assert.equal(sent, 1);
  assert.equal(received.length, 1);
  assert.equal(received[0].method, 'POST');
  assert.equal(received[0].url, '/bot123456:FAKE-TOKEN/sendMessage');
  assert.deepEqual(received[0].body, {
    chat_id: '99887766',
    text: '<b>hello</b>',
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
});

test('sends each message in a multi-part alert', async (t) => {
  const { server, received, base } = await startStub();
  t.after(async () => {
    server.close();
    await once(server, 'close');
  });

  const sent = await sendTelegram(['one', 'two', 'three'], { env: envFor(base) });
  assert.equal(sent, 3);
  assert.deepEqual(received.map((r) => r.body.text), ['one', 'two', 'three']);
});

test('a real formatted alert is accepted and stays within Telegram limits', async (t) => {
  const { server, received, base } = await startStub();
  t.after(async () => {
    server.close();
    await once(server, 'close');
  });

  const row = {
    format: 'CENT@HOME',
    university: "Universita' degli studi di Brescia & Co <test>",
    region: 'LOMBARDIA',
    city: 'BRESCIA',
    deadline: '09/10/2026',
    seats: 3,
    availability: AVAILABILITY.OPEN_LIMITED,
    date: '15/10/2026',
    bookingUrl: 'https://testcisia.it/studenti_tolc/login_sso.php',
  };

  const messages = formatTelegram([{ type: EVENT.BECAME_AVAILABLE, row }]);
  await sendTelegram(messages, { env: envFor(base) });

  const text = received[0].body.text;
  assert.ok(text.length <= 4096);
  // Unbalanced or unescaped markup is what makes Telegram reject a message.
  assert.ok(!/&(?!amp;|lt;|gt;)/.test(text.replace(/&amp;|&lt;|&gt;/g, '')), 'entities must be escaped');
  assert.ok(text.includes('&amp;'), 'the ampersand in the name should be escaped');
  assert.ok(text.includes('&lt;test&gt;'), 'angle brackets should be escaped');
  assert.equal((text.match(/<b>/g) || []).length, (text.match(/<\/b>/g) || []).length);
});

test('a long alert is split across several messages, none over the limit', async (t) => {
  const { server, received, base } = await startStub();
  t.after(async () => {
    server.close();
    await once(server, 'close');
  });

  const events = Array.from({ length: 60 }, (_, i) => ({
    type: EVENT.BECAME_AVAILABLE,
    row: {
      format: 'CENT@HOME',
      university: `Universita numero ${i} con un nome piuttosto lungo per gonfiare il messaggio`,
      region: 'LOMBARDIA',
      city: `CITTA-${i}`,
      deadline: '09/10/2026',
      seats: i,
      availability: AVAILABILITY.OPEN,
      date: '15/10/2026',
      bookingUrl: 'https://testcisia.it/studenti_tolc/login_sso.php',
    },
  }));

  const messages = formatTelegram(events);
  assert.ok(messages.length > 1, 'this many events must be split');

  await sendTelegram(messages, { env: envFor(base) });
  for (const entry of received) assert.ok(entry.body.text.length <= 4096);
});

// A sample alert once marked itself by passing calendarName "CEnT-S (TEST)",
// which formatTelegram printed as a header. When the header was removed the
// parameter kept being accepted and silently ignored, so test messages became
// indistinguishable from real ones and caused a false alarm.
test('a sample alert is unmistakably marked as a test', async (t) => {
  const { server, received, base } = await startStub();
  t.after(async () => {
    server.close();
    await once(server, 'close');
  });

  const sample = {
    type: EVENT.BECAME_AVAILABLE,
    row: {
      format: 'CENT@HOME',
      university: 'Università degli studi di Brescia',
      region: 'LOMBARDIA',
      city: 'BRESCIA',
      deadline: '09/10/2026',
      seats: 3,
      availability: AVAILABILITY.OPEN_LIMITED,
      date: '15/10/2026',
      bookingUrl: 'https://testcisia.it/studenti_tolc/login_sso.php',
    },
  };

  const messages = formatSampleAlert([sample]);
  await sendTelegram(messages, { env: envFor(base) });

  const first = received[0].body.text;
  const last = received[received.length - 1].body.text;

  assert.match(first, /TEST MESSAGE/, 'the first message must open with a test banner');
  assert.match(first, /NOT A REAL SEAT/);
  assert.match(last, /End of test/, 'and close with one, so it cannot be skim-read as real');
  for (const entry of received) assert.ok(entry.body.text.length <= 4096);
});

test('a genuine alert carries no test marker', () => {
  const real = formatTelegram([
    {
      type: EVENT.BECAME_AVAILABLE,
      row: {
        format: 'CENT@HOME',
        university: 'Uni',
        region: 'LAZIO',
        city: 'ROMA',
        deadline: '09/10/2026',
        seats: 5,
        availability: AVAILABILITY.OPEN,
        date: '15/10/2026',
        bookingUrl: 'https://x',
      },
    },
  ]).join('\n');
  assert.ok(!/test/i.test(real), 'a real alert must never mention a test');
});

test('refuses to send when credentials are missing', async () => {
  await assert.rejects(() => sendTelegram('hi', { env: {} }), /TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID/);
});

test('surfaces an API rejection with its reason', async (t) => {
  const { server, base } = await startStub({
    status: 400,
    payload: { ok: false, description: 'Bad Request: chat not found' },
  });
  t.after(async () => {
    server.close();
    await once(server, 'close');
  });

  await assert.rejects(() => sendTelegram('hi', { env: envFor(base) }), /chat not found/);
});

// This repository is public and its Actions logs are public with it.
test('an API error never leaks the bot token', async (t) => {
  const { server, base } = await startStub({
    status: 401,
    payload: { ok: false, description: 'Unauthorized' },
  });
  t.after(async () => {
    server.close();
    await once(server, 'close');
  });

  const error = await sendTelegram('hi', { env: envFor(base) }).catch((e) => e);
  assert.ok(!error.message.includes('FAKE-TOKEN'), 'the token must not appear in error text');
  assert.ok(!error.stack.includes('FAKE-TOKEN'), 'nor in the stack');
});
