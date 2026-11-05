import test from 'node:test';
import assert from 'node:assert/strict';
import { proto } from '@whiskeysockets/baileys';
import {
  BAILEYS_STATUS,
  buildStatusEvent,
  eventId,
  normalizeBaileysStatus,
  phoneFromJid,
  providerTimestamp,
} from '../src/status/normalize.js';

test('status codes match the installed Baileys enum', () => {
  const S = proto.WebMessageInfo.Status;
  for (const [name, value] of Object.entries(BAILEYS_STATUS)) assert.equal(S[name], value, name);
});

test('normalizes only confirmed statuses', () => {
  assert.equal(normalizeBaileysStatus(0), 'failed');
  assert.equal(normalizeBaileysStatus(2), 'sent');
  assert.equal(normalizeBaileysStatus(3), 'delivered');
  assert.equal(normalizeBaileysStatus(4), 'read');
  assert.equal(normalizeBaileysStatus(5), 'read'); // PLAYED
  assert.equal(normalizeBaileysStatus(1), null); // PENDING is not a confirmation
  assert.equal(normalizeBaileysStatus(undefined), null);
  assert.equal(normalizeBaileysStatus('read'), null);
});

test('provider timestamps: accepted when plausible, rejected otherwise', () => {
  const now = Date.UTC(2026, 10, 1, 12, 0, 0);
  const sec = now / 1000 - 30;
  assert.equal(providerTimestamp(sec, now), new Date(sec * 1000).toISOString());
  assert.equal(providerTimestamp({ toNumber: () => sec }, now), new Date(sec * 1000).toISOString()); // Long
  for (const bad of [0, -1, NaN, null, undefined, 'abc', 1000, now / 1000 + 3600]) {
    assert.equal(providerTimestamp(bad, now), null, String(bad));
  }
});

test('event uses provider timestamp when valid, observed otherwise', () => {
  const now = Date.UTC(2026, 10, 1, 12, 0, 0);
  const base = { provider: 'linked_gateway', messageId: 'M1', sender: '2348107920394', recipient: '2349138314501', status: 'delivered', nowMs: now };
  const withTs = buildStatusEvent({ ...base, providerSeconds: now / 1000 - 5 });
  assert.equal(withTs.timestamp_source, 'provider');
  assert.equal(withTs.occurred_at, new Date(now - 5000).toISOString());
  const without = buildStatusEvent({ ...base, providerSeconds: 0 });
  assert.equal(without.timestamp_source, 'observed');
  assert.equal(without.occurred_at, new Date(now).toISOString());
  assert.deepEqual(Object.keys(withTs), [
    'event_id', 'event', 'provider', 'message_id', 'sender', 'recipient', 'status', 'occurred_at', 'timestamp_source',
  ]);
  assert.equal(withTs.event, 'message_status');
});

test('event ids are stable and distinct per status', () => {
  assert.equal(eventId('a', 'M1', 'read'), eventId('a', 'M1', 'read'));
  assert.notEqual(eventId('a', 'M1', 'read'), eventId('a', 'M1', 'delivered'));
  assert.notEqual(eventId('a', 'M1', 'read'), eventId('a', 'M2', 'read'));
});

test('phoneFromJid strips device suffix and rejects non-phone JIDs', () => {
  assert.equal(phoneFromJid('2348107920394:12@s.whatsapp.net'), '2348107920394');
  assert.equal(phoneFromJid('2349138314501@s.whatsapp.net'), '2349138314501');
  assert.equal(phoneFromJid('123@lid'), null);
  assert.equal(phoneFromJid('1203@g.us'), null);
});
