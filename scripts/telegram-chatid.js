#!/usr/bin/env node
/**
 * Prints the chat id(s) your bot can message.
 *
 * Usage:
 *   1. Create a bot: message @BotFather on Telegram, send /newbot, copy the token.
 *   2. Put it in .env as TELEGRAM_BOT_TOKEN=... (copy .env.example to .env).
 *   3. Send your new bot any message, so it has an update to report.
 *   4. npm run telegram:chatid
 */

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  console.error('TELEGRAM_BOT_TOKEN is not set.');
  console.error('');
  console.error('  1. Copy .env.example to .env');
  console.error('  2. Put your @BotFather token in it as TELEGRAM_BOT_TOKEN=...');
  console.error('  3. Run this again');
  process.exit(1);
}

const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
  signal: AbortSignal.timeout(15_000),
});
const payload = await response.json();

if (!payload.ok) {
  console.error(`Telegram rejected the token: ${payload.description ?? response.status}`);
  process.exit(1);
}

const chats = new Map();
for (const update of payload.result ?? []) {
  const chat = update.message?.chat ?? update.channel_post?.chat;
  if (chat) chats.set(chat.id, chat);
}

if (chats.size === 0) {
  console.error('No messages found. Send your bot a message in Telegram, then run this again.');
  console.error('(Telegram only retains recent updates, so do it within a few minutes.)');
  process.exit(1);
}

console.log('Found these chats:\n');
for (const chat of chats.values()) {
  const who = chat.username ? `@${chat.username}` : [chat.first_name, chat.title].filter(Boolean).join(' ');
  console.log(`  TELEGRAM_CHAT_ID=${chat.id}   (${chat.type}${who ? `, ${who}` : ''})`);
}
console.log('\nAdd the id above as the TELEGRAM_CHAT_ID repository secret.');
