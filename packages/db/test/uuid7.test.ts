import { describe, expect, it } from 'vitest';
import { createUuidV7Generator, UUID_RE, uuidv7, uuidv7Time } from '../src/uuid7.js';

const bits = (id: string) =>
  BigInt('0x' + id.replace(/-/g, ''))
    .toString(2)
    .padStart(128, '0');

describe('uuidv7', () => {
  it('is a well-formed UUID with version 7 and variant 10', () => {
    for (let i = 0; i < 1000; i++) {
      const id = uuidv7();
      expect(id).toMatch(UUID_RE);
      const b = bits(id);
      expect(b.slice(48, 52)).toBe('0111'); // version nibble
      expect(b.slice(64, 66)).toBe('10'); // variant
    }
  });

  it('encodes the clock in the first 48 bits', () => {
    const gen = createUuidV7Generator(() => 1_700_000_000_123);
    expect(uuidv7Time(gen())).toBe(1_700_000_000_123);
  });

  it('sorts by creation time as plain strings', () => {
    let now = 1_700_000_000_000;
    const gen = createUuidV7Generator(() => now);
    const ids: string[] = [];
    for (let i = 0; i < 2000; i++) {
      ids.push(gen());
      now += i % 3 === 0 ? 1 : 0; // some ids share a millisecond
    }
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('stays ordered inside one millisecond, even past the 12-bit counter', () => {
    const gen = createUuidV7Generator(() => 1_700_000_000_000);
    const ids = Array.from({ length: 10_000 }, gen);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('never goes backwards when the clock steps back', () => {
    let now = 1_700_000_005_000;
    const gen = createUuidV7Generator(() => now);
    const a = gen();
    now -= 4000;
    const b = gen();
    expect(b > a).toBe(true);
    expect(uuidv7Time(b)).toBeGreaterThanOrEqual(uuidv7Time(a));
  });

  it('fills the random part from a CSPRNG: same millisecond, different bits', () => {
    const tails = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const gen = createUuidV7Generator(() => 1_700_000_000_000); // fresh generator, same clock
      tails.add(gen().slice(19)); // variant + 62 random bits
    }
    expect(tails.size).toBeGreaterThan(195);
  });

  it('rejects a clock outside 48 bits', () => {
    expect(() => createUuidV7Generator(() => -1)()).toThrow(RangeError);
    expect(() => createUuidV7Generator(() => 2 ** 48)()).toThrow(RangeError);
  });
});
