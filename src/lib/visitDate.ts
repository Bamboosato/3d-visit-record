import type { VisitDate, VisitDatePrecision, VisitSpot } from '../types/visit';

export const MIN_VISIT_YEAR = 1900;
export const MAX_VISIT_YEAR = 2100;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function isValidDatePart(precision: Exclude<VisitDatePrecision, 'none'>, value: string): boolean {
  if (typeof value !== 'string') return false;
  if (precision === 'day') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!m) return false;
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    if (year < MIN_VISIT_YEAR || year > MAX_VISIT_YEAR) return false;
    if (month < 1 || month > 12) return false;
    return day >= 1 && day <= daysInMonth(year, month);
  }
  if (precision === 'month') {
    const m = /^(\d{4})-(\d{2})$/.exec(value);
    if (!m) return false;
    const year = Number(m[1]);
    const month = Number(m[2]);
    if (year < MIN_VISIT_YEAR || year > MAX_VISIT_YEAR) return false;
    return month >= 1 && month <= 12;
  }
  const m = /^(\d{4})$/.exec(value);
  if (!m) return false;
  const year = Number(m[1]);
  return year >= MIN_VISIT_YEAR && year <= MAX_VISIT_YEAR;
}

export function normalizeVisitDate(input: VisitDate):
  | { ok: true; value: VisitDate }
  | { ok: false; error: string } {
  if (!input || typeof input !== 'object') {
    return { ok: false, error: '日付情報の形式が不正です。' };
  }
  const { precision } = input;
  if (precision === 'none') {
    return { ok: true, value: { precision: 'none' } };
  }
  if (precision !== 'day' && precision !== 'month' && precision !== 'year') {
    return { ok: false, error: '日付の精度が不正です。' };
  }
  const start = typeof input.start === 'string' ? input.start.trim() : '';
  if (!start || !isValidDatePart(precision, start)) {
    return {
      ok: false,
      error:
        precision === 'day'
          ? '開始日を正しい日付（YYYY-MM-DD）で入力してください。'
          : precision === 'month'
            ? '開始月を正しい年月（YYYY-MM）で入力してください。'
            : '開始年を4桁（1900〜2100）で入力してください。',
    };
  }

  const endRaw = typeof input.end === 'string' ? input.end.trim() : '';
  if (!endRaw) {
    return { ok: true, value: { precision, start } };
  }
  if (!isValidDatePart(precision, endRaw)) {
    return {
      ok: false,
      error:
        precision === 'day'
          ? '終了日を正しい日付（YYYY-MM-DD）で入力してください。'
          : precision === 'month'
            ? '終了月を正しい年月（YYYY-MM）で入力してください。'
            : '終了年を4桁（1900〜2100）で入力してください。',
    };
  }
  if (endRaw < start) {
    return { ok: false, error: '終了日時は開始日時以降を指定してください。' };
  }
  if (endRaw === start) {
    return { ok: true, value: { precision, start } };
  }
  return { ok: true, value: { precision, start, end: endRaw } };
}

export function isValidVisitDate(date: unknown): date is VisitDate {
  if (!date || typeof date !== 'object') return false;
  const d = date as Partial<VisitDate>;
  if (d.precision === 'none') {
    return d.start === undefined && d.end === undefined;
  }
  const normalized = normalizeVisitDate(d as VisitDate);
  return normalized.ok;
}

function toBoundaryYmd(
  precision: Exclude<VisitDatePrecision, 'none'>,
  value: string,
  bound: 'start' | 'end'
): string {
  if (precision === 'day') {
    return value.replace(/-/g, '');
  }
  if (precision === 'month') {
    const [yStr, mStr] = value.split('-');
    const lastDay = daysInMonth(Number(yStr), Number(mStr));
    return bound === 'start' ? `${yStr}${mStr}01` : `${yStr}${mStr}${String(lastDay).padStart(2, '0')}`;
  }
  return bound === 'start' ? `${value}0101` : `${value}1231`;
}

export function getVisitDateRange(date: VisitDate): { start: string; end: string } | null {
  if (date.precision === 'none' || !date.start) return null;
  if (!isValidDatePart(date.precision, date.start)) return null;
  const rangeStart = toBoundaryYmd(date.precision, date.start, 'start');
  const endPart = date.end && isValidDatePart(date.precision, date.end) ? date.end : date.start;
  const rangeEnd = toBoundaryYmd(date.precision, endPart, 'end');
  return rangeEnd >= rangeStart
    ? { start: rangeStart, end: rangeEnd }
    : { start: rangeStart, end: toBoundaryYmd(date.precision, date.start, 'end') };
}

export function doesVisitDateOverlapRange(
  date: VisitDate,
  filterStartYmd: string,
  filterEndYmd: string
): boolean {
  const range = getVisitDateRange(date);
  if (!range) return false;
  return range.start <= filterEndYmd && range.end >= filterStartYmd;
}

export function doesVisitDateOverlapYear(date: VisitDate, year: number): boolean {
  if (!Number.isInteger(year) || year < MIN_VISIT_YEAR || year > MAX_VISIT_YEAR) return false;
  const y = String(year);
  return doesVisitDateOverlapRange(date, `${y}0101`, `${y}1231`);
}

function formatSinglePart(precision: Exclude<VisitDatePrecision, 'none'>, value: string): string {
  if (precision === 'day') {
    return value.replace(/-/g, '/');
  }
  if (precision === 'month') {
    const [y, m] = value.split('-');
    return `${y}年${Number(m)}月`;
  }
  return `${value}年`;
}

export function formatVisitDate(date: VisitDate): string {
  if (date.precision === 'none' || !date.start) return '時期未定';
  const startLabel = formatSinglePart(date.precision, date.start);
  if (date.end && date.end !== date.start) {
    return `${startLabel} 〜 ${formatSinglePart(date.precision, date.end)}`;
  }
  return startLabel;
}

export function extractDistinctYears(spots: VisitSpot[]): number[] {
  const years = new Set<number>();
  for (const spot of spots) {
    for (const entry of spot.entries) {
      const range = getVisitDateRange(entry.date);
      if (!range) continue;
      const startYear = Number(range.start.slice(0, 4));
      const endYear = Number(range.end.slice(0, 4));
      for (let y = startYear; y <= endYear; y++) {
        if (y >= MIN_VISIT_YEAR && y <= MAX_VISIT_YEAR) years.add(y);
      }
    }
  }
  return [...years].sort((a, b) => b - a);
}

export function getTodayDateString(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function getCurrentMonthString(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}
