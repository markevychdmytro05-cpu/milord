export interface PointerPoint { x: number; y: number; }
export interface PointerStep extends PointerPoint { waitMs: number; }
export type BehaviorLogin = 'logged-in' | 'logged-out' | 'unknown';
export interface BehaviorTestResult {
  moves: number; scrolls: number; navigations: number; pauses: number; durationMs: number; stopped: boolean;
  login: BehaviorLogin; loginNote?: string;
}
export function profileMotionTempo(profileId: string): number {
  let hash = 2166136261;
  for (const char of profileId) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return 0.8 + (hash >>> 0) % 601 / 1000;
}
export interface PointerCurve { durationMs: number; at(t: number): PointerPoint; }
// Smooth acceleration and deceleration, with different curvature and timing per gesture.
export function pointerCurve(from: PointerPoint, to: PointerPoint, width: number, height: number,
  tempo: number, random = Math.random): PointerCurve {
  const dx = to.x - from.x, dy = to.y - from.y;
  const distance = Math.hypot(dx, dy) || 1;
  const bend = (random() - 0.5) * Math.min(distance * 0.6, 180);
  const c1 = { x: from.x + dx * 0.3 - dy / distance * bend, y: from.y + dy * 0.3 + dx / distance * bend };
  const c2 = { x: from.x + dx * 0.75 - dy / distance * bend * 0.4, y: from.y + dy * 0.75 + dx / distance * bend * 0.4 };
  return {
    durationMs: (350 + Math.min(distance, 900) * 0.7 + random() * 250) * tempo,
    at: (t) => {
      const u = t * t * t * (10 + t * (-15 + 6 * t)), v = 1 - u;
      return {
        x: Math.max(1, Math.min(width - 1, v ** 3 * from.x + 3 * v ** 2 * u * c1.x + 3 * v * u ** 2 * c2.x + u ** 3 * to.x)),
        y: Math.max(1, Math.min(height - 1, v ** 3 * from.y + 3 * v ** 2 * u * c1.y + 3 * v * u ** 2 * c2.y + u ** 3 * to.y)),
      };
    },
  };
}

// The same curve sampled at a steady 60 Hz, like a real mouse reports its position.
export const POINTER_FRAME_MS = 16;
export function pointerPath(from: PointerPoint, to: PointerPoint, width: number, height: number,
  tempo: number, random = Math.random): PointerStep[] {
  const curve = pointerCurve(from, to, width, height, tempo, random);
  const steps = Math.max(1, Math.ceil(curve.durationMs / POINTER_FRAME_MS));
  return Array.from({ length: steps }, (_, index) => ({ ...curve.at((index + 1) / steps), waitMs: curve.durationMs / steps }));
}

// Drives a curve by elapsed time rather than by step count, so a slow browser round trip never
// stretches or jerks the motion: the next event simply lands where the pointer should be by now.
// Stops early, mid-curve, at `until`. Returns the last position sent.
export async function glidePointer(curve: PointerCurve, move: (point: PointerPoint) => Promise<void>,
  clock: { now(): number; sleep(ms: number, signal: AbortSignal): Promise<void> }, signal: AbortSignal,
  until = Infinity): Promise<PointerPoint> {
  const started = clock.now();
  let last = curve.at(0);
  for (;;) {
    const frameAt = clock.now();
    const t = Math.min(1, (frameAt - started) / Math.max(1, curve.durationMs));
    last = curve.at(t);
    await move(last);
    if (t >= 1) return last;
    const next = Math.max(1, POINTER_FRAME_MS - (clock.now() - frameAt));
    if (clock.now() + next > until) return last;
    await clock.sleep(next, signal);
  }
}

// A wheel gesture of 3–8 uneven notches that together scroll by `amount`.
export function wheelSteps(amount: number, random = Math.random): number[] {
  const weights = Array.from({ length: 3 + Math.floor(random() * 6) }, () => 0.4 + random());
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return weights.map(weight => amount * weight / total);
}

// Mostly short glances, sometimes reading a page, rarely stepping away for a while.
export function readingPauseMs(tempo: number, random = Math.random): number {
  const roll = random();
  if (roll < 0.06) return (15_000 + random() * 25_000) * tempo;
  if (roll < 0.26) return (3000 + random() * 9000) * tempo;
  return (400 + random() * 1200) * tempo;
}
