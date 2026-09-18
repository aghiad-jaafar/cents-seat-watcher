#!/usr/bin/env node
/**
 * Sends a sample alert to Telegram, so you can confirm delivery works before
 * trusting it to wake you at 3am.
 *
 * Usage:
 *   Put TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env, then:
 *   npm run telegram:test
 */

import { sendTelegram, telegramConfigured } from '../src/notify/telegram.js';
import { formatTelegram } from '../src/format.js';
import { EVENT } from '../src/diff.js';
import { AVAILABILITY } from '../src/parse.js';

if (!telegramConfigured()) {
  console.error('Missing credentials. Both are required:\n');
  console.error('  TELEGRAM_BOT_TOKEN   from @BotFather');
  console.error('  TELEGRAM_CHAT_ID     from `npm run telegram:chatid`\n');
  console.error('Put both in .env (copy .env.example to .env), then run this again.');
  process.exit(1);
}

const sample = {
  type: EVENT.BECAME_AVAILABLE,
  row: {
    format: 'CENT@HOME',
    university: "Università degli studi di Brescia",
    region: 'LOMBARDIA',
    city: 'BRESCIA',
    deadline: '09/10/2026',
    seats: 3,
    availability: AVAILABILITY.OPEN_LIMITED,
    date: '15/10/2026',
    bookingUrl: 'https://testcisia.it/studenti_tolc/login_sso.php',
  },
  previous: { availability: AVAILABILITY.FULL, seats: null },
};

const messages = formatTelegram([sample], { calendarName: 'CEnT-S (TEST)' });

console.log('Sending this to Telegram:\n');
console.log(messages.join('\n---\n').replace(/<[^>]+>/g, ''));
console.log();

try {
  await sendTelegram(messages, { log: (m) => console.log(`  ${m}`) });
  console.log('\nDelivered. Check your phone.');
  console.log('If it arrived, the same credentials will work as GitHub secrets.');
} catch (error) {
  console.error(`\nFailed: ${error.message}\n`);
  if (/chat not found/i.test(error.message)) {
    console.error('TELEGRAM_CHAT_ID looks wrong, or you have not messaged the bot yet.');
    console.error('Send your bot a message, then re-run `npm run telegram:chatid`.');
  } else if (/unauthorized/i.test(error.message)) {
    console.error('TELEGRAM_BOT_TOKEN is not valid. Re-copy it from @BotFather.');
  }
  process.exit(1);
}
