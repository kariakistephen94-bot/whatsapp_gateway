import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Journal } from '../src/status/journal.js';
import { StatusOutbox } from '../src/status/outbox.js';
import { fakeClock, silentLogger, tempDir } from './helpers.js';

const ev = (messageId, status) => ({
  event_id: `evt_${messageId}_${status}`,
  event: 'message_status',
  provider: 'linked_gateway',
  message_id: messageId,
  sender: '2348107920394',
  recipient: '2349138314501',
  status,
  occurred_at: '2026-11-01T12:00:00.000Z',
  timestamp_source: 'observed',
});

function make({ dir = tempDir(), clock = fakeClock(), send, ...opts } = {}) {
  const calls = [];
  const outbox = new StatusOutbox({
    journal: new Journal(path.join(dir, 'outbox.jsonl')),
    send: async (e) => { calls.push(structuredClone(e)); return send ? send(e, calls.length) : { ok: true }; },
    now: clock.now,
    random: () => 0.5, // no jitter
    baseDelayMs: 1000,
    maxDelayMs: 8000,
    maxAttempts: 4,
    logger: silentLogger,
    autoStart: false,
    ...opts,
  }).load();
  return { dir, clock, outbox, calls };
}

test('delivers and removes an event', async () => {
  const { outbox, calls } = make();
  outbox.enqueue(ev('M1', 'sent'));
  await outbox.processDue();
  assert.equal(calls.length, 1);
  assert.equal(outbox.items.size, 0);
});

test('retries with exponential backoff, resending the identical event', async () => {
  const { outbox, calls, clock } = make({ send: (_e, n) => (n < 3 ? { ok: false, error: 'http 503' } : { ok: true }) });
  const original = ev('M1', 'delivered');
  outbox.enqueue(original);

  await outbox.processDue();
  assert.equal(calls.length, 1);
  await outbox.processDue(); // not due yet
  assert.equal(calls.length, 1);

  clock.advance(1000); // 1st backoff = 1s
  await outbox.processDue();
  assert.equal(calls.length, 2);
  clock.advance(1999); // 2nd backoff = 2s
  await outbox.processDue();
  assert.equal(calls.length, 2);
  clock.advance(1);
  await outbox.processDue();
  assert.equal(calls.length, 3);

  for (const c of calls) assert.deepEqual(c, original);
  assert.equal(outbox.items.size, 0);
});

test('backoff is capped', () => {
  const { outbox } = make();
  assert.deepEqual([1, 2, 3, 4, 5, 9].map((n) => outbox._backoff(n)), [1000, 2000, 4000, 8000, 8000, 8000]);
});

test('gives up after maxAttempts, parks the event, and can re-queue it', async () => {
  const { outbox, calls, clock } = make({ send: () => ({ ok: false, error: 'http 500' }) });
  outbox.enqueue(ev('M1', 'read'));
  for (let i = 0; i < 10; i++) { await outbox.processDue(); clock.advance(60_000); }
  assert.equal(calls.length, 4);
  assert.deepEqual(outbox.stats().dead, 1);
  assert.equal(outbox.stats().pending, 0);
  assert.equal(outbox.listDead()[0].last_error, 'http 500');

  assert.equal(outbox.retryDead(), 1);
  await outbox.processDue();
  assert.equal(calls.length, 5);
  assert.equal(calls[4].event_id, calls[0].event_id);
});

test('a permanent rejection is parked immediately', async () => {
  const { outbox, calls } = make({ send: () => ({ ok: false, error: 'http 422', permanent: true }) });
  outbox.enqueue(ev('M1', 'read'));
  await outbox.processDue();
  assert.equal(calls.length, 1);
  assert.equal(outbox.stats().dead, 1);
});

test('a throwing sender is treated as a retryable failure', async () => {
  const { outbox } = make({ send: () => { throw new Error('boom'); } });
  outbox.enqueue(ev('M1', 'read'));
  await outbox.processDue();
  assert.equal(outbox.items.get('evt_M1_read').attempts, 1);
  assert.equal(outbox.items.get('evt_M1_read').state, 'pending');
});

test('duplicate event IDs are not queued twice', () => {
  const { outbox } = make();
  assert.equal(outbox.enqueue(ev('M1', 'sent')), true);
  assert.equal(outbox.enqueue(ev('M1', 'sent')), false);
  assert.equal(outbox.items.size, 1);
});

test('events of one message stay in order while an earlier one is retrying; other messages are not blocked by it', async () => {
  const order = [];
  const { outbox, clock } = make({
    send: (e) => {
      order.push(e.event_id);
      return e.event_id === 'evt_M1_sent' && order.filter((x) => x === 'evt_M1_sent').length === 1
        ? { ok: false, error: 'http 502' } : { ok: true };
    },
  });
  outbox.enqueue(ev('M1', 'sent'));
  outbox.enqueue(ev('M1', 'read'));
  outbox.enqueue(ev('M2', 'sent'));
  await outbox.processDue();
  assert.deepEqual(order, ['evt_M1_sent']); // endpoint looks unhealthy: pause the pass
  clock.advance(1000);
  await outbox.processDue();
  assert.deepEqual(order, ['evt_M1_sent', 'evt_M1_sent', 'evt_M1_read', 'evt_M2_sent']);
});

test('pending and parked events survive a restart with attempts and IDs intact', async () => {
  const first = make({ send: () => ({ ok: false, error: 'http 503' }) });
  first.outbox.enqueue(ev('M1', 'delivered'));
  first.outbox.enqueue(ev('M2', 'read'));
  await first.outbox.processDue();
  const attempts = first.outbox.items.get('evt_M1_delivered').attempts;
  first.outbox.journal.close();

  const second = make({ dir: first.dir, clock: first.clock });
  assert.deepEqual([...second.outbox.items.keys()], ['evt_M1_delivered', 'evt_M2_read']);
  assert.equal(second.outbox.items.get('evt_M1_delivered').attempts, attempts);
  first.clock.advance(60_000);
  await second.outbox.processDue();
  assert.deepEqual(second.calls.map((c) => c.event_id), ['evt_M1_delivered', 'evt_M2_read']);
  assert.equal(second.outbox.items.size, 0);
});

test('a torn last journal line from a crash is skipped and does not corrupt the next record', () => {
  const dir = tempDir();
  const file = path.join(dir, 'outbox.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({ k: 'e', event: ev('M1', 'sent'), createdAt: 1 })}\n{"k":"e","event":{"event_id":"evt_tor`);
  const a = make({ dir });
  assert.deepEqual([...a.outbox.items.keys()], ['evt_M1_sent']);
  a.outbox.enqueue(ev('M2', 'sent'));
  a.outbox.journal.close();
  assert.deepEqual([...make({ dir }).outbox.items.keys()], ['evt_M1_sent', 'evt_M2_sent']);
});

test('journal file is private to the owner', () => {
  const { outbox, dir } = make();
  outbox.enqueue(ev('M1', 'sent'));
  assert.equal(fs.statSync(path.join(dir, 'outbox.jsonl')).mode & 0o077, 0);
});
