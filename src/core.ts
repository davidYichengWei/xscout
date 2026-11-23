import { requireConfig, type XscoutConfig } from "./config.ts";
import { readRepoFile } from "./github.ts";
import { formatResultMarkdown, parseResult, type XscoutResult } from "./result.ts";
import {
  loadResultCache,
  loadRun,
  newRunId,
  resultPathFor,
  saveResultCache,
  saveRun,
  type ResearchParams,
  type RunRecord,
} from "./runs.ts";
import { requireSecret } from "./secrets.ts";
import { triggerWebhook } from "./webhook.ts";

export const DEFAULT_WAIT_SECONDS = Number(process.env.XSCOUT_DEFAULT_WAIT ?? 45);

/** The JSON body the XScout routine receives. Keep in sync with routine/INSTRUCTIONS.template.md. */
export function buildPayload(run: RunRecord, cfg: XscoutConfig) {
  const p = run.params;
  return {
    xscout: 1,
    run_id: run.runId,
    query: p.query,
    params: {
      since: p.since ?? null,
      until: p.until ?? null,
      max_posts: p.maxPosts ?? 15,
      language: p.language ?? null,
      answer_language: p.answerLanguage ?? null,
    },
    delivery: { type: "github", repo: cfg.githubRepo, branch: cfg.githubBranch, path: run.resultPath },
    requested_at: run.createdAt,
  };
}

export async function startResearch(params: ResearchParams): Promise<RunRecord> {
  const query = params.query.trim();
  if (!query) throw new Error("query must not be empty");
  const cfg = requireConfig();
  const secret = requireSecret("webhook-secret");
  requireSecret("github-read-token"); // fail before spending a Grok Bot run we could never read back
  const runId = newRunId();
  const run: RunRecord = {
    runId,
    params: { ...params, query },
    resultPath: resultPathFor(cfg.resultsDir, runId),
    createdAt: new Date().toISOString(),
    status: "pending",
  };
  saveRun(run);
  try {
    await triggerWebhook(cfg.webhookUrl, secret, buildPayload(run, cfg));
  } catch (err) {
    run.status = "error";
    run.error = (err as Error).message;
    saveRun(run);
    throw err;
  }
  return run;
}

export type WaitOutcome =
  | { state: "done"; run: RunRecord; result: XscoutResult; elapsedSec: number }
  | { state: "pending"; run: RunRecord; elapsedSec: number; stale: boolean; warning?: string };

function secondsSince(iso: string, until = Date.now()): number {
  return Math.max(0, (until - Date.parse(iso)) / 1000);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export interface WaitOptions {
  signal?: AbortSignal;
  onTick?: (elapsedSec: number) => void;
}

export async function waitForResult(runId: string, waitSeconds: number, opts: WaitOptions = {}): Promise<WaitOutcome> {
  const run = loadRun(runId);
  if (!run) throw new Error(`Unknown run_id "${runId}". Use x_research_recent to list runs started on this machine.`);
  if (run.status === "error" && run.error && !loadResultCache(runId)) {
    throw new Error(`Run ${runId} never started: ${run.error}`);
  }
  const cfg = requireConfig();
  const token = requireSecret("github-read-token");
  const deadline = Date.now() + Math.max(0, waitSeconds) * 1000;
  let warning: string | undefined;

  for (;;) {
    const cached = loadResultCache(runId);
    let raw: string | null | undefined = cached;
    if (raw === undefined) {
      try {
        raw = await readRepoFile(cfg, token, run.resultPath);
        warning = undefined;
      } catch (err) {
        const msg = (err as Error).message;
        if (/HTTP 40[13]/.test(msg)) throw err; // auth problems will not fix themselves
        warning = msg; // transient network / 5xx: keep polling
        raw = null;
      }
    }
    if (raw !== null && raw !== undefined) {
      const result = parseResult(raw, runId);
      if (cached === undefined) {
        saveResultCache(runId, raw);
        run.status = result.status === "ok" ? "done" : "error";
        run.completedAt = new Date().toISOString();
        saveRun(run);
      }
      const end = run.completedAt ? Date.parse(run.completedAt) : Date.now();
      return { state: "done", run, result, elapsedSec: secondsSince(run.createdAt, end) };
    }
    const remaining = deadline - Date.now();
    const elapsedSec = secondsSince(run.createdAt);
    if (remaining <= 0 || opts.signal?.aborted) {
      return { state: "pending", run, elapsedSec, stale: elapsedSec > cfg.staleAfterMinutes * 60, warning };
    }
    opts.onTick?.(elapsedSec);
    await sleep(Math.min(cfg.pollIntervalMs, remaining), opts.signal);
  }
}

export function formatOutcome(outcome: WaitOutcome): string {
  if (outcome.state === "done") {
    return formatResultMarkdown(outcome.result, outcome.run.params.query, outcome.elapsedSec);
  }
  const { run, elapsedSec } = outcome;
  const lines: string[] = [];
  if (outcome.stale) {
    lines.push(
      `XScout has not delivered a result for run_id "${run.runId}" after ${Math.round(elapsedSec / 60)} minutes.`,
      "The routine run may be stuck (for example on an approval card in the Grok Bot app) or may have failed.",
      `Ask the user to check the XScout routine run in Grok Bot. You may keep polling with x_research_result({"run_id": "${run.runId}"}) or start a new x_research.`,
    );
  } else {
    lines.push(
      `XScout is still researching on X (run_id "${run.runId}", ${Math.round(elapsedSec)}s elapsed; runs usually take 20-90s, sometimes longer).`,
      `Call x_research_result({"run_id": "${run.runId}"}) to keep waiting. Do other useful work in between if you can.`,
    );
  }
  if (outcome.warning) lines.push(`(Last poll error, will retry: ${outcome.warning})`);
  return lines.join("\n");
}
