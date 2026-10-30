# 安装与启动（从源码）

没有可下载的安装包，以下都是从源码运行。只在 macOS（Apple silicon）上实际用过。

## 1. 准备工具

| 工具 | 版本 | 怎么装（示例） |
|---|---|---|
| macOS | Apple silicon；Electron 44 要求 macOS 13（Ventura）或更新（[Electron 官方说明](https://www.electronjs.org/docs/latest/breaking-changes)） | — |
| Xcode 命令行工具 | — | `xcode-select --install`（带 git） |
| Node.js | 建议 24 或更新，最低 22.12；本机实测 25.5.0 | [Node.js 官方下载](https://nodejs.org/en/download)（也可用 Homebrew `brew install node`） |
| Bun | 1.4.0（本机实测；其他版本未测试） | [Bun 官方安装说明](https://bun.sh/docs/installation)；装好后新开一个终端，`bun -v` 应能输出版本 |
| git | 近期版本 | 随 Xcode 命令行工具 |
| Tailscale（可选） | v1.38.3 或更新 | 只有要让外部 ChatGPT 通过 Remote access 连进来时才需要：[macOS 下载](https://tailscale.com/download/mac)，并按 [Funnel 官方说明](https://tailscale.com/docs/features/tailscale-funnel)开启 Funnel（tailnet 需开启 MagicDNS、HTTPS，并有 `funnel` 节点属性；macOS 上共享端口只支持 App Store 版或 Standalone 版图形应用，Homebrew 命令行版不算）；配置步骤见 [README.md](README.md#remote-access用-tailscale-funnel-让-chatgpt-连进来本次推荐配置) |

检查：

```sh
node -v && npm -v && bun -v && git --version
```

从源码运行时，桌面应用按名字启动 `bun`（用的是你启动 `npm start` 那个终端的 `PATH`），所以 `bun -v` 在这个终端里必须能用。
Remote access 的常驻 gateway 由 launchd 启动、没有终端 `PATH`，它会在 `$BUN_INSTALL/bin`、`~/.bun/bin`、
`/opt/homebrew/bin`、`/usr/local/bin` 和 `PATH` 里找 `bun`。

## 2. 安装依赖（按顺序）

下面所有命令都在仓库根目录（`oasis-code/`）里执行；进入子目录的命令都写在括号里，执行完会自动回到根目录。

```sh
git clone https://github.com/erwold/oasis.git oasis-code
cd oasis-code
(cd backend-ts && bun install --frozen-lockfile)
(cd frontend && npm ci)
(cd desktop && npm ci)
```

- `backend-ts` 的 `postinstall` 会进入 `../contract` 执行 `bun install`，并把 `contract/` 链接为
  `backend-ts/node_modules/@oasis-code/contract`。前端也通过 `file:../contract` 使用它，所以 **backend-ts 必须先装**。
- Electron 44 的 npm 包不在安装时下载本体：第一次 `npm start` 时才从 GitHub 下载（约 125 MB，终端里显示
  `Downloading Electron binary...`）。网络受限时失败了可以重跑；也可以按 Electron 官方文档设置 `ELECTRON_MIRROR` 使用镜像。
- 安装脚本：npm 11.19 起会列出“未审核的安装脚本”。`desktop/package.json` 和 `frontend/package.json` 的 `allowScripts`
  已经审核过全部依赖，所以不会再有这类提示。两条都是 `false`（不运行）：`electron-winstaller` 的脚本只为 Windows 的
  Squirrel 安装包挑选 7-Zip（本项目 Windows 打 nsis 包，用不到它）；`fsevents` 自带编译好的二进制，没有要运行的东西。
- `desktop` 的 `npm ci` 会打印几条 `npm warn deprecated`（`inflight`、`glob@7`、`rimraf@2`）。它们来自打包工具
  electron-builder 26 自己的依赖，只在 `npm run dist` 打包时用到，不影响运行；`npm audit` 应为 0 个漏洞。
- 用 `--frozen-lockfile` / `npm ci` 是为了严格按仓库里的锁文件安装。

## 3. 启动桌面应用（日常用法）

```sh
(cd desktop && npm start)
```

- 第一次启动时如果 `frontend/dist` 不存在，会自动执行一次 `npm run build`（窗口里显示进度）。
- 后端（`backend-ts`，Bun）由应用自动启动和停止，监听 `127.0.0.1:8321`。
- 在 macOS 上第一次启动会生成 `desktop/.dev/oasis-code.app`（带产品名称和图标的 Electron 副本）。
- 后端日志：`~/.oasis-code/logs/desktop.log`。

启动后按 [README.md](README.md#第一次使用) 的“第一次使用”登录、选文件夹、选模型、发第一个任务。

## 4. 只用浏览器运行（不开桌面应用）

```sh
(cd frontend && npm run build)
(cd backend-ts && bun run start)
```

终端会打印 `http://127.0.0.1:8321/?token=…`，在浏览器里打开一次即可（会设置 30 天的 HttpOnly cookie）。
输出被重定向到文件或管道时只打印令牌所在位置（`~/.oasis-code/session-token`，0600），不会把令牌写进日志。

浏览器模式没有桌面版专属功能：智能体浏览器 / ChatGPT 页面、Remote access 卡片、原生文件夹选择框。

## 5. 更新

```sh
git pull
(cd backend-ts && bun install --frozen-lockfile)
(cd frontend && npm ci && npm run build)
(cd desktop && npm ci)
```

**注意**：桌面应用只在 `frontend/dist` 不存在时才构建界面，所以更新代码后要自己 `npm run build` 一次，否则看到的还是旧界面。

数据库结构升级前，后端会自动在旁边留一份备份 `~/.oasis-code/index.db.v<旧版本>.bak`（只保留最近一份）。
新版本的数据库旧版本打不开；要回退，退出应用，用这份备份替换 `index.db`（并删除 `index.db-wal`、`index.db-shm`）后再启动旧版本。

## 6. 自己打包（可选，未签名）

```sh
(cd desktop && npm run dist)    # 构建界面、把后端编译成单文件、用 electron-builder 打包
```

产物在 `desktop/dist/`（macOS 上是 `.dmg`），打包后的应用不需要 Bun 或 Node。包**没有签名和公证**：
在本机打包、本机打开不受影响；从网上下载或从别的电脑拷来的包会被 Gatekeeper 拦下，第一次打开要先双击一次，
再到 系统设置 → 隐私与安全性 里点“仍要打开”（新版 macOS 不再支持右键 → 打开 来放行）。要在哪个系统用就在哪个系统上打包。
2026-10-19 在 Electron 44 上验证过 `npm run dist:dir`（不生成 `.dmg` 的目录版）能启动；`.dmg` 本身未重新验证，日常建议直接 `npm start`。
