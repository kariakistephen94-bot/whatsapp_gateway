import { resolveInboundIdentity } from './inbound-identity.js';
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import { EventEmitter } from 'node:events';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

/** Normalise a phone number or JID into a WhatsApp JID. */
export function toJid(input) {
  const s = String(input).trim();
  if (s.includes('@')) return s; // already a JID (user, group @g.us, etc.)
  const digits = s.replace(/[^\d]/g, '');
  if (digits.length < 7) throw new Error('Invalid phone number');
  return `${digits}@s.whatsapp.net`;
}

export class WhatsAppClient extends EventEmitter {
  constructor({ authDir, minSendIntervalMs = 1500 }) {
    super();
    this.authDir = authDir;
    this.minSendIntervalMs = minSendIntervalMs;
    this.sock = null;
    this.state = 'starting'; // starting | qr | connecting | open | logged_out | closed
    this.qr = null;
    this.qrDataUrl = null;
    this.me = null;
    this.retries = 0;
    this._queue = Promise.resolve();
    this._lastSend = 0;
    this._stopping = false;
  }

  async start() {
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

    this.sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'warn' }),
      browser: Browsers.macOS('Desktop'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });

    this.sock.ev.on('creds.update', saveCreds);
    this._bindStatusEvents(this.sock.ev);

    this.sock.ev.on('connection.update', async (u) => {
      const { connection, lastDisconnect, qr } = u;

      if (qr) {
        this.qr = qr;
        this.qrDataUrl = await QRCode.toDataURL(qr, { margin: 2, width: 320 });
        this.state = 'qr';
        this.emit('qr', qr);
        logger.info('QR ready — open /qr to scan with WhatsApp > Linked devices');
      }

      if (connection === 'connecting' && this.state !== 'qr') this.state = 'connecting';

      if (connection === 'open') {
        this.state = 'open';
        this.qr = null;
        this.qrDataUrl = null;
        this.retries = 0;
        this.me = this.sock.user;
        logger.info({ me: this.me?.id }, 'WhatsApp connected');
        this.emit('open');
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        this.me = null;
        if (this._stopping) { this.state = 'closed'; return; }
        if (loggedOut) {
          this.state = 'logged_out';
          logger.warn('Logged out from phone. Delete auth dir / call POST /logout then re-pair.');
          this.emit('logged_out');
          return;
        }
        this.state = 'connecting';
        const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.retries++, 5));
        logger.warn({ code, delay }, 'Connection closed, reconnecting');
        setTimeout(() => this.start().catch((e) => logger.error(e, 'restart failed')), delay);
      }
    });

    this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) {
        if (m.key.fromMe) continue;
        const text =
          m.message?.conversation ||
          m.message?.extendedTextMessage?.text ||
          m.message?.imageMessage?.caption ||
          m.message?.videoMessage?.caption ||
          null;
        const identity = await resolveInboundIdentity(m.key, this.sock?.signalRepository?.lidMapping);
        this.emit('message', {
          id: m.key.id,
          from: identity.from,
          rawFrom: m.key.remoteJid,
          phoneResolution: identity.source || 'unresolved',
          participant: m.key.participant || null,
          pushName: m.pushName || null,
          timestamp: Number(m.messageTimestamp) || null,
          text,
          type: m.message ? Object.keys(m.message)[0] : null,
        });
      }
    });
  }

  /**
   * Surface provider status updates for messages WE sent as 'outbound-status'. This is a separate channel
   * from 'message' (inbound), so a receipt can never be mistaken for an inbound message or trigger a reply.
   * Only explicit status codes are forwarded; presence, typing and replies are not consulted.
   */
  _bindStatusEvents(ev) {
    ev.on('messages.update', (updates) => {
      for (const { key, update } of updates || []) {
        if (!key?.fromMe || !key.id || update?.status == null) continue;
        try {
          this.emit('outbound-status', { id: key.id, code: Number(update.status), timestamp: update.messageTimestamp });
        } catch (e) {
          logger.error({ err: e.message }, 'outbound-status listener failed');
        }
      }
    });
  }

  /** Tell listeners a message was handed to WhatsApp. Never allowed to affect the send result. */
  _emitSent(res, jid) {
    try {
      this.emit('outbound-sent', { id: res.key.id, to: jid, sender: this.sock?.user?.id });
    } catch (e) {
      logger.error({ err: e.message }, 'outbound-sent listener failed');
    }
  }

  status() {
    return {
      state: this.state,
      connected: this.state === 'open',
      me: this.me ? { id: this.me.id, name: this.me.name || null } : null,
      needsQr: this.state === 'qr',
    };
  }

  /** Serialise sends and enforce a minimum gap between them. */
  _enqueue(fn) {
    const run = async () => {
      const wait = this._lastSend + this.minSendIntervalMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try { return await fn(); } finally { this._lastSend = Date.now(); }
    };
    const p = this._queue.then(run, run);
    this._queue = p.catch(() => {});
    return p;
  }

  _assertOpen() {
    if (this.state !== 'open') {
      const e = new Error(`WhatsApp not connected (state: ${this.state})`);
      e.status = 503;
      throw e;
    }
  }

  async sendText(to, text) {
    this._assertOpen();
    const jid = toJid(to);
    return this._enqueue(async () => {
      const res = await this.sock.sendMessage(jid, { text });
      this._emitSent(res, jid);
      return { id: res.key.id, to: jid };
    });
  }

  /** media: { url? , base64?, mimetype, fileName?, caption? } */
  async sendMedia(to, media) {
    this._assertOpen();
    const jid = toJid(to);
    const buffer = media.base64 ? Buffer.from(media.base64, 'base64') : { url: media.url };
    const mt = media.mimetype || '';
    let content;
    if (mt.startsWith('image/')) content = { image: buffer, caption: media.caption };
    else if (mt.startsWith('video/')) content = { video: buffer, caption: media.caption };
    else if (mt.startsWith('audio/')) content = { audio: buffer, mimetype: mt };
    else content = { document: buffer, mimetype: mt || 'application/octet-stream', fileName: media.fileName || 'file', caption: media.caption };
    return this._enqueue(async () => {
      const res = await this.sock.sendMessage(jid, content);
      this._emitSent(res, jid);
      return { id: res.key.id, to: jid };
    });
  }

  async checkNumbers(numbers) {
    this._assertOpen();
    const res = await this.sock.onWhatsApp(...numbers.map((n) => toJid(n)));
    return (res || []).map((r) => ({ jid: r.jid, exists: !!r.exists }));
  }

  async logout() {
    this._stopping = true;
    try { await this.sock?.logout(); } catch { /* already gone */ }
    this.state = 'logged_out';
  }
}
