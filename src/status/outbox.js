/**
 * Durable outbox for status events. At-least-once delivery with bounded retries.
 *
 * - Every change is journaled before it takes effect, so a crash or restart loses nothing.
 * - The event body (including event_id and occurred_at) is stored once and re-sent unchanged.
 * - Events for the same message are sent in order: a later event waits while an earlier one is retrying.
 * - After `maxAttempts` (or a permanent rejection) an event is parked as "dead", kept for inspection,
 *   and can be re-queued with retryDead(). Nothing here ever resends the WhatsApp message itself.
 */
export class StatusOutbox {
  constructor({
    journal,
    send, // async (event) => { ok: true } | { ok: false, error, permanent? }
    maxAttempts = 12,
    baseDelayMs = 5_000,
    maxDelayMs = 15 * 60_000,
    deadLimit = 1_000,
    now = Date.now,
    random = Math.random,
    logger,
    autoStart = true,
  }) {
    this.journal = journal;
    this.send = send;
    this.maxAttempts = maxAttempts;
    this.baseDelayMs = baseDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.deadLimit = deadLimit;
    this.now = now;
    this.random = random;
    this.log = logger;
    this.autoStart = autoStart;
    this.items = new Map(); // event_id -> { event, createdAt, attempts, nextAt, state, lastError }
    this._timer = null;
    this._running = null;
    this._pausedUntil = 0;
    this._stopped = false;
  }

  load() {
    for (const r of this.journal.load()) {
      if (r.k === 'e' && r.event?.event_id) {
        this.items.set(r.event.event_id, {
          event: r.event,
          createdAt: r.createdAt ?? this.now(),
          attempts: r.attempts ?? 0,
          nextAt: r.nextAt ?? 0,
          state: r.state ?? 'pending',
          lastError: r.lastError ?? null,
        });
      } else if (r.k === 'a') {
        const it = this.items.get(r.id);
        if (it) Object.assign(it, { attempts: r.attempts, nextAt: r.nextAt, lastError: r.lastError ?? null });
      } else if (r.k === 'x') {
        const it = this.items.get(r.id);
        if (it) Object.assign(it, { state: 'dead', attempts: r.attempts, lastError: r.lastError ?? null });
      } else if (r.k === 'r') {
        const it = this.items.get(r.id);
        if (it) Object.assign(it, { state: 'pending', attempts: 0, nextAt: 0 });
      } else if (r.k === 'd') {
        this.items.delete(r.id);
      }
    }
    this._compact();
    return this;
  }

  /** Returns false if an event with this ID is already queued (or parked). */
  enqueue(event) {
    if (this.items.has(event.event_id)) return false;
    const item = { event, createdAt: this.now(), attempts: 0, nextAt: 0, state: 'pending', lastError: null };
    this.journal.append({ k: 'e', event, createdAt: item.createdAt });
    this.items.set(event.event_id, item);
    if (this.autoStart) this._schedule();
    return true;
  }

  start() {
    this._stopped = false;
    this._schedule();
  }

  async stop() {
    this._stopped = true;
    clearTimeout(this._timer);
    this._timer = null;
    await this._running;
    this.journal.close();
  }

  /** Attempt every event that is due, one at a time. Safe to call concurrently. */
  async processDue() {
    if (this._running) return this._running;
    const pass = (async () => {
      await null; // always yield first so `_running` is set before the pass can finish
      try {
        for (;;) {
          if (this._stopped || this.now() < this._pausedUntil) break;
          const item = this._nextDue();
          if (!item) break;
          await this._attempt(item);
        }
      } finally {
        this._running = null;
        if (!this._stopped) this._schedule();
      }
    })();
    this._running = pass;
    return pass;
  }

  /** Re-queue every parked event with a fresh attempt budget. */
  retryDead() {
    let n = 0;
    for (const [id, it] of this.items) {
      if (it.state !== 'dead') continue;
      this.journal.append({ k: 'r', id });
      Object.assign(it, { state: 'pending', attempts: 0, nextAt: 0 });
      n++;
    }
    if (n && this.autoStart) this._schedule();
    return n;
  }

  stats() {
    let pending = 0;
    let dead = 0;
    let oldest = null;
    let next = null;
    for (const it of this.items.values()) {
      if (it.state === 'dead') { dead++; continue; }
      pending++;
      if (oldest === null || it.createdAt < oldest) oldest = it.createdAt;
      if (next === null || it.nextAt < next) next = it.nextAt;
    }
    return {
      pending,
      dead,
      oldest_pending_age_ms: oldest === null ? null : Math.max(0, this.now() - oldest),
      next_attempt_at: next === null ? null : new Date(Math.max(next, this._pausedUntil)).toISOString(),
    };
  }

  listDead(limit = 50) {
    return [...this.items.values()]
      .filter((it) => it.state === 'dead')
      .slice(-limit)
      .map((it) => ({ event: it.event, attempts: it.attempts, last_error: it.lastError }));
  }

  _nextDue() {
    const blocked = new Set(); // message IDs that already have an earlier pending event
    const now = this.now();
    for (const it of this.items.values()) {
      if (it.state !== 'pending') continue;
      const mid = it.event.message_id;
      if (blocked.has(mid)) continue;
      if (it.nextAt <= now) return it;
      blocked.add(mid);
    }
    return null;
  }

  async _attempt(it) {
    let result;
    try {
      result = await this.send(it.event);
    } catch (e) {
      result = { ok: false, error: `send threw: ${e.message}` };
    }
    const id = it.event.event_id;

    if (result?.ok) {
      this.journal.append({ k: 'd', id, outcome: 'delivered' });
      this.items.delete(id);
      this.log?.debug({ event_id: id, status: it.event.status }, 'status event delivered');
    } else {
      it.attempts += 1;
      it.lastError = String(result?.error || 'unknown error').slice(0, 200);
      if (result?.permanent || it.attempts >= this.maxAttempts) {
        it.state = 'dead';
        this.journal.append({ k: 'x', id, attempts: it.attempts, lastError: it.lastError });
        this.log?.error({ event_id: id, status: it.event.status, attempts: it.attempts, err: it.lastError },
          'status event parked as dead (use POST /status-events/retry-dead after fixing the cause)');
        this._evictDead();
      } else {
        const delay = this._backoff(it.attempts);
        it.nextAt = this.now() + delay;
        this._pausedUntil = it.nextAt; // endpoint looks unhealthy: don't hammer it with the rest of the backlog
        this.journal.append({ k: 'a', id, attempts: it.attempts, nextAt: it.nextAt, lastError: it.lastError });
        this.log?.warn({ event_id: id, attempts: it.attempts, retry_in_ms: delay, err: it.lastError },
          'status event delivery failed, will retry');
      }
    }
    if (this.journal.lines > Math.max(500, this.items.size * 4)) this._compact();
  }

  /** Exponential backoff with +/-20% jitter, capped. `attempts` is the number of failures so far (>= 1). */
  _backoff(attempts) {
    const raw = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (attempts - 1));
    return Math.round(raw * (0.8 + this.random() * 0.4));
  }

  _evictDead() {
    const dead = [...this.items.entries()].filter(([, it]) => it.state === 'dead');
    for (const [id] of dead.slice(0, Math.max(0, dead.length - this.deadLimit))) {
      this.journal.append({ k: 'd', id, outcome: 'evicted' });
      this.items.delete(id);
    }
  }

  _compact() {
    this.journal.rewrite([...this.items.values()].map((it) => ({
      k: 'e',
      event: it.event,
      createdAt: it.createdAt,
      attempts: it.attempts,
      nextAt: it.nextAt,
      state: it.state,
      lastError: it.lastError,
    })));
  }

  _schedule() {
    clearTimeout(this._timer);
    this._timer = null;
    if (this._stopped || this._running) return;
    let next = null;
    for (const it of this.items.values()) {
      if (it.state === 'pending' && (next === null || it.nextAt < next)) next = it.nextAt;
    }
    if (next === null) return;
    const delay = Math.min(60_000, Math.max(50, Math.max(next, this._pausedUntil) - this.now()));
    this._timer = setTimeout(() => {
      this.processDue().catch((e) => this.log?.error({ err: e.message }, 'status outbox pass failed'));
    }, delay);
    this._timer.unref?.();
  }
}
