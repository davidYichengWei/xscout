import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const VERSION = "0.1.0";

export function xscoutHome(): string {
  return process.env.XSCOUT_HOME ?? join(homedir(), ".xscout");
}

export function configPath(): string {
  return join(xscoutHome(), "config.json");
}

/** How the routine sends results back: an encrypted ntfy message, or a commit to a private GitHub repo. */
export type Transport = "ntfy" | "github";
export const TRANSPORTS: readonly Transport[] = ["ntfy", "github"];
export const DEFAULT_NTFY_SERVER = "https://ntfy.sh";

/** Values stored in ~/.xscout/config.json. Secrets never live here (see secrets.ts). */
export interface StoredConfig {
  webhookUrl?: string;
  transport?: Transport;
  ntfyServer?: string;
  githubRepo?: string;
  githubBranch?: string;
  resultsDir?: string;
}

export interface XscoutConfig {
  webhookUrl: string;
  transport: Transport;
  ntfyServer: string;
  githubRepo?: string;
  githubBranch: string;
  resultsDir: string;
  githubApiBase: string;
  pollIntervalMs: number;
  /** A run with no result after this many minutes is reported as probably stuck. */
  staleAfterMinutes: number;
}

const REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const DIR_RE = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/;

export function readStoredConfig(): StoredConfig {
  const path = configPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as StoredConfig;
  } catch (err) {
    throw new Error(`Cannot parse ${path}: ${(err as Error).message}`);
  }
}

export function saveStoredConfig(patch: StoredConfig): StoredConfig {
  if (patch.githubRepo !== undefined && !REPO_RE.test(patch.githubRepo)) {
    throw new Error(`githubRepo must look like "owner/name", got "${patch.githubRepo}"`);
  }
  if (patch.resultsDir !== undefined && !DIR_RE.test(patch.resultsDir)) {
    throw new Error(`resultsDir must be a simple relative path, got "${patch.resultsDir}"`);
  }
  if (patch.webhookUrl !== undefined && !/^https:\/\//.test(patch.webhookUrl)) {
    throw new Error("webhookUrl must start with https://");
  }
  if (patch.transport !== undefined && !TRANSPORTS.includes(patch.transport)) {
    throw new Error(`transport must be one of ${TRANSPORTS.join(", ")}, got "${patch.transport}"`);
  }
  if (patch.ntfyServer !== undefined && !/^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(patch.ntfyServer)) {
    throw new Error(`ntfyServer must look like "https://ntfy.example.com" (no path), got "${patch.ntfyServer}"`);
  }
  const next = { ...readStoredConfig(), ...patch };
  mkdirSync(xscoutHome(), { recursive: true, mode: 0o700 });
  writeFileSync(configPath(), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return next;
}

/** Merged view: environment variables override the stored file (useful for tests and CI). */
export function loadConfig(): Partial<XscoutConfig> {
  const s = readStoredConfig();
  const env = process.env;
  const githubRepo = env.XSCOUT_GITHUB_REPO ?? s.githubRepo;
  return {
    webhookUrl: env.XSCOUT_WEBHOOK_URL ?? s.webhookUrl,
    // Setups from before ntfy support only have a repo configured; keep them on GitHub.
    transport: (env.XSCOUT_TRANSPORT as Transport | undefined) ?? s.transport ?? (githubRepo ? "github" : "ntfy"),
    ntfyServer: (env.XSCOUT_NTFY_SERVER ?? s.ntfyServer ?? DEFAULT_NTFY_SERVER).replace(/\/+$/, ""),
    githubRepo,
    githubBranch: env.XSCOUT_GITHUB_BRANCH ?? s.githubBranch ?? "main",
    resultsDir: env.XSCOUT_RESULTS_DIR ?? s.resultsDir ?? "results",
    githubApiBase: (env.XSCOUT_GITHUB_API ?? "https://api.github.com").replace(/\/+$/, ""),
    pollIntervalMs: Number(env.XSCOUT_POLL_MS ?? 3000),
    staleAfterMinutes: Number(env.XSCOUT_STALE_MINUTES ?? 15),
  };
}

export function requireConfig(): XscoutConfig {
  const cfg = loadConfig();
  const missing: string[] = [];
  if (!cfg.webhookUrl) missing.push("webhookUrl (xscout config --webhook-url <url>)");
  if (cfg.transport === "github" && !cfg.githubRepo) missing.push("githubRepo (xscout config --repo <owner/name>)");
  if (missing.length) {
    throw new Error(`xscout is not configured yet. Missing: ${missing.join("; ")}. Config file: ${configPath()}`);
  }
  return cfg as XscoutConfig;
}
