# 配置

数据目录默认是 `~/.oasis-code`（环境变量 `OASIS_CODE_DATA` 可改），配置文件是 `~/.oasis-code/config.json`
（`OASIS_CODE_CONFIG` 可改）。所有环境变量都以 `OASIS_CODE_` 开头。大多数人**不需要任何配置**：登录订阅、选模型即可。

## 登录方式

### 订阅账号（推荐）

界面：左侧栏底部 **Settings** → **Accounts** 标签 → *Subscriptions*：

| 卡片 | 对应订阅 | 用到它的模型路由前缀 |
|---|---|---|
| **Claude** | Claude Pro / Max | `anthropic:` |
| **Codex** | ChatGPT Plus / Pro（通过 Codex 登录） | `openai:` |

点 **Sign in** → 浏览器打开官方登录页 → 授权后由本机回调自动完成。没自动完成时，把浏览器最后的跳转地址粘贴进
*Paste the final redirect URL* 框，点 **Finish**。登录只能在本机页面（`127.0.0.1`）上发起。
登录后左侧栏底部（Settings 下方）会显示各订阅的剩余额度。

命令行等价操作（在 `backend-ts/` 里）：

```sh
bun run auth login anthropic        # Claude 订阅
bun run auth login openai-codex     # ChatGPT/Codex 订阅；--device 用于没有浏览器的机器，--paste 手动粘贴跳转地址
bun run auth status
bun run auth logout <anthropic|openai-codex>
```

本程序只走各家的浏览器 / 设备登录流程，不读取、不导入其他应用保存的令牌。订阅是否允许这样使用，请按你自己的订阅条款判断。

### API key（可选，按量付费）

**Settings** → **Accounts** → *API keys* → **Add key** 保存；或设置环境变量：

| 前缀 | 环境变量 |
|---|---|
| `anthropic-api:` | `ANTHROPIC_API_KEY` |
| `openai-api:` | `OPENAI_API_KEY` |
| `google:` | `GEMINI_API_KEY` |

## 模型与默认模型

内置路由（`backend-ts/src/config.ts` 的 `DEFAULT_MODELS`）：

- Claude 订阅：`anthropic:claude-opus-5-5`、`anthropic:claude-sonnet-5-5`、`anthropic:claude-sonnet-5`、`anthropic:claude-fable-5-1`
- ChatGPT 订阅：`openai:gpt-6-astra`、`openai:gpt-6.1-sol`、`openai:gpt-6-luna`、`openai:gpt-5.6-luna`
- API key：`anthropic-api:claude-opus-5-5`、`anthropic-api:claude-sonnet-5-5`、`anthropic-api:claude-sonnet-5`、
  `openai-api:gpt-5.6`、`openai-api:gpt-6-pro`、`google:gemini-4-argon`

在界面里用输入框下方的模型按钮选。**默认模型**依次取：`config.json` 的 `default_model` → 环境变量
`OASIS_CODE_DEFAULT_MODEL` → 路由列表第一个（内置列表中是 `anthropic:claude-opus-5-5`）。
只登录了 ChatGPT 或只用 API key 时，可以这样改默认值：

```sh
export OASIS_CODE_DEFAULT_MODEL=openai:gpt-6-astra      # 或 anthropic-api:claude-sonnet-5-5 等
```

（从终端 `npm start` 时环境变量会传给后端。）

**注意**：`config.json` 里一旦写了 `models` 列表，它会**整体替换**内置列表，而不是追加。只想改默认模型时，写 `default_model` 就够了：

```json
{ "default_model": "openai:gpt-6-astra" }
```

`config.json` 还可以设置受保护路径（`protected_paths`，默认 `.git/**`、`.oasis-code/**`，任何工具都不能写）、
命令超时、项目检查等，字段以 `backend-ts/src/config.ts` 的 `HarnessConfigSchema` 为准。

## 命令在哪里跑：Full access 与 Sandbox

每个会话有一个访问方式：

| 访问方式 | 含义 |
|---|---|
| **Full access**（新会话默认） | 以你本人身份运行：真实 HOME、登录 shell 的环境与 PATH、网络、你能访问的所有文件 |
| **Sandbox** | macOS Seatbelt 沙箱：可写工作区，凭据目录和本程序数据不可读，网络按会话授权 |

这台电脑上第一次要运行 Full access 命令时，会话里会问 *Run commands as you on this computer?*：
**Allow full access**（此后本机不再询问）或 **Use the sandbox**（该会话改用沙箱）。
会话处在沙箱时，输入框下方会出现访问方式按钮，可以切回 Full access（会话没有运行中的任务时才能切换）。
SSH 远程会话只能用 Full access。检查点与撤销都只覆盖工作文件夹。

## 权限模式（Auto / Ask before changes / Plan）

与访问方式独立：

| 模式 | 含义 |
|---|---|
| **Auto**（新会话默认） | 可以改文件、运行命令、联网、写附加的原文件夹，不逐项询问 |
| **Ask before changes** | 可以随便读；改文件、运行命令前逐项请你批准 |
| **Plan** | 只读和网页搜索；不能改文件、执行命令或派发 agent |

在当前版本的界面里，**新会话固定从 Auto 开始**；会话不是 Auto 时才会出现 *Switch to Auto* 按钮，界面上没有切到 Ask / Plan 的按钮。
需要时可以用本机 API 切换（会话 ID 在左侧栏会话菜单 → *Copy ID*）：

```sh
curl -X PUT http://127.0.0.1:8321/api/sessions/<会话ID>/mode \
  -H "x-oasis-code-token: $(cat ~/.oasis-code/session-token)" \
  -H 'content-type: application/json' -d '{"mode":"approve"}'   # approve = Ask before changes；也可 plan / auto
```

会话有正在运行的任务时会被拒绝（409），先停掉再切。这个命令会从文件读取本机令牌，不要把令牌本身贴给别人。

## 文件夹怎么打开

界面默认 **direct（原地编辑）**：不复制，会话直接改你的文件夹；文件工具的写入可撤销，命令的写入不可撤销；
不会写你的 `.git` 元数据。文件夹太大无法导入时，界面会提供 **Attach it read-only**（只读挂载，会话在自己的草稿目录里写）
或 *Pick a subfolder*。还有 snapshot（复制一份再工作）方式，主要由 API 使用；详见 [docs/REFERENCE.md](docs/REFERENCE.md)。

## Remote access（外部 ChatGPT 连接）

只在桌面版（macOS）里有：**Settings** → **Connections** 标签中的 *Remote access* 卡片。

- 打开开关后，为当前数据目录安装一个 launchd 用户代理，运行常驻 gateway（`oasis-code gateway run`），监听
  `127.0.0.1:8324`（`OASIS_CODE_GATEWAY_PORT` 可改）。退出应用 gateway 仍在；关掉开关才移除。
- 连接地址形如 `https://<你的域名>/<gateway 密钥>/mcp/current`。地址里含一段**秘密**，等同于访问权限，不要贴到公开地方。
  卡片里可以撤销（换一个新密钥，旧地址立即失效）。卡片里还有 *Connect ChatGPT* 演示，展示如何在 ChatGPT 里添加自定义 MCP 服务器。
- gateway 的配置文件在 `~/.oasis-code/gateway/`（目录 0700、文件 0600）。

**本次推荐：Tailscale Funnel**（在卡片里属于 *Other HTTPS tunnel*）。完整步骤见
[README.md](README.md#remote-access用-tailscale-funnel-让-chatgpt-连进来本次推荐配置)，要点：

```sh
tailscale funnel --bg 8324      # 在你自己的 Tailscale 账号里开启 Funnel 之后
```

再在卡片里 **Change** → *Tunnel* 选 **Other HTTPS tunnel** → *Host* 填 `<机器名>.<tailnet>.ts.net` → **Save** → **Turn on**。
官方条件：Tailscale v1.38.3+；tailnet 开启 MagicDNS 和 HTTPS；策略文件有 `funnel` 节点属性；macOS 上用 Funnel
共享端口只支持 App Store 版或 Standalone 版（系统扩展）图形应用，Homebrew 的命令行服务不在支持范围内。
oasis-code 不安装、不配置、不启动 Tailscale，也不检查 Funnel 是否开着；命令以 Tailscale 官方文档为准
（[Funnel](https://tailscale.com/docs/features/tailscale-funnel)、[`tailscale funnel`](https://tailscale.com/docs/reference/tailscale-cli/funnel)）。

应用支持的全部隧道选项（*Tunnel* 下拉框）：

| 选项 | 你需要做什么 | 地址是否固定 |
|---|---|---|
| *Quick tunnel*（应用现有默认：没有设置固定隧道时使用） | `brew install cloudflared` | 否，gateway 重启（如电脑重启）后会变 |
| *Cloudflare tunnel* | 在 Cloudflare 建命名隧道，把域名路由到 gateway 地址，粘贴 tunnel token | 是 |
| *ngrok domain* | `brew install ngrok`，使用账号分配的域名，粘贴 authtoken | 是 |
| *Other HTTPS tunnel* | 自己运行任意隧道（如上面的 Tailscale Funnel），把一个固定 HTTPS 域名转发到 `127.0.0.1:8324`，在卡片里填这个域名 | 是 |

域名必须是公网 DNS 名（不能是 IP、`localhost`、`.local` 等私有后缀，也不能带端口或路径）；gateway 只接受这个域名下的请求。

另有一个开发用脚本 `backend-ts/scripts/director_tunnel.sh`（Cloudflare quick tunnel + 8322 端口上的 director），见 [docs/REFERENCE.md](docs/REFERENCE.md)。

## 常用环境变量

| 变量 | 作用 |
|---|---|
| `OASIS_CODE_DATA` | 数据目录（默认 `~/.oasis-code`） |
| `OASIS_CODE_CONFIG` | 配置文件路径 |
| `OASIS_CODE_DEFAULT_MODEL` | 默认模型路由 |
| `OASIS_CODE_PORT` / `OASIS_CODE_HOST` | 后端端口 / 地址（默认 `8321` / `127.0.0.1`） |
| `OASIS_CODE_GATEWAY_PORT` | Remote access gateway 端口（默认 `8324`） |
| `OASIS_CODE_SNAPSHOT_MAX_BYTES` / `OASIS_CODE_SNAPSHOT_MAX_FILES` | snapshot 导入上限（默认 2 GB / 20,000 个文件） |
| `OASIS_CODE_USER_DATA` | 桌面应用的 Electron 配置目录 |

## 凭据与本机文件

- `~/.oasis-code/auth.json`：订阅授权与页面上保存的 API key，权限 0600，**明文 JSON，不加密**。
- `~/.oasis-code/session-token`：本机界面/API 令牌（0600）。
- `~/.oasis-code/gateway/`：Remote access 的密钥、隧道 token。
- 不要把数据目录放进同步盘、公开备份或分享给别人。
