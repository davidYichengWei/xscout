/**
 * End-to-end test with a local fake of both remote sides:
 *  - the Grok Bot webhook (verifies auth, then "researches" and runs the real rendered deliver.py)
 *  - the GitHub contents API (accepts PUTs from deliver.py, serves reads to xscout)
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const REPO = "me/xscout-inbox";
const READ_TOKEN = "read-token-123";
const WRITE_TOKEN = "write-token-456";
const WHSEC = `whsec_${randomBytes(24).toString("base64")}`;
const BEARER = "crsr_test_bearer";

const home = mkdtempSync(join(tmpdir(), "xscout-test-"));
const files = new Map<string, { content: Buffer; sha: string }>();
const received: any[] = [];
let botDelayMs = 300;
let botMode: "ok" | "silent" | "bad-json" = "ok";
let port = 0;

function body(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

function verifyWebhook(req: IncomingMessage, raw: Buffer): boolean {
  const auth = req.headers.authorization;
  if (auth) return auth === `Bearer ${BEARER}`;
  const id = req.headers["webhook-id"] as string;
  const ts = req.headers["webhook-timestamp"] as string;
  const sig = req.headers["webhook-signature"] as string;
  const key = Buffer.from(WHSEC.slice(6), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${ts}.${raw.toString("utf8")}`).digest("base64");
  return sig === `v1,${expected}` && Math.abs(Date.now() / 1000 - Number(ts)) < 300;
}

async function fakeBot(payload: any) {
  await new Promise((r) => setTimeout(r, botDelayMs));
  if (botMode === "silent") return;
  const { renderDeliverScript } = await import("../src/routine.ts");
  const script = join(home, "deliver.py");
  writeFileSync(script, renderDeliverScript({ githubRepo: REPO, githubBranch: "main", resultsDir: "results" }));
  const result =
    botMode === "bad-json"
      ? { xscout_result: 1, run_id: payload.run_id, status: "maybe" }
      : {
          xscout_result: 1,
          run_id: payload.run_id,
          status: "ok",
          answer_markdown: `People like it [1]. Query was: ${payload.query}`,
          posts: [
            {
              url: "https://x.com/someone/status/1",
              author_handle: "someone",
              author_name: "Some One",
              created_at: "2026-11-20T10:00:00Z",
              text: "This is great",
              metrics: { likes: 1234, reposts: 56, replies: 7, quotes: null, views: 89000 },
              why_relevant: "Primary source",
            },
          ],
          searches: ["topic lang:en"],
          coverage_notes: "Last 7 days",
          error: null,
        };
  const resultFile = join(home, `${payload.run_id}.json`);
  writeFileSync(resultFile, JSON.stringify(result));
  await new Promise<void>((resolve) => {
    execFile(
      "python3",
      [script, payload.run_id, payload.delivery.path, resultFile],
      { env: { ...process.env, XSCOUT_GITHUB_TOKEN: WRITE_TOKEN, XSCOUT_GITHUB_API: `http://127.0.0.1:${port}` } },
      (err, stdout, stderr) => {
        if (botMode === "ok") assert.ok(!err && stdout.includes("XSCOUT_DELIVERED"), `deliver.py failed: ${stderr}`);
        resolve();
      },
    );
  });
}

async function handler(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url!, "http://x");
  const raw = await body(req);
  if (req.method === "POST" && url.pathname === "/webhook") {
    if (!verifyWebhook(req, raw)) return res.writeHead(401).end("bad signature");
    const payload = JSON.parse(raw.toString());
    received.push(payload);
    res.writeHead(200).end("{}");
    void fakeBot(payload);
    return;
  }
  const repoMatch = url.pathname === `/repos/${REPO}`;
  if (repoMatch) {
    if (req.headers.authorization !== `Bearer ${READ_TOKEN}`) return res.writeHead(401).end();
    return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ full_name: REPO, private: true, default_branch: "main" }));
  }
  const prefix = `/repos/${REPO}/contents/`;
  if (url.pathname.startsWith(prefix)) {
    const path = decodeURIComponent(url.pathname.slice(prefix.length));
    const auth = req.headers.authorization;
    if (req.method === "GET") {
      if (auth !== `Bearer ${READ_TOKEN}` && auth !== `Bearer ${WRITE_TOKEN}`) return res.writeHead(401).end();
      const f = files.get(path);
      if (!f) return res.writeHead(404).end('{"message":"Not Found"}');
      if (String(req.headers.accept).includes("raw")) return res.writeHead(200).end(f.content);
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ sha: f.sha, content: f.content.toString("base64") }));
    }
    if (req.method === "PUT") {
      if (auth !== `Bearer ${WRITE_TOKEN}`) return res.writeHead(403).end('{"message":"forbidden"}');
      const b = JSON.parse(raw.toString());
      files.set(path, { content: Buffer.from(b.content, "base64"), sha: randomBytes(20).toString("hex") });
      return res.writeHead(201, { "content-type": "application/json" }).end("{}");
    }
  }
  res.writeHead(404).end();
}

const server = createServer((req, res) => void handler(req, res));

function useSecret(secret: string) {
  process.env.XSCOUT_WEBHOOK_SECRET = secret;
}

before(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
  Object.assign(process.env, {
    XSCOUT_HOME: home,
    XSCOUT_WEBHOOK_URL: `http://127.0.0.1:${port}/webhook`,
    XSCOUT_GITHUB_REPO: REPO,
    XSCOUT_GITHUB_API: `http://127.0.0.1:${port}`,
    XSCOUT_GITHUB_TOKEN: READ_TOKEN,
    XSCOUT_WEBHOOK_SECRET: WHSEC,
    XSCOUT_POLL_MS: "100",
  });
});

after(() => server.close());

describe("core flow", () => {
  test("signed webhook → bot delivers via deliver.py → result is read back", async () => {
    const { startResearch, waitForResult, formatOutcome } = await import("../src/core.ts");
    const run = await startResearch({ query: "What do people think of Foo?", maxPosts: 5, since: "2026-11-01" });
    const payload = received.at(-1);
    assert.equal(payload.run_id, run.runId);
    assert.equal(payload.params.max_posts, 5);
    assert.equal(payload.params.since, "2026-11-01");
    assert.equal(payload.delivery.repo, REPO);
    assert.match(payload.delivery.path, /^results\/\d{4}-\d{2}-\d{2}\/xs-\d{8}-\d{6}-[0-9a-f]{6}\.json$/);
    const outcome = await waitForResult(run.runId, 10);
    assert.equal(outcome.state, "done");
    const text = formatOutcome(outcome);
    assert.match(text, /https:\/\/x\.com\/someone\/status\/1/);
    assert.match(text, /1\.2K likes/);
    assert.match(text, /People like it \[1\]/);
    // second read comes from the local cache, even without network
    const again = await waitForResult(run.runId, 0);
    assert.equal(again.state, "done");
  });

  test("bearer-key webhooks are supported", async () => {
    useSecret(BEARER);
    try {
      const { startResearch, waitForResult } = await import("../src/core.ts");
      const run = await startResearch({ query: "bearer mode" });
      assert.equal((await waitForResult(run.runId, 10)).state, "done");
    } finally {
      useSecret(WHSEC);
    }
  });

  test("wrong webhook secret fails loudly and records the error", async () => {
    useSecret(`whsec_${randomBytes(24).toString("base64")}`);
    try {
      const { startResearch } = await import("../src/core.ts");
      await assert.rejects(startResearch({ query: "should fail" }), /HTTP 401/);
    } finally {
      useSecret(WHSEC);
    }
  });

  test("slow bot → pending with run_id, then x_research_result picks it up", async () => {
    botDelayMs = 1500;
    try {
      const { startResearch, waitForResult, formatOutcome } = await import("../src/core.ts");
      const run = await startResearch({ query: "slow one" });
      const first = await waitForResult(run.runId, 0.3);
      assert.equal(first.state, "pending");
      assert.match(formatOutcome(first), new RegExp(run.runId));
      const second = await waitForResult(run.runId, 10);
      assert.equal(second.state, "done");
    } finally {
      botDelayMs = 300;
    }
  });

  test("deliver.py refuses invalid results; client reports stale runs", async () => {
    botMode = "bad-json";
    process.env.XSCOUT_STALE_MINUTES = "0";
    try {
      const { startResearch, waitForResult, formatOutcome } = await import("../src/core.ts");
      const run = await startResearch({ query: "bad json" });
      const outcome = await waitForResult(run.runId, 2);
      assert.equal(outcome.state, "pending"); // nothing was delivered
      assert.ok(outcome.state === "pending" && outcome.stale);
      assert.match(formatOutcome(outcome), /may be stuck/);
    } finally {
      botMode = "ok";
      delete process.env.XSCOUT_STALE_MINUTES;
    }
  });

  test("deliver.py rejects a path outside the expected results location", async () => {
    const { renderDeliverScript } = await import("../src/routine.ts");
    const script = join(home, "deliver-guard.py");
    writeFileSync(script, renderDeliverScript({ githubRepo: REPO, githubBranch: "main", resultsDir: "results" }));
    const f = join(home, "x.json");
    writeFileSync(f, JSON.stringify({ xscout_result: 1, run_id: "xs-20261123-000000-abcdef", status: "ok" }));
    const err = await new Promise<string>((resolve) =>
      execFile("python3", [script, "xs-20261123-000000-abcdef", "../../etc/passwd", f], { env: { ...process.env, XSCOUT_GITHUB_TOKEN: WRITE_TOKEN } }, (_e, _o, stderr) =>
        resolve(stderr),
      ),
    );
    assert.match(err, /XSCOUT_DELIVERY_FAILED: result_path must be results\/2026-11-23\//);
  });
});

describe("MCP server over stdio", () => {
  test("lists tools and answers x_research end to end", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../src/server.ts", import.meta.url))],
      env: { ...(process.env as Record<string, string>) },
      stderr: "pipe",
    });
    const client = new Client({ name: "test", version: "0" });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((t) => t.name).sort(), ["x_research", "x_research_recent", "x_research_result"]);
      const res: any = await client.callTool({ name: "x_research", arguments: { query: "MCP end to end", wait_seconds: 10 } });
      assert.ok(!res.isError, res.content?.[0]?.text);
      assert.match(res.content[0].text, /## X research: MCP end to end/);
      assert.match(res.content[0].text, /x\.com\/someone\/status\/1/);
      const json: any = await client.callTool({ name: "x_research", arguments: { query: "json please", wait_seconds: 10, response_format: "json" } });
      assert.equal(JSON.parse(json.content[0].text).xscout_result, 1);
      const recent: any = await client.callTool({ name: "x_research_recent", arguments: { limit: 3 } });
      assert.match(recent.content[0].text, /json please/);
      const unknown: any = await client.callTool({ name: "x_research_result", arguments: { run_id: "nope" } });
      assert.equal(unknown.isError, true);
    } finally {
      await client.close();
    }
  });
});

describe("codex config merge", () => {
  test("replaces an existing xscout block and keeps everything else", async () => {
    const { upsertCodexToml } = await import("../src/agents.ts");
    const before = `model = "x"\n\n[mcp_servers.xscout]\ncommand = "old"\n\n[mcp_servers.xscout.env]\nA = "1"\n\n[mcp_servers.other]\ncommand = "keep"\n`;
    const out = upsertCodexToml(before, { command: "/node", args: ["/srv.ts"] });
    assert.doesNotMatch(out, /old/);
    assert.doesNotMatch(out, /A = "1"/);
    assert.match(out, /\[mcp_servers\.other\]\ncommand = "keep"/);
    assert.match(out, /\[mcp_servers\.xscout\]\ncommand = "\/node"\nargs = \["\/srv\.ts"\]/);
    assert.equal(upsertCodexToml(out, { command: "/node", args: ["/srv.ts"] }), out);
  });
});
