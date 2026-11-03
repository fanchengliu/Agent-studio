# 模块地图

| 目录 / 文件                            | 责任                                             |
| -------------------------------------- | ------------------------------------------------ |
| `electron/main.mjs`                    | 窗口、目录选择、系统加密、浏览器面板、通知与托盘 |
| `src/App.jsx`                          | 应用状态、工作台导航与全局交互                   |
| `src/Canvas.jsx` / `nodes.jsx`         | 画布手势、连线、节点与布局                       |
| `src/panels.jsx`                       | 会话、文件、差异与终端                           |
| `src/dialogs.jsx` / `Workbench.jsx`    | 连接设置、角色、账号、模板与工具箱               |
| `server/index.mjs`                     | 本机 HTTP / WebSocket 入口与用户操作 API         |
| `server/store.mjs`                     | 工作台数据读写及进程重启后的状态处理             |
| `server/runtime.mjs`                   | 队列、并发、依赖流程、权限与协作边界             |
| `server/adapters.mjs` / `rpc.mjs`      | 各家 CLI / ACP / API 的协议适配                  |
| `server/mcp.mjs` / `cli.mjs`           | Agent 调用的协作工具                             |
| `server/history.mjs` / `workbench.mjs` | 画布撤销与管理功能                               |
| `server/schedules.mjs`                 | 日历排期计算                                     |
| `scripts/`                             | 启动准备、验证、打包与截图                       |
| `tests/`                               | 独立协议子进程、状态机和数据边界检查             |

## 一次任务

界面提交目标 → 本机 API 建立任务 → Runtime 按并发和依赖调度 → Adapter 启动对应工具 → 实际事件和权限请求回到 Runtime → WebSocket 更新界面 → 结果落盘并传给下游。

每个 Agent 保存独立会话 ID。画布连线也是协作工具的访问范围。取消和失败保留明确状态；任务恢复不会自动重放未确认的副作用。

## 数据边界

源码目录不承载正常用户运行数据。桌面版数据位于 Electron `userData/workspace`，项目文件位于用户选择的目录。测试使用临时隔离目录。模型 Key 使用系统加密，原工具的登录仍由原工具管理。

当前数据层是 JSON 文件和内存调度，尚不是面向大量长期任务的数据库实现；这属于后续优化重点。
