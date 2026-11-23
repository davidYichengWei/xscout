# Installing `x-via-grokbot`

> **Instructions for coding agents:** Follow steps 1–6 in order. Run every local command automatically. Pause and ask the user **only** at Step 3 (creating the routine inside the Grok Bot app) and Step 4 (storing the webhook secret safely without pasting it into chat).

---

## Step 1: Check Node.js and clone into a permanent directory

1. Check Node.js version (`node -v`).
   - Requires **Node.js >= 23.6** (`x-via-grokbot` runs TypeScript directly with no build step).
   - If the machine uses `HTTPS_PROXY` / `HTTP_PROXY`, requires **Node.js >= 25**.
   - If Node is too old or missing, install or switch to a supported Node version before continuing.
2. Clone the repository into a **permanent** directory (for example `~/x-via-grokbot` — do **not** use `/tmp`, because agent MCP configs reference the absolute path to `src/server.ts`):

```bash
git clone https://github.com/davidYichengWei/x-via-grokbot.git ~/x-via-grokbot
cd ~/x-via-grokbot
npm ci
```

> **Proxy tip:** If `HTTPS_PROXY` / `HTTP_PROXY` is set and `npm ci` hangs or is very slow, test direct connectivity (`env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy -u ALL_PROXY -u all_proxy curl -fsS https://ntfy.sh/v1/health`). If direct access works, run `npm ci` without proxy env vars and pass `--no-proxy` in Step 5.

## Step 2: Render the Grok Bot routine

```bash
node ~/x-via-grokbot/src/cli.ts routine
```

This writes:
- `~/.x-via-grokbot/CREATE_ROUTINE_MESSAGE.md` — a ready-to-paste chat message that asks Grok Bot to create the routine automatically.
- `~/.x-via-grokbot/ROUTINE_INSTRUCTIONS.md` — the raw instructions if the user prefers creating the routine manually.

If a clipboard utility is available, copy the chat message to the user's clipboard now so they only need to press Paste:
- macOS: `pbcopy < ~/.x-via-grokbot/CREATE_ROUTINE_MESSAGE.md`
- Linux (Wayland/X11, if installed): `wl-copy < ~/.x-via-grokbot/CREATE_ROUTINE_MESSAGE.md` or `xclip -selection clipboard < ~/.x-via-grokbot/CREATE_ROUTINE_MESSAGE.md`

## Step 3: Ask the user to create the routine in Grok Bot

**Pause here and give the user these brief instructions:**

1. Open the **Grok Bot** app and paste the message (already on your clipboard, or located at `~/.x-via-grokbot/CREATE_ROUTINE_MESSAGE.md`) into a chat.
2. When Grok Bot asks to approve the routine or tool access, approve it and allow `python3 /tmp/x-via-grokbot/deliver.py ...` plus its HTTPS requests to `ntfy.sh` to run unattended without approval prompts (nobody watches webhook runs, so an approval prompt blocks them until timeout).
3. Open the new routine's **Webhook** trigger settings and copy:
   - the **Webhook URL** (`https://...`)
   - the **Webhook Key** (either a `whsec_...` signing secret or a `crsr_...` Bearer key)
4. Reply with the **Webhook URL** only — do **not** paste the Webhook Key into chat.

*(Manual alternative: create a Routine with trigger **Webhook**, paste `~/.x-via-grokbot/ROUTINE_INSTRUCTIONS.md` verbatim into Instructions, and set the same auto-approval rule.)*

## Step 4: Save the Webhook URL and secret safely

1. Save the Webhook URL the user provided:

```bash
node ~/x-via-grokbot/src/cli.ts config --webhook-url '<WEBHOOK_URL>'
```

2. Store the Webhook Key **without putting it in chat history**:
   - If you have a dedicated secure secret-input tool, use it and pipe the value to `node ~/x-via-grokbot/src/cli.ts secret set webhook-secret --from-file <file>`.
   - Otherwise, ask the user to run ONE of these commands in their own terminal and tell you when done:
     - **macOS (after copying the key):**
       ```bash
       pbpaste | node ~/x-via-grokbot/src/cli.ts secret set webhook-secret
       ```
     - **macOS or Linux (interactive stdin):**
       ```bash
       node ~/x-via-grokbot/src/cli.ts secret set webhook-secret
       # paste the key, then press Enter and Ctrl-D
       ```
   - Verify it was stored without printing it:
     ```bash
     node ~/x-via-grokbot/src/cli.ts secret status
     ```
     Confirm `webhook-secret: present`.

## Step 5: Detect installed coding agents and register the MCP server

Check which supported agents exist on this machine so you don't create unused config files:
- `claude`: `command -v claude` succeeds
- `codex`: `~/.codex` exists or `command -v codex` succeeds
- `cursor`: `~/.cursor` exists
- `antigravity`: `~/.gemini` exists

Register `x-via-grokbot` for the detected agents (or whichever the user requested):

```bash
node ~/x-via-grokbot/src/cli.ts install-agents --only <comma-separated-list>
```

- If you found in Step 1 that direct network access is faster than the shell's proxy, unset proxy vars and pass `--no-proxy`:
  ```bash
  env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy -u ALL_PROXY -u all_proxy \
    node ~/x-via-grokbot/src/cli.ts install-agents --only <comma-separated-list> --no-proxy
  ```
- For any other MCP client (Windsurf, Claude Desktop, etc.), print the JSON snippet with:
  ```bash
  node ~/x-via-grokbot/src/cli.ts mcp-spec
  ```
- Each modified config file is automatically backed up alongside itself (`*.x-via-grokbot-backup-<timestamp>`).

## Step 6: Verify end-to-end

1. Run diagnostics:

```bash
node ~/x-via-grokbot/src/cli.ts doctor
```

Make sure `config`, `secrets`, `ntfy`, and the registered agents all show `✓`.

2. Run a quick live smoke test (let the user know this takes ~1–3 minutes):

```bash
node ~/x-via-grokbot/src/cli.ts ask "What has @AnthropicAI posted on X in the past 3 days? Link the main announcements." --max-posts 3
```

3. If it returns an answer with cited `https://x.com/...` links, setup is complete! Remind the user to **restart their coding agent (or open a new session)** so the `x-via-grokbot` MCP server loads.

---

### Adding another machine later?

You don't need to create a second Grok Bot routine — every machine shares the same routine. See [`docs/ADVANCED.md#using-more-machines`](docs/ADVANCED.md#using-more-machines) for encrypted secret transfer between machines.
