#!/usr/bin/env node
import { enableEnvProxy } from "./net.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AGENT_IDS, claudeConfigFile, installAgent, MCP_SERVER_NAME, serverSpec, type AgentId } from "./agents.ts";
import {
  appHome,
  configPath,
  DEFAULT_NTFY_SERVER,
  loadConfig,
  readStoredConfig,
  requireConfig,
  saveStoredConfig,
  VERSION,
  type Transport,
} from "./config.ts";
import { checkNtfyServer } from "./ntfy.ts";
import { formatOutcome, startResearch, waitForResult } from "./core.ts";
import { getRepoInfo } from "./github.ts";
import { renderCreateRoutineMessage, renderRoutineInstructions } from "./routine.ts";
import { listRuns, loadResultCache } from "./runs.ts";
import {
  getSecret,
  isSecretName,
  sealSecret,
  SECRET_NAMES,
  secretEnvVar,
  secretStoreDescription,
  setSecret,
  transferKeygen,
  unsealSecret,
} from "./secrets.ts";

enableEnvProxy();

const BOOL_FLAGS = new Set(["json", "dry-run", "print", "help", "no-proxy"]);

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

const HELP = `x-via-grokbot ${VERSION}: search X from any coding agent through your Grok Bot.

Setup
  x-via-grokbot config --webhook-url <url> [--transport ntfy|github] [--ntfy-server https://ntfy.sh]
                       [--repo <owner/name>] [--branch main] [--results-dir results]   (GitHub transport)
  x-via-grokbot secret set <webhook-secret|github-read-token> [--from-file <file>]   (else reads stdin)
  x-via-grokbot secret status
  x-via-grokbot secret keygen | seal <name> --pubkey <file> | unseal <name> <ciphertext>   (move a secret between machines)
  x-via-grokbot routine [--print]          Render the routine instructions (and a chat message that creates the routine)
  x-via-grokbot install-agents [--only claude,codex,cursor,antigravity] [--no-proxy] [--dry-run]
  x-via-grokbot doctor                     Check configuration, secrets, transport and agent registrations

Use
  x-via-grokbot ask "<question>" [--wait 300] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--max-posts 15] [--json]
  x-via-grokbot result <run_id> [--wait 120] [--json]
  x-via-grokbot recent [--limit 10]
  x-via-grokbot mcp-spec                   Print the MCP server command for manual configuration
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
  const github = cfg.transport === "github";
  cfg.webhookUrl ? ok(`webhookUrl ${cfg.webhookUrl.replace(/(.{40}).+/, "$1…")}`) : (failures++, bad("webhookUrl missing"));
  ok(`transport ${cfg.transport}${github ? "" : ` via ${cfg.ntfyServer} (results end-to-end encrypted)`}`);
  if (github) {
    cfg.githubRepo ? ok(`githubRepo ${cfg.githubRepo} @ ${cfg.githubBranch}, dir ${cfg.resultsDir}/`) : (failures++, bad("githubRepo missing"));
  }

  console.log(`secrets (${secretStoreDescription()}, or env)`);
  const webhookSecret = getSecret("webhook-secret");
  webhookSecret
    ? ok(`webhook-secret present (${webhookSecret.startsWith("whsec_") ? "Standard Webhooks signing" : "Bearer key"})`)
    : (failures++, bad("webhook-secret missing"));
  const token = github ? getSecret("github-read-token") : undefined;
  if (github) token ? ok("github-read-token present") : (failures++, bad("github-read-token missing"));

  console.log(github ? "github" : "ntfy");
  try {
    if (!github) {
      await checkNtfyServer(cfg.ntfyServer!);
      ok(`${cfg.ntfyServer} reachable`);
    } else if (cfg.githubRepo && token) {
      const info = await getRepoInfo(cfg as ReturnType<typeof requireConfig>, token);
      info.private ? ok(`${info.fullName} reachable and private`) : (failures++, bad(`${info.fullName} is PUBLIC: make it private`));
      if (info.defaultBranch !== cfg.githubBranch) bad(`default branch is "${info.defaultBranch}" but x-via-grokbot uses "${cfg.githubBranch}"`);
    } else bad("skipped (needs githubRepo and github-read-token)");
  } catch (err) {
    failures++;
    bad((err as Error).message);
  }

  console.log("agents");
  const checks: Array<[string, string]> = [
    ["claude", claudeConfigFile()],
    ["codex", join(homedir(), ".codex", "config.toml")],
    ["cursor", join(homedir(), ".cursor", "mcp.json")],
    ["antigravity", join(homedir(), ".gemini", "config", "mcp_config.json")],
  ];
  for (const [id, file] of checks) {
    const has = existsSync(file) && readFileSync(file, "utf8").includes(MCP_SERVER_NAME);
    has ? ok(`${id}: ${MCP_SERVER_NAME} registered`) : bad(`${id}: not registered (x-via-grokbot install-agents --only ${id})`);
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
        ...(str(flags.transport) && { transport: str(flags.transport) as Transport }),
        ...(str(flags["ntfy-server"]) && { ntfyServer: str(flags["ntfy-server"])!.replace(/\/+$/, "") }),
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
        for (const n of SECRET_NAMES) console.log(`${n}: ${getSecret(n) ? "present" : `missing (${secretStoreDescription()} or ${secretEnvVar(n)})`}`);
        return 0;
      }
      if (sub === "keygen") {
        process.stdout.write(transferKeygen());
        return 0;
      }
      if (sub === "seal" && name && isSecretName(name)) {
        const pub = str(flags.pubkey);
        if (!pub) throw new Error("usage: x-via-grokbot secret seal <name> --pubkey <file>");
        console.log(sealSecret(name, readFileSync(pub, "utf8")));
        return 0;
      }
      if (sub === "unseal" && name && isSecretName(name) && pos[2]) {
        unsealSecret(name, pos[2]);
        console.log(`Stored ${name} in ${secretStoreDescription()}.`);
        return 0;
      }
      if (sub !== "set" || !name || !isSecretName(name)) {
        console.error(`usage: x-via-grokbot secret set <${SECRET_NAMES.join("|")}> [--from-file <file>]`);
        return 2;
      }
      const file = str(flags["from-file"]);
      const value = file ? readFileSync(file, "utf8") : await readStdin();
      setSecret(name, value);
      console.log(`Stored ${name} in ${secretStoreDescription()}.`);
      return 0;
    }

    case "routine": {
      const cfg = loadConfig();
      if (cfg.transport === "github" && !cfg.githubRepo) throw new Error("Set the repo first: x-via-grokbot config --repo <owner/name>");
      const vars = {
        ntfyServer: cfg.ntfyServer ?? DEFAULT_NTFY_SERVER,
        githubRepo: cfg.githubRepo,
        githubBranch: cfg.githubBranch ?? "main",
        resultsDir: cfg.resultsDir ?? "results",
      };
      const text = renderRoutineInstructions(vars);
      mkdirSync(appHome(), { recursive: true, mode: 0o700 });
      const out = join(appHome(), "ROUTINE_INSTRUCTIONS.md");
      writeFileSync(out, text);
      const message = join(appHome(), "CREATE_ROUTINE_MESSAGE.md");
      writeFileSync(message, renderCreateRoutineMessage(vars));
      if (flags.print) console.log(text);
      else {
        console.log(`Routine instructions written to ${out}`);
        console.log(`Chat message asking Grok Bot to create the routine written to ${message}`);
      }
      return 0;
    }

    case "install-agents": {
      const only = str(flags.only)?.split(",").map((s) => s.trim()) ?? [...AGENT_IDS];
      const unknown = only.filter((id) => !(AGENT_IDS as readonly string[]).includes(id));
      if (unknown.length) throw new Error(`Unknown agent(s): ${unknown.join(", ")}. Known: ${AGENT_IDS.join(", ")}`);
      const spec = serverSpec({ pinProxy: flags["no-proxy"] !== true });
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
      console.log(JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: serverSpec() } }, null, 2));
      return 0;

    case "doctor":
      return doctor();

    case "ask": {
      const query = pos.join(" ").trim();
      if (!query) throw new Error('usage: x-via-grokbot ask "<question>"');
      const run = await startResearch({
        query,
        since: str(flags.since),
        until: str(flags.until),
        maxPosts: num(flags["max-posts"]),
        language: str(flags.language),
        answerLanguage: str(flags["answer-language"]),
      });
      process.stderr.write(`started ${run.runId}; waiting for Grok Bot`);
      const outcome = await waitForResult(run.runId, num(flags.wait) ?? 300, { onTick: () => process.stderr.write(".") });
      process.stderr.write("\n");
      console.log(flags.json && outcome.state === "done" ? loadResultCache(run.runId) : formatOutcome(outcome));
      return outcome.state === "done" ? 0 : 3;
    }

    case "result": {
      const [runId] = pos;
      if (!runId) throw new Error("usage: x-via-grokbot result <run_id>");
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
    console.error(`x-via-grokbot: ${(err as Error).message}`);
    process.exit(1);
  },
);
