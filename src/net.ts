import http from "node:http";

const PROXY_VARS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"] as const;

/** Proxy-related variables currently set (used to pin them into agent MCP configs). */
export function proxyEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of PROXY_VARS) {
    const v = process.env[k];
    if (v) out[k] = v;
  }
  return out;
}

/**
 * Node's fetch ignores HTTP(S)_PROXY by default. Corporate/dev boxes often only reach
 * GitHub through a proxy, so opt in to Node's built-in env-proxy support when one is set.
 */
export function enableEnvProxy(): boolean {
  const env = process.env;
  if (!(env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy)) return false;
  if (env.XSCOUT_NO_PROXY_SUPPORT === "1") return false;
  const setGlobal = (http as unknown as { setGlobalProxyFromEnv?: (env?: NodeJS.ProcessEnv) => void }).setGlobalProxyFromEnv;
  if (typeof setGlobal !== "function") {
    process.stderr.write("xscout: proxy env detected but this Node lacks http.setGlobalProxyFromEnv; use Node >= 25 or NODE_USE_ENV_PROXY=1\n");
    return false;
  }
  setGlobal();
  return true;
}
