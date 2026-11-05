import crypto from 'node:crypto';

/** Order of confirmed delivery progress. `failed` is handled separately and never outranks a receipt. */
export const STATUS_RANK = { sent: 1, delivered: 2, read: 3 };
export const STATUSES = ['sent', 'delivered', 'read', 'failed'];

// Baileys proto.WebMessageInfo.Status values (checked against the installed library in the tests).
const BAILEYS_STATUS = { ERROR: 0, PENDING: 1, SERVER_ACK: 2, DELIVERY_ACK: 3, READ: 4, PLAYED: 5 };
export { BAILEYS_STATUS };

/**
 * Map a Baileys message status code to the gateway vocabulary.
 * PENDING (not yet handed to WhatsApp) and anything unknown map to null, i.e. "not a confirmed update".
 * PLAYED is WhatsApp's own receipt for audio/video that was opened, which also marks the message read.
 */
export function normalizeBaileysStatus(code) {
  switch (Number(code)) {
    case BAILEYS_STATUS.ERROR: return 'failed';
    case BAILEYS_STATUS.SERVER_ACK: return 'sent';
    case BAILEYS_STATUS.DELIVERY_ACK: return 'delivered';
    case BAILEYS_STATUS.READ:
    case BAILEYS_STATUS.PLAYED: return 'read';
    default: return null;
  }
}

const MIN_PLAUSIBLE_MS = Date.UTC(2015, 0, 1);
const MAX_FUTURE_SKEW_MS = 5 * 60_000;

function toSeconds(t) {
  if (t == null) return NaN;
  if (typeof t === 'object') return typeof t.toNumber === 'function' ? t.toNumber() : Number(t.low);
  return Number(t);
}

/**
 * ISO timestamp from a provider value in unix seconds, or null if the value is missing or implausible
 * (0, NaN, before 2015, or more than 5 minutes in the future). Callers then fall back to "observed".
 */
export function providerTimestamp(seconds, nowMs = Date.now()) {
  const s = toSeconds(seconds);
  if (!Number.isFinite(s) || s <= 0) return null;
  const ms = s * 1000;
  if (ms < MIN_PLAUSIBLE_MS || ms > nowMs + MAX_FUTURE_SKEW_MS) return null;
  return new Date(ms).toISOString();
}

/** Deterministic: the same (sender, message, status) always yields the same ID, across retries and restarts. */
export function eventId(sender, messageId, status) {
  return `gwevt_${crypto.createHash('sha256').update(`${sender}:${messageId}:${status}`).digest('hex').slice(0, 32)}`;
}

export function buildStatusEvent({ provider, messageId, sender, recipient, status, providerSeconds, nowMs = Date.now() }) {
  const fromProvider = providerTimestamp(providerSeconds, nowMs);
  return {
    event_id: eventId(sender, messageId, status),
    event: 'message_status',
    provider,
    message_id: messageId,
    sender,
    recipient,
    status,
    occurred_at: fromProvider ?? new Date(nowMs).toISOString(),
    timestamp_source: fromProvider ? 'provider' : 'observed',
  };
}

/** "2348107920394:12@s.whatsapp.net" -> "2348107920394"; non-phone JIDs return null. */
export function phoneFromJid(jid) {
  const m = /^(\d+)(?::\d+)?@s\.whatsapp\.net$/.exec(String(jid || ''));
  return m ? m[1] : null;
}

/** Groups, broadcast lists and newsletters have per-participant receipts, which are not forwarded. */
export function isOneToOneJid(jid) {
  return /@(s\.whatsapp\.net|lid)$/.test(String(jid || ''));
}
