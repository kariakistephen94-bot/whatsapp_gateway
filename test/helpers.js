import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';

export function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-gw-test-'));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function fakeClock(start = Date.UTC(2026, 10, 1, 12, 0, 0)) {
  const clock = { t: start, now: () => clock.t, advance: (ms) => { clock.t += ms; } };
  return clock;
}

export const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

export const SENDER_JID = '2348107920394:12@s.whatsapp.net';
export const RECIPIENT_JID = '2349138314501@s.whatsapp.net';
