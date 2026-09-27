import { expect, it } from 'vitest';
import { AtomicClock, parseSntpReply } from '../src/main/ntp';

const reply = (receiveMs: number, transmitMs: number, stratum = 2) => {
  const buffer = Buffer.alloc(48);
  buffer[0] = 0x24; buffer[1] = stratum;
  const write = (at: number, ms: number) => {
    const seconds = Math.floor(ms / 1000) + 2_208_988_800;
    buffer.writeUInt32BE(seconds, at); buffer.writeUInt32BE(Math.round((ms % 1000) / 1000 * 2 ** 32) >>> 0, at + 4);
  };
  write(32, receiveMs); write(40, transmitMs);
  return buffer;
};

it('computes the clock offset and network delay from one SNTP exchange', () => {
  // Local clock 42 ms slow; 10 ms each way; the server spends 1 ms.
  const sentLocal = 1_790_000_000_000;
  const result = parseSntpReply(reply(sentLocal + 42 + 10, sentLocal + 42 + 11), sentLocal, sentLocal + 21)!;
  expect(result.offsetMs).toBeCloseTo(42, 0);
  expect(result.delayMs).toBeCloseTo(20, 0);
});

it('ignores replies from unsynchronized or malformed servers', () => {
  expect(parseSntpReply(reply(1, 1, 0), 0, 0)).toBeUndefined();
  expect(parseSntpReply(Buffer.alloc(10), 0, 0)).toBeUndefined();
});

it('trusts only a recent reading confirmed by two servers', async () => {
  const clock = new AtomicClock(async () => ({ offsetMs: 42, uncertaintyMs: 5, at: 1000, servers: 1 }));
  clock.start(); await new Promise((resolve) => setTimeout(resolve, 0)); clock.stop();
  expect(clock.current(2000)).toBeUndefined();
  expect(clock.last()?.offsetMs).toBe(42);
  const agreed = new AtomicClock(async () => ({ offsetMs: 42, uncertaintyMs: 5, at: 1000, servers: 3 }));
  agreed.start(); await new Promise((resolve) => setTimeout(resolve, 0)); agreed.stop();
  expect(agreed.current(2000)?.offsetMs).toBe(42);
  expect(agreed.current(1000 + 11 * 60_000)).toBeUndefined();
});
