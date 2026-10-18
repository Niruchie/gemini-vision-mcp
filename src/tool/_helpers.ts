import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { lookup } from "node:dns/promises";

export type MediaType = "text" | "image" | "audio" | "video";

export interface ImageDict {
  data: string;
  mime_type: string;
}

const EXT_MAP: Record<string, Record<string, string>> = {
  image: {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
  },
  audio: {
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
  },
  video: {
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".avi": "video/x-msvideo",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
  },
};

const DEFAULTS: Record<MediaType, string> = {
  image: "image/jpeg",
  audio: "audio/mpeg",
  video: "video/mp4",
  text: "text/plain",
};

const DEFAULT_MAX_URL_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 15_000;

function positiveEnvNumber(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Max bytes accepted from an URL fetch (`MCP_MAX_URL_BYTES`). */
export function maxUrlBytes(): number {
  return positiveEnvNumber("MCP_MAX_URL_BYTES", DEFAULT_MAX_URL_BYTES);
}

/** Max bytes accepted from a local file (`MCP_MAX_FILE_BYTES`). */
export function maxFileBytes(): number {
  return positiveEnvNumber("MCP_MAX_FILE_BYTES", DEFAULT_MAX_FILE_BYTES);
}

/** Whether requests to loopback/private/link-local addresses are permitted. */
export function allowPrivateUrls(): boolean {
  return process.env.MCP_ALLOW_PRIVATE_URLS === "1";
}

function ipv4Octets(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => Number(p));
  if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
  return octets;
}

/** Whether an IPv4 address is not a globally routable public address. */
export function isPrivateIpv4(ip: string): boolean {
  const o = ipv4Octets(ip);
  if (!o) return true; // unknown shape -> treat as unsafe
  const [a, b] = o;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true; // 192.0.0/24 + 192.0.2/24
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

/** Whether an IPv6 (or IPv4-mapped) address is not a globally routable public address. */
export function isPrivateIpv6(ip: string): boolean {
  const addr = ip.trim().toLowerCase().split("%")[0];
  const mapped = addr.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return isPrivateIpv4(mapped[1]);
  if (addr === "::" || addr === "::1") return true;
  if (/^f[cd]/.test(addr)) return true; // fc00::/7 unique local
  if (/^fe[89ab]/.test(addr)) return true; // fe80::/10 link-local
  if (addr.startsWith("ff")) return true; // ff00::/8 multicast
  if (addr.startsWith("2002:") || addr.startsWith("64:ff9b")) return true; // 6to4 / NAT64

  // Also inspect the embedded IPv4 of IPv4-compatible forms such as ::127.0.0.1
  const tail = addr.match(/:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (tail) return isPrivateIpv4(tail[1]);

  return false;
}

function isIpv6Literal(hostname: string): boolean {
  return hostname.includes(":");
}

/**
 * Validate a resource URL before fetching: blocks non-HTTP(S) schemes and, unless
 * `MCP_ALLOW_PRIVATE_URLS=1`, hosts resolving to non-public addresses (SSRF guard).
 */
export async function assertUrlAllowed(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported URL scheme: ${url.protocol.replace(":", "")} (only http/https)`);
  }
  if (allowPrivateUrls()) return url;

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses: string[] = [];
  if (isIpv6Literal(hostname)) {
    addresses.push(hostname);
  } else if (ipv4Octets(hostname)) {
    addresses.push(hostname);
  } else {
    let resolved;
    try {
      resolved = await lookup(hostname, { all: true });
    } catch {
      throw new Error(`Cannot resolve host: ${hostname}`);
    }
    if (resolved.length === 0) throw new Error(`Cannot resolve host: ${hostname}`);
    for (const r of resolved) addresses.push(r.address);
  }

  for (const address of addresses) {
    const blocked = isIpv6Literal(address)
      ? isPrivateIpv6(address)
      : isPrivateIpv4(address);
    if (blocked) {
      throw new Error(
        `Blocked non-public address for ${hostname} (${address}). ` +
          "Set MCP_ALLOW_PRIVATE_URLS=1 to allow private/loopback resources.",
      );
    }
  }
  return url;
}

async function readBodyCapped(resp: Response, limit: number, url: string): Promise<Buffer> {
  const declared = Number(resp.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    throw new Error(
      `Resource too large: ${url} declares ${declared} bytes (limit ${limit}). ` +
        "Raise MCP_MAX_URL_BYTES to allow it.",
    );
  }
  if (!resp.body) return Buffer.from(await resp.arrayBuffer());

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of resp.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > limit) {
      await resp.body.cancel().catch(() => undefined);
      throw new Error(
        `Resource too large: ${url} exceeds ${limit} bytes. ` +
          "Raise MCP_MAX_URL_BYTES to allow it.",
      );
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function detectMime(filePath: string, mediaType: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const table = EXT_MAP[mediaType];
  if (table && table[ext]) return table[ext];
  return DEFAULTS[mediaType as MediaType] ?? "application/octet-stream";
}

export function decodeB64(data: string): { data: string; mimeType: string } {
  if (data.startsWith("data:")) {
    const [header, b64] = data.split(",", 2);
    const mime = header.split(":")[1].split(";")[0];
    return { data: b64, mimeType: mime };
  }
  if (data.startsWith("/9j/")) return { data, mimeType: "image/jpeg" };
  if (data.startsWith("iVBOR")) return { data, mimeType: "image/png" };
  if (data.startsWith("UklGR")) return { data, mimeType: "image/webp" };
  return { data, mimeType: "image/jpeg" };
}

export async function fileToImageDict(
  filePath: string,
  mediaType: string,
): Promise<ImageDict> {
  const limit = maxFileBytes();
  const info = await stat(filePath).catch(() => null);
  if (info && info.isFile() && info.size > limit) {
    throw new Error(
      `File too large: ${filePath} is ${info.size} bytes (limit ${limit}). ` +
        "Raise MCP_MAX_FILE_BYTES to allow it.",
    );
  }
  if (mediaType === "text") {
    const text = await readFile(filePath, "utf-8");
    return {
      data: Buffer.from(text, "utf-8").toString("base64"),
      mime_type: "text/plain",
    };
  }
  const mime = detectMime(filePath, mediaType);
  const b64 = (await readFile(filePath)).toString("base64");
  return { data: b64, mime_type: mime };
}

export function contentTypeForUrl(url: string, header: string | null): string {
  let contentType = header ?? "";
  if (contentType.includes(";")) {
    contentType = contentType.split(";")[0].trim();
  }
  if (!contentType || contentType === "application/octet-stream") {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    for (const table of Object.values(EXT_MAP)) {
      if (table[ext]) return table[ext];
    }
    return "application/octet-stream";
  }
  return contentType;
}

/**
 * Fetch a URL and return it base64-encoded. Every redirect hop is re-validated and
 * the body is capped at `MCP_MAX_URL_BYTES`.
 */
export async function fetchUrl(url: string): Promise<ImageDict> {
  const limit = maxUrlBytes();
  let current = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const target = await assertUrlAllowed(current);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const resp = await fetch(target, {
        signal: controller.signal,
        redirect: "manual",
      });

      if (resp.status >= 300 && resp.status < 400) {
        const location = resp.headers.get("location");
        await resp.body?.cancel().catch(() => undefined);
        if (!location) throw new Error(`Redirect without Location from ${target.href}`);
        if (hop === MAX_REDIRECTS) throw new Error(`Too many redirects fetching ${url}`);
        current = new URL(location, target.href).href;
        continue;
      }

      if (!resp.ok) {
        await resp.body?.cancel().catch(() => undefined);
        throw new Error(`Fetch failed ${resp.status} ${resp.statusText} for ${target.href}`);
      }

      const contentType = contentTypeForUrl(target.href, resp.headers.get("content-type"));
      const body = await readBodyCapped(resp, limit, target.href);
      return { data: body.toString("base64"), mime_type: contentType };
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        throw new Error(`Fetch timed out after ${FETCH_TIMEOUT_MS}ms: ${target.href}`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`Too many redirects fetching ${url}`);
}

export function errText(e: unknown): string {
  return `Error: ${e instanceof Error ? e.message : String(e)}`;
}
