# 基线验证记录

目标版本：0.2.0；环境：Windows x64、Node.js 24、Electron 45。

| 检查                   | 命令 / 证据            |
| ---------------------- | ---------------------- |
| Node 模块语法          | `npm run check`        |
| 前端生产构建           | `npm run build`        |
| 核心、协议、数据与 Git | `npm test`             |
| 画布与工具箱           | `npm run test:canvas`  |
| 浏览器与桌面工作流     | `npm run test:ui`      |
| 打包后的窗口与终端     | `npm run test:package` |
| 生产依赖审计           | `npm audit --omit=dev` |

入库时的可移植结果见 [baseline.json](validation/baseline.json)。发行包内的 `validation.json` 记录最后一次打包后检查；`Windows/build-info.json` 记录源码 commit 与构建环境。

本机运行产生的原始报告和截图放在被 Git 忽略的 `test-results/`。公共记录仅保留检查项、结果和时间，不带本机路径、运行数据或凭据。

## 这些检查覆盖什么

- 真实子进程的 JSON-RPC / stream-json 收发、UTF-8、会话、批准与拒绝。
- 上游结果传递、失败阻断、队列与并发、取消、重启状态、连接授权。
- 文件边界、符号链接、并发内容冲突、工作树创建与合并。
- 画布与管理操作、真实 ConPTY 命令输出、浏览器真实点击和截图。
- 源码构建与 Windows 便携包启动。

## 尚未验证的部分

- 未向真实 AI 模型发送任务，也未消耗额外模型额度。
- 未以真实账号证明所有提供商的登录、额度、模型和完整任务都可用。
- 多提供商真实协作、断线、额度不足及升级兼容性仍需要进一步验证。
- 尚未做大规模长时间运行、所有 DPI / 输入方式和无障碍场景的完整验证。

协议测试使用明确隔离的测试进程，不是模型端到端实测。历史本机 Codex、Claude 和 Grok 的初始化握手通过，也不等于完整生成任务通过。
