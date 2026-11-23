import { execFileSync } from "node:child_process";
import { constants, generateKeyPairSync, privateDecrypt, publicEncrypt } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { xscoutHome } from "./config.ts";

/**
 * Secrets live in the macOS login Keychain (service "xscout"), or on other platforms in
 * ~/.xscout/secrets.json (mode 0600). Environment variables always take precedence.
 */
const SERVICE = "xscout";

export const SECRET_NAMES = ["webhook-secret", "github-read-token"] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

const ENV_VARS: Record<SecretName, string> = {
  "webhook-secret": "XSCOUT_WEBHOOK_SECRET",
  "github-read-token": "XSCOUT_GITHUB_TOKEN",
};

export function isSecretName(name: string): name is SecretName {
  return (SECRET_NAMES as readonly string[]).includes(name);
}

export function secretEnvVar(name: SecretName): string {
  return ENV_VARS[name];
}

function useKeychain(): boolean {
  return process.platform === "darwin" && process.env.XSCOUT_SECRET_STORE !== "file";
}

export function secretStoreDescription(): string {
  return useKeychain() ? 'macOS Keychain service "xscout"' : secretsFile();
}

export function getSecret(name: SecretName): string | undefined {
  const fromEnv = process.env[ENV_VARS[name]]?.trim();
  if (fromEnv) return fromEnv;
  const stored = useKeychain() ? readKeychain(name) : readFileStore()[name];
  if (stored) return stored;
  // Read side only: fall back to the GitHub CLI login on this machine. Never used for the bot's write token.
  if (name === "github-read-token" && process.env.XSCOUT_NO_GH_FALLBACK !== "1") return ghAuthToken();
  return undefined;
}

export function requireSecret(name: SecretName): string {
  const value = getSecret(name);
  if (!value) {
    throw new Error(
      `Missing secret "${name}". Store it with: xscout secret set ${name} --from-file <file>  (or set ${ENV_VARS[name]}).`,
    );
  }
  return value;
}

export function setSecret(name: SecretName, value: string): void {
  const clean = value.trim();
  if (!clean) throw new Error("Refusing to store an empty secret.");
  if (/[\r\n]/.test(clean)) throw new Error("Secret must be a single line.");
  if (useKeychain()) {
    // `security -i` keeps the value out of the process argument list.
    const quoted = `"${clean.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    execFileSync("security", ["-i"], {
      input: `add-generic-password -U -s ${SERVICE} -a ${name} -l "xscout ${name}" -w ${quoted}\n`,
      stdio: ["pipe", "ignore", "pipe"],
    });
    if (readKeychain(name) !== clean) throw new Error(`Keychain write for "${name}" could not be verified.`);
    return;
  }
  writeFileStore({ ...readFileStore(), [name]: clean });
}

function readKeychain(name: SecretName): string | undefined {
  try {
    const value = execFileSync("security", ["find-generic-password", "-s", SERVICE, "-a", name, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function secretsFile(): string {
  return join(xscoutHome(), "secrets.json");
}

function readFileStore(): Partial<Record<SecretName, string>> {
  const path = secretsFile();
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeFileStore(data: Partial<Record<SecretName, string>>): void {
  mkdirSync(xscoutHome(), { recursive: true, mode: 0o700 });
  const path = secretsFile();
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

let ghTokenCache: { value: string | undefined; at: number } | undefined;

function ghAuthToken(): string | undefined {
  if (ghTokenCache && Date.now() - ghTokenCache.at < 5 * 60_000) return ghTokenCache.value;
  let value: string | undefined;
  for (const gh of ["gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"]) {
    try {
      value = execFileSync(gh, ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim() || undefined;
      if (value) break;
    } catch {
      // try the next location
    }
  }
  ghTokenCache = { value, at: Date.now() };
  return value;
}

/*
 * Moving a secret to another machine without it ever appearing in plain text in transit:
 *   target: xscout secret keygen        -> prints an RSA public key (private key stays in ~/.xscout/transfer/)
 *   source: xscout secret seal <name> --pubkey <file>   -> prints ciphertext
 *   target: xscout secret unseal <name> <ciphertext>    -> stores the secret, deletes the key pair
 */
function transferDir(): string {
  return join(xscoutHome(), "transfer");
}

export function transferKeygen(): string {
  const dir = transferDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 3072,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  writeFileSync(join(dir, "private.pem"), privateKey, { mode: 0o600 });
  return publicKey;
}

export function sealSecret(name: SecretName, publicKeyPem: string): string {
  const value = requireSecret(name);
  return publicEncrypt({ key: publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(value)).toString("base64");
}

export function unsealSecret(name: SecretName, ciphertextB64: string): void {
  const keyPath = join(transferDir(), "private.pem");
  if (!existsSync(keyPath)) throw new Error("No transfer key on this machine. Run `xscout secret keygen` first.");
  const value = privateDecrypt(
    { key: readFileSync(keyPath, "utf8"), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(ciphertextB64.replace(/\s+/g, ""), "base64"),
  ).toString("utf8");
  setSecret(name, value);
  rmSync(transferDir(), { recursive: true, force: true });
}
