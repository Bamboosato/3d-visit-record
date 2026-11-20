import { describe, expect, it } from 'vitest';
import {
  doesVisitDateOverlapYear,
  extractDistinctYears,
  formatVisitDate,
  getVisitDateRange,
  normalizeVisitDate,
} from '../src/lib/visitDate';
import type { VisitSpot } from '../src/types/visit';

describe('visitDate', () => {
  it('normalizes valid single dates and strips equal end dates', () => {
    expect(normalizeVisitDate({ precision: 'day', start: '2026-08-15' })).toEqual({
      ok: true,
      value: { precision: 'day', start: '2026-08-15' },
    });

    expect(
      normalizeVisitDate({ precision: 'day', start: '2026-08-15', end: '2026-08-15' })
    ).toEqual({
      ok: true,
      value: { precision: 'day', start: '2026-08-15' },
    });

    expect(normalizeVisitDate({ precision: 'month', start: '2025-09', end: '2025-10' })).toEqual({
      ok: true,
      value: { precision: 'month', start: '2025-09', end: '2025-10' },
    });

    expect(normalizeVisitDate({ precision: 'year', start: '2018', end: '2020' })).toEqual({
      ok: true,
      value: { precision: 'year', start: '2018', end: '2020' },
    });

    expect(normalizeVisitDate({ precision: 'none', start: '2026-01-01' })).toEqual({
      ok: true,
      value: { precision: 'none' },
    });
  });

  it('validates leap years, invalid calendar dates, and end >= start', () => {
    expect(normalizeVisitDate({ precision: 'day', start: '2024-02-29' }).ok).toBe(true);
    expect(normalizeVisitDate({ precision: 'day', start: '2026-02-29' }).ok).toBe(false);
    expect(normalizeVisitDate({ precision: 'day', start: '2026-02-30' }).ok).toBe(false);
    expect(normalizeVisitDate({ precision: 'month', start: '2026-13' }).ok).toBe(false);
    expect(normalizeVisitDate({ precision: 'year', start: '1899' }).ok).toBe(false);
    expect(
      normalizeVisitDate({ precision: 'day', start: '2026-08-16', end: '2026-08-14' }).ok
    ).toBe(false);
    expect(
      normalizeVisitDate({ precision: 'month', start: '2025-10', end: '2025-09' }).ok
    ).toBe(false);
  });

  it('formats all 7 precision and range combinations cleanly', () => {
    expect(formatVisitDate({ precision: 'none' })).toBe('時期未定');
    expect(formatVisitDate({ precision: 'day', start: '2026-08-15' })).toBe('2026/08/15');
    expect(
      formatVisitDate({ precision: 'day', start: '2026-08-14', end: '2026-08-16' })
    ).toBe('2026/08/14 〜 2026/08/16');
    expect(formatVisitDate({ precision: 'month', start: '2025-10' })).toBe('2025年10月');
    expect(
      formatVisitDate({ precision: 'month', start: '2025-09', end: '2025-10' })
    ).toBe('2025年9月 〜 2025年10月');
    expect(formatVisitDate({ precision: 'year', start: '2019' })).toBe('2019年');
    expect(formatVisitDate({ precision: 'year', start: '2018', end: '2020' })).toBe(
      '2018年 〜 2020年'
    );
  });

  it('computes range boundaries and cross-year overlaps accurately', () => {
    expect(getVisitDateRange({ precision: 'month', start: '2024-02' })).toEqual({
      start: '20240201',
      end: '20240229',
    });

    const crossYear = { precision: 'day' as const, start: '2025-12-29', end: '2026-01-03' };
    expect(doesVisitDateOverlapYear(crossYear, 2024)).toBe(false);
    expect(doesVisitDateOverlapYear(crossYear, 2025)).toBe(true);
    expect(doesVisitDateOverlapYear(crossYear, 2026)).toBe(true);
    expect(doesVisitDateOverlapYear(crossYear, 2027)).toBe(false);

    const multiYear = { precision: 'year' as const, start: '2018', end: '2020' };
    expect(doesVisitDateOverlapYear(multiYear, 2019)).toBe(true);
    expect(doesVisitDateOverlapYear({ precision: 'none' }, 2026)).toBe(false);
  });

  it('extracts distinct covered years in descending order', () => {
    const spots: VisitSpot[] = [
      {
        id: 's1',
        name: '年末年始旅行',
        status: 'visited',
        category: 'tourism',
        center: [139.7, 35.6],
        elevation: 10,
        camera: { zoom: 12, pitch: 45, bearing: 0 },
        isPinned: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        entries: [
          {
            id: 'e1',
            kind: 'visited',
            date: { precision: 'day', start: '2024-12-30', end: '2025-01-02' },
            memo: '',
            photos: [],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
          {
            id: 'e2',
            kind: 'planned',
            date: { precision: 'year', start: '2027' },
            memo: '',
            photos: [],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
    ];
    expect(extractDistinctYears(spots)).toEqual([2027, 2025, 2024]);
  });
});
