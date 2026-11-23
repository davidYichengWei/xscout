# x-via-grokbot

[English](README.md) | [简体中文](README.zh-CN.md)

**Let your coding agent search and read X (Twitter) through your existing Grok Bot subscription — no X API key, no xAI API key, no extra cost.**

`x-via-grokbot` is an MCP server and CLI for Claude Code, Codex, Cursor, Antigravity, or any MCP client. Your agent sends a question to your [Grok Bot](https://docs.x.ai/grok-bot) via an official Webhook Routine; Grok Bot researches X using its built-in public X access and returns an end-to-end encrypted answer with cited post URLs.

## Install

Paste this into your coding agent (Claude Code, Codex, Cursor, etc.):

```text
Install and configure https://github.com/davidYichengWei/x-via-grokbot for me.
Read INSTALL.md in the repo first and follow it step by step. Do everything you can automatically, and only pause when I need to act in the Grok Bot app or enter the webhook secret.
```

*Prefer installing manually? Follow [`INSTALL.md`](INSTALL.md).*

## Requirements

- A [Grok Bot](https://docs.x.ai/grok-bot) subscription with Routines
- Node.js **23.6+** (**25+** if behind an HTTP proxy)
- macOS or Linux

## Why this works well

- **Official surfaces only** — uses Grok Bot's official [Webhook Routines](https://docs.x.ai/grok-bot/skills-routines-and-automations), no undocumented endpoints or cookie scraping.
- **Nothing to host, no extra accounts** — results come back via [ntfy.sh](https://ntfy.sh) with per-run end-to-end encryption (ntfy only ever sees ciphertext).
- **Isolated & structured** — every query runs in its own routine run and returns a synthesized answer plus cited post URLs, authors, timestamps, and engagement.
- **Works everywhere** — built-in registration for Claude Code, Codex, Cursor, and Antigravity, plus `mcp-spec` for any other MCP client.

## Docs

- [`INSTALL.md`](INSTALL.md) — Agent runbook & manual setup guide
- [`docs/ADVANCED.md`](docs/ADVANCED.md) — Architecture, MCP tools, CLI, encryption, private GitHub repo transport, multi-machine setup, proxies, and troubleshooting

## License

[MIT](LICENSE) — independent project, not affiliated with xAI, X Corp., Cursor, or ntfy.
