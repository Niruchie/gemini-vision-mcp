import type { ClientHolder } from "./session.js";

function tpmLimit(): number {
  const n = Number(process.env.GEMINI_TPM_LIMIT);
  return Number.isFinite(n) && n > 0 ? n : 4_000_000;
}

/** Background TPM monitor - logs a warning when usage crosses thresholds. */
export function startTpmMonitor(
  geminiClientHolder: ClientHolder,
): NodeJS.Timeout {
  const timer = setInterval(() => {
    try {
      const gemini = geminiClientHolder.client;
      if (!gemini) return;
      const stats = gemini.usage;
      const limit = tpmLimit();
      if (stats.tpmUsagePct >= 75) {
        console.error(
          `[event] TPM threshold reached: ${stats.currentTpm}/${limit} ` +
            `(${stats.tpmUsagePct.toFixed(1)}%)`,
        );
      }
    } catch (e) {
      console.error(`[event] TPM monitor error: ${e}`);
    }
  }, 60_000);
  if (typeof timer === "object" && "unref" in timer) {
    (timer as NodeJS.Timeout).unref?.();
  }
  return timer;
}
