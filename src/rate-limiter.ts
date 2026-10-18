export class RateLimiter {
  private timestamps: number[] = [];

  constructor(
    private readonly maxRequests: number,
    private readonly windowSeconds: number,
  ) {}

  acquire(): boolean {
    const now = Date.now() / 1000;
    const cutoff = now - this.windowSeconds;
    while (this.timestamps.length > 0 && this.timestamps[0] <= cutoff) {
      this.timestamps.shift();
    }
    if (this.timestamps.length >= this.maxRequests) return false;
    this.timestamps.push(now);
    return true;
  }

  get remaining(): number {
    const now = Date.now() / 1000;
    const cutoff = now - this.windowSeconds;
    while (this.timestamps.length > 0 && this.timestamps[0] <= cutoff) {
      this.timestamps.shift();
    }
    return Math.max(0, this.maxRequests - this.timestamps.length);
  }
}
