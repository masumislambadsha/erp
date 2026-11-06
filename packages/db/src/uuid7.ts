import { randomBytes } from 'node:crypto';

/**
 * UUIDv7 (RFC 9562): 48-bit Unix time in milliseconds, then version 7, a 12-bit counter, the
 * variant bits `10`, and 62 random bits. IDs from one generator never repeat and never go
 * backwards, even inside one millisecond or when the clock steps back, so index inserts stay
 * local. All randomness comes from node:crypto.
 */
export type Clock = () => number;

export interface UuidV7Generator {
  (): string;
}

const COUNTER_MAX = 0xfff; // 12 bits

export function createUuidV7Generator(clock: Clock = Date.now): UuidV7Generator {
  let lastMs = -1;
  let counter = 0;

  return () => {
    let ms = Math.floor(clock());
    if (!Number.isSafeInteger(ms) || ms < 0 || ms > 0xffff_ffff_ffff) {
      throw new RangeError('uuidv7: clock must return a time in ms that fits 48 bits');
    }
    const rand = randomBytes(10);
    if (ms > lastMs) {
      lastMs = ms;
      // A fresh millisecond starts the counter at a random value below 2^11, leaving headroom.
      counter = (((rand[8] ?? 0) << 8) | (rand[9] ?? 0)) & 0x7ff;
    } else {
      // Same millisecond, or the clock stepped back: keep the last time and count up.
      ms = lastMs;
      counter += 1;
      if (counter > COUNTER_MAX) {
        lastMs += 1; // counter exhausted: borrow the next millisecond
        ms = lastMs;
        counter = 0;
      }
    }

    const b = Buffer.alloc(16);
    b.writeUIntBE(ms, 0, 6);
    b[6] = 0x70 | (counter >> 8); // version 7 + counter high nibble
    b[7] = counter & 0xff;
    b[8] = 0x80 | ((rand[0] ?? 0) & 0x3f); // variant 10xx
    for (let i = 1; i < 8; i++) b[8 + i] = rand[i] ?? 0;
    const h = b.toString('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };
}

/** The default generator: use this for every app-generated ID. */
export const uuidv7: UuidV7Generator = createUuidV7Generator();

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Milliseconds since the epoch encoded in a UUIDv7. */
export function uuidv7Time(id: string): number {
  return parseInt(id.replace(/-/g, '').slice(0, 12), 16);
}
