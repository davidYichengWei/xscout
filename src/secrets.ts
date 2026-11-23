import { execFileSync } from "node:child_process";

/**
 * Secrets live in the macOS login Keychain (service "xscout").
 * Environment variables take precedence so tests / other platforms still work.
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

export function getSecret(name: SecretName): string | undefined {
  const fromEnv = process.env[ENV_VARS[name]]?.trim();
  if (fromEnv) return fromEnv;
  if (process.platform !== "darwin") return undefined;
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

export function requireSecret(name: SecretName): string {
  const value = getSecret(name);
  if (!value) {
    throw new Error(
      `Missing secret "${name}". Store it with: xscout secret set ${name} --from-file <file>  (or set ${ENV_VARS[name]}).`,
    );
  }
  return value;
}

/** Stores the secret via `security -i` so the value never appears in a process argument list. */
export function setSecret(name: SecretName, value: string): void {
  if (process.platform !== "darwin") {
    throw new Error(`Keychain storage is macOS-only. Export ${ENV_VARS[name]} instead.`);
  }
  const clean = value.trim();
  if (!clean) throw new Error("Refusing to store an empty secret.");
  if (/[\r\n]/.test(clean)) throw new Error("Secret must be a single line.");
  const quoted = `"${clean.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  execFileSync("security", ["-i"], {
    input: `add-generic-password -U -s ${SERVICE} -a ${name} -l "xscout ${name}" -w ${quoted}\n`,
    stdio: ["pipe", "ignore", "pipe"],
  });
  if (getSecret(name) !== clean) throw new Error(`Keychain write for "${name}" could not be verified.`);
}
