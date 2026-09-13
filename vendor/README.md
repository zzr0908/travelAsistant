# 固定 Harness 运行时

Agent 使用 DeepSeek Harness，版本和提交由 `deepseek-harness.lock.json` 固定。`node scripts/bootstrap.mjs` 自动取得该提交、按冻结锁安装依赖、构建并生成相对路径的运行产物清单。

`deepseek-harness/` 不提交到业务仓库，发布安装副本时包含构建产物、所需依赖、上游许可证和第三方声明。功能服务只加载独立的日志格式校验模块；完整 Harness 只在 Agent 进程运行。

更新固定提交时须重新检查工具、模型钩子、会话格式与远程日志回归，不能仅更改版本字符串。
