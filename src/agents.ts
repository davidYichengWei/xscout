import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { proxyEnv } from "./net.ts";

export const MCP_SERVER_NAME = "x-via-grokbot";

export const AGENT_IDS = ["claude", "codex", "cursor", "antigravity"] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export interface ServerSpec {
  command: string;
  args: string[];
  /** Pinned env, currently only proxy variables (some agents, e.g. Codex, strip the parent env). */
  env?: Record<string, string>;
}

/** Prefer a stable PATH symlink (e.g. /opt/homebrew/bin/node) over a versioned Cellar path that breaks on upgrade. */
function stableNodePath(): string {
  const real = realpathSync(process.execPath);
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const candidate = join(dir, "node");
    try {
      if (dir && realpathSync(candidate) === real) return candidate;
    } catch {
      // not present in this PATH entry
    }
  }
  return process.execPath;
}

export function serverSpec({ pinProxy = true }: { pinProxy?: boolean } = {}): ServerSpec {
  const env = pinProxy ? proxyEnv() : {};
  return {
    command: stableNodePath(),
    args: [fileURLToPath(new URL("./server.ts", import.meta.url))],
    ...(Object.keys(env).length ? { env } : {}),
  };
}

function resolveTarget(path: string): string {
  return existsSync(path) ? realpathSync(path) : path;
}

function backup(path: string): string | undefined {
  if (!existsSync(path) || readFileSync(path, "utf8").trim() === "") return undefined;
  const dest = `${path}.x-via-grokbot-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  copyFileSync(path, dest);
  return dest;
}

function upsertJsonMcp(file: string, spec: ServerSpec, dryRun: boolean): string {
  const target = resolveTarget(file);
  const text = existsSync(target) ? readFileSync(target, "utf8") : "";
  let data: { mcpServers?: Record<string, unknown> } = {};
  if (text.trim()) {
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new Error(`${target} is not valid JSON (${(err as Error).message}); fix it and re-run.`);
    }
  }
  data.mcpServers = {
    ...(data.mcpServers ?? {}),
    [MCP_SERVER_NAME]: { command: spec.command, args: spec.args, ...(spec.env ? { env: spec.env } : {}) },
  };
  if (dryRun) return `would write mcpServers["${MCP_SERVER_NAME}"] to ${target}`;
  const saved = backup(target);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(data, null, 2)}\n`);
  return `wrote mcpServers["${MCP_SERVER_NAME}"] to ${target}${saved ? ` (backup: ${saved})` : ""}`;
}

/** Removes every [mcp_servers.x-via-grokbot] / [mcp_servers.x-via-grokbot.*] table, then appends a fresh one. */
export function upsertCodexToml(text: string, spec: ServerSpec): string {
  const kept: string[] = [];
  let skipping = false;
  for (const line of text.split("\n")) {
    const header = line.match(/^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/);
    if (header) {
      const name = header[1].replace(/"/g, "");
      skipping = name === `mcp_servers.${MCP_SERVER_NAME}` || name.startsWith(`mcp_servers.${MCP_SERVER_NAME}.`);
    }
    if (!skipping) kept.push(line);
  }
  const block = [
    `[mcp_servers.${MCP_SERVER_NAME}]`,
    `command = ${JSON.stringify(spec.command)}`,
    `args = [${spec.args.map((a) => JSON.stringify(a)).join(", ")}]`,
    "startup_timeout_sec = 20",
    "tool_timeout_sec = 300",
    "",
    ...(spec.env
      ? [`[mcp_servers.${MCP_SERVER_NAME}.env]`, ...Object.entries(spec.env).map(([k, v]) => `${k} = ${JSON.stringify(v)}`), ""]
      : []),
  ].join("\n");
  const base = kept.join("\n").replace(/\s*$/, "");
  return `${base ? `${base}\n\n` : ""}${block}`;
}

function installCodex(spec: ServerSpec, dryRun: boolean): string {
  const target = resolveTarget(join(homedir(), ".codex", "config.toml"));
  const text = existsSync(target) ? readFileSync(target, "utf8") : "";
  const next = upsertCodexToml(text, spec);
  if (dryRun) return `would write [mcp_servers.${MCP_SERVER_NAME}] to ${target}`;
  const saved = backup(target);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, next);
  return `wrote [mcp_servers.${MCP_SERVER_NAME}] to ${target}${saved ? ` (backup: ${saved})` : ""}`;
}

/** Claude Code keeps user-scope MCP servers in .claude.json, which moves when CLAUDE_CONFIG_DIR is set. */
export function claudeConfigFile(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  return dir ? join(dir, ".claude.json") : join(homedir(), ".claude.json");
}

function installClaude(spec: ServerSpec, dryRun: boolean): string {
  const json = JSON.stringify({ type: "stdio", command: spec.command, args: spec.args, ...(spec.env ? { env: spec.env } : {}) });
  if (dryRun) return `would run: claude mcp add-json --scope user ${MCP_SERVER_NAME} '${json}'`;
  try {
    execFileSync("claude", ["mcp", "remove", "--scope", "user", MCP_SERVER_NAME], { stdio: "ignore" });
  } catch {
    // not registered yet
  }
  execFileSync("claude", ["mcp", "add-json", "--scope", "user", MCP_SERVER_NAME, json], { stdio: "pipe" });
  return `registered ${MCP_SERVER_NAME} in Claude Code (user scope, ${claudeConfigFile()})`;
}

export function installAgent(id: AgentId, spec: ServerSpec, dryRun = false): string {
  switch (id) {
    case "claude":
      return installClaude(spec, dryRun);
    case "codex":
      return installCodex(spec, dryRun);
    case "cursor":
      return upsertJsonMcp(join(homedir(), ".cursor", "mcp.json"), spec, dryRun);
    case "antigravity":
      return upsertJsonMcp(join(homedir(), ".gemini", "config", "mcp_config.json"), spec, dryRun);
  }
}
