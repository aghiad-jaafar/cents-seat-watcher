/**
 * Telegram Bot API notifier. Zero dependencies - Node 20+ has global fetch.
 */

const API_BASE = 'https://api.telegram.org';

export function telegramConfigured(env = process.env) {
  return Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
}

/**
 * @param {string[]|string} messages HTML-formatted message bodies
 */
export async function sendTelegram(messages, { env = process.env, log = () => {} } = {}) {
  const list = Array.isArray(messages) ? messages : [messages];
  if (list.length === 0) return 0;

  if (!telegramConfigured(env)) {
    throw new Error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must both be set');
  }

  const url = `${API_BASE}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  let sent = 0;

  for (const text of list) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      // Never interpolate the token into an error that may reach a public log.
      throw new Error(`Telegram API error ${response.status}: ${payload.description ?? 'unknown'}`);
    }
    sent += 1;
    log(`telegram message sent (${text.length} chars)`);
  }

  return sent;
}
