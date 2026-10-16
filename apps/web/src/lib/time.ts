export function getIsoTimestr(): string {
  return new Date().toISOString();
}

export const getTimestamp = () => {
  return Date.parse(new Date().toUTCString()) / 1000;
};

export const getMillisecond = () => {
  return new Date().getTime();
};

export function formatDateTime(
  input: string | number | Date | null | undefined
): string {
  if (!input) return '—';
  const d = new Date(input);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

const RELATIVE_UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 31_536_000_000],
  ['month', 2_592_000_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

/**
 * "10 days ago" / "10天前".
 *
 * The locale is a parameter rather than read from paraglide so `lib/` stays
 * i18n-free — callers pass `getLocale()`.
 */
export function formatRelativeTime(
  input: string | number | Date | null | undefined,
  locale = 'en'
): string {
  if (!input) return '—';
  const d = new Date(input);
  if (isNaN(d.getTime())) return '—';
  const diff = d.getTime() - Date.now();
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, ms] of RELATIVE_UNITS) {
    if (abs >= ms) return rtf.format(Math.round(diff / ms), unit);
  }
  return rtf.format(Math.round(diff / 1000), 'second');
}

export const getOneYearLaterTimestr = () => {
  const currentDate = new Date();
  const oneYearLater = new Date(currentDate);
  oneYearLater.setFullYear(currentDate.getFullYear() + 1);
  return oneYearLater.toISOString();
};
