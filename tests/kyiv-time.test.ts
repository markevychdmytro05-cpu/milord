import { describe, expect, it } from 'vitest';
import { kyivDateTimeInput, nextKyivSale, parseKyivDateTime } from '../src/core/kyiv-time';

describe('Kyiv sale time independent of the computer timezone', () => {
  it('converts 10:00 Kyiv in summer to 07:00 UTC', () => {
    expect(new Date(parseKyivDateTime('2026-09-26T10:00')).toISOString()).toBe('2026-09-26T07:00:00.000Z');
  });
  it('converts 10:00 Kyiv in winter to 08:00 UTC', () => {
    expect(new Date(parseKyivDateTime('2026-12-26T10:00')).toISOString()).toBe('2026-12-26T08:00:00.000Z');
  });
  it('handles the next 10:00 across both seasonal clock changes', () => {
    expect(new Date(parseKyivDateTime(nextKyivSale(Date.parse('2026-03-28T10:00:00Z')))).toISOString())
      .toBe('2026-03-29T07:00:00.000Z');
    expect(new Date(parseKyivDateTime(nextKyivSale(Date.parse('2026-10-24T10:00:00Z')))).toISOString())
      .toBe('2026-10-25T08:00:00.000Z');
  });
  it('defaults to the next 10:00 and displays logs in Kyiv time', () => {
    expect(nextKyivSale(Date.parse('2026-09-26T06:59:00Z'))).toBe('2026-09-26T10:00:00');
    expect(nextKyivSale(Date.parse('2026-09-26T07:00:00Z'))).toBe('2026-09-27T10:00:00');
    expect(kyivDateTimeInput(Date.parse('2026-12-26T08:00:00Z'))).toBe('2026-12-26T10:00:00');
  });
  it.each(['2026-02-30T10:00', 'bad', '2026-03-29T03:30', '2026-10-25T03:30'])(
    'rejects invalid, nonexistent or ambiguous local times: %s', (value) => {
      expect(() => parseKyivDateTime(value)).toThrow();
    });
});
