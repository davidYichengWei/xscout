# xscout

[English](README.md) | [简体中文](README.zh-CN.md)

**Search and read X (Twitter) from any coding agent through your own Grok Bot.**

xscout is an MCP server and CLI. It lets Claude Code, Codex, Cursor and Antigravity search X, read posts and threads, and get back a synthesized answer with cited source posts. The research is done by your [Grok Bot](https://docs.x.ai/grok-bot), using its built-in public X access. You don't need an X API or xAI API key, and you pay nothing beyond your existing Grok Bot subscription.

```text
coding agent ──MCP──▶ xscout (your machine) ──POST official webhook {run_id, query, topic, one-time key}──▶ Grok Bot routine (researches X)
     ▲                                                                                                       │
     └──── polls ntfy.sh/<topic>, verifies and decrypts ◀── publishes the result, encrypted with the run's key ──┘
```

- **Official surfaces only.** xscout triggers a Grok Bot [webhook routine](https://docs.x.ai/grok-bot/skills-routines-and-automations). It doesn't depend on any undocumented Grok Bot endpoint, so app updates are unlikely to break it.
- **Nothing to host, no extra accounts.** Your machine only makes outbound HTTPS requests. Results come back through [ntfy](https://ntfy.sh), a public HTTP pub/sub service that needs no account, and they're encrypted end to end so ntfy only ever sees ciphertext.
- **Isolated runs.** Every request is its own routine run, so runs never mix with each other or with your main Grok Bot chat, and you can run several at once.
- **Structured results.** You get an answer plus the source posts: URL, author, time, text and engagement.

## Requirements

- A Grok Bot subscription with Routines available.
- Node.js **23.6 or newer** on each machine that runs the agents. xscout runs its TypeScript sources directly, so there's no build step. If the machine reaches the internet through an HTTP(S) proxy, use Node **25 or newer**.
- macOS or Linux. On macOS, the webhook key goes into the login Keychain. On Linux, it goes into `~/.xscout/secrets.json` with mode `0600`.

That's all. A GitHub account is only needed for the [optional GitHub transport](#optional-deliver-through-a-private-github-repo).

## Setup

Setup takes about 5 minutes: two steps on your machine, one in Grok Bot, and two back on your machine.

### 1. Install xscout

```bash
git clone https://github.com/davidYichengWei/xscout.git
cd xscout
npm ci
alias xscout="node $PWD/src/cli.ts"   # optional; the rest of this guide uses `xscout`
```

The agent configs point at this folder by absolute path, so put it somewhere it can stay. If you move it later, re-run `xscout install-agents`.

### 2. Render the routine

```bash
xscout routine
```

This writes two files:

- `~/.xscout/CREATE_ROUTINE_MESSAGE.md`: a chat message that asks Grok Bot to create the routine for you.
- `~/.xscout/ROUTINE_INSTRUCTIONS.md`: the routine's instructions on their own, if you'd rather create it by hand.

### 3. Create the webhook routine in Grok Bot

Paste the whole content of `~/.xscout/CREATE_ROUTINE_MESSAGE.md` into a Grok Bot chat (on macOS: `pbcopy < ~/.xscout/CREATE_ROUTINE_MESSAGE.md`). Grok Bot creates a routine named **xscout webhook research** with a **Webhook** trigger. When it asks, allow `python3 /tmp/xscout/deliver.py ...` and its HTTPS requests to `ntfy.sh` to run without approval: nobody watches these runs, and an approval card blocks a run until it times out.

To create it by hand instead: make a new Routine with the trigger set to **Webhook**, paste `~/.xscout/ROUTINE_INSTRUCTIONS.md` into **Instructions** unchanged (it contains a small Python script that has to stay byte-for-byte identical), and set up the same approval rule.

Then copy the routine's **webhook URL** and its **key** from the routine's trigger settings in the Grok Bot app. The key is either a `whsec_…` signing secret or a `crsr_…` Bearer key; both work. Never paste the key into a chat.

### 4. Connect xscout to the routine

```bash
xscout config --webhook-url 'https://…the webhook URL…'
xscout secret set webhook-secret        # paste the key, then Enter and Ctrl-D
```

### 5. Register the MCP server with your agents, then try it

```bash
xscout install-agents                   # or: --only claude,codex
xscout doctor
xscout ask "What has @AnthropicAI posted on X in the past 3 days? Link the main announcements." --max-posts 5
```

`install-agents` adds an `xscout` MCP server to each agent's config:

| Agent | Config |
|---|---|
| Claude Code | `claude mcp add-json --scope user` (`~/.claude.json`, or `$CLAUDE_CONFIG_DIR/.claude.json`) |
| Codex | `~/.codex/config.toml` |
| Cursor | `~/.cursor/mcp.json` |
| Antigravity | `~/.gemini/config/mcp_config.json` |

Each existing file is backed up next to itself (`*.xscout-backup-<time>`) before it's changed. Restart the agents, or open a new session, to load the server. For any other MCP client, `xscout mcp-spec` prints the command to configure by hand.

`doctor` checks the config, the webhook key, that the ntfy server is reachable, and the agent registrations. The first `ask` usually takes 1 to 5 minutes. After that, ask your agent something like *"Search X for reactions to …"* and it will call xscout.

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

## How results get back to you

For every run, xscout generates a random ntfy topic (`xs_` plus 24 random characters) and a one-time 32-byte key, and sends both to the routine in the webhook request. Nothing else ever learns them.

When the research is done, the routine's `deliver.py` compresses the result, encrypts it with that key, and publishes it to the topic as an ntfy attachment. The encryption uses only the Python standard library: HMAC-SHA256 in counter mode for the keystream, then an HMAC-SHA256 tag over the run ID, nonce and ciphertext (encrypt-then-MAC). xscout polls the topic, checks the tag, decrypts, and caches the result in `~/.xscout/runs/`.

What ntfy can see: the topic name, the run ID (used as the file name), the time, and the size of the ciphertext. It can't read your question or the answer. On ntfy.sh, messages are kept for 12 hours and attachments for 3 hours; xscout caches each result after the first read, so this only matters if nobody collects a result for 3 hours.

To use your own ntfy server instead of ntfy.sh:

```bash
xscout config --ntfy-server https://ntfy.example.com
xscout routine        # then update the routine's instructions in Grok Bot
```

## Optional: deliver through a private GitHub repo

If you'd rather keep results in a repo you own, permanently, xscout can have the routine commit them to a private GitHub repo instead.

1. Create a **private** repo with a README, for example `gh repo create xscout-inbox --private --add-readme`.
2. At [GitHub → Settings → Fine-grained tokens](https://github.com/settings/personal-access-tokens/new), create a token limited to that repo with **Contents: Read and write**. This is the routine's write token. A read-only token for your machine is optional: if you're logged in with `gh auth login`, xscout uses `gh auth token`.
3. In a Grok Bot chat, ask it to save a secret named `XSCOUT_GITHUB_TOKEN`, and paste the write token into the secure secret card (choose **Save securely**).
4. Switch xscout over and re-render the routine:

   ```bash
   xscout config --transport github --repo <your-github-user>/xscout-inbox
   xscout secret set github-read-token   # optional
   xscout routine
   ```

5. Paste the new `~/.xscout/CREATE_ROUTINE_MESSAGE.md` into Grok Bot so it updates the routine. A routine rendered with a repo accepts both ntfy and GitHub delivery, so machines on either transport keep working.

## Using more machines

Every machine runs its own xscout but shares the same routine. On the new machine:

```bash
git clone https://github.com/davidYichengWei/xscout.git && cd xscout && npm ci
node src/cli.ts config --webhook-url '<the same webhook URL>'
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

The key only travels encrypted with RSA-OAEP, and the one-time key pair is deleted after `unseal`. On the GitHub transport, also set `--transport github --repo …` on the new machine, and run `gh auth login` there or move `github-read-token` the same way.

## Proxies

If `HTTPS_PROXY` or `HTTP_PROXY` is set, xscout turns on Node's built-in proxy support (Node 25 or newer). Some agents, such as Codex, don't pass their environment to MCP servers, so by default `install-agents` copies the current proxy variables into each agent's xscout config.

If your machine can reach the webhook host and ntfy directly, and the proxy is slow, register without them:

```bash
env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy -u ALL_PROXY -u all_proxy xscout install-agents --no-proxy
```

## Limits and costs

- **Speed.** A run usually takes 1 to 5 minutes. Most of that is Grok Bot running several X searches one after another; delivery and polling add about 15 seconds. Narrow questions are faster: name the accounts, the time range, and how many posts you need.
- **Quota.** Each run uses your Grok Bot usage quota. Put related questions into one detailed query.
- **Rate limits.** Grok Bot caps webhook-triggered routine runs. At the time of writing, the cap is 200 per hour for one routine and 300 per hour across all routines. ntfy.sh also rate-limits anonymous use, far above what xscout needs.
- **What it can read.** Only public X content. xscout and the routine never post, like, follow or DM.

## Security

- Results are encrypted end to end with a fresh key per run, and xscout rejects anything that fails authentication.
- The routine only delivers to the ntfy server (and, if configured, the GitHub repo) baked into its instructions, and ignores any other destination named in a request.
- The routine treats posts, linked pages and the query itself as untrusted data, and it ignores instructions found there.
- The webhook key stays in the macOS Keychain or in a `0600` file. The environment variable `XSCOUT_WEBHOOK_SECRET` overrides it.
- Local state (config, run records with their one-time keys, cached results) lives in `~/.xscout/` with private file permissions. Set `XSCOUT_HOME` to move it.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| A run stays pending for a long time | Open the routine run in the Grok Bot app. It's often waiting on an approval card; allow `deliver.py` to run unattended (see step 3). |
| `Grok Bot webhook returned HTTP 401` (or 403) | Wrong webhook key. Re-run `xscout secret set webhook-secret`. |
| `result failed authentication` | The routine didn't copy the run's key exactly. Run the query again; if it keeps happening, re-paste the routine instructions. |
| `XSCOUT_DELIVERY_FAILED: delivery.url must be …` in the routine run | The routine's instructions were rendered for a different ntfy server. Run `xscout routine` and update the routine. |
| `doctor` says an agent isn't registered | Run `xscout install-agents --only <agent>` and restart that agent. |
| Requests hang behind a proxy | Use Node 25 or newer, or register with `--no-proxy` if direct access works. |

## Development

```bash
npm test            # end-to-end tests: local mock webhook, ntfy and GitHub APIs, plus the rendered deliver.py run for real
npm run typecheck
```

The webhook payload and the result format are the contract between `src/core.ts`, `src/result.ts` and `routine/INSTRUCTIONS.template.md`, and the encryption in `src/seal.ts` must match `seal()` in `routine/deliver.template.py` byte for byte. Change them together.

## Disclaimer

xscout is an independent project. It isn't affiliated with or endorsed by xAI, X Corp., Cursor or ntfy. Use it in line with the terms of the services it touches.

## License

[MIT](LICENSE)
