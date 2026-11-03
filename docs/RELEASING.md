# 打包与发布

## 源码准备

```powershell
npm ci --ignore-scripts
npm run verify
npm run setup:runtime
npm run test:canvas
npm run test:ui
```

`setup:runtime` 在本机已有对应 Electron 时直接复用；否则从 Electron 官方 GitHub 下载，并使用锁定 npm 包内的 SHA-256 校验后解压。

## Windows 便携包

在源码提交后执行：

```powershell
npm run package
npm run test:package
```

成功构建的位置写入被 Git 忽略的 `release/latest-build.json`。目录内包含运行环境、应用、生产依赖、许可证、说明和 `build-info.json`。完整目录必须一起分发。

`build-info.json` 记录源 commit、是否存在未提交改动和构建环境。正式发布前确认 `sourceDirty` 为 `false`。

打包器从固定 commit 的 `git archive` 创建隔离源码目录，再构建和复制应用。未提交的参考资料不会进入发行包；已跟踪源码有未提交改动时会拒绝打包。`docs/references/` 保留为本地参考资料目录，不随 Git 提交或发行。

## 基线发布物

- 完整包：Windows 成品目录、源码 ZIP、Git bundle、说明与校验清单。
- 源码 ZIP：由 `git archive` 从指定 commit 创建。
- Git bundle：包含对应的提交与标签，供离线恢复版本历史。
- `SHA256SUMS.txt`：发行文件的 SHA-256。
- `validation.json`：移除机器路径后的验证结果。

源码和文档进 Git；大体积成品、依赖、运行数据、缓存和日志不进入 Git。GitHub Release 标注为基线预发布，真实模型验证范围写清楚。
