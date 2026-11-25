import { programDragTravel, programFlingTravel, programScrollUnits } from '../programScroll';

it('sends whole wheel units and carries the remainder', () => {
  let carry = 0;
  const sent: number[] = [];
  for (const pixels of [30, 30, 30, 60]) {
    const next = programScrollUnits(carry, pixels, 51);
    carry = next.carry; sent.push(next.units);
  }
  expect(sent).toEqual([0, 1, 0, 1]);
  expect(carry).toBeCloseTo((150 - 102) / 51, 5);
});

it('drops a fraction carried the other way when the finger reverses', () => {
  const up = programScrollUnits(0, 40, 51);
  expect(up.units).toBe(0);
  const down = programScrollUnits(up.carry, -40, 51);
  expect(down.units).toBe(0);
  expect(down.carry).toBeCloseTo(-40 / 51, 5);
  expect(programScrollUnits(0.5, 0, 51)).toEqual({ units: 0, carry: 0.5 });
  expect(programScrollUnits(0, Number.NaN, 51)).toEqual({ units: 0, carry: 0 });
});

it('lets a wrapped screen scroll locally before the program scrolls', () => {
  // A screen that fits: every drag goes to the program.
  expect(programDragTravel(20, 0, 0)).toBe(20);
  expect(programDragTravel(-20, 0, 0)).toBe(-20);
  // Taller than the viewport, in the middle: the list absorbs both directions.
  expect(programDragTravel(20, 300, 900)).toBe(0);
  expect(programDragTravel(-20, 300, 900)).toBe(0);
  // At the top edge (older) and past it in an iOS bounce.
  expect(programDragTravel(20, 899, 900)).toBe(20);
  expect(programDragTravel(20, 940, 900)).toBe(20);
  expect(programDragTravel(-20, 900, 900)).toBe(0);
  // At the bottom edge (newer), including a negative bounce offset.
  expect(programDragTravel(-20, -12, 900)).toBe(-20);
  expect(programDragTravel(20, 0, 900)).toBe(0);
});

it('adds a bounded flick and ignores a slow release', () => {
  expect(programFlingTravel(200, 400)).toBe(0);
  expect(programFlingTravel(1200, 400)).toBe(300);
  expect(programFlingTravel(-8000, 400)).toBe(-400);
  expect(programFlingTravel(Number.NaN, 400)).toBe(0);
});
