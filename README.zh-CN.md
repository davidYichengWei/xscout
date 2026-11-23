# xscout

[English](README.md) | [简体中文](README.zh-CN.md)

**让任何 coding agent 通过你自己的 Grok Bot 搜索和阅读 X（Twitter）。**

xscout 是一个 MCP 服务器加命令行工具。Claude Code、Codex、Cursor 和 Antigravity 可以用它搜索 X、阅读帖子和整条 Thread，拿回一段综合回答，并附上引用的原帖。调研由你的 [Grok Bot](https://docs.x.ai/grok-bot) 用它内置的公开 X 读取能力完成。你不需要 X API 或 xAI API 的 key，除了现有的 Grok Bot 订阅，不需要额外付费。

```text
coding agent ──MCP──▶ xscout（你的机器）──POST 官方 Webhook {run_id, query}──▶ Grok Bot Routine（云电脑，查 X）
     ▲                                                                                   │
     └──── 轮询 GitHub 读取 results/<date>/<run_id>.json ◀── 把结果 JSON 提交到你的私有仓库 ──┘
```

- **只用官方能力。** xscout 通过 Grok Bot 的 [Webhook Routine](https://docs.x.ai/grok-bot/skills-routines-and-automations) 触发调研，再通过 GitHub API 读回结果。它不依赖任何未公开的 Grok Bot 接口，所以 Grok Bot 更新一般不会让它失效。
- **不用部署服务。** 你的机器只发出站 HTTPS 请求，不开服务、不开端口，也不需要内网穿透。结果经过的是你自己的私有 GitHub 仓库。
- **每次运行相互独立。** 每个请求都是一次单独的 Routine 运行，不会串话，也不会污染你和 Grok Bot 的主聊天，可以同时跑多个。
- **结构化结果。** 返回一段回答，加上来源帖子列表：链接、作者、时间、原文和互动数据。

## 环境要求

- 有 Grok Bot 订阅，并且能使用 Routine。
- 一个 GitHub 账号。[`gh` 命令行](https://cli.github.com/)不是必需的，但能让配置更省事。
- 每台跑 Agent 的机器上要有 Node.js **23.6 或更新版本**。xscout 直接运行 TypeScript 源码，不需要构建。如果这台机器要通过 HTTP(S) 代理上网，需要 Node **25 或更新版本**。
- macOS 或 Linux。macOS 上密钥存在登录钥匙串里；Linux 上存在 `~/.xscout/secrets.json`，权限为 `0600`。

## 配置步骤

整个配置大约 10 分钟。第 1 到 4 步在你的机器和 GitHub 上做，第 5、6 步在 Grok Bot 里做，第 7 到 9 步回到你的机器上做。

### 1. 安装 xscout

```bash
git clone https://github.com/davidYichengWei/xscout.git
cd xscout
npm ci
alias xscout="node $PWD/src/cli.ts"   # 可选；下文统一写作 `xscout`
```

各 Agent 的配置里写的是这个目录的绝对路径，所以请放在一个以后不会挪动的位置。如果之后移动了目录，要重新运行 `xscout install-agents`。

### 2. 在 GitHub 上建一个私有的收件仓库

Grok Bot 会把每次的结果提交到这个仓库，xscout 再从这里读回来。

```bash
gh repo create xscout-inbox --private --add-readme
```

也可以在网页上建：新建一个**私有**仓库，勾选 **Add a README**，保证 `main` 分支存在，其他保持为空。结果里会包含你的调研问题，所以这个仓库一定要保持私有；如果它是公开的，`xscout doctor` 会报错。

### 3. 创建 GitHub token

打开 [GitHub → Settings → Fine-grained tokens](https://github.com/settings/personal-access-tokens/new)。每个 token 的 **Repository access** 都选 *Only select repositories*，并且只勾选收件仓库。

| Token | 权限 | 给谁用 |
|---|---|---|
| **写 token**（必需） | Contents：**Read and write** | Grok Bot，用来提交结果 |
| **读 token**（可选） | Contents：**Read-only** | 你机器上的 xscout，用来读结果 |

如果这台机器已经用 `gh auth login` 登录过，可以不建读 token，xscout 会自动使用 `gh auth token`。写 token 永远不会保存在你的机器上。

### 4. 配置 xscout 并生成 Routine 指令

```bash
xscout config --repo <你的 GitHub 用户名>/xscout-inbox
xscout secret set github-read-token     # 可选：粘贴读 token，按回车，再按 Ctrl-D
xscout routine
```

`xscout routine` 会生成两个文件：

- `~/.xscout/ROUTINE_INSTRUCTIONS.md`：Grok Bot Routine 的指令，已经填好了你的仓库名。
- `~/.xscout/CREATE_ROUTINE_MESSAGE.md`：一条聊天消息，请 Grok Bot 帮你创建这个 Routine，里面已经嵌好了上面的指令。

### 5. 把写 token 交给 Grok Bot

在 Grok Bot 的聊天里发送：

> 请帮我保存一个名为 `XSCOUT_GITHUB_TOKEN` 的 secret，我会把值粘贴到安全的 secret 卡片里。

出现 secret 卡片后，把**写 token** 粘贴进去，选择 **Save securely**。不要把 token 当普通聊天消息发出去。

### 6. 创建 Webhook Routine

最简单的方式是把 `~/.xscout/CREATE_ROUTINE_MESSAGE.md` 的全部内容粘贴到 Grok Bot 聊天里，让它自己创建 Routine。你也可以手动创建：

1. 新建一个 **Routine**，触发方式选 **Webhook**。
2. 把 `~/.xscout/ROUTINE_INSTRUCTIONS.md` 的全部内容原样粘贴到 **Instructions**。里面有一小段 Python 脚本，必须一个字节都不改。
3. 确认 Routine 运行时能读到 `XSCOUT_GITHUB_TOKEN` 这个 secret，并且运行 `python3 /tmp/xscout/deliver.py ...`（以及它对 `api.github.com` 的请求）不需要人工审批。这些运行没人盯着，一旦弹出审批卡片，运行就会一直卡到超时。

然后在 Grok Bot 应用里这个 Routine 的触发设置中，复制 **Webhook URL** 和 **key**。key 可能是 `whsec_…` 签名密钥，也可能是 `crsr_…` Bearer key，两种都支持。不要把 key 粘贴到任何聊天里。

### 7. 把 xscout 连到这个 Routine

```bash
xscout config --webhook-url 'https://…你的 Webhook URL…'
xscout secret set webhook-secret        # 粘贴 key，按回车，再按 Ctrl-D
```

### 8. 把 MCP 服务器注册到各个 Agent

```bash
xscout install-agents                   # 或者：--only claude,codex
```

它会在每个 Agent 的配置里加一个 `xscout` MCP 服务器：

| Agent | 配置位置 |
|---|---|
| Claude Code | `claude mcp add-json --scope user`（`~/.claude.json`，设置了 `CLAUDE_CONFIG_DIR` 时是 `$CLAUDE_CONFIG_DIR/.claude.json`） |
| Codex | `~/.codex/config.toml` |
| Cursor | `~/.cursor/mcp.json` |
| Antigravity | `~/.gemini/config/mcp_config.json` |

修改前会先在原文件旁边备份一份（`*.xscout-backup-<时间>`）。重启 Agent 或新开一个会话，就能加载这个服务器。其他 MCP 客户端可以用 `xscout mcp-spec` 打印启动命令，手动配置。

### 9. 检查并试用

```bash
xscout doctor
xscout ask "最近 X 上大家怎么评价 Claude 的最新发布？给 5 条代表性帖子" --since 2026-11-01
```

`doctor` 会检查配置、密钥、收件仓库的访问权限和各 Agent 的注册情况。第一次 `ask` 通常要 1 到 5 分钟。之后直接对 Agent 说「帮我在 X 上搜一下大家对……的反应」，它就会调用 xscout。

## 在 Agent 里使用

| MCP 工具 | 作用 |
|---|---|
| `x_research(query, since?, until?, max_posts?, language?, answer_language?, wait_seconds?, response_format?)` | 发起一次调研，最多等待 `wait_seconds` 秒（默认 45，最大 240）。到时还没完成，就返回一个 `run_id`。 |
| `x_research_result(run_id, wait_seconds?)` | 继续等待之前某次调研的结果，不会再触发新的 Grok Bot 运行。 |
| `x_research_recent(limit?)` | 列出这台机器上最近的调研记录，方便 Agent 找回丢失的 `run_id` 或复用已有答案。 |

一次调研经常比单次工具调用允许等待的时间更长，这是正常的：Agent 会先拿到 `run_id`，再调用 `x_research_result` 取回答案。

## 命令行

```bash
xscout ask "<问题>" [--wait 300] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--max-posts 15] [--json]
xscout result <run_id> [--wait 120] [--json]
xscout recent [--limit 10]
xscout doctor
xscout --help
```

## 在多台机器上使用

每台机器各自运行 xscout，但共用同一个 Routine 和收件仓库。在新机器上：

```bash
git clone https://github.com/davidYichengWei/xscout.git && cd xscout && npm ci
node src/cli.ts config --repo <你的 GitHub 用户名>/xscout-inbox --webhook-url '<同一个 Webhook URL>'
node src/cli.ts secret keygen > /tmp/xscout.pub     # 生成一次性公钥
```

把 `/tmp/xscout.pub` 拷到一台已经有 Webhook key 的机器上，运行：

```bash
xscout secret seal webhook-secret --pubkey /tmp/xscout.pub   # 输出密文
```

回到新机器：

```bash
node src/cli.ts secret unseal webhook-secret '<密文>'
node src/cli.ts install-agents
node src/cli.ts doctor
```

key 只以 RSA-OAEP 加密后的形式传输，`unseal` 之后一次性密钥对会被删除。读 token 可以在新机器上 `gh auth login`，或者用同样的方式迁移 `github-read-token`。

## 代理

如果设置了 `HTTPS_PROXY` 或 `HTTP_PROXY`，xscout 会启用 Node 内置的代理支持（需要 Node 25 或更新版本）。有些 Agent（比如 Codex）不会把自己的环境变量传给 MCP 服务器，所以 `install-agents` 默认会把当前的代理变量写进各 Agent 的 xscout 配置。

如果你的机器能直连 `api.github.com` 和 Webhook 的域名，而代理又很慢，可以不带代理注册：

```bash
env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy -u ALL_PROXY -u all_proxy xscout install-agents --no-proxy
```

## 限制与费用

- **速度。** 一次调研通常要 1 到 5 分钟，大部分时间是 Grok Bot 一轮接一轮地在 X 上搜索；结果传递和轮询大约再加 30 秒。问题越具体越快：说清楚看哪些账号、什么时间范围、要几条帖子。
- **额度。** 每次运行都会消耗你的 Grok Bot 使用额度。相关的问题尽量合成一个详细的问题。
- **频率限制。** Grok Bot 对 Webhook 触发的 Routine 运行有上限。撰写本文时，单个 Routine 每小时 200 次，所有 Routine 合计每小时 300 次。
- **能读什么。** 只能读公开的 X 内容。xscout 和这个 Routine 都不会发帖、点赞、关注或发私信。

## 安全

- 收件仓库必须是私有的，`doctor` 会检查。每个 token 都只限这一个仓库。
- Routine 只会把结果交付到它指令里写死的那个仓库，请求里指定其他目的地一律忽略。
- Routine 把帖子、链接页面以及问题本身都当作不可信数据，不会执行其中夹带的指令。
- Webhook key 和读 token 存在 macOS 钥匙串或权限为 `0600` 的文件里。环境变量 `XSCOUT_WEBHOOK_SECRET` 和 `XSCOUT_GITHUB_TOKEN` 可以覆盖它们。
- 本地状态（配置、运行记录、结果缓存）存在 `~/.xscout/`，可以用 `XSCOUT_HOME` 换位置。

## 常见问题

| 现象 | 可能原因 |
|---|---|
| 一次调研长时间停在 pending | 在 Grok Bot 应用里打开这次 Routine 运行，通常是卡在审批卡片上了。按第 6 步放行 `deliver.py` 的无人值守运行。 |
| `Grok Bot webhook returned HTTP 401`（或 403） | Webhook key 不对，重新运行 `xscout secret set webhook-secret`。 |
| Routine 运行里出现 `XSCOUT_DELIVERY_FAILED: GitHub HTTP 404` | 写 token 访问不了收件仓库，或者 Routine 里的仓库名写错了。 |
| `doctor` 显示某个 Agent 没注册 | 运行 `xscout install-agents --only <agent>`，然后重启这个 Agent。 |
| 走代理时请求一直挂着 | 换 Node 25 或更新版本；如果能直连，就用 `--no-proxy` 重新注册。 |

## 开发

```bash
npm test            # 端到端测试：本地模拟 Webhook 和 GitHub API，并真实运行渲染出来的 deliver.py
npm run typecheck
```

Webhook 的请求体和结果格式，是 `src/core.ts`、`src/result.ts` 和 `routine/INSTRUCTIONS.template.md` 三者之间的约定，修改时要一起改。

## 免责声明

xscout 是一个独立项目，与 xAI、X Corp. 和 Cursor 都没有关联，也没有得到它们的背书。请在遵守相关服务条款的前提下使用。

## 许可证

[MIT](LICENSE)
