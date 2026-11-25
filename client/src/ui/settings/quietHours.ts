/** Minutes after midnight, as quiet hours store them. */
export function formatClock(minutes: number): string {
  const value = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

export const HOUR_CHOICES = Array.from({ length: 24 }, (_, hour) => hour);
/** Five-minute steps; an odd minute saved by an older version still shows, it just has no chip selected. */
export const MINUTE_CHOICES = Array.from({ length: 12 }, (_, index) => index * 5);

export function withHour(minutes: number, hour: number): number {
  return hour * 60 + (minutes % 60);
}

export function withMinute(minutes: number, minute: number): number {
  return Math.floor(minutes / 60) * 60 + minute;
}
