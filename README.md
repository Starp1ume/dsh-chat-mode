# DSH 聊天 / 工作双模式插件（非官方）

一个给 **DeepSeek Harness（DSH）桌面端** 用的第三方插件：在同一个界面里提供「聊天」和「工作」两种模式，一键切换。

> **非官方说明**：本项目是个人开发的第三方插件，与 DeepSeek 官方无关。
> 使用本插件前请自行确认符合 DeepSeek 的服务条款；因使用本插件产生的账号或数据风险由使用者自行承担。
> **测试范围**：仅在 **Windows** + **DSH 0.2.1-rc.3** 上测试过，其他系统 / 版本未经验证，可能无法使用。

## 功能

- **聊天 / 工作模式切换**：标题栏「编辑」菜单右侧有一个分段按钮（聊天 / 工作），两种模式下都可见；默认启动在聊天模式。聊天模式下，插件会用一条受控样式隐藏左上角与侧栏开关相关的标题栏按钮（聊天层覆盖了整个侧栏，点它们没有效果）：侧栏展开时隐藏「收起侧边栏」，侧栏收起时隐藏「打开侧边栏」以及标题栏里只在该状态出现的「新建会话」图标；请使用网页自带的侧边栏按钮。
- **聊天模式不消耗 token**：聊天模式内嵌 DSH 桌面端自带的 Electron webview，加载 DeepSeek 官方网页版（默认 https://chat.deepseek.com），由你在页面里自行登录使用。DSH 不会为聊天模式调用 API、不触发 Agent 循环、不产生 token 消耗。
- **工作模式 = DSH 原生界面**：工作模式就是原来的 Agent / Code 界面，行为不变，只有这个模式会调用 API。
- **带入工作模式（只填不发）**：在聊天网页里选中文字后，点标题栏「带入工作」：插件用固定脚本只读取当前选中文字（仅在你点击时、且页面为官方站点时执行），然后切到工作模式，把「模板 + 选中文字」填入输入框，**不会自动发送**，发不发由你决定。模板可在「设置 → 聊天模式 → 带入工作」里修改。没有选中文字或读取失败时，会回退到原来的粘贴对话框；选中文字超过 20000 字会截断并提示。
- **记住登录（可选，实验性）**：开启后，插件会把聊天网页里 `localStorage` 的 `userToken` 一项保存到本机，下次启动时自动写回并重新加载，免去重新登录。**默认关闭**；只处理 `userToken` 这一项，不碰 cookie、其它存储项或页面内容。

## 安装

前置条件：Windows 上的 DSH 桌面端（开发与测试版本为 0.2.1-rc.3），并且当前会话可以执行工具（plugin_manager）。

1. 克隆本仓库（`git clone https://github.com/Starp1ume/dsh-chat-mode.git dsh-chat-mode`）。
2. 保持该目录在原位。安装时 DSH 会把它以 **Junction（目录链接）** 的方式链到 profile 的 `node_modules/@local/dsh-chat-mode`，**之后不要移动、重命名或删除该目录**，否则插件会失效。
3. 在 DSH 的对话里让 agent 安装，例如：

   > 用 plugin_manager 的 install_bundle 安装插件，target 为 `D:\path\to\dsh-chat-mode`（填本目录的绝对路径）。

   如果不熟悉，可以在 DSH 的创造模式里发送这条指令。

   安装需要你审批。完成后确认返回 `enabled: true`、`application: applied`，且没有额外 warnings。
4. **完全退出 DSH**（托盘图标 → 退出，确保进程结束；只关闭窗口只是隐藏到托盘），再重新启动。

> 说明：因为安装是 Junction 形态，之后修改 `client.js` 等文件**不需要重新安装**，完全退出并重启 DSH 即会生效。

## 首次使用

1. 启动后默认在**聊天模式**，主区域显示 DeepSeek 官方网页版；如果未登录，按页面提示登录自己的账号。
2. 首次启动时「记住登录」是**关闭**的。如果希望下次启动免登录，可在「设置 → 聊天模式」里开启；
   设置页会同时提示：保存的登录信息是**明文**存在本机插件 localStorage 中的，同源脚本理论上可读。
3. 想回到原生 Agent 界面时，点标题栏的「工作」；工作模式按钮会用警示色标出，并带提示「工作模式会消耗 token」。

## 卸载

1. 打开「设置 → 聊天模式」，先点「清除已保存登录」（如果你开启过记住登录）。**如果跳过这一步，登录信息会留在本机，卸载后无法再通过插件清除。**
2. 在 DSH 对话里让 agent 执行 `plugin_manager` → `remove_bundle`，`target: @local/dsh-chat-mode`。
3. 完全退出 DSH 后，检查 `C:\Users\<你的用户名>\.dsh\profiles\desktop\node_modules\@local\` 下是否还残留 `dsh-chat-mode` 目录链接。若残留，用 **cmd** 删除（**不要带 `/s`，不要用 `Remove-Item -Recurse`**）：

   ```
   cmd /c rmdir "C:\Users\<你的用户名>\.dsh\profiles\desktop\node_modules\@local\dsh-chat-mode"
   ```

4. 重新启动 DSH。

> 注意：`remove_bundle` 不一定会自动删除指向仓库目录的 Junction，残留链接需要按上面第 3 步手动清理；清理前请先确认目标目录确实是 `node_modules\@local\dsh-chat-mode`。

## 隐私说明

本插件只在本机读写以下数据：插件不会把这些数据发送给除你设置的聊天网站之外的任何服务；写回登录信息时，只写入该聊天网站的页面存储。

| 存储键（DSH 桌面窗口的 localStorage） | 内容 | 何时写入 |
| --- | --- | --- |
| `dsh-chat-mode:prefs:v1` | 模式偏好：默认模式、网页地址、是否记住上次模式、上次模式、是否记住登录、诊断面板开关、带入工作模板 | 修改设置 / 切换模式时 |
| `dsh-chat-mode:login:v1` | 聊天网页 `localStorage.userToken` 的副本与保存时间 | 仅当你开启「记住登录」并恢复成功后 |

- 以上内容均为**明文**，保存在 DSH 桌面端自身的 localStorage（窗口 origin 为 `dsh-app://app/`），其他同源脚本理论上可以读取。
- 插件**不写入**独立文件，也**不会**读取 `document.cookie`、其他 localStorage 项、IndexedDB 或页面内容，不分析你输入的文字。
- 「带入工作」只在你点击时、且页面为官方站点（`https://chat.deepseek.com`，origin 完全相等）时，用固定脚本读取 `window.getSelection().toString()`（当前选中文字）；读到的文字只放内存，填入后即丢弃，**不写入任何存储**，不读取聊天记录或输入框里已有内容，也不会自动发送。
- 插件自身**唯一的网络行为**是让 webview 加载你在设置里填写的聊天网页地址（默认 `https://chat.deepseek.com`）。页面内部的具体请求由 DeepSeek 官方网页自己发起，与本插件无关。
- 聊天页面本身可能有自己的 cookie / 本地存储；那些由官方页面管理，插件不读取。

请仅在你自己的电脑上使用「记住登录」。如果怀疑凭据泄露，请到 DeepSeek 的账号设置里处理。

## 已知限制

- **位置常量按作者机器测量**：标题栏切换按钮的左偏移 `TITLEBAR_LEFT_OFFSET = 154`、聊天层顶部下移 `CHAT_LAYER_TOP = 34` 是在特定分辨率 / 屏幕缩放下量出来的，在你的机器上可能出现偏移。
  调整方法：编辑 `chat-mode/client.js` 顶部附近的这些常量 → 完全退出并重启 DSH 生效（不需要重新安装）。
- **标题栏侧栏按钮的隐藏依赖 DSH 的按钮标识**：聊天模式下，插件通过一条受控样式隐藏这些按钮（在 `<html>` 上设置 `data-chat-mode-hide-toggle="1"` 并注入一条只作用于它们的 `<style>`）：侧栏展开时的「收起侧边栏 / Collapse sidebar」、侧栏收起时的「打开侧边栏 / Open sidebar」，以及收起状态下才出现在标题栏的「新建会话 / New session」图标（用 `[data-sidebar-collapsed="true"]` 限定，避免误隐藏展开态侧栏里的同名按钮）。DSH 改版后按钮文案或属性可能变化，**失效时表现为按钮重新显示**（不影响其它功能，也不会误隐藏其它元素）。如需关闭该行为，把 `client.js` 里的 `HIDE_DSH_SIDEBAR_BUTTON` 设为 `false`，完全退出重启生效。
- **聊天模式下会把标题栏菜单左移**：为消除被隐藏按钮左侧的空白，受控样式把 DSH 的菜单左偏移变量 `--dsh-windows-menu-start` 覆盖为 12px（只在聊天模式、`html[data-chat-mode-hide-toggle="1"]` 期间生效；撤销属性后自动恢复 DSH 原值：展开 48px、收起 84px）。切换条仍按「菜单右边界 + 8px」动态测量，并监听 `<html>` 属性变化重新测量，因此两者一起移动、不会重叠。该方案依赖 DSH 的菜单变量与 preload 菜单宿主，DSH 改版后可能失效——**失效时通常表现为左侧空白重新出现**（菜单回到原位），不会造成控件重叠或点击异常。
- **平台与版本**：仅在 Windows + DSH 0.2.1-rc.3 测试过。DSH 升级后（尤其是桌面端 webview 租约接口变化时）插件可能失效，需要重新适配。
- **记住登录有边界**：只恢复 `userToken` 一项；如果 token 过期或站点改版，仍需重新登录。在网页里主动退出登录后，插件会清除已保存的登录副本（该检测依赖页面跳转，未必每次都能识别；如果退出后仍被自动登录，请到设置里手动点「清除已保存登录」）。恢复时登录页会闪一下再进入已登录状态；恢复失败会自动清除已保存副本并停留在登录页，不会报错。
- **标题栏是桌面端原生区域**：不同缩放比例下若按钮与系统按钮重叠，请通过上面的常量微调。

## 开发与发布自查

仓库自带一个 secret 扫描脚本，供本地自查和 GitHub Actions 使用。它**不包含在 npm 打包产物里**（`scripts/` 与 `.github/` 不在 `package.json` 的 `files` 列表）；但如果通过 `git clone` 安装，这两个目录仍会随仓库下载到本机，只是插件运行时不会用到它们。

```powershell
node scripts/scan-secrets.mjs            # 默认：扫描 git 跟踪文件在工作区里的内容
node scripts/scan-secrets.mjs --staged   # 提交前：只扫描暂存区（最接近下一次提交的内容）
node scripts/scan-secrets.mjs --history  # 全部历史：新增行 + 曾出现过的危险文件名
node scripts/scan-secrets.mjs --all      # 连同未跟踪文件一起扫描
```

建议加一个本地 pre-commit 钩子（可选）：

```sh
node scripts/scan-secrets.mjs --staged
```

### CI 能保证什么、不能保证什么

- **PR 合入 main 之前**：把 `secret-scan` 设为必需状态检查（仓库 **Settings → Rules → Rulesets**，对 main 启用 “Require status checks to pass”，并把 `secret-scan` 加进去），扫描失败时 PR 无法合并。注意：仓库 owner 需要在 GitHub 上完成这一配置，工作流文件本身无法强制它生效。
- **打 tag 之后**：`release` 工作流（`.github/workflows/release.yml`）会先跑同一套扫描，扫描失败就不会创建 GitHub Release；它还会校验 tag 与 `package.json` 版本一致。
- **不能保证**：`git push` 或 tag 推送本身无法被工作流阻止或撤销——push 事件是在内容已经上传之后才触发的。如果推送后扫描才失败，需要删除 tag / 回退提交，并**轮换可能已泄露的凭证**。

工作流里用 `fetch-depth: 0` 拉完整历史，否则 `--history` 看不到旧提交。

## 反馈模板

遇到问题时，请提供：

- DSH 版本（如 `0.2.1-rc.3`）
- Windows 版本（如 `Windows 11 23H2`）
- 屏幕分辨率与缩放比例（如 `2560×1440 @ 150%`）
- 问题描述与复现步骤
- 标题栏截图（**请先给路径、用户名、登录信息等打码**）

提交 issue 时请不要粘贴 token、cookie，或带有账号信息的完整截图。

## 许可证

MIT，详见 [LICENSE](LICENSE)。
