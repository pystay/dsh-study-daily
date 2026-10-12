# 更新日志

本项目遵循 Semantic Versioning。发布记录只描述已合并且可由仓库源码验证的变化。

## 0.1.0 — 2026-10-12

- 首次提供自包含 DSH bundle 包，不再依赖个人学习简报官仓库的本地 `link:` 包。
- 增加只读 `obsidian_tasks` 工具：递归扫描 Markdown 复选框任务、过滤和汇总。
- 输出包含总数/未完成/已完成、优先级分布、项目分布与任务列表（按优先级、项目或标签排序，含截止日期与停滞天数）。
- **零配置即用**：未配置 `vault_path` 时使用默认库 `~/Documents/Obsidian`；目录不存在会在首次查询时自动创建并写入示例笔记；可用 `create_vault_if_missing: false` 关闭写入。
- 路径优先级：配置 `vault_path` ＞ 工具参数 `vault_path` ＞ 默认库；配置已设时参数无法覆盖，保留防提示注入边界。
- 锁定 DSH `0.2.0-rc.2` 工具 API 与 Cordis `~4.0.4` peer 范围。
