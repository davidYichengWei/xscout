# `x-via-grokbot` — Advanced Reference

## Architecture

```text
coding agent ──MCP──▶ x-via-grokbot (your machine) ──POST official webhook {run_id, query, topic, one-time key}──▶ Grok Bot routine (researches X)
     ▲                                                                                                                   │
     └────────── polls ntfy.sh/<topic>, verifies and decrypts ◀──────── publishes the result, encrypted with the key ────┘
```

- **No X API key or xAI API key.** Research runs on your own [Grok Bot](https://docs.x.ai/grok-bot) using its built-in public X access.
- **No inbound ports or self-hosted server.** Your machine only makes outbound HTTPS calls.
- **Supported agents:**

| Agent | Config |
|---|---|
| Claude Code | `claude mcp add-json --scope user` (`~/.claude.json`, or `$CLAUDE_CONFIG_DIR/.claude.json`) |
| Codex | `~/.codex/config.toml` |
| Cursor | `~/.cursor/mcp.json` |
| Antigravity | `~/.gemini/config/mcp_config.json` |

For any other MCP client, run `node src/cli.ts mcp-spec` to print the stdio server spec.

## MCP tools

| MCP tool | What it does |
|---|---|
| `x_research(query, since?, until?, max_posts?, language?, answer_language?, wait_seconds?, response_format?)` | Starts one research run and waits up to `wait_seconds` (default 45, max 240). If not done yet, returns a `run_id`. |
| `x_research_result(run_id, wait_seconds?)` | Keeps waiting for an earlier run. Does not start a new Grok Bot run. |
| `x_research_recent(limit?)` | Lists recent runs on this machine so an agent can recover a lost `run_id` or reuse a cached answer. |

Runs often take longer than a single MCP tool call waits (typically 1–5 minutes). That's expected: the agent gets a `run_id` and calls `x_research_result` to collect the answer.

## CLI reference

Optionally alias `x-via-grokbot="node /path/to/x-via-grokbot/src/cli.ts"`:

```bash
x-via-grokbot ask "<question>" [--wait 300] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--max-posts 15] [--json]
x-via-grokbot result <run_id> [--wait 120] [--json]
x-via-grokbot recent [--limit 10]
x-via-grokbot doctor
x-via-grokbot mcp-spec
x-via-grokbot --help
```

## How results get back to you (end-to-end encryption)

For every run, `x-via-grokbot` generates a random ntfy topic (`xvg_` + 24 random base64url characters) and a one-time 32-byte key, and sends both to the routine inside the webhook payload. Nothing else ever learns them.

When the research finishes, the routine's `deliver.py` compresses the result with zlib, encrypts it with that key, and publishes it to the topic as an ntfy attachment. The encryption uses only the Python standard library: HMAC-SHA256 in counter mode for the keystream, plus an HMAC-SHA256 authentication tag over the run ID, nonce, and ciphertext (encrypt-then-MAC). `x-via-grokbot` polls the topic, verifies the tag with constant-time comparison, decrypts, and caches the result in `~/.x-via-grokbot/runs/`.

What ntfy can see: the random topic name, the run ID (used as the attachment filename), the timestamp, and the ciphertext size. It cannot read your query or the answer. On `ntfy.sh`, messages are kept for 12 hours and attachments for 3 hours; `x-via-grokbot` caches each result locally on first read.

To use your own ntfy server instead of `ntfy.sh`:

```bash
node src/cli.ts config --ntfy-server https://ntfy.example.com
node src/cli.ts routine        # then update the routine's instructions in Grok Bot
```

## Optional: deliver through a private GitHub repo

If you prefer keeping all research results permanently in a private GitHub repo you own:

1. Create a **private** repo with a README, e.g. `gh repo create x-via-grokbot-inbox --private --add-readme`.
2. At [GitHub → Settings → Fine-grained tokens](https://github.com/settings/personal-access-tokens/new), create a token limited to that repo with **Contents: Read and write**. This is the routine's write token. A read-only token for your machine is optional if `gh auth login` is active.
3. In a Grok Bot chat, ask it to save a secret named `X_VIA_GROKBOT_GITHUB_TOKEN`, and paste the write token into the secure secret card (**Save securely**).
4. Switch `x-via-grokbot` over and re-render the routine:

```bash
node src/cli.ts config --transport github --repo <your-github-user>/x-via-grokbot-inbox
node src/cli.ts secret set github-read-token   # optional if logged into gh
node src/cli.ts routine
```

5. Paste the new `~/.x-via-grokbot/CREATE_ROUTINE_MESSAGE.md` into Grok Bot to update the routine. A routine rendered with a repo accepts both ntfy and GitHub delivery, so machines on either transport keep working.

## Using more machines

Every machine runs its own `x-via-grokbot` and shares the same Grok Bot routine. You can move the webhook secret to a new machine encrypted with a one-time RSA-OAEP 3072-bit key pair:

On the **new machine**:

```bash
git clone https://github.com/davidYichengWei/x-via-grokbot.git ~/x-via-grokbot
cd ~/x-via-grokbot && npm ci
node src/cli.ts config --webhook-url '<the same webhook URL>'
node src/cli.ts secret keygen > /tmp/xvg.pub
```

Copy `/tmp/xvg.pub` to a machine that already has the webhook secret and run:

```bash
node src/cli.ts secret seal webhook-secret --pubkey /tmp/xvg.pub
```

Back on the **new machine**:

```bash
node src/cli.ts secret unseal webhook-secret '<ciphertext>'
node src/cli.ts install-agents
node src/cli.ts doctor
```

The one-time key pair is deleted immediately after `unseal`.

## Proxies

If `HTTPS_PROXY` or `HTTP_PROXY` is set, `x-via-grokbot` enables Node's built-in env-proxy support (requires Node 25+). Some agents (such as Codex) strip parent environment variables before launching MCP servers, so `install-agents` pins the current proxy variables into each agent's config by default.

If your machine can reach the webhook host and ntfy directly (and the proxy is slow), register without proxy env vars:

```bash
env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy -u ALL_PROXY -u all_proxy \
  node src/cli.ts install-agents --no-proxy
```

## Limits and costs

- **Speed.** A run typically takes 1–5 minutes. Most of that is Grok Bot running several X searches sequentially; delivery and polling add ~15 seconds. Specific queries (naming accounts, date ranges, and `--max-posts`) finish faster.
- **Quota.** Each run uses your Grok Bot usage quota. Combine related questions into one detailed query instead of many small ones.
- **Rate limits.** Grok Bot caps webhook-triggered routine runs (currently ~200/hour per routine, ~300/hour across all routines).
- **Read-only.** Only public X content is read. Neither `x-via-grokbot` nor the routine ever posts, likes, follows, or DMs.

## Security

- Results are encrypted end to end with a fresh 32-byte key per run; anything that fails authentication is rejected immediately.
- The routine only delivers to the ntfy server (and, if configured, GitHub repo) baked into its instructions and ignores any other destination in a payload.
- The routine treats posts, linked pages, and the query itself as untrusted data and ignores prompt-injection instructions found there.
- Secrets are stored in the macOS login Keychain (`x-via-grokbot`) or in `~/.x-via-grokbot/secrets.json` (mode `0600`). `X_VIA_GROKBOT_WEBHOOK_SECRET` overrides stored secrets.
- Local state lives in `~/.x-via-grokbot/` with `0700`/`0600` permissions. Override with `X_VIA_GROKBOT_HOME`.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| A run stays pending for a long time | Open the routine run in the Grok Bot app — it is often waiting on an approval card. Allow `deliver.py` to run unattended. |
| `Grok Bot webhook returned HTTP 401` (or `403`) | Wrong webhook secret. Re-run `node src/cli.ts secret set webhook-secret`. |
| `result failed authentication` | The routine altered or truncated `delivery.key`. Retry; if it persists, re-paste the routine instructions verbatim. |
| `X_VIA_GROKBOT_DELIVERY_FAILED: delivery.url must be …` | The routine was rendered for a different ntfy server. Run `node src/cli.ts routine` and update the routine. |
| `doctor` says an agent isn't registered | Run `node src/cli.ts install-agents --only <agent>` and restart that agent. |
| Requests hang behind a proxy | Use Node 25+, or re-register with `--no-proxy` if direct access works. |

## Development

```bash
npm run typecheck
npm test            # end-to-end tests with local mock webhook, ntfy, GitHub API, and real deliver.py
```

The webhook payload and result schema are the contract between `src/core.ts`, `src/result.ts`, and `routine/INSTRUCTIONS.template.md`. The encryption in `src/seal.ts` must match `seal()` in `routine/deliver.template.py` byte for byte. Change them together.
