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
  const fromKeychain = process.platform === "darwin" ? readKeychain(name) : undefined;
  if (fromKeychain) return fromKeychain;
  // Read side only: fall back to the GitHub CLI login on this machine. Never used for the bot's write token.
  if (name === "github-read-token" && process.env.XSCOUT_NO_GH_FALLBACK !== "1") return ghAuthToken();
  return undefined;
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

let ghTokenCache: { value: string | undefined; at: number } | undefined;

function ghAuthToken(): string | undefined {
  if (ghTokenCache && Date.now() - ghTokenCache.at < 5 * 60_000) return ghTokenCache.value;
  let value: string | undefined;
  for (const gh of ["gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh"]) {
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
