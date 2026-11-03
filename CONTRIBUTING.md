# 开发约定

当前工作是打稳 0.2.0 基线，界面和交互可以继续调整。

1. 使用 Node.js 24、Git 和 Windows x64，执行 `npm ci --ignore-scripts`。
2. 从 `main` 建立一条聚焦的分支，例如 `design/canvas-spacing`、`fix/task-cancellation`。
3. 先复现问题，再修改相关模块。不要把模拟结果用于生产运行时。
4. 执行 `npm run format`、`npm run verify`；画布改动再执行 `npm run test:canvas`，桌面/进程改动执行 `npm run test:ui`。
5. 每次提交说明问题、行为变化、检查结果与未验证部分。尽量避免把功能重写、视觉调整和协议变更混在一个提交。

真实模型测试会消耗提供商额度，应明确选择账号、项目和任务。自动化检查默认使用临时目录及协议测试进程。

运行数据、账号、Key、日志、构建目录和个人绝对路径不得进入提交。发行包通过 GitHub Releases 分发，不放进 Git 历史。
