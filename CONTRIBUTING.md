# 参与修改

欢迎一起改。这是个人维护的项目，没有正式的发布流程和治理规则；较大的改动请先开一个 [issue](https://github.com/erwold/oasis/issues) 说一下想法，再提 pull request。

## 开发环境

按 [INSTALL.md](INSTALL.md) 安装。代码结构：

| 目录 | 内容 |
|---|---|
| `contract/` | 前后端共享的 zod 模式 |
| `backend-ts/` | 后端（TypeScript + Bun）：模型调用、工具、权限、数据库、director、gateway |
| `frontend/` | 界面（React + Vite） |
| `desktop/` | Electron 桌面外壳 |
| `docs/` | 文档；公开的技术参考是 [docs/REFERENCE.md](docs/REFERENCE.md) |

## 提交前跑一下受影响部分的检查

只跑你改到的部分即可：

```sh
(cd backend-ts && bun run typecheck && bun test)   # 后端；测试不会访问任何云服务，也不读 ~/.oasis-code
(cd frontend && npm test && npm run build)         # 前端单元测试与构建
(cd desktop && npm test)                           # 桌面外壳单元测试
```

前端还有端到端测试（`frontend/e2e/`，在 Chrome 里驱动真实界面、启动一个临时后端）。它们较重：先 `npm run build`，
再一次只跑一个文件，例如 `OASIS_CODE_E2E_PORT=8399 node --test e2e/<文件>.e2e.ts`。不要在跑着你日常 oasis-code 的情况下随便占用或结束端口上的进程。

公开导出与密钥扫描工具在 `scripts/oss/`（默认只演练、不写入的 `node scripts/oss/export-public.mjs`，以及
`scan-secrets.mjs`），用法和导出规则见 [PUBLIC_EXPORT.md](PUBLIC_EXPORT.md)。

## 约定

- 提交说明写清楚“改了什么、为什么、怎么验证的”；没跑过的测试不要写成已通过。
- 不要提交密钥、令牌、`.env`、`~/.oasis-code` 里的任何东西、个人路径、截图或日志原文；测试里用占位路径和合成数据。
- 新引入第三方代码或素材时，在说明里写清来源和许可证，并更新 `NOTICE`。
- 你提交的贡献按仓库的 Apache License 2.0 授权（见 [LICENSE](LICENSE)）。
- 安全问题请私下报告，见 [SECURITY.md](SECURITY.md)。
