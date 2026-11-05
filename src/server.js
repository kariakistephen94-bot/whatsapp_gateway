import express from 'express';
import { createInboundForwarder } from './inbound-webhook.js';
import crypto from 'node:crypto';
import pino from 'pino';
import { WhatsAppClient } from './whatsapp.js';
import { createStatusPipeline } from './status/index.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const API_KEY = process.env.API_KEY;
if (!API_KEY || API_KEY.length < 16) {
  console.error('Set API_KEY (min 16 chars) in the environment. See .env.example');
  process.exit(1);
}
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const forwardInbound = createInboundForwarder(process.env);

const wa = new WhatsAppClient({
  authDir: process.env.AUTH_DIR || './auth_state',
  minSendIntervalMs: Number(process.env.MIN_SEND_INTERVAL_MS || 1500),
});

// Delivery/read status forwarding (STATUS_WEBHOOK_URL). Separate from the inbound WEBHOOK_URL path below.
let statusPipeline = null;
try {
  statusPipeline = createStatusPipeline({ env: process.env, logger });
} catch (e) {
  console.error(`Status forwarding misconfigured: ${e.message}`);
  process.exit(1);
}
if (statusPipeline) {
  statusPipeline.attach(wa);
  statusPipeline.start();
} else {
  logger.info('STATUS_WEBHOOK_URL not set: delivery/read status forwarding is off');
}

// Keep the last 200 inbound messages in memory for GET /messages
const inbox = [];
wa.on('message', async (m) => {
  inbox.push(m);
  if (inbox.length > 200) inbox.shift();
  if (forwardInbound) {
    try {
      await forwardInbound(m);
    } catch (e) {
      logger.warn({ err: e.message }, 'inbound webhook delivery failed');
    }
  }
});

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '25mb' }));

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function auth(req, res, next) {
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const key = bearer || req.headers['x-api-key'] || req.query.key || '';
  if (!key || !safeEqual(key, API_KEY)) return res.status(401).json({ error: 'unauthorized' });
  next();
}

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use(auth);

app.get('/status', (_req, res) => res.json(wa.status()));

// Simple page that shows the pairing QR. Open: /qr?key=YOUR_API_KEY
app.get('/qr', (_req, res) => {
  const s = wa.status();
  if (s.connected) return res.type('html').send('<h2>Already connected ✅</h2>');
  if (!wa.qrDataUrl) {
    return res.type('html').send(`<meta http-equiv="refresh" content="2"><h3>Waiting for QR… (state: ${s.state})</h3>`);
  }
  res.type('html').send(`<!doctype html><meta http-equiv="refresh" content="15">
    <body style="font-family:system-ui;text-align:center;padding:2rem">
    <h2>Scan with WhatsApp</h2>
    <p>Phone → Settings → Linked devices → Link a device</p>
    <img src="${wa.qrDataUrl}" alt="QR" /></body>`);
});

app.get('/qr.json', (_req, res) => res.json({ qr: wa.qr, dataUrl: wa.qrDataUrl }));

app.post('/send', async (req, res, next) => {
  try {
    const { to, text, media } = req.body || {};
    if (!to) return res.status(400).json({ error: '"to" is required' });
    if (!text && !media) return res.status(400).json({ error: 'Provide "text" and/or "media"' });
    const result = media
      ? await wa.sendMedia(to, { ...media, caption: media.caption ?? text })
      : await wa.sendText(to, text);
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

app.post('/send-bulk', async (req, res, next) => {
  try {
    const { messages } = req.body || {};
    if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: '"messages" array required' });
    if (messages.length > 50) return res.status(400).json({ error: 'Max 50 per request' });
    const results = [];
    for (const m of messages) {
      try { results.push({ ok: true, ...(await wa.sendText(m.to, m.text)) }); }
      catch (e) { results.push({ ok: false, to: m.to, error: e.message }); }
    }
    res.json({ results });
  } catch (e) { next(e); }
});

app.post('/check', async (req, res, next) => {
  try {
    const { numbers } = req.body || {};
    if (!Array.isArray(numbers) || !numbers.length) return res.status(400).json({ error: '"numbers" array required' });
    res.json({ results: await wa.checkNumbers(numbers) });
  } catch (e) { next(e); }
});

app.get('/messages', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  res.json({ messages: inbox.slice(-limit) });
});

// Status-forwarding outbox: queue health, and re-queue of events that exhausted their retries.
app.get('/status-events', (_req, res) => {
  if (!statusPipeline) return res.json({ enabled: false });
  res.json({ enabled: true, ...statusPipeline.outbox.stats(), dead_events: statusPipeline.outbox.listDead() });
});

app.post('/status-events/retry-dead', (_req, res) => {
  if (!statusPipeline) return res.status(404).json({ error: 'status forwarding is not enabled' });
  res.json({ ok: true, requeued: statusPipeline.outbox.retryDead() });
});

app.post('/logout', async (_req, res) => {
  await wa.logout();
  res.json({ ok: true, note: 'Delete the auth dir and restart to pair again.' });
});

app.use((err, _req, res, _next) => {
  const status = err.status || (/Invalid phone/.test(err.message) ? 400 : 500);
  if (status >= 500 && status !== 503) logger.error(err);
  res.status(status).json({ error: err.message });
});

await wa.start();
const server = app.listen(PORT, HOST, () => logger.info(`Gateway listening on http://${HOST}:${PORT}`));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    wa._stopping = true;
    server.close(() => Promise.resolve(statusPipeline?.stop()).finally(() => process.exit(0)));
  });
}
