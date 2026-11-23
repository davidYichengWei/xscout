import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, statSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function runTs(code: string, env: Record<string, string>): string {
  return execFileSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

test("file secret store + sealed transfer between machines", () => {
  const source = mkdtempSync(join(tmpdir(), "xscout-src-"));
  const target = mkdtempSync(join(tmpdir(), "xscout-dst-"));
  const common = { XSCOUT_SECRET_STORE: "file", XSCOUT_NO_GH_FALLBACK: "1", XSCOUT_WEBHOOK_SECRET: "" };
  const cli = (home: string, args: string[], input?: string) =>
    execFileSync(process.execPath, ["src/cli.ts", ...args], { cwd: root, env: { ...process.env, ...common, XSCOUT_HOME: home }, encoding: "utf8", input });

  cli(source, ["secret", "set", "webhook-secret"], "crsr_secret_value_123\n");
  assert.equal(statSync(join(source, "secrets.json")).mode & 0o777, 0o600);

  const pub = cli(target, ["secret", "keygen"]);
  assert.match(pub, /BEGIN PUBLIC KEY/);
  const pubFile = join(source, "target.pub");
  execFileSync("sh", ["-c", `cat > '${pubFile}'`], { input: pub });
  const sealed = cli(source, ["secret", "seal", "webhook-secret", "--pubkey", pubFile]).trim();
  assert.doesNotMatch(sealed, /crsr_secret_value_123/);
  cli(target, ["secret", "unseal", "webhook-secret", sealed]);
  assert.match(cli(target, ["secret", "status"]), /webhook-secret: present/);
  const stored = runTs(`import { getSecret } from "./src/secrets.ts"; process.stdout.write(getSecret("webhook-secret") ?? "")`, {
    ...common,
    XSCOUT_HOME: target,
  });
  assert.equal(stored, "crsr_secret_value_123");
  assert.throws(() => cli(target, ["secret", "unseal", "webhook-secret", sealed]), /No transfer key/); // key pair is single-use
});

test("fetch goes through HTTP(S)_PROXY when one is set", async () => {
  const origin = createServer((_req, res) => res.end("from-origin"));
  let proxied = 0;
  const proxy = createServer((req, res) => {
    proxied++;
    const upstream = request(req.url!, { method: req.method, headers: req.headers }, (up) => {
      res.writeHead(up.statusCode!, up.headers);
      up.pipe(res);
    });
    req.pipe(upstream);
  });
  await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  const originPort = (origin.address() as { port: number }).port;
  const proxyPort = (proxy.address() as { port: number }).port;
  try {
    const code = `import { enableEnvProxy } from "./src/net.ts";
      const on = enableEnvProxy();
      const t = await (await fetch("http://127.0.0.1:${originPort}/x")).text();
      process.stdout.write(JSON.stringify({ on, t }));`;
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of ["HTTPS_PROXY", "https_proxy", "http_proxy", "ALL_PROXY", "all_proxy", "no_proxy"]) delete env[k];
    Object.assign(env, { HTTP_PROXY: `http://127.0.0.1:${proxyPort}`, NO_PROXY: "" });
    const out = await new Promise<string>((resolve, reject) => {
      execFile(process.execPath, ["--input-type=module", "-e", code], { cwd: root, env }, (err, stdout) =>
        err ? reject(err) : resolve(stdout),
      );
    });
    assert.deepEqual(JSON.parse(out), { on: true, t: "from-origin" });
    assert.equal(proxied, 1);
  } finally {
    origin.close();
    proxy.close();
  }
});

test("codex config pins proxy env in a sub-table", async () => {
  const { upsertCodexToml } = await import("../src/agents.ts");
  const out = upsertCodexToml("", { command: "/node", args: ["/s.ts"], env: { HTTPS_PROXY: "http://127.0.0.1:18791" } });
  assert.match(out, /\[mcp_servers\.xscout\]\n[\s\S]*tool_timeout_sec = 300\n\n\[mcp_servers\.xscout\.env\]\nHTTPS_PROXY = "http:\/\/127\.0\.0\.1:18791"\n/);
  assert.equal(upsertCodexToml(out, { command: "/node", args: ["/s.ts"] }).includes("HTTPS_PROXY"), false);
});

test("serverSpec pins proxy env only when asked", async () => {
  const { serverSpec } = await import("../src/agents.ts");
  const saved = process.env.HTTPS_PROXY;
  process.env.HTTPS_PROXY = "http://127.0.0.1:18791";
  try {
    assert.equal(serverSpec().env?.HTTPS_PROXY, "http://127.0.0.1:18791");
    assert.equal(serverSpec({ pinProxy: false }).env, undefined);
  } finally {
    if (saved === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = saved;
  }
});

test("claude config file follows CLAUDE_CONFIG_DIR", async () => {
  const { claudeConfigFile } = await import("../src/agents.ts");
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = "/tmp/claude-cfg";
  try {
    assert.equal(claudeConfigFile(), "/tmp/claude-cfg/.claude.json");
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
  }
});

test("create-routine message embeds the rendered instructions", async () => {
  const { renderCreateRoutineMessage, renderRoutineInstructions } = await import("../src/routine.ts");
  const vars = { ntfyServer: "https://ntfy.sh", githubRepo: "someone/inbox", githubBranch: "main", resultsDir: "results" };
  const message = renderCreateRoutineMessage(vars);
  assert.ok(message.includes(`===== BEGIN ROUTINE INSTRUCTIONS =====\n${renderRoutineInstructions(vars).trimEnd()}\n===== END ROUTINE INSTRUCTIONS =====`));
  assert.doesNotMatch(message, /\{\{[A-Z_]+\}\}/);
});
