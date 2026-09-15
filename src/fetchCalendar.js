/**
 * HTTP layer: one GET per poll, with retries and an identifying User-Agent.
 *
 * testcisia.it serves no robots.txt (403), so there are no crawl directives to
 * honour, but the request rate is kept deliberately modest and the UA is
 * honest about what this is so an admin can identify the traffic.
 */

const USER_AGENT =
  'cents-seat-watcher/1.0 (personal seat-availability notifier; +https://github.com/topics/cents-seat-watcher)';

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class FetchError extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.name = 'FetchError';
    this.status = status;
  }
}

/** Retry on network failures and 5xx; fail fast on 4xx, which will not fix itself. */
export async function fetchCalendar(url, { attempts = MAX_ATTEMPTS, timeoutMs = DEFAULT_TIMEOUT_MS, log = () => {} } = {}) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-GB,en;q=0.9,it;q=0.8',
          'Cache-Control': 'no-cache',
        },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
      });

      if (response.status >= 400 && response.status < 500) {
        throw new FetchError(`HTTP ${response.status} (client error, not retrying)`, { status: response.status });
      }
      if (!response.ok) {
        throw new FetchError(`HTTP ${response.status}`, { status: response.status });
      }

      const html = await response.text();
      if (!html || html.length < 500) {
        throw new FetchError(`suspiciously short response (${html.length} bytes)`);
      }
      return html;
    } catch (error) {
      lastError = error;
      if (error instanceof FetchError && error.status >= 400 && error.status < 500) throw error;
      if (attempt === attempts) break;
      const backoffMs = 1000 * 2 ** (attempt - 1);
      log(`fetch attempt ${attempt}/${attempts} failed (${error.message}), retrying in ${backoffMs}ms`);
      await sleep(backoffMs);
    }
  }

  throw new FetchError(`all ${attempts} attempts failed: ${lastError?.message ?? 'unknown error'}`);
}
