/**
 * Optional email notifier.
 *
 * Dormant by default: it is a no-op unless SMTP_USER, SMTP_PASS and
 * ALERT_EMAIL_TO are all present. nodemailer is an optionalDependency and is
 * imported lazily, so the Telegram-only path never needs it installed.
 *
 * For Gmail, SMTP_PASS must be a 16-character App Password, which requires
 * 2-Step Verification on the Google account. A normal password will not work.
 */

export function emailConfigured(env = process.env) {
  return Boolean(env.SMTP_USER && env.SMTP_PASS && env.ALERT_EMAIL_TO);
}

export async function sendEmail({ subject, html, text }, { env = process.env, log = () => {} } = {}) {
  if (!emailConfigured(env)) {
    log('email notifier: not configured, skipping');
    return false;
  }

  let nodemailer;
  try {
    ({ default: nodemailer } = await import('nodemailer'));
  } catch {
    log('email notifier: nodemailer is not installed, skipping (run `npm install nodemailer`)');
    return false;
  }

  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST ?? 'smtp.gmail.com',
    port: Number(env.SMTP_PORT ?? 465),
    secure: String(env.SMTP_SECURE ?? 'true') === 'true',
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  });

  await transport.sendMail({
    from: env.SMTP_FROM ?? env.SMTP_USER,
    to: env.ALERT_EMAIL_TO,
    subject,
    html,
    text,
  });

  log(`email sent to ${env.ALERT_EMAIL_TO}`);
  return true;
}
