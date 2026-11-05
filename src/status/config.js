function intEnv(env, name, fallback, min) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be an integer >= ${min}`);
  return n;
}

function parseUrl(name, value) {
  let u;
  try { u = new URL(value); } catch { throw new Error(`${name} is not a valid URL`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`${name} must be http(s)`);
  return u;
}

const sameEndpoint = (a, b) => a.origin === b.origin && a.pathname.replace(/\/$/, '') === b.pathname.replace(/\/$/, '');
const isLoopback = (u) => ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) || u.hostname.endsWith('.localhost');

/**
 * Read status-forwarding settings from the environment.
 * Returns null when STATUS_WEBHOOK_URL is unset (feature off); throws with a secret-free message when
 * the configuration is unusable.
 */
export function loadStatusConfig(env) {
  const rawUrl = (env.STATUS_WEBHOOK_URL || '').trim();
  if (!rawUrl) return null;

  const url = parseUrl('STATUS_WEBHOOK_URL', rawUrl);
  const secret = env.STATUS_WEBHOOK_SECRET || '';
  if (secret.length < 16) throw new Error('STATUS_WEBHOOK_SECRET (min 16 chars) is required when STATUS_WEBHOOK_URL is set');
  if (secret === env.API_KEY) throw new Error('STATUS_WEBHOOK_SECRET must be different from API_KEY');
  if (env.WEBHOOK_URL && sameEndpoint(url, parseUrl('WEBHOOK_URL', env.WEBHOOK_URL))) {
    throw new Error('STATUS_WEBHOOK_URL must not be the same endpoint as WEBHOOK_URL (inbound messages)');
  }

  const warnings = [];
  if (url.protocol === 'http:' && !isLoopback(url)) {
    warnings.push('STATUS_WEBHOOK_URL is plain http to a non-loopback host: the secret is sent unencrypted');
  }

  return {
    url: url.toString(),
    displayUrl: `${url.origin}${url.pathname}`, // safe to log: no query string
    secret,
    dataDir: env.STATUS_DATA_DIR || './data',
    timeoutMs: intEnv(env, 'STATUS_WEBHOOK_TIMEOUT_MS', 10_000, 100),
    maxAttempts: intEnv(env, 'STATUS_MAX_ATTEMPTS', 12, 1),
    baseDelayMs: intEnv(env, 'STATUS_RETRY_BASE_MS', 5_000, 10),
    maxDelayMs: intEnv(env, 'STATUS_RETRY_MAX_MS', 15 * 60_000, 10),
    ledgerTtlMs: intEnv(env, 'STATUS_LEDGER_TTL_DAYS', 30, 1) * 86_400_000,
    warnings,
  };
}
