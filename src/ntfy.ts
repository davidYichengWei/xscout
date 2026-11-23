import { randomBytes } from "node:crypto";
import { VERSION } from "./config.ts";
import { openSealed, SealError } from "./seal.ts";

/** Where one run's result is delivered. The topic and key are per run and only ever sent to the routine. */
export interface NtfyDelivery {
  server: string;
  topic: string;
  key: string;
}

export const NTFY_TOPIC_RE = /^xvg_[A-Za-z0-9_-]{24}$/;

export function newNtfyTopic(): string {
  return `xvg_${randomBytes(18).toString("base64url")}`;
}

interface NtfyMessage {
  event: string;
  message?: string;
  attachment?: { url: string; size?: number };
}

const HEADERS = { "user-agent": `x-via-grokbot/${VERSION}`, "cache-control": "no-cache" };

async function get(url: string, what: string): Promise<string> {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`ntfy ${what} failed: HTTP ${res.status} ${text}`.trim());
  }
  return await res.text();
}

/**
 * Returns the decrypted result JSON, or null while nothing has been delivered yet.
 * Throws SealError if something was delivered but does not authenticate with this run's key.
 */
export async function readNtfyResult(d: NtfyDelivery, runId: string): Promise<string | null> {
  const lines = (await get(`${d.server}/${d.topic}/json?poll=1&since=all`, "poll")).split("\n").filter((l) => l.trim());
  const messages = lines.map((l) => JSON.parse(l) as NtfyMessage).filter((m) => m.event === "message");
  let lastError: SealError | undefined;
  for (const m of messages.reverse()) {
    let body = m.message ?? "";
    if (m.attachment?.url) {
      if (new URL(m.attachment.url).origin !== new URL(d.server).origin) continue;
      body = await get(m.attachment.url, "attachment download");
    }
    try {
      return openSealed(body, d.key, runId);
    } catch (err) {
      if (!(err instanceof SealError)) throw err;
      lastError = err;
    }
  }
  if (lastError) throw lastError;
  return null;
}

export async function checkNtfyServer(server: string): Promise<void> {
  const text = await get(`${server}/v1/health`, "health check");
  if (!/"healthy"\s*:\s*true/.test(text)) throw new Error(`ntfy server ${server} is not healthy: ${text.slice(0, 200)}`);
}
