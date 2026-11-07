import { ApplicationScrollMotion } from '../applicationScrollMotion';

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

function fixture() {
  const scroll = jest.fn();
  const enabled = { value: true };
  const motion = new ApplicationScrollMotion({ lineHeight: 17, scroll, active: () => enabled.value });
  return { motion, scroll, enabled };
}

it('keeps native scrolling inside the screen and carries one fling past its edge', () => {
  const { motion, scroll } = fixture();
  motion.begin(100, 500);
  motion.move(200);
  expect(scroll).not.toHaveBeenCalled();
  motion.end(2000);
  jest.advanceTimersByTime(100);
  expect(scroll).not.toHaveBeenCalled();
  jest.advanceTimersByTime(900);
  expect(scroll.mock.calls.reduce((sum, [lines]) => sum + lines, 0)).toBeGreaterThan(20);
  const count = scroll.mock.calls.length;
  jest.advanceTimersByTime(2000);
  expect(scroll.mock.calls.length).toBeLessThanOrEqual(count + 2);
});

it('reverses within the same drag and preserves partial lines instead of discarding movement', () => {
  const { motion, scroll } = fixture();
  motion.begin(500, 500);
  motion.move(8); motion.move(16);
  expect(scroll).not.toHaveBeenCalled();
  motion.move(34); motion.move(0);
  expect(scroll.mock.calls.map(([lines]) => lines)).toEqual([2, -2]);
  motion.begin(0, 500); motion.move(-34); motion.end(-1500);
  jest.advanceTimersByTime(200);
  expect(scroll.mock.calls.at(-1)?.[0]).toBeLessThan(0);
  motion.stop();
});

it('stops on a new touch, cancellation, loss of access or disposal', () => {
  const { motion, scroll, enabled } = fixture();
  motion.begin(0, 0); motion.end(2000);
  jest.advanceTimersByTime(100);
  expect(scroll).toHaveBeenCalled();
  motion.begin(0, 0);
  const count = scroll.mock.calls.length;
  jest.advanceTimersByTime(2000);
  expect(scroll).toHaveBeenCalledTimes(count);
  motion.end(2000, true);
  jest.advanceTimersByTime(100);
  expect(scroll).toHaveBeenCalledTimes(count);
  motion.end(2000); enabled.value = false;
  jest.advanceTimersByTime(100);
  expect(scroll).toHaveBeenCalledTimes(count);
  enabled.value = true; motion.end(2000); motion.stop();
  jest.advanceTimersByTime(2000);
  expect(scroll).toHaveBeenCalledTimes(count);
});
