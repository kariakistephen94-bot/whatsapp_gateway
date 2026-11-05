import fs from 'node:fs';
import path from 'node:path';

/**
 * Append-only JSON-lines file with fsync on every append.
 * A torn final line left by a crash is skipped on load and never glued to the next record.
 */
export class Journal {
  constructor(file) {
    this.file = file;
    this.fd = null;
    this.lines = 0;
    this.skipped = 0;
    this._needsNewline = false;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  }

  load() {
    let raw = '';
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const records = [];
    this.skipped = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { records.push(JSON.parse(line)); } catch { this.skipped++; }
    }
    this.lines = records.length;
    this._needsNewline = raw.length > 0 && !raw.endsWith('\n');
    return records;
  }

  append(record) {
    if (this.fd === null) this.fd = fs.openSync(this.file, 'a', 0o600);
    const prefix = this._needsNewline ? '\n' : '';
    this._needsNewline = false;
    fs.writeSync(this.fd, `${prefix}${JSON.stringify(record)}\n`);
    fs.fsyncSync(this.fd);
    this.lines++;
  }

  /** Atomically replace the file's contents (compaction). */
  rewrite(records) {
    const tmp = `${this.file}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeSync(fd, records.map((r) => `${JSON.stringify(r)}\n`).join(''));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.close();
    fs.renameSync(tmp, this.file);
    this.lines = records.length;
    this._needsNewline = false;
  }

  close() {
    if (this.fd !== null) { fs.closeSync(this.fd); this.fd = null; }
  }
}
