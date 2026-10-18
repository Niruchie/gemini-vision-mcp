import { describe, expect, it } from "vitest";
import { RateLimiter } from "../src/rate-limiter.js";

describe("RateLimiter", () => {
  it("allows up to max_requests then rejects", () => {
    const limiter = new RateLimiter(2, 60);
    expect(limiter.acquire()).toBe(true);
    expect(limiter.acquire()).toBe(true);
    expect(limiter.acquire()).toBe(false);
    expect(limiter.remaining).toBe(0);
  });

  it("reports remaining quota", () => {
    const limiter = new RateLimiter(3, 60);
    expect(limiter.remaining).toBe(3);
    limiter.acquire();
    expect(limiter.remaining).toBe(2);
  });

  it("refills after the window slides", async () => {
    const limiter = new RateLimiter(1, 0.05);
    expect(limiter.acquire()).toBe(true);
    expect(limiter.acquire()).toBe(false);
    await new Promise((r) => setTimeout(r, 80));
    expect(limiter.acquire()).toBe(true);
  });
});
