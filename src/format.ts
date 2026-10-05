// Display formatting. All demo times are shown in Lagos time (WAT).

const TZ = 'Africa/Lagos';

const time = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const timeSeconds = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dateTime = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const ngn = new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', maximumFractionDigits: 0 });

export const formatTime = (iso: string): string => time.format(new Date(iso));
export const formatTimeSeconds = (iso: string): string => timeSeconds.format(new Date(iso));
export const formatDateTime = (iso: string): string => dateTime.format(new Date(iso));
export const formatNgn = (amount: number): string => ngn.format(amount).replace('NGN', '₦').replace(/\s/g, '');

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return s ? `${m}m ${s}s` : `${m}m`;
}
