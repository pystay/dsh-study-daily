# 安全政策

## 支持范围

当前适配目标为 DeepSeek Harness `0.2.0-rc.2`。尚未声明对其他 DSH 版本的支持。

## 报告安全问题

请勿在公开 Issue 中附上 Obsidian Vault 内容、私有路径、会话记录、访问令牌或其他个人数据。若 GitHub 仓库启用了 Private vulnerability reporting，请优先通过该功能私下报告；否则先联系仓库维护者请求私下沟通渠道，再提供最少复现信息。

## 数据访问边界

插件读取 Markdown 文件以汇总待办，**不修改或删除已有笔记**。写入行为只有两处，且都不改动笔记：

1. 当解析出的 Vault 目录不存在且 `create_vault_if_missing` 为 `true`（默认）时，创建该目录并写入一份示例欢迎笔记；显式设为 `false` 可完全关闭。
2. `study_dashboard` 工具会在 **Vault 之外**写出一份看板 HTML（默认 `~/.dsh-study-daily/dashboard.html`）。该页面自包含、零外链；任务文本经 HTML 转义、上下文数据岛经 JSON 转义，防 XSS 与 `</script>` 逃逸。

扫描路径的解析优先级为：**插件配置中的 `vault_path` ＞ 工具参数 `vault_path` ＞ 默认库路径（`~/Documents/Obsidian`）**。

- 仅当插件配置未设置 `vault_path`（空字符串，DSH 默认值）时，才允许工具调用参数 `vault_path` 指定要扫描的目录。这一兜底用于应对 DSH 重写 `cordis.patch.yml` 导致配置无法持久化的情况。
- 一旦配置里显式设置了 `vault_path`，参数无法覆盖它，从而保留对提示注入（prompt injection）改路径的防护。
- 三者皆空时使用默认库路径，实现零配置即用。

任务正文会返回给 DSH 会话并进入该会话的模型上下文，用户应自行确认 Vault 内容适合提供给所用模型。
