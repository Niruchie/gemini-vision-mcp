import { GoogleGenAI, Modality } from "@google/genai";

// TPM safety threshold: refresh session when usage exceeds this fraction of the limit
const TPM_REFRESH_THRESHOLD = 0.75;
// TPM compaction threshold: ask model to summarize history at this fraction
const TPM_COMPACT_THRESHOLD = 0.7;
// Default TPM limit for gemini-3.1-flash-live-preview.
export const DEFAULT_TPM_LIMIT = 4_000_000;
const COMPRESSION_TRIGGER_TOKENS = 25_000;
const KEEP_RECENT_TURNS = 3;
const EXCERPT_MAX_CHARS = 200;

export interface UsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

export interface ImageInput {
  data: string;
  mimeType: string;
}

export class UsageStats {
  totalInputTokens = 0;
  totalOutputTokens = 0;
  totalTokens = 0;
  turnCount = 0;
  sessionCount = 0;
  lastTurnTokens = 0;
  lastTurnTime: number | null = null;
  tpmLimit: number;
  private turnWindow: Array<{ t: number; tokens: number }> = [];

  constructor(tpmLimit = DEFAULT_TPM_LIMIT) {
    this.tpmLimit = tpmLimit;
  }

  recordTurn(usageMetadata: UsageMetadata | null | undefined): void {
    if (!usageMetadata) return;
    const inputTokens = usageMetadata.promptTokenCount ?? 0;
    const outputTokens = usageMetadata.candidatesTokenCount ?? 0;
    const total = usageMetadata.totalTokenCount ?? 0;

    this.totalInputTokens += inputTokens;
    this.totalOutputTokens += outputTokens;
    this.totalTokens += total;
    this.turnCount += 1;
    this.lastTurnTokens = total;
    this.lastTurnTime = Date.now() / 1000;

    const now = Date.now() / 1000;
    this.turnWindow.push({ t: now, tokens: inputTokens });
    this.turnWindow = this.turnWindow.filter((e) => now - e.t < 60);
  }

  get currentTpm(): number {
    return this.turnWindow.reduce((acc, e) => acc + e.tokens, 0);
  }

  get tpmUsagePct(): number {
    if (this.tpmLimit <= 0) return 0;
    return (this.currentTpm / this.tpmLimit) * 100;
  }

  get needsRefresh(): boolean {
    return this.tpmUsagePct >= TPM_REFRESH_THRESHOLD * 100;
  }

  get needsCompact(): boolean {
    return this.tpmUsagePct >= TPM_COMPACT_THRESHOLD * 100;
  }

  toDict(): Record<string, unknown> {
    return {
      total_input_tokens: this.totalInputTokens,
      total_output_tokens: this.totalOutputTokens,
      total_tokens: this.totalTokens,
      turn_count: this.turnCount,
      session_count: this.sessionCount,
      last_turn_tokens: this.lastTurnTokens,
      current_tpm: this.currentTpm,
      tpm_limit: this.tpmLimit,
      tpm_usage_pct: Math.round(this.tpmUsagePct * 10) / 10,
      needs_refresh: this.needsRefresh,
    };
  }
}

interface HistoryTurn {
  prompt: string;
  response: string;
}

interface PendingTurn {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  parts: string[];
  timer: NodeJS.Timeout;
}

export class GeminiLiveClient {
  readonly usage: UsageStats;
  private ai: GoogleGenAI;
  private model: string;
  private session: any = null;
  private connecting: Promise<void> | null = null;
  private history: HistoryTurn[] = [];
  private pending: PendingTurn | null = null;

  constructor(
    apiKey: string,
    model = "gemini-3.1-flash-live-preview",
    tpmLimit = DEFAULT_TPM_LIMIT,
  ) {
    this.ai = new GoogleGenAI({ apiKey });
    this.model = model;
    this.usage = new UsageStats(tpmLimit);
  }

  get connected(): boolean {
    return this.session !== null;
  }

  get historyLength(): number {
    return this.history.length;
  }

  private recordTurn(prompt: string, response: string): void {
    this.history.push({ prompt, response });
  }

  private compactHistory(): string {
    if (this.history.length === 0) return "";
    const recent = this.history.slice(-KEEP_RECENT_TURNS);
    const old = this.history.slice(0, -KEEP_RECENT_TURNS);
    if (old.length === 0) {
      const lines: string[] = [];
      for (const h of recent) {
        lines.push(`User: ${h.prompt}`);
        lines.push(`Assistant: ${h.response}`);
      }
      return lines.join("\n");
    }
    const summaryLines = old.map((h) => {
      let excerpt = h.response.slice(0, EXCERPT_MAX_CHARS);
      if (h.response.length > EXCERPT_MAX_CHARS) excerpt += "...";
      return `- ${h.prompt} -> ${excerpt}`;
    });
    const summary = "Previous conversation context:\n" + summaryLines.join("\n");
    const recentLines: string[] = [];
    for (const h of recent) {
      recentLines.push(`User: ${h.prompt}`);
      recentLines.push(`Assistant: ${h.response}`);
    }
    return summary + "\n\nRecent conversation:\n" + recentLines.join("\n");
  }

  private async replayHistory(): Promise<void> {
    const compacted = this.compactHistory();
    if (!compacted) return;
    await this.session.sendClientContent({
      turns: [
        {
          role: "user",
          parts: [{ text: `[Conversation context]\n${compacted}` }],
        },
      ],
      turnComplete: false,
    });
    console.error(`[gemini] Replayed ${this.history.length} turns into new session`);
  }

  private async ensureConnected(): Promise<void> {
    if (this.session !== null) return;
    if (this.connecting !== null) {
      await this.connecting;
      return;
    }
    this.connecting = this.connect();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private async connect(): Promise<void> {
    const config = {
      responseModalities: [Modality.AUDIO],
      outputAudioTranscription: {},
      contextWindowCompression: {
        slidingWindow: {},
        triggerTokens: String(COMPRESSION_TRIGGER_TOKENS),
      },
    };
    this.session = await this.ai.live.connect({
      model: this.model,
      config,
      callbacks: {
        onopen: () => {
          console.error("[gemini] Live session connected");
        },
        onmessage: (message) => {
          this.handleMessage(message);
        },
        onerror: (e: Error) => {
          console.error(`[gemini] Session error: ${e.message}`);
          this.pending?.reject(e);
          this.pending = null;
        },
        onclose: (e: { reason?: string }) => {
          console.error(`[gemini] Session closed: ${e?.reason ?? ""}`);
          this.session = null;
          this.pending?.reject(new Error("Session closed"));
          this.pending = null;
        },
      },
    });
    this.usage.sessionCount += 1;
    console.error(`[gemini] Session #${this.usage.sessionCount} opened`);
  }

  private handleMessage(message: any): void {
    const usageMeta =
      message?.usageMetadata ?? message?.serverContent?.usageMetadata ?? null;
    if (usageMeta) {
      this.usage.recordTurn({
        promptTokenCount: usageMeta.promptTokenCount,
        candidatesTokenCount: usageMeta.candidatesTokenCount,
        totalTokenCount: usageMeta.totalTokenCount,
      });
      if (this.usage.needsRefresh) {
        console.error(
          `[gemini] TPM threshold reached (${this.usage.tpmUsagePct}%), scheduling session refresh`,
        );
      }
    }

    if (!this.pending) return;
    const serverContent = message?.serverContent;
    if (!serverContent) return;

    const outTranscription = serverContent.outputTranscription;
    if (outTranscription?.text) {
      this.pending.parts.push(outTranscription.text);
    }
    const modelTurn = serverContent.modelTurn;
    if (modelTurn?.parts) {
      for (const part of modelTurn.parts) {
        if (typeof part?.text === "string" && part.text.length > 0) {
          this.pending.parts.push(part.text);
        }
      }
    }
    if (serverContent.turnComplete) {
      const text =
        this.pending.parts.join("\n") || "(no description returned)";
      const resolve = this.pending.resolve;
      clearTimeout(this.pending.timer);
      this.pending = null;
      resolve(text);
    }
  }

  private waitForTurn(timeoutSeconds: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (this.pending) {
        reject(new Error("Another turn is already in progress"));
        return;
      }
      const timer = setTimeout(() => {
        if (this.pending) {
          const parts = this.pending.parts;
          this.pending = null;
          resolve(parts.join("\n") || "(no description returned)");
        }
      }, timeoutSeconds * 1000);
      // Unref so a stuck timer never keeps the process alive on stdio transport
      if (typeof timer === "object" && "unref" in timer) {
        (timer as NodeJS.Timeout).unref?.();
      }
      this.pending = { resolve, reject, parts: [], timer };
    });
  }

  private async receive(timeoutSeconds = 30): Promise<string> {
    return this.waitForTurn(timeoutSeconds);
  }

  private async sendTurn(
    parts: Array<Record<string, unknown>>,
    prompt: string,
    timeoutSeconds: number,
  ): Promise<string> {
    await this.session.sendClientContent({
      turns: [{ role: "user", parts }],
      turnComplete: true,
    });
    const response = await this.receive(timeoutSeconds);
    this.recordTurn(prompt, response);
    return response;
  }

  async describeImage(
    imageB64: string,
    mimeType = "image/jpeg",
    prompt = "Describe this image in detail.",
    timeout = 30,
    compact = false,
  ): Promise<string> {
    await this.checkTpmRefresh();
    await this.ensureConnected();
    const parts = [
      { inlineData: { data: imageB64, mimeType } },
      { text: prompt },
    ];
    try {
      const response = await this.sendTurn(parts, prompt, timeout);
      if (compact) await this.compactAndReconnect();
      return response;
    } catch (e) {
      console.error(`[gemini] Session error, reconnecting: ${e}`);
      await this.reconnect();
      const response = await this.sendTurn(parts, prompt, timeout);
      if (compact) await this.compactAndReconnect();
      return response;
    }
  }

  async describeImages(
    images: ImageInput[],
    prompt = "Describe these images in detail.",
    timeout = 45,
    compact = false,
  ): Promise<string> {
    await this.checkTpmRefresh();
    await this.ensureConnected();
    const parts: Array<Record<string, unknown>> = images.map((img) => ({
      inlineData: { data: img.data, mimeType: img.mimeType },
    }));
    parts.push({ text: prompt });
    try {
      const response = await this.sendTurn(parts, prompt, timeout);
      if (compact) await this.compactAndReconnect();
      return response;
    } catch (e) {
      console.error(`[gemini] Session error, reconnecting: ${e}`);
      await this.reconnect();
      const response = await this.sendTurn(parts, prompt, timeout);
      if (compact) await this.compactAndReconnect();
      return response;
    }
  }

  /** Ask Gemini to summarize the conversation history. */
  private async selfCompact(): Promise<string> {
    if (this.history.length === 0 || !this.session) return "";
    const transcript = this.history
      .map((h) => `User: ${h.prompt}\nAssistant: ${h.response}`)
      .join("\n");
    const compactPrompt =
      "Summarize the following conversation into a concise context block. " +
      "Preserve all key facts, topics discussed, decisions made, and important details. " +
      `Keep it under 500 words.\n\n${transcript}`;
    await this.session.sendClientContent({
      turns: [{ role: "user", parts: [{ text: compactPrompt }] }],
      turnComplete: true,
    });
    return this.receive(30);
  }

  /** Handle TPM thresholds: compact at 70%, hard refresh at 75%. */
  private async checkTpmRefresh(): Promise<void> {
    if (this.usage.needsRefresh && this.session !== null) {
      console.error(
        `[gemini] Hard refresh: TPM at ${this.usage.tpmUsagePct}% ` +
          `(${this.usage.currentTpm}/${this.usage.tpmLimit})`,
      );
      await this.reconnect();
    } else if (this.usage.needsCompact && this.session !== null) {
      console.error(
        `[gemini] Auto-compacting: TPM at ${this.usage.tpmUsagePct}% ` +
          `(${this.usage.currentTpm}/${this.usage.tpmLimit})`,
      );
      const summary = await this.selfCompact();
      if (summary && summary !== "(no description returned)") {
        this.history = [{ prompt: "[conversation summary]", response: summary }];
        console.error(`[gemini] Self-compacted to summary (${summary.length} chars)`);
      } else {
        const compactText = this.compactHistory();
        if (compactText) {
          this.history = [
            { prompt: "[conversation summary]", response: compactText },
          ];
          console.error(`[gemini] Fallback compaction (${compactText.length} chars)`);
        }
      }
      await this.reconnect();
    }
  }

  private async compactAndReconnect(): Promise<void> {
    if (this.history.length === 0) {
      await this.reconnect();
      return;
    }
    console.error(
      `[gemini] Compacting history (${this.history.length} turns) via self-summarization`,
    );
    const summary = await this.selfCompact();
    if (summary && summary !== "(no description returned)") {
      this.history = [{ prompt: "[conversation summary]", response: summary }];
      console.error(`[gemini] Self-compacted to summary (${summary.length} chars)`);
    } else {
      const compactText = this.compactHistory();
      if (compactText) {
        this.history = [
          { prompt: "[conversation summary]", response: compactText },
        ];
        console.error(`[gemini] Fallback compaction (${compactText.length} chars)`);
      }
    }
    await this.reconnect();
  }

  /** Compact history via self-summarization and reconnect. */
  async compact(): Promise<string> {
    if (this.history.length === 0) return "No history to compact.";
    const turnCount = this.history.length;
    const summary = await this.selfCompact();
    let method: string;
    let size: number;
    if (summary && summary !== "(no description returned)") {
      this.history = [{ prompt: "[conversation summary]", response: summary }];
      method = "self-summarized";
      size = summary.length;
    } else {
      const compactText = this.compactHistory();
      this.history = [{ prompt: "[conversation summary]", response: compactText }];
      method = "fallback excerpt";
      size = compactText.length;
    }
    await this.reconnect();
    return `Compacted ${turnCount} turns (${method}, ${size} chars) and reconnected.`;
  }

  async reconnect(): Promise<void> {
    await this.close();
    await this.connect();
    await this.replayHistory();
  }

  async close(): Promise<void> {
    if (this.session) {
      try {
        await this.session.close();
      } catch {
        // ignore
      }
    }
    this.session = null;
  }
}
