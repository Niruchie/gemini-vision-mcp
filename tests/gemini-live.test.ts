import { describe, expect, it } from "vitest";
import { DEFAULT_TPM_LIMIT, UsageStats } from "../src/gemini-live.js";

describe("UsageStats", () => {
  it("starts at zero", () => {
    const stats = new UsageStats(1000);
    expect(stats.totalTokens).toBe(0);
    expect(stats.turnCount).toBe(0);
    expect(stats.currentTpm).toBe(0);
    expect(stats.needsRefresh).toBe(false);
    expect(stats.needsCompact).toBe(false);
  });

  it("accumulates turns and estimates TPM from a 60s window", () => {
    const stats = new UsageStats(1000);
    stats.recordTurn({ promptTokenCount: 600, candidatesTokenCount: 50, totalTokenCount: 650 });
    expect(stats.turnCount).toBe(1);
    expect(stats.totalInputTokens).toBe(600);
    expect(stats.currentTpm).toBe(600);
    expect(stats.tpmUsagePct).toBe(60);
    expect(stats.needsCompact).toBe(false);
    stats.recordTurn({ promptTokenCount: 200, candidatesTokenCount: 10, totalTokenCount: 210 });
    expect(stats.tpmUsagePct).toBe(80);
    expect(stats.needsCompact).toBe(true);
    expect(stats.needsRefresh).toBe(true);
  });

  it("ignores null metadata", () => {
    const stats = new UsageStats(1000);
    stats.recordTurn(null);
    expect(stats.turnCount).toBe(0);
  });

  it("serializes to the usage stats dict", () => {
    const stats = new UsageStats(1000);
    stats.recordTurn({ promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 });
    const dict = stats.toDict() as Record<string, unknown>;
    expect(dict.total_input_tokens).toBe(10);
    expect(dict.total_output_tokens).toBe(5);
    expect(dict.total_tokens).toBe(15);
    expect(dict.turn_count).toBe(1);
    expect(dict.tpm_limit).toBe(1000);
    expect(dict).toHaveProperty("needs_refresh");
  });

  it("exports the default TPM limit", () => {
    expect(DEFAULT_TPM_LIMIT).toBe(4_000_000);
  });
});
