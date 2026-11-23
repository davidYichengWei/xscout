import { z } from "zod";

/** Contract between the xscout routine (writer) and this client (reader). Keep in sync with routine/INSTRUCTIONS.template.md. */
const Metrics = z.looseObject({
  likes: z.number().nullish(),
  reposts: z.number().nullish(),
  replies: z.number().nullish(),
  quotes: z.number().nullish(),
  views: z.number().nullish(),
});

const Post = z.looseObject({
  url: z.string(),
  author_handle: z.string().nullish(),
  author_name: z.string().nullish(),
  created_at: z.string().nullish(),
  text: z.string().nullish(),
  metrics: Metrics.nullish(),
  why_relevant: z.string().nullish(),
});

export const ResultSchema = z.looseObject({
  xscout_result: z.literal(1),
  run_id: z.string(),
  status: z.enum(["ok", "error"]),
  answer_markdown: z.string().nullish(),
  posts: z.array(Post).nullish(),
  searches: z.array(z.string()).nullish(),
  coverage_notes: z.string().nullish(),
  error: z.string().nullish(),
  started_at: z.string().nullish(),
  completed_at: z.string().nullish(),
});

export type XscoutResult = z.infer<typeof ResultSchema>;
export type XscoutPost = z.infer<typeof Post>;

export function parseResult(raw: string, expectedRunId: string): XscoutResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Result file is not valid JSON: ${(err as Error).message}`);
  }
  const parsed = ResultSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`Result file does not match the xscout schema: ${z.prettifyError(parsed.error)}`);
  }
  if (parsed.data.run_id !== expectedRunId) {
    throw new Error(`Result run_id mismatch: expected ${expectedRunId}, got ${parsed.data.run_id}`);
  }
  return parsed.data;
}

function fmtCount(n: number | null | undefined): string | undefined {
  if (n === null || n === undefined) return undefined;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(n);
}

function formatPost(p: XscoutPost, i: number): string {
  const who = [p.author_handle ? `@${p.author_handle.replace(/^@/, "")}` : undefined, p.author_name ? `(${p.author_name})` : undefined]
    .filter(Boolean)
    .join(" ");
  const m = p.metrics ?? {};
  const metrics = [
    fmtCount(m.likes) && `${fmtCount(m.likes)} likes`,
    fmtCount(m.reposts) && `${fmtCount(m.reposts)} reposts`,
    fmtCount(m.replies) && `${fmtCount(m.replies)} replies`,
    fmtCount(m.views) && `${fmtCount(m.views)} views`,
  ]
    .filter(Boolean)
    .join(", ");
  const head = [who || "unknown author", p.created_at, metrics].filter(Boolean).join(" · ");
  const lines = [`${i + 1}. ${head}`, `   ${p.url}`];
  if (p.text) lines.push(...p.text.trim().split("\n").map((l) => `   > ${l}`));
  if (p.why_relevant) lines.push(`   Why relevant: ${p.why_relevant}`);
  return lines.join("\n");
}

export function formatResultMarkdown(r: XscoutResult, query: string, elapsedSec?: number): string {
  const out: string[] = [];
  if (r.status === "error") {
    out.push(`Grok Bot could not finish this research: ${r.error ?? "unknown error"}`);
  }
  out.push(`## X research: ${query}`, "");
  if (r.answer_markdown?.trim()) out.push(r.answer_markdown.trim(), "");
  const posts = r.posts ?? [];
  out.push(`### Source posts (${posts.length})`, "");
  out.push(posts.length ? posts.map(formatPost).join("\n\n") : "_No posts returned._", "");
  if (r.coverage_notes?.trim()) out.push(`### Coverage notes`, "", r.coverage_notes.trim(), "");
  if (r.searches?.length) out.push(`_Searches run: ${r.searches.map((s) => `\`${s}\``).join(", ")}_`);
  out.push(`_run_id: ${r.run_id}${elapsedSec !== undefined ? ` · ${Math.round(elapsedSec)}s` : ""} · via Grok Bot (xscout)_`);
  return out.join("\n");
}
