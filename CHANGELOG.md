# Changelog

## 未发布

### 新增

- 发布前 secret 扫描：`scripts/scan-secrets.mjs`（本地可跑，支持 `--staged` / `--history` / `--all` / `--dir`）与 `.github/workflows/secret-scan.yml`（push / PR / merge queue 自动跑）。两者不包含在 npm 打包产物里（不在 `package.json` 的 `files` 中），但 `git clone` 安装时会随仓库下载。
- `.github/workflows/release.yml`：打 `v*` tag 时先跑同一套扫描，通过后才创建 GitHub Release，并校验 tag 与 `package.json` 版本一致。

### 修复

- secret 扫描补上暂存区模式（`--staged`）：按 git index 内容检查，防止“先暂存含凭证的文件、再把工作区改干净”绕过检查。
- secret 扫描的历史模式补上危险文件名检查（如历史提交过 `.env` 后删除）；同时覆盖插件登录副本 `{ v, token, savedAt }` 这种独立 `token` 字段的字面量。
- 文档改为按真实范围说明：CI 只能保证 PR 合入前拦截、tag 后阻止创建 Release；已经 push 的内容无法由工作流撤销。
- 取消对扫描脚本与两个工作流文件的整体免检（原 `SELF` 集合）：工作区、暂存区、历史扫描都会检查这两个工作流与扫描脚本自身；实测不存在模式定义误报，动态凭据引用（如 `${{ github.token }}`）正常通过，没有加任何文件级豁免。
- 历史模式的文件名检查改用 NUL 分隔的 `git log --raw -z` 输出解析真实路径，覆盖新增、删除、重命名、复制涉及的路径，正确处理中文、空格和特殊字符；不再依赖 `diff --git` 标题正则。

## 0.1.0 — 2026-10-24（初版）

首个可试用版本。

### 新增功能

- **聊天 / 工作双模式**：标题栏分段按钮一键切换；默认启动在聊天模式。
- **聊天模式**：内嵌 DSH 桌面端的 Electron webview，加载 DeepSeek 官方网页版（默认 `https://chat.deepseek.com`，可在设置页修改）；聊天模式下不调用 DSH API、不触发 Agent 循环、不消耗 token。
- **工作模式**：保持 DSH 原生 Agent / Code 界面不变；按钮用警示色并提示「工作模式会消耗 token」。
- **带入工作模式**：「带入工作」对话框支持读取剪贴板（用户点击时）或手动粘贴，确认后只填入工作模式输入框，不自动发送。
- **设置页（设置 → 聊天模式）**：默认启动模式、网页地址（含域名校验与二次确认）、记住上次模式、记住登录（默认关）、清除已保存登录、诊断面板开关。
- **记住登录（可选）**：仅处理聊天网页 `localStorage.userToken` 一项，明文保存在本机插件 localStorage；仅当用户在设置页开启后才保存 / 恢复；恢复失败自动清除副本并静默停留登录页。
- 中英文界面文案（`locale/zh.json`、`locale/en.json`）。

### 已知限制

- 仅在 Windows + DSH 0.2.1-rc.3 上测试过；其他系统 / 版本未验证。
- 标题栏按钮左偏移 `TITLEBAR_LEFT_OFFSET = 154` 与聊天层顶部偏移 `CHAT_LAYER_TOP = 34` 是在作者机器的分辨率 / 缩放下测量的，不同缩放比例下可能需要调整（改 `client.js` 顶部常量后完全退出重启生效）。
- 依赖 DSH 桌面端未公开的 webview 租约机制（`dshDesktop.browser.acquire/release`），DSH 升级后可能失效。
- 记住登录只恢复 `userToken`；token 过期、站点改版等场景仍需重新登录；恢复时登录页会短暂显示。
- 只恢复一项登录信息，不保存密码、cookie、其他存储项或页面内容。
