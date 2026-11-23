import { VERSION, type XscoutConfig } from "./config.ts";

function headers(token: string, accept: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept,
    "x-github-api-version": "2022-11-28",
    "user-agent": `xscout/${VERSION}`,
    "cache-control": "no-cache",
  };
}

function contentsUrl(cfg: XscoutConfig, path: string): string {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `${cfg.githubApiBase}/repos/${cfg.githubRepo}/contents/${encodedPath}?ref=${encodeURIComponent(cfg.githubBranch)}`;
}

async function failure(res: Response, what: string): Promise<Error> {
  const text = (await res.text().catch(() => "")).slice(0, 300);
  const hint =
    res.status === 401
      ? " The github-read-token is invalid or expired."
      : res.status === 403
        ? " The token lacks access or the API rate limit was hit."
        : "";
  return new Error(`GitHub ${what} failed: HTTP ${res.status}.${hint} ${text}`.trim());
}

/** Returns the raw file text, or null while the file does not exist yet. */
export async function readRepoFile(cfg: XscoutConfig, token: string, path: string): Promise<string | null> {
  const res = await fetch(contentsUrl(cfg, path), {
    headers: headers(token, "application/vnd.github.raw+json"),
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 404) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.ok) throw await failure(res, `read of ${path}`);
  return await res.text();
}

export interface RepoInfo {
  fullName: string;
  private: boolean;
  defaultBranch: string;
}

export async function getRepoInfo(cfg: XscoutConfig, token: string): Promise<RepoInfo> {
  const res = await fetch(`${cfg.githubApiBase}/repos/${cfg.githubRepo}`, {
    headers: headers(token, "application/vnd.github+json"),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw await failure(res, `access to ${cfg.githubRepo}`);
  const data = (await res.json()) as { full_name: string; private: boolean; default_branch: string };
  return { fullName: data.full_name, private: data.private, defaultBranch: data.default_branch };
}
