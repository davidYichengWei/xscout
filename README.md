# xscout

[English](README.md) | [简体中文](README.zh-CN.md)

**Search and read X (Twitter) from any coding agent through your own Grok Bot.**

xscout is an MCP server and CLI. It lets Claude Code, Codex, Cursor and Antigravity search X, read posts and threads, and get back a synthesized answer with cited source posts. The research is done by your [Grok Bot](https://docs.x.ai/grok-bot), using its built-in public X access. You don't need an X API or xAI API key, and you pay nothing beyond your existing Grok Bot subscription.

```text
coding agent ──MCP──▶ xscout (your machine) ──POST official webhook {run_id, query}──▶ Grok Bot routine (cloud computer, researches X)
     ▲                                                                                        │
     └──── polls GitHub for results/<date>/<run_id>.json ◀── commits the result JSON to your private repo ──┘
```

- **Official surfaces only.** xscout triggers a Grok Bot [webhook routine](https://docs.x.ai/grok-bot/skills-routines-and-automations) and reads results through the GitHub API. It doesn't depend on any undocumented Grok Bot endpoint, so app updates are unlikely to break it.
- **Nothing to host.** Your machine only makes outbound HTTPS requests. There's no server, no open port and no tunnel. Results travel through a private GitHub repo that you own.
- **Isolated runs.** Every request is its own routine run, so runs never mix with each other or with your main Grok Bot chat, and you can run several at once.
- **Structured results.** You get an answer plus the source posts: URL, author, time, text and engagement.

## Requirements

- A Grok Bot subscription with Routines available.
- A GitHub account. The [`gh` CLI](https://cli.github.com/) is optional but makes setup easier.
- Node.js **23.6 or newer** on each machine that runs the agents. xscout runs its TypeScript sources directly, so there's no build step. If the machine reaches the internet through an HTTP(S) proxy, use Node **25 or newer**.
- macOS or Linux. On macOS, secrets go into the login Keychain. On Linux, they go into `~/.xscout/secrets.json` with mode `0600`.

## Setup

Setup takes about 10 minutes. Steps 1 to 4 happen on your machine and on GitHub, steps 5 and 6 happen in Grok Bot, and steps 7 to 9 happen back on your machine.

### 1. Install xscout

```bash
git clone https://github.com/davidYichengWei/xscout.git
cd xscout
npm ci
alias xscout="node $PWD/src/cli.ts"   # optional; the rest of this guide uses `xscout`
```

The agent configs point at this folder by absolute path, so put it somewhere it can stay. If you move it later, re-run `xscout install-agents`.

### 2. Create a private "inbox" repo on GitHub

Grok Bot commits each result here, and xscout reads it back.

```bash
gh repo create xscout-inbox --private --add-readme
```

You can also do this on the web: create a **private** repo, check **Add a README** so the `main` branch exists, and leave everything else empty. Results include your research questions, so keep this repo private; `xscout doctor` reports a public inbox as a problem.

### 3. Create GitHub tokens

Go to [GitHub → Settings → Fine-grained tokens](https://github.com/settings/personal-access-tokens/new). For each token, set **Repository access** to *Only select repositories* and pick the inbox repo only.

| Token | Permission | Used by |
|---|---|---|
| **Write token** (required) | Contents: **Read and write** | Grok Bot, to commit results |
| **Read token** (optional) | Contents: **Read-only** | xscout on your machine, to read results |

If you're logged in with `gh auth login` on the machine, you can skip the read token: xscout falls back to `gh auth token`. The write token is never stored on your machine.

### 4. Configure xscout and render the routine

```bash
xscout config --repo <your-github-user>/xscout-inbox
xscout secret set github-read-token     # optional: paste the read token, then Enter and Ctrl-D
xscout routine
```

`xscout routine` writes two files:

- `~/.xscout/ROUTINE_INSTRUCTIONS.md`: the instructions for the Grok Bot routine, already filled in with your repo.
- `~/.xscout/CREATE_ROUTINE_MESSAGE.md`: a chat message that asks Grok Bot to create the routine for you, with those instructions embedded.

### 5. Give Grok Bot the write token

In a Grok Bot chat, send:

> Please save a secret named `XSCOUT_GITHUB_TOKEN` for me. I'll paste the value into the secure secret card.

When the secret card appears, paste the **write token** and choose **Save securely**. Don't paste the token as a normal chat message.

### 6. Create the webhook routine

The easiest way is to paste the whole content of `~/.xscout/CREATE_ROUTINE_MESSAGE.md` into the Grok Bot chat and let it create the routine. You can also create it yourself:

1. Create a new **Routine** with the trigger set to **Webhook**.
2. Paste the full content of `~/.xscout/ROUTINE_INSTRUCTIONS.md` into **Instructions**, unchanged. It contains a small Python script that has to stay byte-for-byte identical.
3. Make sure routine runs can read the `XSCOUT_GITHUB_TOKEN` secret, and that running `python3 /tmp/xscout/deliver.py ...` with its requests to `api.github.com` doesn't need manual approval. Nobody watches these runs, and an approval card blocks the run until it times out.

Then copy the routine's **webhook URL** and its **key** from the routine's trigger settings in the Grok Bot app. The key is either a `whsec_…` signing secret or a `crsr_…` Bearer key; both work. Never paste the key into a chat.

### 7. Connect xscout to the routine

```bash
xscout config --webhook-url 'https://…the webhook URL…'
xscout secret set webhook-secret        # paste the key, then Enter and Ctrl-D
```

### 8. Register the MCP server with your agents

```bash
xscout install-agents                   # or: --only claude,codex
```

This adds an `xscout` MCP server to each agent's config:

| Agent | Config |
|---|---|
| Claude Code | `claude mcp add-json --scope user` (`~/.claude.json`, or `$CLAUDE_CONFIG_DIR/.claude.json`) |
| Codex | `~/.codex/config.toml` |
| Cursor | `~/.cursor/mcp.json` |
| Antigravity | `~/.gemini/config/mcp_config.json` |

Each existing file is backed up next to itself (`*.xscout-backup-<time>`) before it's changed. Restart the agents, or open a new session, to load the server. For any other MCP client, `xscout mcp-spec` prints the command to configure by hand.

### 9. Check and try it

```bash
xscout doctor
xscout ask "What are people on X saying about the latest Claude release? Give 5 representative posts." --since 2026-11-01
```

`doctor` checks the config, the secrets, access to the inbox repo and the agent registrations. The first `ask` usually takes 1 to 5 minutes. After that, ask your agent something like *"Search X for reactions to …"* and it will call xscout.

## Using xscout from agents

| MCP tool | What it does |
|---|---|
| `x_research(query, since?, until?, max_posts?, language?, answer_language?, wait_seconds?, response_format?)` | Starts one research run and waits up to `wait_seconds` (default 45, max 240). If the run isn't done by then, it returns a `run_id`. |
| `x_research_result(run_id, wait_seconds?)` | Keeps waiting for an earlier run. It doesn't start a new Grok Bot run. |
| `x_research_recent(limit?)` | Lists recent runs on this machine, so an agent can recover a lost `run_id` or reuse an answer. |

Runs often take longer than one tool call is allowed to wait. That's expected: the agent gets a `run_id` and calls `x_research_result` to collect the answer.

## CLI

```bash
xscout ask "<question>" [--wait 300] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--max-posts 15] [--json]
xscout result <run_id> [--wait 120] [--json]
xscout recent [--limit 10]
xscout doctor
xscout --help
```

## Using more machines

Every machine runs its own xscout but shares the same routine and inbox repo. On the new machine:

```bash
git clone https://github.com/davidYichengWei/xscout.git && cd xscout && npm ci
node src/cli.ts config --repo <your-github-user>/xscout-inbox --webhook-url '<the same webhook URL>'
node src/cli.ts secret keygen > /tmp/xscout.pub     # prints a one-time public key
```

Copy `/tmp/xscout.pub` to a machine that already has the webhook key and run:

```bash
xscout secret seal webhook-secret --pubkey /tmp/xscout.pub   # prints ciphertext
```

Back on the new machine:

```bash
node src/cli.ts secret unseal webhook-secret '<ciphertext>'
node src/cli.ts install-agents
node src/cli.ts doctor
```

The key only travels encrypted with RSA-OAEP, and the one-time key pair is deleted after `unseal`. For the read token, run `gh auth login` on the new machine or move `github-read-token` the same way.

## Proxies

If `HTTPS_PROXY` or `HTTP_PROXY` is set, xscout turns on Node's built-in proxy support (Node 25 or newer). Some agents, such as Codex, don't pass their environment to MCP servers, so by default `install-agents` copies the current proxy variables into each agent's xscout config.

If your machine can reach `api.github.com` and the webhook host directly, and the proxy is slow, register without them:

```bash
env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy -u ALL_PROXY -u all_proxy xscout install-agents --no-proxy
```

## Limits and costs

- **Speed.** A run usually takes 1 to 5 minutes. Most of that is Grok Bot running several X searches one after another; delivery and polling add about 30 seconds. Narrow questions are faster: name the accounts, the time range, and how many posts you need.
- **Quota.** Each run uses your Grok Bot usage quota. Put related questions into one detailed query.
- **Rate limits.** Grok Bot caps webhook-triggered routine runs. At the time of writing, the cap is 200 per hour for one routine and 300 per hour across all routines.
- **What it can read.** Only public X content. xscout and the routine never post, like, follow or DM.

## Security

- The inbox repo must be private, and `doctor` checks this. Each token is scoped to that one repo.
- The routine delivers only to the repo baked into its instructions and ignores any other destination named in a request.
- The routine treats posts, linked pages and the query itself as untrusted data, and it ignores instructions found there.
- The webhook key and read token stay in the macOS Keychain or in a `0600` file. Environment variables `XSCOUT_WEBHOOK_SECRET` and `XSCOUT_GITHUB_TOKEN` override them.
- Local state (config, run records, cached results) lives in `~/.xscout/`. Set `XSCOUT_HOME` to move it.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| A run stays pending for a long time | Open the routine run in the Grok Bot app. It's often waiting on an approval card; allow `deliver.py` to run unattended (see step 6). |
| `Grok Bot webhook returned HTTP 401` (or 403) | Wrong webhook key. Re-run `xscout secret set webhook-secret`. |
| `XSCOUT_DELIVERY_FAILED: GitHub HTTP 404` in the routine run | The write token can't access the inbox repo, or the repo name in the routine is wrong. |
| `doctor` says an agent isn't registered | Run `xscout install-agents --only <agent>` and restart that agent. |
| Requests hang behind a proxy | Use Node 25 or newer, or register with `--no-proxy` if direct access works. |

## Development

```bash
npm test            # end-to-end tests: a local mock webhook and GitHub API, plus the rendered deliver.py run for real
npm run typecheck
```

The webhook payload and the result format are the contract between `src/core.ts`, `src/result.ts` and `routine/INSTRUCTIONS.template.md`. Change them together.

## Disclaimer

xscout is an independent project. It isn't affiliated with or endorsed by xAI, X Corp. or Cursor. Use it in line with the terms of the services it touches.

## License

[MIT](LICENSE)
