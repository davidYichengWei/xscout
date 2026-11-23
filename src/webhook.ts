import { createHmac, randomUUID } from "node:crypto";
import { VERSION } from "./config.ts";

/**
 * Builds the auth headers for a Grok Bot routine webhook.
 * - `whsec_...` secrets: Standard Webhooks signature (HMAC-SHA256 over `id.timestamp.body`).
 * - anything else (e.g. `crsr_...` keys): `Authorization: Bearer <secret>`.
 */
export function webhookHeaders(secret: string, body: string, now = Date.now()): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": `xscout/${VERSION}`,
  };
  if (secret.startsWith("whsec_")) {
    const id = `msg_${randomUUID().replaceAll("-", "")}`;
    const timestamp = Math.floor(now / 1000).toString();
    const key = Buffer.from(secret.slice("whsec_".length), "base64");
    const signature = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
    headers["webhook-id"] = id;
    headers["webhook-timestamp"] = timestamp;
    headers["webhook-signature"] = `v1,${signature}`;
  } else {
    headers.authorization = `Bearer ${secret}`;
  }
  return headers;
}

export async function triggerWebhook(url: string, secret: string, payload: unknown): Promise<number> {
  const body = JSON.stringify(payload);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: webhookHeaders(secret, body),
      body,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new Error(`Could not reach the Grok Bot webhook: ${(err as Error).message}`);
  }
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 500);
    const hint =
      res.status === 401 || res.status === 403
        ? " Check that the stored webhook-secret matches the routine's current key/secret."
        : res.status === 429
          ? " Routine rate limit reached (about 200 runs/hour per routine)."
          : "";
    throw new Error(`Grok Bot webhook returned HTTP ${res.status}.${hint} ${text}`.trim());
  }
  await res.body?.cancel().catch(() => {});
  return res.status;
}
