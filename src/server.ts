#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { VERSION } from "./config.ts";
import { enableEnvProxy } from "./net.ts";
import { DEFAULT_WAIT_SECONDS, formatOutcome, startResearch, waitForResult, type WaitOutcome } from "./core.ts";
import { loadResultCache, listRuns } from "./runs.ts";

const INSTRUCTIONS = `xscout researches X (Twitter) through the user's own Grok Bot, using its built-in public X access.
- Calls are slow (usually 1-5 minutes) and use the user's Grok Bot quota: put related questions into ONE detailed query instead of many small ones.
- Results contain a synthesized answer plus source post URLs. Cite those URLs; do not invent posts.
- If x_research returns a pending run_id, call x_research_result with that run_id to keep waiting.`;

const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .optional();

const WAIT = z
  .number()
  .int()
  .min(0)
  .max(240)
  .optional()
  .describe(`Seconds to block waiting for the result (default ${DEFAULT_WAIT_SECONDS}). If the result is not ready, you get a run_id to poll.`);

const FORMAT = z
  .enum(["markdown", "json"])
  .optional()
  .describe("markdown (default): readable answer with numbered source posts. json: the raw structured result.");

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

function progressReporter(extra: Extra): ((elapsedSec: number) => void) | undefined {
  const token = extra._meta?.progressToken;
  if (token === undefined) return undefined;
  return (elapsedSec) => {
    extra
      .sendNotification({
        method: "notifications/progress",
        params: { progressToken: token, progress: Math.round(elapsedSec), message: `Grok Bot researching on X... ${Math.round(elapsedSec)}s` },
      })
      .catch(() => {});
  };
}

function render(outcome: WaitOutcome, format: "markdown" | "json" | undefined) {
  const text =
    format === "json" && outcome.state === "done"
      ? (loadResultCache(outcome.run.runId) ?? JSON.stringify(outcome.result, null, 2))
      : formatOutcome(outcome);
  return { content: [{ type: "text" as const, text }] };
}

function failure(err: unknown) {
  return { isError: true, content: [{ type: "text" as const, text: `xscout error: ${(err as Error).message ?? String(err)}` }] };
}

enableEnvProxy();

const server = new McpServer({ name: "xscout", version: VERSION }, { instructions: INSTRUCTIONS });

server.registerTool(
  "x_research",
  {
    title: "Research X (Twitter) via Grok Bot",
    description:
      "Search and read X (Twitter) posts through the user's Grok Bot and get back a synthesized answer with cited source posts (URL, author, time, text, engagement). " +
      "Good for: what people are saying about a topic or product, finding posts or threads by an account, reading a specific X post or thread by URL, launch and announcement reactions, expert opinions, trends. " +
      "Slow: usually 1-5 minutes, so ask one detailed question. If it is not finished within wait_seconds, you get a run_id; call x_research_result to continue.",
    inputSchema: {
      query: z
        .string()
        .min(3)
        .describe(
          "The research question, in natural language. Be specific: name the topic, relevant @handles, product names, and what you need (opinions, facts, links, a timeline). May include X post URLs to read.",
        ),
      since: DATE.describe("Only consider posts on or after this date (YYYY-MM-DD)."),
      until: DATE.describe("Only consider posts on or before this date (YYYY-MM-DD)."),
      max_posts: z.number().int().min(1).max(50).optional().describe("Maximum number of source posts to return (default 15)."),
      language: z.string().max(10).optional().describe("Restrict posts to a language code, for example en, ja or zh."),
      answer_language: z.string().max(20).optional().describe("Language of the written answer. Defaults to the language of the query."),
      wait_seconds: WAIT,
      response_format: FORMAT,
    },
    annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: false },
  },
  async (args, extra) => {
    try {
      const run = await startResearch({
        query: args.query,
        since: args.since,
        until: args.until,
        maxPosts: args.max_posts,
        language: args.language,
        answerLanguage: args.answer_language,
      });
      const outcome = await waitForResult(run.runId, args.wait_seconds ?? DEFAULT_WAIT_SECONDS, {
        signal: extra.signal,
        onTick: progressReporter(extra),
      });
      return render(outcome, args.response_format);
    } catch (err) {
      return failure(err);
    }
  },
);

server.registerTool(
  "x_research_result",
  {
    title: "Get the result of an X research run",
    description: "Wait for and fetch the result of an earlier x_research call by run_id. Cheap: it only polls for the delivered result and does not start a new Grok Bot run.",
    inputSchema: {
      run_id: z.string().describe("The run_id returned by x_research, for example xs-20261123-072559-a1b2c3."),
      wait_seconds: WAIT,
      response_format: FORMAT,
    },
    annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  },
  async (args, extra) => {
    try {
      const outcome = await waitForResult(args.run_id, args.wait_seconds ?? DEFAULT_WAIT_SECONDS, {
        signal: extra.signal,
        onTick: progressReporter(extra),
      });
      return render(outcome, args.response_format);
    } catch (err) {
      return failure(err);
    }
  },
);

server.registerTool(
  "x_research_recent",
  {
    title: "List recent X research runs",
    description: "List recent x_research runs started on this machine with their status. Use it to recover a lost run_id or to reuse a recent answer instead of re-running the same research.",
    inputSchema: { limit: z.number().int().min(1).max(50).optional().describe("How many runs to list (default 10).") },
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
  },
  async (args) => {
    try {
      const runs = listRuns(args.limit ?? 10);
      const text = runs.length
        ? runs.map((r) => `- ${r.runId} [${r.status}] ${r.createdAt}: ${r.params.query.slice(0, 160)}`).join("\n")
        : "No xscout runs yet.";
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      return failure(err);
    }
  },
);

await server.connect(new StdioServerTransport());
