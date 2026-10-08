/**
 * Collection photos: the driver's picture of the order as they collect it, so
 * a "missing Coke" dispute is settled by looking.
 *
 * Files on disk, not rows in the database: a few hundred kilobytes each would
 * bloat every database backup. They live in PHOTO_DIR (default: photos/ next to
 * the database, inside the service's writable /var/lib/dispatch) and are
 * deleted after PHOTO_RETENTION_DAYS (default 30), which is all a dispute needs
 * and as little as POPIA asks of us. They are deliberately not backed up.
 */
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, unlinkSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { randomBytes } from 'node:crypto';

export const MAX_PHOTO_BYTES = 3 * 1024 * 1024;
const DAY_MS = 86400 * 1000;

/** A JPEG starts FF D8 FF. Anything else is not a photo from the app's camera. */
export const isJpeg = (buf) => Buffer.isBuffer(buf) && buf.length > 3
  && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;

export class PhotoStore {
  constructor({ dir, retentionDays = 30, now = () => Date.now() }) {
    this.dir = dir;
    this.retentionMs = retentionDays * DAY_MS;
    this.now = now;
  }

  /** Save one photo; returns its file name (never a client-chosen path). */
  save(buffer) {
    // Created on first use, so a server (or test) that never sees a photo
    // leaves no empty folder behind.
    mkdirSync(this.dir, { recursive: true });
    const file = `collect-${this.now().toString(36)}-${randomBytes(8).toString('hex')}.jpg`;
    writeFileSync(join(this.dir, file), buffer);
    return file;
  }

  /** The photo's bytes, or null if it was never there or has been deleted. */
  read(file) {
    const safe = basename(String(file ?? ''));
    if (!safe || safe !== file) return null;
    const p = join(this.dir, safe);
    return existsSync(p) ? readFileSync(p) : null;
  }

  /** Delete photos older than the retention period. Returns the files removed. */
  sweep() {
    const cutoff = this.now() - this.retentionMs;
    const removed = [];
    if (!existsSync(this.dir)) return removed;
    for (const f of readdirSync(this.dir)) {
      if (!/^collect-.*\.jpg$/.test(f)) continue;
      const p = join(this.dir, f);
      try {
        if (statSync(p).mtimeMs < cutoff) { unlinkSync(p); removed.push(f); }
      } catch { /* gone already */ }
    }
    return removed;
  }
}
