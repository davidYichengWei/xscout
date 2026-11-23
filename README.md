# xscout

让任何 coding agent（Claude Code / Codex / Cursor / Antigravity）通过**你自己的 Grok Bot（XScout）**搜索和阅读 X。
复用 Grok Bot 订阅额度，不需要 X API 或 xAI API 付费。

```text
Agent ──MCP──▶ xscout（本机）──POST 官方 Webhook {run_id, query, …}──▶ XScout Routine（Grok Bot 云电脑，独立对话，查 X）
  ▲                                                                              │
  └──── 轮询 GitHub API 读取 results/<date>/<run_id>.json ◀── deliver.py 提交到私有仓库 ──┘
```

- 每次请求都是一次独立的 Routine 运行：不串话，也不会污染 XScout 的主聊天，支持并发。
- 返回结构化结果：一段综合回答，加上来源帖子列表（链接、作者、时间、原文、互动数据）。
- 你的 Mac 不部署任何服务、不开端口，只发普通的出站 HTTPS 请求。
- 只用官方能力（Routine Webhook）和 GitHub API，不依赖 Grok Bot 的内部接口。

## MCP 工具

| 工具 | 作用 |
|---|---|
| `x_research(query, since?, until?, max_posts?, language?, answer_language?, wait_seconds?, response_format?)` | 发起一次研究，最多等待 `wait_seconds` 秒（默认 45）。超时就返回 `run_id` |
| `x_research_result(run_id, wait_seconds?)` | 继续等待某次研究的结果。不会再触发 Grok Bot |
| `x_research_recent(limit?)` | 列出最近的研究记录 |

## 一次性配置

1. **GitHub**
   - 新建一个**私有**仓库，例如 `xscout-inbox`，勾选初始化 README，保证 `main` 分支存在。
   - 建两个 fine-grained token，Repository access 都只选这个仓库：
     - **写 token**：Contents 设为 Read and write。交给 XScout 使用。
     - **读 token**：Contents 设为 Read-only。给本机使用。
2. **本机**
   ```bash
   node src/cli.ts config --repo <you>/xscout-inbox --webhook-url <routine webhook URL>
   node src/cli.ts secret set github-read-token --from-file <file>
   node src/cli.ts secret set webhook-secret --from-file <file>
   node src/cli.ts routine          # 生成 ~/.xscout/ROUTINE_INSTRUCTIONS.md
   node src/cli.ts install-agents   # 写入 Claude / Codex / Cursor / Antigravity 的 MCP 配置（会自动备份原文件）
   node src/cli.ts doctor
   ```
3. **Grok Bot（XScout）**
   - 在 XScout 的聊天里让它把写 token 安全保存为 secret，名字叫 `XSCOUT_GITHUB_TOKEN`（通过 secret 卡片选择 Save securely）。
   - 给 XScout 新建一个 Routine，触发方式选 **Webhook**，Instructions 粘贴 `~/.xscout/ROUTINE_INSTRUCTIONS.md` 的全部内容。
   - 复制 Webhook URL 和 key/secret（`whsec_…` 签名密钥或 `crsr_…` Bearer key 都支持），填回第 2 步。

## 命令行

```bash
node src/cli.ts ask "大家怎么评价 X 产品的最新发布？" --since 2026-11-01
node src/cli.ts result <run_id> --wait 120
node src/cli.ts recent
```

## 开发

```bash
npm test          # 端到端测试：本地模拟 webhook 和 GitHub API，并真实运行渲染后的 deliver.py
npm run typecheck
```

- 需要 Node ≥ 23.6，直接运行 `.ts` 文件。
- 秘密存放在 macOS 钥匙串（service `xscout`），也可以用环境变量 `XSCOUT_WEBHOOK_SECRET` / `XSCOUT_GITHUB_TOKEN` 覆盖。
- 本地状态保存在 `~/.xscout/`。
- Agent 配置里写的是本目录的绝对路径。移动目录后要重新运行 `install-agents`。
