import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appHome } from "./config.ts";
import type { NtfyDelivery } from "./ntfy.ts";

export interface ResearchParams {
  query: string;
  since?: string;
  until?: string;
  maxPosts?: number;
  language?: string;
  answerLanguage?: string;
}

export type RunStatus = "pending" | "done" | "error";

export interface RunRecord {
  runId: string;
  params: ResearchParams;
  /** GitHub transport: where the routine commits the result. */
  resultPath?: string;
  /** ntfy transport: where the routine publishes the sealed result, and the key to open it. */
  ntfy?: NtfyDelivery;
  createdAt: string;
  status: RunStatus;
  completedAt?: string;
  /** Set when the webhook trigger itself failed. */
  error?: string;
}

export const RUN_ID_RE = /^xvg-\d{8}-\d{6}-[0-9a-f]{6}$/;

function runsDir(): string {
  const dir = join(appHome(), "runs");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function newRunId(now = new Date()): string {
  const iso = now.toISOString(); // 2026-11-23T07:25:59.123Z
  const date = iso.slice(0, 10).replaceAll("-", "");
  const time = iso.slice(11, 19).replaceAll(":", "");
  return `xvg-${date}-${time}-${randomBytes(3).toString("hex")}`;
}

/** results/2026-11-23/xvg-20261123-072559-a1b2c3.json */
export function resultPathFor(resultsDir: string, runId: string): string {
  const d = runId.slice(4, 12);
  return `${resultsDir}/${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}/${runId}.json`;
}

function atomicWrite(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}

export function saveRun(run: RunRecord): void {
  atomicWrite(join(runsDir(), `${run.runId}.json`), `${JSON.stringify(run, null, 2)}\n`);
}

export function loadRun(runId: string): RunRecord | undefined {
  if (!RUN_ID_RE.test(runId)) return undefined;
  const path = join(runsDir(), `${runId}.json`);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as RunRecord;
}

export function saveResultCache(runId: string, raw: string): void {
  atomicWrite(join(runsDir(), `${runId}.result.json`), raw);
}

export function loadResultCache(runId: string): string | undefined {
  const path = join(runsDir(), `${runId}.result.json`);
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

export function listRuns(limit = 10): RunRecord[] {
  return readdirSync(runsDir())
    .filter((f) => RUN_ID_RE.test(f.replace(/\.json$/, "")) && f.endsWith(".json"))
    .sort()
    .reverse()
    .slice(0, limit)
    .map((f) => JSON.parse(readFileSync(join(runsDir(), f), "utf8")) as RunRecord);
}
