import type { GeminiLiveClient } from "../gemini-live.js";
import type { Mutex } from "../server.js";

/** Shared context passed to every tool register(). */
export interface ToolContext {
  getGemini: () => GeminiLiveClient;
  /** Drop the current client so the next call starts fully fresh (no history, no usage). */
  resetGemini: () => Promise<void>;
  checkApiKey: () => void;
  /** Rate limit + TPM guard (use before spending Gemini tokens). */
  checkRate: () => Promise<void>;
  /** Rate limit only - for token-spending calls that must work at the TPM ceiling. */
  acquireRate: () => Promise<void>;
  lock: Mutex;
  clientHolder: { client: GeminiLiveClient | null };
}
