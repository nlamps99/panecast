/** Carries a native terminal fling across the edge of the captured screen. */
export class ApplicationScrollMotion {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private toOlder = 0;
  private toNewer = 0;
  private translation = 0;
  private remoteTravel = 0;
  private remainder = 0;

  constructor(private readonly options: {
    lineHeight: number;
    scroll: (lines: number) => void;
    active: () => boolean;
  }) {}

  begin(offset: number, range: number): void {
    this.stop();
    const position = Math.max(0, Math.min(range, offset));
    this.toOlder = Math.max(0, range - position);
    this.toNewer = position;
    this.translation = this.remoteTravel = this.remainder = 0;
  }

  move(translation: number): void {
    if (!this.options.active() || !Number.isFinite(translation)) return;
    this.translation = translation;
    // Native scrolling consumes the part inside the current screen. Only the
    // excess becomes wheel input, including a reversal during the same drag.
    const travel = Math.max(0, translation - this.toOlder) + Math.min(0, translation + this.toNewer);
    this.remainder += travel - this.remoteTravel;
    this.remoteTravel = travel;
    const lines = Math.trunc(this.remainder / this.options.lineHeight);
    if (lines) {
      this.remainder -= lines * this.options.lineHeight;
      this.options.scroll(lines);
    }
  }

  end(velocityY: number, canceled = false): void {
    this.stop();
    if (canceled || !this.options.active() || !Number.isFinite(velocityY)) return;
    // Match a normal mobile fling, but bound a very fast gesture so it cannot
    // leave seconds of remote input queued after the user touches again.
    let velocity = Math.max(-3, Math.min(3, velocityY / 1000));
    if (Math.abs(velocity) < 0.08) return;
    let previous = Date.now();
    const started = previous;
    const tick = () => {
      this.timer = null;
      if (!this.options.active()) return;
      const now = Date.now();
      const elapsed = Math.min(64, now - previous);
      previous = now;
      const decay = Math.exp(-elapsed / 325);
      this.move(this.translation + velocity * 325 * (1 - decay));
      velocity *= decay;
      if (Math.abs(velocity) >= 0.04 && now - started < 1500) this.timer = setTimeout(tick, 16);
    };
    this.timer = setTimeout(tick, 16);
  }

  stop(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
