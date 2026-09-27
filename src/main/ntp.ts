import { createSocket } from 'node:dgram';
import { isFreshClockSync, type ClockSync } from '../core/clock-sync';
export type { ClockSync } from '../core/clock-sync';

// Atomic time over SNTP (RFC 4330), no request to the shop. It tells how far this computer's clock
// is from UTC; the buyer accounts for measurement uncertainty when scheduling the sale refresh.
const SERVERS = ['time.apple.com', 'time.google.com', 'time.cloudflare.com', 'pool.ntp.org'];
const NTP_EPOCH_OFFSET_S = 2_208_988_800;

// The four timestamps of one exchange give the standard offset ((t2 − t1) + (t3 − t4)) / 2.
export function parseSntpReply(reply: Buffer, sentAt: number, receivedAt: number): { offsetMs: number; delayMs: number } | undefined {
  if (reply.length < 48) return undefined;
  const mode = reply[0]! & 0x07, stratum = reply[1]!;
  if (mode !== 4 || stratum < 1 || stratum > 15) return undefined; // Server reply from a synchronized clock only.
  const read = (at: number) => (reply.readUInt32BE(at) - NTP_EPOCH_OFFSET_S) * 1000 + reply.readUInt32BE(at + 4) / 2 ** 32 * 1000;
  const received = read(32), transmitted = read(40);
  if (!Number.isFinite(received) || !Number.isFinite(transmitted) || received <= 0) return undefined;
  return {
    offsetMs: ((received - sentAt) + (transmitted - receivedAt)) / 2,
    delayMs: (receivedAt - sentAt) - (transmitted - received),
  };
}

function query(host: string, timeoutMs: number): Promise<{ offsetMs: number; delayMs: number } | undefined> {
  return new Promise((resolve) => {
    const socket = createSocket('udp4');
    const finish = (value?: { offsetMs: number; delayMs: number }) => { clearTimeout(timer); socket.close(); resolve(value); };
    const timer = setTimeout(() => finish(), timeoutMs);
    const request = Buffer.alloc(48);
    request[0] = 0x23; // version 4, client mode
    let sentAt = 0;
    socket.on('error', () => finish());
    socket.on('message', (reply) => finish(parseSntpReply(reply, sentAt, Date.now())));
    socket.send(request, 123, host, (error) => { if (error) finish(); else sentAt = Date.now(); });
  });
}

// Several servers, several rounds each: the reply with the shortest round trip is the most exact;
// the median across servers rejects a single bad one.
export async function measureClock(timeoutMs = 2000, rounds = 3): Promise<ClockSync | undefined> {
  const best = (await Promise.all(SERVERS.map(async (host) => {
    let chosen: { offsetMs: number; delayMs: number } | undefined;
    for (let round = 0; round < rounds; round++) {
      const reply = await query(host, timeoutMs);
      if (reply && reply.delayMs >= 0 && (!chosen || reply.delayMs < chosen.delayMs)) chosen = reply;
    }
    return chosen;
  }))).filter((reply): reply is { offsetMs: number; delayMs: number } => !!reply && reply.delayMs < 1000);
  return summarizeClockReplies(best, Date.now());
}

export function summarizeClockReplies(best: { offsetMs: number; delayMs: number }[], at: number): ClockSync | undefined {
  if (!best.length) return undefined;
  const offsets = best.map((reply) => reply.offsetMs).sort((a, b) => a - b);
  const median = offsets[Math.floor(offsets.length / 2)]!;
  const agreeing = best.filter((reply) => Math.abs(reply.offsetMs - median) <= 50);
  return {
    offsetMs: Math.round(median),
    // Cover each agreeing server's interval around the rounded estimate. The shortest RTT from
    // another server alone would understate the uncertainty of the median we actually use.
    uncertaintyMs: Math.ceil(Math.max(...agreeing.map((reply) =>
      Math.abs(reply.offsetMs - Math.round(median)) + reply.delayMs / 2))),
    at,
    servers: agreeing.length,
  };
}

export class AtomicClock {
  private latest?: ClockSync;
  private timer?: ReturnType<typeof setInterval>;
  constructor(private readonly measure = measureClock, private readonly intervalMs = 60_000) {}
  start(): void {
    const run = () => { void this.measure().then((sync) => { if (sync) this.latest = sync; }).catch(() => {}); };
    run();
    this.timer = setInterval(run, this.intervalMs);
    this.timer.unref?.();
  }
  stop(): void { clearInterval(this.timer); }
  // Only a recent reading agreed by at least two servers is trusted for the sale start.
  current(now = Date.now()): ClockSync | undefined {
    const sync = this.latest;
    return isFreshClockSync(sync, now) ? sync : undefined;
  }
  // For display: the last reading even if it has become stale.
  last(): ClockSync | undefined { return this.latest; }
}
