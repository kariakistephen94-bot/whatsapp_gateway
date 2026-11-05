import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Journal } from '../src/status/journal.js';
import { StatusOutbox } from '../src/status/outbox.js';
import { StatusTracker } from '../src/status/tracker.js';
import { RECIPIENT_JID, SENDER_JID, fakeClock, silentLogger, tempDir } from './helpers.js';

const DELIVERY_ACK = 3;
const READ = 4;
const PLAYED = 5;
const ERROR = 0;

function setup(dir = tempDir(), clock = fakeClock()) {
  const outbox = new StatusOutbox({
    journal: new Journal(path.join(dir, 'outbox.jsonl')),
    send: async () => ({ ok: true }),
    now: clock.now,
    logger: silentLogger,
    autoStart: false,
  }).load();
  const tracker = new StatusTracker({
    journal: new Journal(path.join(dir, 'ledger.jsonl')),
    outbox,
    now: clock.now,
    logger: silentLogger,
  }).load();
  const statuses = () => [...outbox.items.values()].map((i) => i.event.status);
  return { dir, clock, outbox, tracker, statuses };
}

const sec = (clock, ago = 0) => Math.floor(clock.t / 1000) - ago;

test('emits sent at send time with sender/recipient as plain phone numbers', () => {
  const { tracker, outbox, clock } = setup();
  assert.equal(tracker.registerSent({ id: 'M1', to: RECIPIENT_JID, sender: SENDER_JID }), true);
  const [ev] = [...outbox.items.values()].map((i) => i.event);
  assert.deepEqual(ev, {
    event_id: ev.event_id,
    event: 'message_status',
    provider: 'linked_gateway',
    message_id: 'M1',
    sender: '2348107920394',
    recipient: '2349138314501',
    status: 'sent',
    occurred_at: new Date(clock.t).toISOString(),
    timestamp_source: 'observed',
  });
  assert.match(ev.event_id, /^gwevt_[0-9a-f]{32}$/);
});

test('delivered then read are emitted once each, with provider timestamps', () => {
  const { tracker, outbox, statuses, clock } = setup();
  tracker.registerSent({ id: 'M1', to: RECIPIENT_JID, sender: SENDER_JID });
  assert.equal(tracker.handleProviderUpdate({ id: 'M1', code: DELIVERY_ACK, timestamp: sec(clock, 20) }), 'emitted');
  assert.equal(tracker.handleProviderUpdate({ id: 'M1', code: READ, timestamp: sec(clock, 5) }), 'emitted');
  assert.deepEqual(statuses(), ['sent', 'delivered', 'read']);
  const delivered = [...outbox.items.values()].find((i) => i.event.status === 'delivered').event;
  assert.equal(delivered.timestamp_source, 'provider');
  assert.equal(delivered.occurred_at, new Date((sec(clock, 20)) * 1000).toISOString());
});

test('duplicate updates do not create duplicate events', () => {
  const { tracker, statuses, clock } = setup();
  tracker.registerSent({ id: 'M1', to: RECIPIENT_JID, sender: SENDER_JID });
  tracker.handleProviderUpdate({ id: 'M1', code: DELIVERY_ACK, timestamp: sec(clock) });
  assert.equal(tracker.handleProviderUpdate({ id: 'M1', code: DELIVERY_ACK, timestamp: sec(clock) }), 'duplicate');
  assert.equal(tracker.registerSent({ id: 'M1', to: RECIPIENT_JID, sender: SENDER_JID }), false);
  assert.deepEqual(statuses(), ['sent', 'delivered']);
});

test('read is never downgraded by a late delivered or sent', () => {
  const { tracker, statuses, clock } = setup();
  tracker.registerSent({ id: 'M1', to: RECIPIENT_JID, sender: SENDER_JID });
  tracker.handleProviderUpdate({ id: 'M1', code: READ, timestamp: sec(clock) });
  assert.equal(tracker.handleProviderUpdate({ id: 'M1', code: DELIVERY_ACK, timestamp: sec(clock, 10) }), 'stale');
  assert.equal(tracker.handleProviderUpdate({ id: 'M1', code: 2, timestamp: sec(clock, 10) }), 'duplicate'); // sent already emitted
  assert.deepEqual(statuses(), ['sent', 'read']); // delivered is not invented either
});

test('played counts as read', () => {
  const { tracker, statuses, clock } = setup();
  tracker.registerSent({ id: 'M1', to: RECIPIENT_JID, sender: SENDER_JID });
  tracker.handleProviderUpdate({ id: 'M1', code: PLAYED, timestamp: sec(clock) });
  assert.deepEqual(statuses(), ['sent', 'read']);
});

test('failed: emitted for a NACK, but never after a receipt, and a later receipt still wins', () => {
  const a = setup();
  a.tracker.registerSent({ id: 'M1', to: RECIPIENT_JID, sender: SENDER_JID });
  assert.equal(a.tracker.handleProviderUpdate({ id: 'M1', code: ERROR }), 'emitted');
  const failed = [...a.outbox.items.values()].find((i) => i.event.status === 'failed').event;
  assert.equal(failed.timestamp_source, 'observed');
  assert.equal(a.tracker.handleProviderUpdate({ id: 'M1', code: DELIVERY_ACK, timestamp: sec(a.clock) }), 'emitted');
  assert.deepEqual(a.statuses(), ['sent', 'failed', 'delivered']);

  const b = setup();
  b.tracker.registerSent({ id: 'M2', to: RECIPIENT_JID, sender: SENDER_JID });
  b.tracker.handleProviderUpdate({ id: 'M2', code: DELIVERY_ACK, timestamp: sec(b.clock) });
  assert.equal(b.tracker.handleProviderUpdate({ id: 'M2', code: ERROR }), 'stale');
  assert.deepEqual(b.statuses(), ['sent', 'delivered']);
});

test('no receipt means no failure: a silent message stays at sent', () => {
  const { tracker, statuses, clock, outbox } = setup();
  tracker.registerSent({ id: 'M1', to: RECIPIENT_JID, sender: SENDER_JID });
  clock.advance(30 * 86_400_000 - 1000);
  tracker.prune();
  assert.deepEqual(statuses(), ['sent']);
  assert.equal(outbox.stats().dead, 0);
});

test('updates for messages we did not send, PENDING, and unknown codes are ignored', () => {
  const { tracker, statuses } = setup();
  assert.equal(tracker.handleProviderUpdate({ id: 'NOT_OURS', code: READ, timestamp: 1 }), 'unknown');
  tracker.registerSent({ id: 'M1', to: RECIPIENT_JID, sender: SENDER_JID });
  assert.equal(tracker.handleProviderUpdate({ id: 'M1', code: 1 }), 'ignored');
  assert.equal(tracker.handleProviderUpdate({ id: 'M1', code: 99 }), 'ignored');
  assert.deepEqual(statuses(), ['sent']);
});

test('an update that races ahead of registerSent is applied afterwards, in order', () => {
  const { tracker, statuses, clock } = setup();
  tracker.handleProviderUpdate({ id: 'M1', code: DELIVERY_ACK, timestamp: sec(clock) });
  assert.deepEqual(statuses(), []);
  tracker.registerSent({ id: 'M1', to: RECIPIENT_JID, sender: SENDER_JID });
  assert.deepEqual(statuses(), ['sent', 'delivered']);
});

test('groups and broadcasts are not tracked', () => {
  const { tracker, statuses } = setup();
  assert.equal(tracker.registerSent({ id: 'G1', to: '120363@g.us', sender: SENDER_JID }), false);
  assert.equal(tracker.registerSent({ id: 'B1', to: 'status@broadcast', sender: SENDER_JID }), false);
  assert.deepEqual(statuses(), []);
});

test('ledger survives a restart: no re-emission and no downgrade', () => {
  const first = setup();
  first.tracker.registerSent({ id: 'M1', to: RECIPIENT_JID, sender: SENDER_JID });
  first.tracker.handleProviderUpdate({ id: 'M1', code: READ, timestamp: sec(first.clock) });
  const idsBefore = [...first.outbox.items.keys()];

  const second = setup(first.dir, first.clock);
  assert.deepEqual([...second.outbox.items.keys()], idsBefore); // pending events were replayed with the same IDs
  assert.equal(second.tracker.handleProviderUpdate({ id: 'M1', code: READ, timestamp: sec(first.clock) }), 'duplicate');
  assert.equal(second.tracker.handleProviderUpdate({ id: 'M1', code: DELIVERY_ACK, timestamp: sec(first.clock) }), 'stale');
  assert.equal(second.outbox.items.size, idsBefore.length);
  const ev = second.outbox.items.get(idsBefore[1]).event;
  assert.equal(ev.recipient, '2349138314501');
});

test('old ledger entries are pruned after the TTL', () => {
  const { tracker, clock, dir } = setup();
  tracker.registerSent({ id: 'M1', to: RECIPIENT_JID, sender: SENDER_JID });
  clock.advance(31 * 86_400_000);
  tracker.prune();
  assert.equal(tracker.messages.size, 0);
  assert.equal(setup(dir, clock).tracker.messages.size, 0);
});
