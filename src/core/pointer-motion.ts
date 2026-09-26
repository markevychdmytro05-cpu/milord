export interface PointerPoint { x: number; y: number; }
export interface PointerStep extends PointerPoint { waitMs: number; }
export interface BehaviorTestResult { moves: number; scrolls: number; navigations: number; durationMs: number; stopped: boolean; }
export function profileMotionTempo(profileId: string): number {
  let hash = 2166136261;
  for (const char of profileId) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return 0.8 + (hash >>> 0) % 601 / 1000;
}
// Smooth acceleration and deceleration, with different curvature and timing per gesture.
export function pointerPath(from: PointerPoint, to: PointerPoint, width: number, height: number,
  tempo: number, random = Math.random): PointerStep[] {
  const dx = to.x - from.x, dy = to.y - from.y;
  const distance = Math.hypot(dx, dy) || 1;
  const bend = (random() - 0.5) * Math.min(distance * 0.6, 180);
  const c1 = { x: from.x + dx * 0.3 - dy / distance * bend, y: from.y + dy * 0.3 + dx / distance * bend };
  const c2 = { x: from.x + dx * 0.75 - dy / distance * bend * 0.4, y: from.y + dy * 0.75 + dx / distance * bend * 0.4 };
  const duration = (350 + Math.min(distance, 900) * 0.7 + random() * 250) * tempo;
  const steps = Math.ceil(duration / 22);
  return Array.from({ length: steps }, (_, index) => {
    const t = (index + 1) / steps;
    const u = t * t * t * (10 + t * (-15 + 6 * t)), v = 1 - u;
    return {
      x: Math.max(1, Math.min(width - 1, v ** 3 * from.x + 3 * v ** 2 * u * c1.x + 3 * v * u ** 2 * c2.x + u ** 3 * to.x)),
      y: Math.max(1, Math.min(height - 1, v ** 3 * from.y + 3 * v ** 2 * u * c1.y + 3 * v * u ** 2 * c2.y + u ** 3 * to.y)),
      waitMs: duration / steps * (0.7 + random() * 0.6),
    };
  });
}
