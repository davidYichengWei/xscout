#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AGENT_IDS, installAgent, serverSpec, type AgentId } from "./agents.ts";
import { configPath, loadConfig, readStoredConfig, requireConfig, saveStoredConfig, VERSION, xscoutHome } from "./config.ts";
import { formatOutcome, startResearch, waitForResult } from "./core.ts";
import { getRepoInfo } from "./github.ts";
import { renderRoutineInstructions } from "./routine.ts";
import { listRuns, loadResultCache } from "./runs.ts";
import { getSecret, isSecretName, SECRET_NAMES, secretEnvVar, setSecret } from "./secrets.ts";

const BOOL_FLAGS = new Set(["json", "dry-run", "print", "help"]);

function parseArgs(args: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split(/=(.*)/s, 2);
      if (inline !== undefined) flags[k] = inline;
      else if (BOOL_FLAGS.has(k) || i + 1 >= args.length) flags[k] = true;
      else flags[k] = args[++i];
    } else pos.push(a);
  }
  return { pos, flags };
}

const str = (v: string | true | undefined) => (typeof v === "string" ? v : undefined);
const num = (v: string | true | undefined) => (typeof v === "string" ? Number(v) : undefined);

const HELP = `xscout ${VERSION}: search X from any coding agent through your Grok Bot.

Setup
  xscout config --repo <owner/name> --webhook-url <url> [--branch main] [--results-dir results]
  xscout secret set <webhook-secret|github-read-token> [--from-file <file>]   (else reads stdin)
  xscout secret status
  xscout routine [--print]          Render the routine instructions to paste into Grok Bot
  xscout install-agents [--only claude,codex,cursor,antigravity] [--dry-run]
  xscout doctor                     Check configuration, secrets and GitHub access

Use
  xscout ask "<question>" [--wait 300] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--max-posts 15] [--json]
  xscout result <run_id> [--wait 120] [--json]
  xscout recent [--limit 10]
  xscout mcp-spec                   Print the MCP server command for manual configuration
`;

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) process.stderr.write("Paste the secret, then press Enter and Ctrl-D:\n");
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function ok(msg: string) {
  console.log(`  ✓ ${msg}`);
}
function bad(msg: string) {
  console.log(`  ✗ ${msg}`);
}

async function doctor(): Promise<number> {
  let failures = 0;
  const cfg = loadConfig();
  console.log(`config (${configPath()})`);
  cfg.webhookUrl ? ok(`webhookUrl ${cfg.webhookUrl.replace(/(.{40}).+/, "$1…")}`) : (failures++, bad("webhookUrl missing"));
  cfg.githubRepo ? ok(`githubRepo ${cfg.githubRepo} @ ${cfg.githubBranch}, dir ${cfg.resultsDir}/`) : (failures++, bad("githubRepo missing"));

  console.log("secrets (macOS Keychain service \"xscout\" or env)");
  const webhookSecret = getSecret("webhook-secret");
  webhookSecret
    ? ok(`webhook-secret present (${webhookSecret.startsWith("whsec_") ? "Standard Webhooks signing" : "Bearer key"})`)
    : (failures++, bad("webhook-secret missing"));
  const token = getSecret("github-read-token");
  token ? ok("github-read-token present") : (failures++, bad("github-read-token missing"));

  console.log("github");
  if (cfg.githubRepo && token) {
    try {
      const info = await getRepoInfo(cfg as ReturnType<typeof requireConfig>, token);
      info.private ? ok(`${info.fullName} reachable and private`) : (failures++, bad(`${info.fullName} is PUBLIC: make it private`));
      if (info.defaultBranch !== cfg.githubBranch) bad(`default branch is "${info.defaultBranch}" but xscout uses "${cfg.githubBranch}"`);
    } catch (err) {
      failures++;
      bad((err as Error).message);
    }
  } else bad("skipped (needs githubRepo and github-read-token)");

  console.log("agents");
  const checks: Array<[string, string]> = [
    ["claude", join(homedir(), ".claude.json")],
    ["codex", join(homedir(), ".codex", "config.toml")],
    ["cursor", join(homedir(), ".cursor", "mcp.json")],
    ["antigravity", join(homedir(), ".gemini", "config", "mcp_config.json")],
  ];
  for (const [id, file] of checks) {
    const has = existsSync(file) && /xscout/.test(readFileSync(file, "utf8"));
    has ? ok(`${id}: xscout registered`) : bad(`${id}: not registered (xscout install-agents --only ${id})`);
  }
  console.log(failures ? `\n${failures} problem(s) found.` : "\nAll required checks passed.");
  return failures ? 1 : 0;
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags } = parseArgs(rest);

  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return 0;

    case "--version":
      console.log(VERSION);
      return 0;

    case "config": {
      const patch = {
        ...(str(flags["webhook-url"]) && { webhookUrl: str(flags["webhook-url"]) }),
        ...(str(flags.repo) && { githubRepo: str(flags.repo) }),
        ...(str(flags.branch) && { githubBranch: str(flags.branch) }),
        ...(str(flags["results-dir"]) && { resultsDir: str(flags["results-dir"]) }),
      };
      const saved = Object.keys(patch).length ? saveStoredConfig(patch) : readStoredConfig();
      console.log(JSON.stringify(saved, null, 2));
      return 0;
    }

    case "secret": {
      const [sub, name] = pos;
      if (sub === "status") {
        for (const n of SECRET_NAMES) console.log(`${n}: ${getSecret(n) ? "present" : `missing (Keychain or ${secretEnvVar(n)})`}`);
        return 0;
      }
      if (sub !== "set" || !name || !isSecretName(name)) {
        console.error(`usage: xscout secret set <${SECRET_NAMES.join("|")}> [--from-file <file>]`);
        return 2;
      }
      const file = str(flags["from-file"]);
      const value = file ? readFileSync(file, "utf8") : await readStdin();
      setSecret(name, value);
      console.log(`Stored ${name} in the macOS Keychain (service "xscout").`);
      return 0;
    }

    case "routine": {
      const cfg = loadConfig();
      if (!cfg.githubRepo) throw new Error("Set the repo first: xscout config --repo <owner/name>");
      const text = renderRoutineInstructions({
        githubRepo: cfg.githubRepo,
        githubBranch: cfg.githubBranch ?? "main",
        resultsDir: cfg.resultsDir ?? "results",
      });
      mkdirSync(xscoutHome(), { recursive: true, mode: 0o700 });
      const out = join(xscoutHome(), "ROUTINE_INSTRUCTIONS.md");
      writeFileSync(out, text);
      if (flags.print) console.log(text);
      else console.log(`Routine instructions written to ${out}`);
      return 0;
    }

    case "install-agents": {
      const only = str(flags.only)?.split(",").map((s) => s.trim()) ?? [...AGENT_IDS];
      const unknown = only.filter((id) => !(AGENT_IDS as readonly string[]).includes(id));
      if (unknown.length) throw new Error(`Unknown agent(s): ${unknown.join(", ")}. Known: ${AGENT_IDS.join(", ")}`);
      const spec = serverSpec();
      let failed = 0;
      for (const id of only as AgentId[]) {
        try {
          console.log(`${id}: ${installAgent(id, spec, flags["dry-run"] === true)}`);
        } catch (err) {
          failed++;
          console.log(`${id}: FAILED ${(err as Error).message}`);
        }
      }
      return failed ? 1 : 0;
    }

    case "mcp-spec":
      console.log(JSON.stringify({ mcpServers: { xscout: serverSpec() } }, null, 2));
      return 0;

    case "doctor":
      return doctor();

    case "ask": {
      const query = pos.join(" ").trim();
      if (!query) throw new Error('usage: xscout ask "<question>"');
      const run = await startResearch({
        query,
        since: str(flags.since),
        until: str(flags.until),
        maxPosts: num(flags["max-posts"]),
        language: str(flags.language),
        answerLanguage: str(flags["answer-language"]),
      });
      process.stderr.write(`started ${run.runId}; waiting for XScout`);
      const outcome = await waitForResult(run.runId, num(flags.wait) ?? 300, { onTick: () => process.stderr.write(".") });
      process.stderr.write("\n");
      console.log(flags.json && outcome.state === "done" ? loadResultCache(run.runId) : formatOutcome(outcome));
      return outcome.state === "done" ? 0 : 3;
    }

    case "result": {
      const [runId] = pos;
      if (!runId) throw new Error("usage: xscout result <run_id>");
      const outcome = await waitForResult(runId, num(flags.wait) ?? 0, { onTick: () => process.stderr.write(".") });
      console.log(flags.json && outcome.state === "done" ? loadResultCache(runId) : formatOutcome(outcome));
      return outcome.state === "done" ? 0 : 3;
    }

    case "recent": {
      const runs = listRuns(num(flags.limit) ?? 10);
      if (!runs.length) console.log("No runs yet.");
      for (const r of runs) console.log(`${r.runId}  ${r.status.padEnd(7)}  ${r.params.query.slice(0, 100)}`);
      return 0;
    }

    default:
      console.error(`Unknown command "${cmd}".\n\n${HELP}`);
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`xscout: ${(err as Error).message}`);
    process.exit(1);
  },
);
