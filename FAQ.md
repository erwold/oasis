# 常见问题与排障

## 安装

**`bun install` / `npm ci` 报找不到 `@oasis-code/contract` 或 `zod`。**
安装顺序错了。先 `(cd backend-ts && bun install --frozen-lockfile)`（它会装好 `contract/`），再装 `frontend`、`desktop`。

**`npm ci` 说 lock 文件和 package.json 不一致。**
不要改 `package.json`；确认你在仓库根目录下对应的子目录里执行，且代码是最新的 `git pull`。

**第一次 `npm start` 卡在下载 Electron 或失败。**
它要从 GitHub 下载 Electron 44 的本体。网络恢复后重跑 `(cd desktop && npm start)`；受限网络下可按 Electron 官方文档设置 `ELECTRON_MIRROR`。

**Node 版本太旧导致构建失败。**
前端用 Vite 8，最低 Node 22.12；建议 Node 24 或更新（本机实测 25.5.0）。`node -v` 确认。

## 启动

**`npm start` 后窗口报后端起不来 / 找不到 bun。**
在同一个终端里执行 `bun -v`。从源码运行时应用按名字启动 `bun`，需要它在这个终端的 `PATH` 上。

**提示端口 8321 已被占用，或连上了“别的数据目录的后端”。**
每个数据目录只能有一个后端。应用会接入同一数据目录下已经在运行的后端，但会拒绝别的程序或别的数据目录的后端。
关掉另一个 oasis-code（或占用 8321 的程序）；需要同时跑两份时，给第二份设不同的 `OASIS_CODE_DATA` 和 `OASIS_CODE_PORT`。
不要随意结束你不认识的进程。

**更新代码后界面没变。**
桌面应用只在 `frontend/dist` 不存在时才构建界面。执行 `(cd frontend && npm run build)` 后重启应用。

**看日志。**
`~/.oasis-code/logs/desktop.log`（后端日志）。发给别人前请先检查里面有没有你不想公开的路径或网址。

## 登录与模型

**点 Sign in 后浏览器授权完了，但应用一直显示 Signing in。**
等界面出现 *Paste the final redirect URL* 输入框，把浏览器地址栏里最后的地址粘贴进去，点 **Finish**。
也可以用命令行：`(cd backend-ts && bun run auth login anthropic)`（或 `openai-codex`，加 `--paste` / `--device`）。

**Sign in 按钮是灰的。**
登录只能在本机页面（`127.0.0.1`）上进行。用桌面应用，或用后端打印的本机地址打开。

**我只有 ChatGPT 订阅，第一次运行就报没有登录 / 没有凭据。**
默认模型是 *Claude Opus 5.5*（Claude 订阅）。在输入框下方的模型按钮里换成 GPT 系列，或设置
`OASIS_CODE_DEFAULT_MODEL=openai:gpt-6-astra`，见 [CONFIGURATION.md](CONFIGURATION.md#模型与默认模型)。

**输入框提示 *No route has a credential yet*。**
还没有任何可用登录或 key。去 **Settings** → **Accounts** 登录订阅，或在 *API keys* 里 **Add key**。

**显示 *Sign in again*。**
授权过期或被撤销，重新点 **Sign in again**。

**用 Antigravity 登录有什么风险？**
Antigravity 个人版[服务条款](https://antigravity.google/terms)第 6 条规定：用第三方软件通过 Antigravity 的 OAuth 访问服务属于违约，Google 可以暂停或终止账号。oasis-code 就是这样的第三方软件，用不用、用哪个账号请自行判断。不想承担这个风险，可以在 Accounts 里改用 Google Gemini 的 API key。

**Antigravity 登录提示 *needs an OAuth client*。**
源码里不带 Antigravity 登录用的 OAuth 客户端。要用的话，在数据目录（默认 `~/.oasis-code/`）里放一个
`antigravity-client.json`：`{"client_id": "…", "client_secret": "…"}`，或者设置环境变量
`OASIS_CODE_ANTIGRAVITY_CLIENT_ID` 和 `OASIS_CODE_ANTIGRAVITY_CLIENT_SECRET`。改完不用重启，下次登录或刷新时生效。

**我在 `config.json` 里加了一个模型，其他模型都不见了。**
`models` 会整体替换内置列表。删掉 `models`，只保留 `default_model`，或把需要的路由都写进去。

## 使用

**它改坏了我的文件，能撤销吗？**
文件工具做的修改：会话里点 *Undo file changes*（文件仍是 run 留下的样子时可撤销）。命令做的修改（`rm`、`git checkout`、
构建脚本等）不能撤销。所以重要项目先提交/备份，或用副本。

**我不想让它以我的身份跑命令。**
第一次问 *Run commands as you on this computer?* 时选 **Use the sandbox**。如果之前已经选过 Allow，
后续新会话不会再问；当前版本界面上没有把新会话默认改成沙箱的开关，请只在可信项目里使用，或用独立的 macOS 用户。

**怎么切到 Ask before changes 或 Plan？**
当前界面没有这个切换按钮，可以用本机 API，见 [CONFIGURATION.md](CONFIGURATION.md#权限模式auto--ask-before-changes--plan)。

**文件夹太大打不开。**
界面会提示，可以选 **Attach it read-only**（只读挂载）或 *Pick a subfolder*。

**SSH 连不上。**
只支持密钥认证（BatchMode，不能交互输入密码或口令）；不读你的 `~/.ssh/config`，所以要把用户、主机、端口、密钥路径直接告诉 agent。
有口令的私钥请先加进 ssh-agent。远端需要 `python3` ≥ 3.9（Linux 或 macOS）。首次连接会让你确认主机密钥指纹。

**Remote access 的地址变了。**
*Quick tunnel* 的地址在 gateway 重启（例如电脑重启）后就会变。需要固定地址时，改用 Cloudflare 命名隧道、ngrok 固定域名，
或你自己的 HTTPS 隧道（如 Tailscale Funnel），见 [CONFIGURATION.md](CONFIGURATION.md#remote-access外部-chatgpt-连接)。

**Quick tunnel 提示 cloudflared 没装。**
`brew install cloudflared`（应用在 `/opt/homebrew/bin`、`/usr/local/bin` 找它）。

**退出应用后 Remote access 还在跑？**
是的，gateway 是常驻的 launchd 代理。不用时在 Remote access 卡片里关掉开关。

## 平台与发布

**Linux / Windows / Intel Mac 能用吗？**
没有验证过。代码里有 Linux 相关的分支，但没有人实际用过；Remote access 依赖 macOS 的 launchd。

**有安装包、自动更新、签名吗？**
都没有。从源码运行，更新方法见 [INSTALL.md](INSTALL.md#5-更新)。自己打的包没有签名。

**数据会发到哪里？** 见 [PRIVACY.md](PRIVACY.md)。
