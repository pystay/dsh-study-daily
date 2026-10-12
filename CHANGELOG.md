# 更新日志

本项目遵循 Semantic Versioning。发布记录只描述已合并且可由仓库源码验证的变化。

## 0.2.0 — 2026-10-12

- 新增只读 `study_dashboard` 工具：把 Vault 待办渲染成一份**自包含、可交互的 HTML 任务看板**（KPI + 优先级/项目分布 + 按优先级分组的任务列表），写到本地文件并返回路径；用浏览器打开即可。
- 看板右下角内置**任务小窗口**：折叠/展开、从待办里按「优先级 + 搁置天数」挑出今日计划（生成计划 / 重新生成 / 清除推荐）、手动添加自定义任务、勾选完成 + Toast、删除、位置切换、`localStorage` 持久化、键盘可达（Esc 收起）。
- 看板**完全自包含**：内联 CSS/JS、零外链、离线可开；所有任务文本经 HTML 转义，上下文数据岛经 JSON 转义（防 `</script>` 逃逸与 XSS）。
- 新增配置 `dashboard_path`：看板输出路径，留空默认 `~/.dsh-study-daily/dashboard.html`（刻意不写进 Vault，避免污染笔记）。
- 只读性不变：`study_dashboard` 只读 Vault，不修改任何笔记。

## 0.1.0 — 2026-10-12

- 首次提供自包含 DSH bundle 包，不再依赖个人学习简报官仓库的本地 `link:` 包。
- 增加只读 `obsidian_tasks` 工具：递归扫描 Markdown 复选框任务、过滤和汇总。
- 输出包含总数/未完成/已完成、优先级分布、项目分布与任务列表（按优先级、项目或标签排序，含截止日期与停滞天数）。
- **零配置即用**：未配置 `vault_path` 时使用默认库 `~/Documents/Obsidian`；目录不存在会在首次查询时自动创建并写入示例笔记；可用 `create_vault_if_missing: false` 关闭写入。
- 路径优先级：配置 `vault_path` ＞ 工具参数 `vault_path` ＞ 默认库；配置已设时参数无法覆盖，保留防提示注入边界。
- 锁定 DSH `0.2.0-rc.2` 工具 API 与 Cordis `~4.0.4` peer 范围。
