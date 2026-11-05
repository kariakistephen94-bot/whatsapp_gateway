import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createWebhookSender } from '../src/status/webhook.js';
import { loadStatusConfig } from '../src/status/config.js';

const SECRET = 'status-secret-0123456789';
const EVENT = {
  event_id: 'gwevt_abc', event: 'message_status', provider: 'linked_gateway', message_id: 'M1',
  sender: '2348107920394', recipient: '2349138314501', status: 'read',
  occurred_at: '2026-11-01T12:00:00.000Z', timestamp_source: 'provider',
};

function server(handler) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { seen.push({ headers: req.headers, body, url: req.url }); handler(req, res, seen.length); });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${srv.address().port}/hook`, seen, close: () => srv.close(),
  })));
}

test('POSTs the event as JSON with the gateway key header', async () => {
  const s = await server((_q, res) => res.writeHead(204).end());
  try {
    const result = await createWebhookSender({ url: s.url, secret: SECRET })(EVENT);
    assert.deepEqual(result, { ok: true });
    assert.equal(s.seen[0].headers['x-helios-gateway-key'], SECRET);
    assert.equal(s.seen[0].headers['x-helios-event-id'], 'gwevt_abc');
    assert.equal(s.seen[0].headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(s.seen[0].body), EVENT);
    assert.equal(s.seen[0].headers.authorization, undefined); // the gateway API key is never sent
  } finally { s.close(); }
});

test('classifies responses: 5xx/401/404 retry, 400/422 are permanent, redirects are not followed', async () => {
  const codes = [500, 401, 404, 429, 400, 422, 302];
  const s = await server((_q, res, n) => res.writeHead(codes[n - 1], { location: 'http://127.0.0.1:1/steal' }).end());
  try {
    const send = createWebhookSender({ url: s.url, secret: SECRET });
    const out = [];
    for (let i = 0; i < codes.length; i++) out.push(await send(EVENT));
    assert.deepEqual(out.map((r) => [r.ok, !!r.permanent]), [
      [false, false], [false, false], [false, false], [false, false], [false, true], [false, true], [false, false],
    ]);
    assert.match(out[6].error, /redirects are not followed/);
  } finally { s.close(); }
});

test('network errors and timeouts are retryable and do not leak the secret or URL', async () => {
  const refused = await createWebhookSender({ url: 'http://127.0.0.1:1/hook?token=urlsecret', secret: SECRET })(EVENT);
  assert.equal(refused.ok, false);
  assert.ok(!refused.permanent);
  assert.ok(!refused.error.includes(SECRET) && !refused.error.includes('urlsecret'), refused.error);

  const s = await server(() => {}); // never responds
  try {
    const r = await createWebhookSender({ url: s.url, secret: SECRET, timeoutMs: 100 })(EVENT);
    assert.deepEqual(r, { ok: false, error: 'network: timeout' });
  } finally { s.close(); }
});

test('config: disabled without a URL', () => {
  assert.equal(loadStatusConfig({}), null);
  assert.equal(loadStatusConfig({ STATUS_WEBHOOK_URL: '  ' }), null);
});

test('config: requires a distinct secret of reasonable length', () => {
  const base = { STATUS_WEBHOOK_URL: 'http://127.0.0.1:8000/hook', API_KEY: 'a'.repeat(32) };
  assert.throws(() => loadStatusConfig(base), /STATUS_WEBHOOK_SECRET/);
  assert.throws(() => loadStatusConfig({ ...base, STATUS_WEBHOOK_SECRET: 'short' }), /STATUS_WEBHOOK_SECRET/);
  assert.throws(() => loadStatusConfig({ ...base, STATUS_WEBHOOK_SECRET: base.API_KEY }), /different from API_KEY/);
  const ok = loadStatusConfig({ ...base, STATUS_WEBHOOK_SECRET: SECRET });
  assert.equal(ok.secret, SECRET);
  assert.equal(ok.maxAttempts, 12);
  assert.deepEqual(ok.warnings, []);
});

test('config: rejects bad URLs and the inbound webhook endpoint; warns on cleartext remote http', () => {
  const env = { STATUS_WEBHOOK_SECRET: SECRET, API_KEY: 'a'.repeat(32) };
  assert.throws(() => loadStatusConfig({ ...env, STATUS_WEBHOOK_URL: 'not a url' }), /valid URL/);
  assert.throws(() => loadStatusConfig({ ...env, STATUS_WEBHOOK_URL: 'ftp://x/y' }), /http/);
  assert.throws(
    () => loadStatusConfig({ ...env, STATUS_WEBHOOK_URL: 'http://127.0.0.1:8000/in/', WEBHOOK_URL: 'http://127.0.0.1:8000/in' }),
    /WEBHOOK_URL/,
  );
  const remote = loadStatusConfig({ ...env, STATUS_WEBHOOK_URL: 'http://helios.example.com/hook?token=zzz' });
  assert.equal(remote.warnings.length, 1);
  assert.equal(remote.displayUrl, 'http://helios.example.com/hook'); // query string is not logged
});

test('config: numeric overrides are validated', () => {
  const env = { STATUS_WEBHOOK_URL: 'http://127.0.0.1:8000/h', STATUS_WEBHOOK_SECRET: SECRET };
  assert.equal(loadStatusConfig({ ...env, STATUS_MAX_ATTEMPTS: '3' }).maxAttempts, 3);
  assert.throws(() => loadStatusConfig({ ...env, STATUS_MAX_ATTEMPTS: '0' }), /STATUS_MAX_ATTEMPTS/);
  assert.throws(() => loadStatusConfig({ ...env, STATUS_RETRY_BASE_MS: 'x' }), /STATUS_RETRY_BASE_MS/);
});
