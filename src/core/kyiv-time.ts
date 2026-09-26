export const SALE_TIME_ZONE = 'Europe/Kyiv';

const formatter = new Intl.DateTimeFormat('sv-SE', {
  timeZone: SALE_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

export function kyivDateTimeInput(timestamp: number): string {
  const parts = Object.fromEntries(formatter.formatToParts(timestamp).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

export function parseKyivDateTime(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) throw new Error('Вкажіть дату й час продажу за Києвом.');
  const normalized = value.length === 16 ? `${value}:00` : value;
  const wallTime = Date.parse(`${normalized}Z`);
  if (!Number.isFinite(wallTime) || new Date(wallTime).toISOString().slice(0, 19) !== normalized) {
    throw new Error('Некоректна дата продажу.');
  }
  const candidates = new Set<number>();
  // Sample both sides of a possible DST transition; never infer the computer's local timezone.
  for (const delta of [-86_400_000, 0, 86_400_000]) {
    const sample = wallTime + delta;
    const offset = Date.parse(`${kyivDateTimeInput(sample)}Z`) - sample;
    const instant = wallTime - offset;
    if (kyivDateTimeInput(instant) === normalized) candidates.add(instant);
  }
  if (candidates.size !== 1) throw new Error('Цей час відсутній або повторюється через переведення годинника. Оберіть інший час.');
  return [...candidates][0]!;
}

export function nextKyivSale(now = Date.now()): string {
  const date = kyivDateTimeInput(now).slice(0, 10);
  const today = `${date}T10:00:00`;
  if (parseKyivDateTime(today) > now) return today;
  const tomorrow = new Date(Date.parse(`${date}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return `${tomorrow}T10:00:00`;
}
