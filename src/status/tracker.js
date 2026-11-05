import {
  STATUS_RANK,
  buildStatusEvent,
  isOneToOneJid,
  normalizeBaileysStatus,
  phoneFromJid,
} from './normalize.js';

const STASH_TTL_MS = 60_000;
const STASH_MAX = 500;

/**
 * Remembers the messages this gateway sent and turns confirmed WhatsApp status updates for them into
 * `message_status` events, at most once per (message, status) and never going backwards.
 *
 * Only messages registered through registerSent() are tracked. Updates for any other ID (messages sent
 * from the phone, inbound messages read on another device, ...) are ignored.
 * It only produces events for the outbox; it never sends anything to WhatsApp.
 */
export class StatusTracker {
  constructor({ journal, outbox, provider = 'linked_gateway', ttlMs = 30 * 86_400_000, now = Date.now, logger }) {
    this.journal = journal;
    this.outbox = outbox;
    this.provider = provider;
    this.ttlMs = ttlMs;
    this.now = now;
    this.log = logger;
    this.messages = new Map(); // id -> { id, sender, recipient, at, rank, emitted:Set }
    this.stash = new Map(); // id -> { at, updates[] }: updates that raced ahead of registerSent()
  }

  load() {
    for (const r of this.journal.load()) {
      if (r.k === 'm') {
        this.messages.set(r.id, { id: r.id, sender: r.sender, recipient: r.recipient, at: r.at, rank: 0, emitted: new Set() });
      } else if (r.k === 's') {
        const m = this.messages.get(r.id);
        if (!m) continue;
        m.emitted.add(r.status);
        if (STATUS_RANK[r.status]) m.rank = Math.max(m.rank, STATUS_RANK[r.status]);
      }
    }
    this.prune();
    return this;
  }

  /** Called right after sendMessage() resolved. Emits `sent`. Returns false if the chat is not tracked. */
  registerSent({ id, to, sender }) {
    const senderPhone = phoneFromJid(sender);
    if (!id || !senderPhone || !isOneToOneJid(to)) {
      this.log?.debug({ message_id: id }, 'message not tracked for status updates (group/broadcast or unknown sender)');
      return false;
    }
    if (this.messages.has(id)) return false;
    const m = { id, sender: senderPhone, recipient: phoneFromJid(to) ?? to, at: this.now(), rank: 0, emitted: new Set() };
    this.journal.append({ k: 'm', id, sender: m.sender, recipient: m.recipient, at: m.at });
    this.messages.set(id, m);

    this._advance(m, 'sent', null);
    const early = this.stash.get(id);
    this.stash.delete(id);
    for (const u of early?.updates ?? []) this._advance(m, u.status, u.timestamp);
    return true;
  }

  /** `update`: { id, code (Baileys status number), timestamp (unix seconds, optional) } */
  handleProviderUpdate({ id, code, timestamp }) {
    const status = normalizeBaileysStatus(code);
    if (!status) return 'ignored';
    const m = this.messages.get(id);
    if (!m) {
      this._stashEarly(id, status, timestamp);
      return 'unknown';
    }
    return this._advance(m, status, timestamp);
  }

  /** Forget messages older than the TTL and rewrite the journal. */
  prune() {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, m] of this.messages) if (m.at < cutoff) this.messages.delete(id);
    for (const [id, s] of this.stash) if (s.at < this.now() - STASH_TTL_MS) this.stash.delete(id);
    this.journal.rewrite([...this.messages.values()].flatMap((m) => [
      { k: 'm', id: m.id, sender: m.sender, recipient: m.recipient, at: m.at },
      ...[...m.emitted].map((status) => ({ k: 's', id: m.id, status })),
    ]));
  }

  _advance(m, status, providerSeconds) {
    if (m.emitted.has(status)) return 'duplicate';
    if (status === 'failed') {
      // A receipt proves the message reached the device; a late NACK must not contradict it.
      if (m.rank >= STATUS_RANK.delivered) return 'stale';
    } else if (STATUS_RANK[status] <= m.rank) {
      return 'stale'; // e.g. `delivered` arriving after `read`
    }

    const event = buildStatusEvent({
      provider: this.provider,
      messageId: m.id,
      sender: m.sender,
      recipient: m.recipient,
      status,
      providerSeconds,
      nowMs: this.now(),
    });
    // Outbox first: a crash in between can at worst enqueue the same event_id twice, never lose it.
    this.outbox.enqueue(event);
    this.journal.append({ k: 's', id: m.id, status });
    m.emitted.add(status);
    if (status !== 'failed') m.rank = STATUS_RANK[status];
    this.log?.info({ message_id: m.id, status, timestamp_source: event.timestamp_source }, 'message status recorded');
    return 'emitted';
  }

  _stashEarly(id, status, timestamp) {
    if (!id) return;
    const s = this.stash.get(id) ?? { at: this.now(), updates: [] };
    s.updates.push({ status, timestamp });
    this.stash.set(id, s);
    if (this.stash.size > STASH_MAX) this.stash.delete(this.stash.keys().next().value);
  }
}
