# DSH Study Daily

[![CI](https://github.com/pystay/dsh-study-daily/actions/workflows/ci.yml/badge.svg)](https://github.com/pystay/dsh-study-daily/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/pystay/dsh-study-daily?sort=semver)](https://github.com/pystay/dsh-study-daily/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19.0%20%7C%7C%20%3E%3D24.0.0-brightgreen)](package.json)
[![DSH](https://img.shields.io/badge/DSH-0.2.0--rc.2-blue)](package.json)

面向 **DeepSeek Harness（DSH）0.2.0-rc.2** 的只读 Obsidian 待办插件。它扫描配置的 Vault 中的 Markdown 复选框任务，提供两个工具：`obsidian_tasks`（对话内文本查询）与 `study_dashboard`（生成自包含、可交互的 HTML 任务看板）。

> 本仓库只发布 DSH 插件，不包含个人学习简报官 CLI。不提供番茄钟、Git 学习统计、新闻聚合或简报生成。

## 功能

- 只读扫描 Obsidian Vault 中的 `.md` 笔记，识别 `- [ ]`、`* [x]` 等任务行。
- 汇总待办总量、未完成数和已完成数；展示项目、标签、优先级、截止日期及停滞天数。
- 可按任务正文、项目名或标签筛选；默认隐藏已完成任务。
- 可限制扫描笔记数量和结果行数；跳过隐藏目录、`node_modules`、`attachments` 和 `assets`。
- **任务看板**：`study_dashboard` 把待办渲染成一份自包含 HTML（KPI + 优先级/项目分布 + 分组任务列表 + 右下角任务小窗口），写到本地并返回路径，浏览器打开即可交互。
- 不联网、不创建或修改笔记，不接受工具参数指定或覆盖 Vault 路径。

## 兼容范围

| 组件 | 目标版本 |
| --- | --- |
| DeepSeek Harness | `0.2.0-rc.2` |
| `@deepseek-ai/dsh-tools` | `0.2.0-rc.2` |
| `@deepseek-ai/cordis` | `~4.0.4` |
| Node.js | `^22.19.0` 或 `>=24.0.0` |

插件使用 DSH 提供的 `defineTool` 与 Cordis `name` / `inject` / `apply(ctx, config)` 契约。以上是目标版本约束；其他 DSH 版本未在本仓库中承诺兼容。

## 安装

将 GitHub bundle 添加到目标 profile（此处以 `web` 为例）：

```sh
dsh plugin --profile web add "github:pystay/dsh-study-daily#main"
```

安装后需重启对应 profile 才会加载 bundle：

```sh
dsh --profile web --dump-config
dsh --profile web
```

要从本地源码试用，可在插件根目录执行：

```sh
dsh plugin --profile web add "link:<插件目录绝对路径>"
```

## 配置 Vault（默认零配置）

**零配置即用**：不设置 `vault_path` 时，插件使用默认库路径 `~/Documents/Obsidian`（Windows 为 `%USERPROFILE%\Documents\Obsidian`）。若该目录不存在，会在**首次查询时自动创建**，并写入一份示例欢迎笔记。也就是说，别人安装插件后无需任何配置即可直接使用。

如需自定义路径，编辑 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`。Windows 默认 DSH 数据目录通常位于 `%USERPROFILE%\.dsh`；如设置了 `DSH_HOME`，以该环境变量指向的目录为准。

在该文件中添加插件行（将路径替换为本机 Vault 路径）：

```yaml
- id: dsh-study-daily
  config:
    vault_path: 'D:/Notes/Obsidian'
    max_notes: 200
    max_items: 20
    project_filters: []
    group_by: priority
    show_stale_days: 7
    create_vault_if_missing: true
```

路径建议使用绝对路径。也支持 `~/...` 和环境变量 `$NAME` / `${NAME}`。DSH patch 中的 `config` 是整行替换；如果自定义配置，建议明确列出需要的参数。插件会对省略项应用安全默认值。

> **配置没生效时的兜底**：DSH 会在启动时重写 `cordis.patch.yml`，手动写入的配置块可能被丢弃，导致 `vault_path` 一直是空字符串、工具返回"尚未配置"。为此插件额外支持**把 `vault_path` 作为工具参数直接传入**：当插件配置未设置 `vault_path` 时，可以在对话里让模型用 `vault_path` 参数指定要扫描的 Vault 绝对路径。一旦插件配置里设置了 `vault_path`，则以配置为准（参数无法覆盖），以保留防提示注入的安全边界。

配置范围：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `vault_path` | 空（用默认库） | Vault 路径；留空时使用默认库 `~/Documents/Obsidian` |
| `max_notes` | `200` | 最多扫描笔记数，范围 `1–1000` |
| `max_items` | `20` | 最多返回任务数，范围 `1–100` |
| `project_filters` | `[]` | 按 Markdown 标题项目名筛选，支持 `*` 通配符 |
| `group_by` | `priority` | 结果排序：`project`、`priority` 或 `tag` |
| `show_stale_days` | `7` | 停滞天数的计算阈值，范围 `0–3650` |
| `create_vault_if_missing` | `true` | 目标目录不存在时是否自动创建（含示例笔记）；设为 `false` 关闭 |
| `dashboard_path` | 空（用默认位置） | `study_dashboard` 看板 HTML 的输出路径；留空默认 `~/.dsh-study-daily/dashboard.html` |

重启 profile 后，在 DSH 对话中请求查询 Obsidian 待办。插件注册的工具名为 `obsidian_tasks`，可传入：

- `query`：可选关键词，搜索正文、项目名和标签。
- `include_completed`：可选布尔值，设为 `true` 才包含已完成任务。
- `vault_path`：可选字符串，仅当插件配置未设置 `vault_path` 时用于直接指定要扫描的 Vault 绝对路径。

### 任务看板工具 `study_dashboard`

在 DSH 对话里直接让它生成看板，例如：

> 用 study_dashboard 生成我的 Obsidian 任务看板

它会读 Vault、把看板写到本地文件并返回文件路径（默认 `~/.dsh-study-daily/dashboard.html`），**用浏览器打开该文件即可查看**（DSH 对话本身只能渲染文本，交互式看板需要浏览器）。可传入：

- `vault_path`：可选，语义同 `obsidian_tasks`。
- `output_path`：可选，看板 HTML 的写出路径。

看板右下角的悬浮球是**任务小窗口**：从你的待办里按「优先级 + 搁置天数」挑出今日计划（生成计划 / 重新生成 / 清除推荐）、手动添加自定义任务、勾选完成 + Toast、删除；任务状态只存在浏览器 `localStorage`，不联网、不回传。

## 隐私与权限

插件只读取 `vault_path` 下受扫描规则覆盖的 Markdown 文件，**不修改已有笔记**。写入行为只有两处，且都不改动笔记：

1. 当目标 Vault 目录不存在且 `create_vault_if_missing` 为 `true`（默认）时，创建该目录并写入一份示例欢迎笔记；设为 `false` 即可关闭。
2. `study_dashboard` 会在 **Vault 之外**写出一份看板 HTML（默认 `~/.dsh-study-daily/dashboard.html`，可用 `dashboard_path` 改）。

`obsidian_tasks` 会把任务正文、项目标题和标签作为工具结果传入当前 DSH 会话，因此也会进入该会话所用模型的上下文。请只选择你愿意提供给该模型的 Vault。

## 开发与验证

无需安装运行时依赖即可运行测试（需要符合兼容范围的 Node.js）：

```sh
npm test
npm run check
```

测试基于 Node.js 内置测试运行器，覆盖解析、排序、过滤、路径边界、Vault 只读和 bundle 元数据。当前仓库 CI 对 Node.js 22.19 与 24.x 执行语法检查和测试。

## 已知限制

- 只扫描 Markdown 复选框；不读取 `.canvas`、JSON、CSV 或 Dataview 查询结果。
- 标签使用简报官原有 `#tag` / `@tag` 语法识别；截止日期使用 `@YYYY-MM-DD`。复选框优先级仅解析 `P1` / `P2` / `P3`、`(P1)` 和 `!!P1!!` 形式；其他 Obsidian Tasks 插件标记当前不保证识别。
- `max_notes` 达到上限后会停止扫描，结果不代表 Vault 中所有笔记。
- DSH 安装加载需在实际目标 profile 验证；自动化测试不启动或修改你的 DSH profile。

## 许可证

MIT，详见 [LICENSE](LICENSE)。
