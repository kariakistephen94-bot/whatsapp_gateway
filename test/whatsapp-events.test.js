import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { WhatsAppClient } from '../src/whatsapp.js';
import { createStatusPipeline } from '../src/status/index.js';
import { RECIPIENT_JID, SENDER_JID, silentLogger, tempDir } from './helpers.js';

function fakeClient() {
  const wa = new WhatsAppClient({ authDir: 'unused', minSendIntervalMs: 0 });
  const ev = new EventEmitter();
  const sent = [];
  wa.sock = {
    user: { id: SENDER_JID },
    sendMessage: async (jid, content) => { sent.push({ jid, content }); return { key: { id: `ID${sent.length}`, remoteJid: jid, fromMe: true } }; },
  };
  wa.state = 'open';
  wa._bindStatusEvents(ev);
  return { wa, ev, sent };
}

test('send results are unchanged and announce the sent message', async () => {
  const { wa } = fakeClient();
  const announced = [];
  wa.on('outbound-sent', (m) => announced.push(m));
  assert.deepEqual(await wa.sendText('2349138314501', 'hi'), { id: 'ID1', to: RECIPIENT_JID });
  assert.deepEqual(announced, [{ id: 'ID1', to: RECIPIENT_JID, sender: SENDER_JID }]);
});

test('a throwing status listener cannot break /send', async () => {
  const { wa } = fakeClient();
  wa.on('outbound-sent', () => { throw new Error('listener bug'); });
  assert.deepEqual(await wa.sendText('2349138314501', 'hi'), { id: 'ID1', to: RECIPIENT_JID });
});

test('status updates become outbound-status only; they are never inbound messages and never trigger a send', async () => {
  const { wa, ev, sent } = fakeClient();
  const statuses = [];
  const inbound = [];
  wa.on('outbound-status', (s) => statuses.push(s));
  wa.on('message', (m) => inbound.push(m));

  ev.emit('messages.update', [
    { key: { id: 'A', fromMe: true, remoteJid: RECIPIENT_JID }, update: { status: 4, messageTimestamp: 1782000000 } },
    { key: { id: 'B', fromMe: false, remoteJid: RECIPIENT_JID }, update: { status: 4 } }, // our read of an inbound message
    { key: { id: 'C', fromMe: true, remoteJid: RECIPIENT_JID }, update: { message: {} } }, // edit, not a status
  ]);
  assert.deepEqual(statuses, [{ id: 'A', code: 4, timestamp: 1782000000 }]);
  assert.deepEqual(inbound, []);
  assert.deepEqual(sent, []);
});

test('end to end: send, receipts out of order and duplicated, nothing sent back to WhatsApp', async () => {
  const dir = tempDir();
  const posted = [];
  const pipeline = createStatusPipeline({
    env: { STATUS_WEBHOOK_URL: 'http://127.0.0.1:9/hook', STATUS_WEBHOOK_SECRET: 'status-secret-0123456789', STATUS_DATA_DIR: dir },
    logger: silentLogger,
    fetchImpl: async (_url, init) => { posted.push(JSON.parse(init.body)); return new Response(null, { status: 200 }); },
  });
  const { wa, ev, sent } = fakeClient();
  pipeline.attach(wa);
  pipeline.start();

  await wa.sendText('2349138314501', 'hi');
  const nowSec = Math.floor(Date.now() / 1000);
  const upd = (status) => ev.emit('messages.update', [{ key: { id: 'ID1', fromMe: true, remoteJid: RECIPIENT_JID }, update: { status, messageTimestamp: nowSec } }]);
  upd(4); upd(3); upd(4); upd(3); // read, late delivered, duplicates
  await pipeline.outbox.processDue();
  await pipeline.stop();

  assert.deepEqual(posted.map((e) => e.status), ['sent', 'read']);
  assert.equal(new Set(posted.map((e) => e.event_id)).size, 2);
  assert.equal(posted[1].timestamp_source, 'provider');
  assert.equal(sent.length, 1); // only the original message; status handling sent nothing
  assert.ok(path.isAbsolute(path.resolve(dir)));
});
