import type { GeminiLiveClient } from "../gemini-live.js";

export interface ClientHolder {
  client: GeminiLiveClient | null;
}

export async function onSessionStart(
  _geminiClientHolder: ClientHolder,
): Promise<boolean> {
  console.error("[event] Gemini Live session started");
  return true;
}

export async function onSessionEnd(
  geminiClientHolder: ClientHolder,
): Promise<void> {
  const gemini = geminiClientHolder.client;
  if (gemini) {
    const stats = gemini.usage.toDict();
    console.error(
      `[event] Session ended - Total tokens: ${stats.total_tokens}, Turns: ${stats.turn_count}`,
    );
    await gemini.close();
  }
  geminiClientHolder.client = null;
}
