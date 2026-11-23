# xscout

[English](README.md) | [简体中文](README.zh-CN.md)

**让任何 coding agent 通过你自己的 Grok Bot 搜索和阅读 X（Twitter）。**

xscout 是一个 MCP 服务器加命令行工具。Claude Code、Codex、Cursor 和 Antigravity 可以用它搜索 X、阅读帖子和整条 Thread，拿回一段综合回答，并附上引用的原帖。调研由你的 [Grok Bot](https://docs.x.ai/grok-bot) 用它内置的公开 X 读取能力完成。你不需要 X API 或 xAI API 的 key，除了现有的 Grok Bot 订阅，不需要额外付费。

```text
coding agent ──MCP──▶ xscout（你的机器）──POST 官方 Webhook {run_id, query, 频道名, 一次性密钥}──▶ Grok Bot Routine（查 X）
     ▲                                                                                            │
     └──── 轮询 ntfy.sh/<频道名>，验证并解密 ◀── 用这次的密钥加密结果后发布 ──────────────────────────┘
```

- **只用官方能力。** xscout 通过 Grok Bot 的 [Webhook Routine](https://docs.x.ai/grok-bot/skills-routines-and-automations) 触发调研，不依赖任何未公开的 Grok Bot 接口，所以 Grok Bot 更新一般不会让它失效。
- **不用部署服务，也不用注册别的账号。** 你的机器只发出站 HTTPS 请求。结果通过 [ntfy](https://ntfy.sh) 传回来，这是一个不需要账号的公开 HTTP 消息推送服务。结果是端到端加密的，ntfy 只能看到密文。
- **每次运行相互独立。** 每个请求都是一次单独的 Routine 运行，不会串话，也不会污染你和 Grok Bot 的主聊天，可以同时跑多个。
- **结构化结果。** 返回一段回答，加上来源帖子列表：链接、作者、时间、原文和互动数据。

## 环境要求

- 有 Grok Bot 订阅，并且能使用 Routine。
- 每台跑 Agent 的机器上要有 Node.js **23.6 或更新版本**。xscout 直接运行 TypeScript 源码，不需要构建。如果这台机器要通过 HTTP(S) 代理上网，需要 Node **25 或更新版本**。
- macOS 或 Linux。macOS 上 Webhook key 存在登录钥匙串里；Linux 上存在 `~/.xscout/secrets.json`，权限为 `0600`。

就这些。只有使用[可选的 GitHub 回传方式](#可选通过私有-github-仓库回传)时才需要 GitHub 账号。

## 配置步骤

整个配置大约 5 分钟：在你的机器上做两步，在 Grok Bot 里做一步，再回到你的机器上做两步。

### 1. 安装 xscout

```bash
git clone https://github.com/davidYichengWei/xscout.git
cd xscout
npm ci
alias xscout="node $PWD/src/cli.ts"   # 可选；下文统一写作 `xscout`
```

各 Agent 的配置里写的是这个目录的绝对路径，所以请放在一个以后不会挪动的位置。如果之后移动了目录，要重新运行 `xscout install-agents`。

### 2. 生成 Routine 指令

```bash
xscout routine
```

它会生成两个文件：

- `~/.xscout/CREATE_ROUTINE_MESSAGE.md`：一条聊天消息，请 Grok Bot 帮你创建这个 Routine。
- `~/.xscout/ROUTINE_INSTRUCTIONS.md`：单独的 Routine 指令，想手动创建时用。

### 3. 在 Grok Bot 里创建 Webhook Routine

把 `~/.xscout/CREATE_ROUTINE_MESSAGE.md` 的全部内容粘贴到 Grok Bot 聊天里发送（macOS 上可以用 `pbcopy < ~/.xscout/CREATE_ROUTINE_MESSAGE.md` 复制）。Grok Bot 会创建一个名为 **xscout webhook research**、触发方式为 **Webhook** 的 Routine。它问起时，请允许 `python3 /tmp/xscout/deliver.py ...` 以及它对 `ntfy.sh` 的 HTTPS 请求无需审批直接运行。这些运行没人盯着，一旦弹出审批卡片，运行就会一直卡到超时。

也可以手动创建：新建一个 **Routine**，触发方式选 **Webhook**，把 `~/.xscout/ROUTINE_INSTRUCTIONS.md` 原样粘贴到 **Instructions**（里面有一小段 Python 脚本，必须一个字节都不改），再设置同样的免审批规则。

然后在 Grok Bot 应用里这个 Routine 的触发设置中，复制 **Webhook URL** 和 **key**。key 可能是 `whsec_…` 签名密钥，也可能是 `crsr_…` Bearer key，两种都支持。不要把 key 粘贴到任何聊天里。

### 4. 把 xscout 连到这个 Routine

```bash
xscout config --webhook-url 'https://…你的 Webhook URL…'
xscout secret set webhook-secret        # 粘贴 key，按回车，再按 Ctrl-D
```

### 5. 注册到各个 Agent，然后试用

```bash
xscout install-agents                   # 或者：--only claude,codex
xscout doctor
xscout ask "@AnthropicAI 最近 3 天在 X 上发了什么？列出主要公告并附链接" --max-posts 5
```

`install-agents` 会在每个 Agent 的配置里加一个 `xscout` MCP 服务器：

| Agent | 配置位置 |
|---|---|
| Claude Code | `claude mcp add-json --scope user`（`~/.claude.json`，设置了 `CLAUDE_CONFIG_DIR` 时是 `$CLAUDE_CONFIG_DIR/.claude.json`） |
| Codex | `~/.codex/config.toml` |
| Cursor | `~/.cursor/mcp.json` |
| Antigravity | `~/.gemini/config/mcp_config.json` |

修改前会先在原文件旁边备份一份（`*.xscout-backup-<时间>`）。重启 Agent 或新开一个会话，就能加载这个服务器。其他 MCP 客户端可以用 `xscout mcp-spec` 打印启动命令，手动配置。

`doctor` 会检查配置、Webhook key、ntfy 服务器能否连通，以及各 Agent 的注册情况。第一次 `ask` 通常要 1 到 5 分钟。之后直接对 Agent 说「帮我在 X 上搜一下大家对……的反应」，它就会调用 xscout。

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

## 结果是怎么传回来的

每次运行，xscout 都会随机生成一个 ntfy 频道名（`xs_` 加 24 个随机字符）和一把 32 字节的一次性密钥，随 Webhook 请求一起发给 Routine。除此之外没有任何人知道它们。

调研完成后，Routine 里的 `deliver.py` 会先压缩结果，用这把密钥加密，再作为 ntfy 附件发布到这个频道。加密只用 Python 标准库：用 HMAC-SHA256 计数器模式生成密钥流，再对 run ID、nonce 和密文计算一个 HMAC-SHA256 校验码（先加密后认证）。xscout 轮询这个频道，验证校验码后解密，并把结果缓存在 `~/.xscout/runs/`。

ntfy 能看到的只有：频道名、run ID（用作文件名）、时间和密文大小。它看不到你的问题和答案。ntfy.sh 上消息保留 12 小时，附件保留 3 小时；xscout 第一次读到结果后就会缓存，所以只有在 3 小时内都没人去取结果时才会有影响。

想用你自己的 ntfy 服务器代替 ntfy.sh：

```bash
xscout config --ntfy-server https://ntfy.example.com
xscout routine        # 然后在 Grok Bot 里更新 Routine 的指令
```

## 可选：通过私有 GitHub 仓库回传

如果你希望结果永久保存在自己的仓库里，xscout 也可以让 Routine 把结果提交到一个私有 GitHub 仓库。

1. 建一个带 README 的**私有**仓库，例如 `gh repo create xscout-inbox --private --add-readme`。
2. 在 [GitHub → Settings → Fine-grained tokens](https://github.com/settings/personal-access-tokens/new) 建一个只限这个仓库的 token，权限 **Contents: Read and write**，这是给 Routine 用的写 token。你机器上的只读 token 可以不建：如果已经 `gh auth login`，xscout 会自动使用 `gh auth token`。
3. 在 Grok Bot 聊天里请它保存一个名为 `XSCOUT_GITHUB_TOKEN` 的 secret，把写 token 粘贴到安全的 secret 卡片里（选 **Save securely**）。
4. 切换 xscout 并重新生成 Routine 指令：

   ```bash
   xscout config --transport github --repo <你的 GitHub 用户名>/xscout-inbox
   xscout secret set github-read-token   # 可选
   xscout routine
   ```

5. 把新的 `~/.xscout/CREATE_ROUTINE_MESSAGE.md` 粘贴给 Grok Bot，让它更新 Routine。配置了仓库后生成的 Routine 同时接受 ntfy 和 GitHub 两种回传方式，用哪种的机器都能继续工作。

## 在多台机器上使用

每台机器各自运行 xscout，但共用同一个 Routine。在新机器上：

```bash
git clone https://github.com/davidYichengWei/xscout.git && cd xscout && npm ci
node src/cli.ts config --webhook-url '<同一个 Webhook URL>'
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

key 只以 RSA-OAEP 加密后的形式传输，`unseal` 之后一次性密钥对会被删除。如果用的是 GitHub 回传方式，新机器上还要设置 `--transport github --repo …`，并且 `gh auth login`，或者用同样的方式迁移 `github-read-token`。

## 代理

如果设置了 `HTTPS_PROXY` 或 `HTTP_PROXY`，xscout 会启用 Node 内置的代理支持（需要 Node 25 或更新版本）。有些 Agent（比如 Codex）不会把自己的环境变量传给 MCP 服务器，所以 `install-agents` 默认会把当前的代理变量写进各 Agent 的 xscout 配置。

如果你的机器能直连 Webhook 的域名和 ntfy，而代理又很慢，可以不带代理注册：

```bash
env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy -u ALL_PROXY -u all_proxy xscout install-agents --no-proxy
```

## 限制与费用

- **速度。** 一次调研通常要 1 到 5 分钟，大部分时间是 Grok Bot 一轮接一轮地在 X 上搜索；结果传递和轮询大约再加 15 秒。问题越具体越快：说清楚看哪些账号、什么时间范围、要几条帖子。
- **额度。** 每次运行都会消耗你的 Grok Bot 使用额度。相关的问题尽量合成一个详细的问题。
- **频率限制。** Grok Bot 对 Webhook 触发的 Routine 运行有上限。撰写本文时，单个 Routine 每小时 200 次，所有 Routine 合计每小时 300 次。ntfy.sh 对匿名使用也有频率限制，但远高于 xscout 的用量。
- **能读什么。** 只能读公开的 X 内容。xscout 和这个 Routine 都不会发帖、点赞、关注或发私信。

## 安全

- 结果用每次新生成的密钥端到端加密，校验不通过的内容 xscout 一律拒收。
- Routine 只会把结果交付到它指令里写死的 ntfy 服务器（以及配置了的话，那个 GitHub 仓库），请求里指定其他目的地一律忽略。
- Routine 把帖子、链接页面以及问题本身都当作不可信数据，不会执行其中夹带的指令。
- Webhook key 存在 macOS 钥匙串或权限为 `0600` 的文件里，环境变量 `XSCOUT_WEBHOOK_SECRET` 可以覆盖它。
- 本地状态（配置、带一次性密钥的运行记录、结果缓存）存在 `~/.xscout/`，文件权限为私有，可以用 `XSCOUT_HOME` 换位置。

## 常见问题

| 现象 | 可能原因 |
|---|---|
| 一次调研长时间停在 pending | 在 Grok Bot 应用里打开这次 Routine 运行，通常是卡在审批卡片上了。按第 3 步放行 `deliver.py` 的无人值守运行。 |
| `Grok Bot webhook returned HTTP 401`（或 403） | Webhook key 不对，重新运行 `xscout secret set webhook-secret`。 |
| `result failed authentication` | Routine 没有原样抄下这次的密钥。重新发起查询；如果反复出现，重新粘贴一次 Routine 指令。 |
| Routine 运行里出现 `XSCOUT_DELIVERY_FAILED: delivery.url must be …` | Routine 的指令是按另一个 ntfy 服务器生成的。运行 `xscout routine` 并更新 Routine。 |
| `doctor` 显示某个 Agent 没注册 | 运行 `xscout install-agents --only <agent>`，然后重启这个 Agent。 |
| 走代理时请求一直挂着 | 换 Node 25 或更新版本；如果能直连，就用 `--no-proxy` 重新注册。 |

## 开发

```bash
npm test            # 端到端测试：本地模拟 Webhook、ntfy 和 GitHub API，并真实运行渲染出来的 deliver.py
npm run typecheck
```

Webhook 的请求体和结果格式，是 `src/core.ts`、`src/result.ts` 和 `routine/INSTRUCTIONS.template.md` 三者之间的约定；`src/seal.ts` 的加密必须和 `routine/deliver.template.py` 里的 `seal()` 逐字节一致。修改时要一起改。

## 免责声明

xscout 是一个独立项目，与 xAI、X Corp.、Cursor 和 ntfy 都没有关联，也没有得到它们的背书。请在遵守相关服务条款的前提下使用。

## 许可证

[MIT](LICENSE)
