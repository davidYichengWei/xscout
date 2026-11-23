# x-via-grokbot

[English](README.md) | [简体中文](README.zh-CN.md)

**让你的 Coding Agent 复用已有的 Grok Bot 订阅直接搜索和阅读 X（Twitter）——无需 X API Key，无需 xAI API Key，零额外费用。**

`x-via-grokbot` 是一个 MCP Server 与 CLI，支持 Claude Code、Codex、Cursor、Antigravity 以及任意 MCP 客户端。Agent 通过官方 Webhook Routine 把问题发给你的 [Grok Bot](https://docs.x.ai/grok-bot)，由 Grok Bot 用内置的公开 X 检索能力完成调研，并将带原帖链接的结果端到端加密回传。

## 安装

直接把下面这段话发给你的 Coding Agent（Claude Code、Codex、Cursor 等）：

```text
帮我安装并配置 https://github.com/davidYichengWei/x-via-grokbot
请先阅读仓库里的 INSTALL.md 并按步骤执行：你能自动完成的步骤全部自己做完，只在需要我在 Grok Bot 里操作以及录入 Webhook Key 时再叫我。
```

*如果想手动安装，直接看 [`INSTALL.md`](INSTALL.md)。*

## 前置条件

- 一个支持 Routines 的 [Grok Bot](https://docs.x.ai/grok-bot) 订阅
- Node.js **23.6+**（如果走 HTTP 代理则需要 **25+**）
- macOS 或 Linux

## 特点

- **只走官方能力** — 基于 Grok Bot 官方 [Webhook Routine](https://docs.x.ai/grok-bot/skills-routines-and-automations)，不依赖未公开接口，也不需要抓 Cookie。
- **零自建、零额外账号** — 结果经 [ntfy.sh](https://ntfy.sh) 端到端加密回传，中转服务器只能看到密文。
- **隔离且结构化** — 每次查询独立运行，互不干扰，返回整理后的结论以及原帖链接、作者、时间与互动数据。
- **主流 Agent 开箱即用** — 内置 Claude Code、Codex、Cursor、Antigravity 自动注册，也支持用 `mcp-spec` 接入其他 MCP 客户端。

## 更多文档

- [`INSTALL.md`](INSTALL.md) — Agent 自动安装指引 / 手动安装步骤
- [`docs/ADVANCED.md`](docs/ADVANCED.md) — 架构、MCP 工具与 CLI 说明、加密机制、GitHub 私有库回传、多机同步、代理与排障

## License

[MIT](LICENSE) — 独立开源项目，与 xAI、X Corp.、Cursor、ntfy 无关。
