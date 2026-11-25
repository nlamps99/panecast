import { formatClock, HOUR_CHOICES, MINUTE_CHOICES, withHour, withMinute } from '../quietHours';

it('formats minutes after midnight as HH:mm', () => {
  expect(formatClock(0)).toBe('00:00');
  expect(formatClock(22 * 60 + 5)).toBe('22:05');
  expect(formatClock(1439)).toBe('23:59');
});

it('changes the hour or the minute and keeps the other', () => {
  expect(withHour(22 * 60 + 30, 7)).toBe(7 * 60 + 30);
  expect(withMinute(22 * 60 + 30, 45)).toBe(22 * 60 + 45);
  expect(withMinute(7 * 60 + 13, 0)).toBe(7 * 60);
});

it('offers every hour and five-minute steps', () => {
  expect(HOUR_CHOICES).toHaveLength(24);
  expect(MINUTE_CHOICES).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
});
