import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";

/*
 * Result envelope for relays that should only ever see ciphertext (ntfy). The routine side is
 * implemented with the Python standard library in routine/deliver.template.py, which has no AES,
 * so this is encrypt-then-MAC built from HMAC-SHA256 only:
 *   enc = HMAC(key, "x-via-grokbot-enc"), mac = HMAC(key, "x-via-grokbot-mac")
 *   ciphertext = deflate(plaintext) XOR (HMAC(enc, nonce || be64(0)) || HMAC(enc, nonce || be64(1)) || ...)
 *   tag = HMAC(mac, "x-via-grokbot-v1\0" || run_id || "\0" || nonce || ciphertext)
 * Keep both implementations byte-for-byte compatible.
 */

export const SEAL_VERSION = 1;

export interface SealedEnvelope {
  x_via_grokbot_sealed: typeof SEAL_VERSION;
  run_id: string;
  nonce: string;
  ciphertext: string;
  tag: string;
}

export class SealError extends Error {}

export function newSealKey(): string {
  return randomBytes(32).toString("base64url");
}

function decodeKey(keyB64url: string): Buffer {
  const key = Buffer.from(keyB64url, "base64url");
  if (key.length !== 32) throw new SealError("result key must be 32 bytes");
  return key;
}

const hmac = (key: Buffer, ...parts: Buffer[]) => {
  const h = createHmac("sha256", key);
  for (const p of parts) h.update(p);
  return h.digest();
};

function keystreamXor(encKey: Buffer, nonce: Buffer, data: Buffer): Buffer {
  const out = Buffer.alloc(data.length);
  const counter = Buffer.alloc(8);
  for (let off = 0, i = 0n; off < data.length; off += 32, i++) {
    counter.writeBigUInt64BE(i);
    const block = hmac(encKey, nonce, counter);
    for (let j = 0; j < 32 && off + j < data.length; j++) out[off + j] = data[off + j] ^ block[j];
  }
  return out;
}

function tagFor(macKey: Buffer, runId: string, nonce: Buffer, ciphertext: Buffer): Buffer {
  return hmac(macKey, Buffer.from(`x-via-grokbot-v1\0${runId}\0`), nonce, ciphertext);
}

function subkeys(keyB64url: string) {
  const key = decodeKey(keyB64url);
  return { enc: hmac(key, Buffer.from("x-via-grokbot-enc")), mac: hmac(key, Buffer.from("x-via-grokbot-mac")) };
}

export function seal(plaintext: string, keyB64url: string, runId: string): string {
  const { enc, mac } = subkeys(keyB64url);
  const nonce = randomBytes(16);
  const ciphertext = keystreamXor(enc, nonce, deflateSync(Buffer.from(plaintext, "utf8"), { level: 9 }));
  const envelope: SealedEnvelope = {
    x_via_grokbot_sealed: SEAL_VERSION,
    run_id: runId,
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: tagFor(mac, runId, nonce, ciphertext).toString("base64"),
  };
  return JSON.stringify(envelope);
}

/** Verifies and decrypts an envelope. Throws SealError if it was not sealed with this key for this run. */
export function openSealed(text: string, keyB64url: string, runId: string): string {
  let env: Partial<SealedEnvelope>;
  try {
    env = JSON.parse(text);
  } catch {
    throw new SealError("delivered message is not a sealed x-via-grokbot envelope");
  }
  if (
    env.x_via_grokbot_sealed !== SEAL_VERSION ||
    typeof env.nonce !== "string" ||
    typeof env.ciphertext !== "string" ||
    typeof env.tag !== "string"
  ) {
    throw new SealError("delivered message is not a sealed x-via-grokbot envelope");
  }
  if (env.run_id !== runId) throw new SealError(`envelope is for run ${env.run_id}, expected ${runId}`);
  const { enc, mac } = subkeys(keyB64url);
  const nonce = Buffer.from(env.nonce, "base64");
  const ciphertext = Buffer.from(env.ciphertext, "base64");
  const tag = Buffer.from(env.tag, "base64");
  const expected = tagFor(mac, runId, nonce, ciphertext);
  if (tag.length !== expected.length || !timingSafeEqual(tag, expected)) {
    throw new SealError("result failed authentication (wrong key, or the routine altered the key it was given)");
  }
  return inflateSync(keystreamXor(enc, nonce, ciphertext)).toString("utf8");
}
