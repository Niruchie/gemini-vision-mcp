import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertUrlAllowed,
  contentTypeForUrl,
  decodeB64,
  detectMime,
  errText,
  fetchUrl,
  fileToImageDict,
  isPrivateIpv4,
  isPrivateIpv6,
} from "../src/tool/_helpers.js";

describe("detectMime", () => {
  it("maps known extensions per media type", () => {
    expect(detectMime("a.png", "image")).toBe("image/png");
    expect(detectMime("a.JPG", "image")).toBe("image/jpeg");
    expect(detectMime("a.mp3", "audio")).toBe("audio/mpeg");
    expect(detectMime("a.mkv", "video")).toBe("video/x-matroska");
  });

  it("falls back to per-type defaults", () => {
    expect(detectMime("a.unknown", "image")).toBe("image/jpeg");
    expect(detectMime("a.unknown", "text")).toBe("text/plain");
  });
});

describe("decodeB64", () => {
  it("parses data URLs", () => {
    const { data, mimeType } = decodeB64("data:image/png;base64,AAAA");
    expect(data).toBe("AAAA");
    expect(mimeType).toBe("image/png");
  });

  it("sniffs common prefixes", () => {
    expect(decodeB64("/9j/abc").mimeType).toBe("image/jpeg");
    expect(decodeB64("iVBORabc").mimeType).toBe("image/png");
    expect(decodeB64("UklGRabc").mimeType).toBe("image/webp");
  });
});

describe("fileToImageDict", () => {
  it("reads text files as text/plain", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gv-"));
    const p = join(dir, "note.txt");
    writeFileSync(p, "hello");
    const img = await fileToImageDict(p, "text");
    expect(img.mime_type).toBe("text/plain");
    expect(Buffer.from(img.data, "base64").toString()).toBe("hello");
  });

  it("reads binary files with detected mime", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gv-"));
    const p = join(dir, "pic.png");
    writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const img = await fileToImageDict(p, "image");
    expect(img.mime_type).toBe("image/png");
  });

  it("refuses files above MCP_MAX_FILE_BYTES", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gv-"));
    const p = join(dir, "big.bin");
    writeFileSync(p, Buffer.alloc(64));
    process.env.MCP_MAX_FILE_BYTES = "8";
    try {
      await expect(fileToImageDict(p, "image")).rejects.toThrow(/File too large/);
    } finally {
      delete process.env.MCP_MAX_FILE_BYTES;
    }
  });
});

describe("URL guards", () => {
  it("classifies non-public addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.5.5", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "224.0.0.1"]) {
      expect(isPrivateIpv4(ip), ip).toBe(true);
    }
    expect(isPrivateIpv4("8.8.8.8")).toBe(false);
    for (const ip of ["::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "ff02::1"]) {
      expect(isPrivateIpv6(ip), ip).toBe(true);
    }
    expect(isPrivateIpv6("2001:4860:4860::8888")).toBe(false);
  });

  it("rejects non-http(s) schemes", async () => {
    await expect(assertUrlAllowed("file:///etc/passwd")).rejects.toThrow(/Unsupported URL scheme/);
    await expect(assertUrlAllowed("data:text/plain,hi")).rejects.toThrow(/Unsupported URL scheme/);
    await expect(assertUrlAllowed("not a url")).rejects.toThrow(/Invalid URL/);
  });

  it("blocks loopback, private and metadata targets by default", async () => {
    delete process.env.MCP_ALLOW_PRIVATE_URLS;
    await expect(assertUrlAllowed("http://127.0.0.1:8080/x")).rejects.toThrow(/Blocked non-public address/);
    await expect(assertUrlAllowed("http://[::1]/x")).rejects.toThrow(/Blocked non-public address/);
    await expect(assertUrlAllowed("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(
      /Blocked non-public address/,
    );
    await expect(assertUrlAllowed("http://192.168.0.10/")).rejects.toThrow(/Blocked non-public address/);
  });

  it("allows public http(s) targets", async () => {
    // Literal public IP: no DNS lookup, keeps the suite hermetic.
    const url = await assertUrlAllowed("http://93.184.216.34/photo.png");
    expect(url.hostname).toBe("93.184.216.34");
  });

  it("honours MCP_ALLOW_PRIVATE_URLS", async () => {
    process.env.MCP_ALLOW_PRIVATE_URLS = "1";
    try {
      await expect(assertUrlAllowed("http://127.0.0.1:3000/x")).resolves.toBeInstanceOf(URL);
    } finally {
      delete process.env.MCP_ALLOW_PRIVATE_URLS;
    }
  });
});

describe("fetchUrl", () => {
  const server = createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "image/png" });
    res.end(Buffer.from([0x89, 0x50]));
  }).listen(0);
  const port = () => (server.address() as { port: number }).port;

  beforeAll(() => {
    // The suite talks to a loopback fixture server.
    process.env.MCP_ALLOW_PRIVATE_URLS = "1";
  });
  afterAll(() => {
    delete process.env.MCP_ALLOW_PRIVATE_URLS;
    server.close();
  });

  it("fetches and base64-encodes with content-type", async () => {
    const img = await fetchUrl(`http://127.0.0.1:${port()}/x.png`);
    expect(img.mime_type).toBe("image/png");
    expect(img.data.length).toBeGreaterThan(0);
  });

  it("throws on HTTP errors", async () => {
    await expect(fetchUrl("http://127.0.0.1:1/nope")).rejects.toThrow();
  });

  it("refuses bodies above MCP_MAX_URL_BYTES", async () => {
    process.env.MCP_MAX_URL_BYTES = "1";
    try {
      await expect(fetchUrl(`http://127.0.0.1:${port()}/x.png`)).rejects.toThrow(/too large/);
    } finally {
      delete process.env.MCP_MAX_URL_BYTES;
    }
  });

  it("re-validates every redirect target", async () => {
    delete process.env.MCP_ALLOW_PRIVATE_URLS;
    try {
      await expect(fetchUrl(`http://127.0.0.1:${port()}/redirect`)).rejects.toThrow(
        /Blocked non-public address/,
      );
    } finally {
      process.env.MCP_ALLOW_PRIVATE_URLS = "1";
    }
  });
});

describe("contentTypeForUrl", () => {
  it("strips charset suffixes", () => {
    expect(contentTypeForUrl("http://x/y", "text/plain; charset=utf-8")).toBe("text/plain");
  });
});

describe("errText", () => {
  it("formats caught errors as `Error: <message>`", () => {
    expect(errText(new Error("boom"))).toBe("Error: boom");
    expect(errText("raw")).toBe("Error: raw");
  });
});
