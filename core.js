import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MAX_NOTES_LIMIT = 1000;
const MAX_ITEMS_LIMIT = 100;
const MAX_OUTPUT_LENGTH = 12_000;
const SKIP_DIRS = new Set(['node_modules', 'attachments', 'assets']);
const PRIORITY_MARKER = /!!P([123])!!|\(P([123])\)|\bP([123])\b/;
const DUE_DATE_MARKER = /@(\d{4}-\d{2}-\d{2})/;
const TAG_TOKEN = /[@#]([A-Za-z0-9_\u4e00-\u9fa5-]+)/g;
const CHECKBOX = /^\s*[-*+]?\s*\[( |x|X)\]\s*/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
const DEFAULT_VAULT_DIRNAME = 'Obsidian';
const WELCOME_NOTE = `# 欢迎使用 DSH Study Daily

本 Vault 由 @mmop/dsh-study-daily 插件在首次使用时自动创建。
在下面用 Markdown 复选框记录你的待办，插件会自动汇总：

- [ ] 示例：读一篇论文 (P2) #学习
- [ ] 示例：整理本周笔记 !!P1!! @2030-01-01
`;

/** 未配置 vault_path 时使用的默认库路径（跨平台：用户主目录下的 Documents/Obsidian）。 */
export function defaultVaultPath() {
  return path.join(os.homedir(), 'Documents', DEFAULT_VAULT_DIRNAME);
}

/**
 * 确保 Vault 目录存在；不存在则递归创建，并写入一份示例欢迎笔记。
 * 只在目录缺失时执行，已存在的目录不会被改动。
 */
export async function ensureVault(root) {
  await mkdir(root, { recursive: true });
  const welcome = path.join(root, '欢迎.md');
  try {
    await stat(welcome);
  } catch {
    // wx 独占创建：并发下若已被别处创建则忽略，不覆盖用户内容。
    await writeFile(welcome, WELCOME_NOTE, { encoding: 'utf8', flag: 'wx' }).catch(() => {});
  }
}

export function positiveInteger(value, fallback, maximum) {
  if (!Number.isSafeInteger(value) || value < 1) return fallback;
  return Math.min(value, maximum);
}

export function normalizeConfig(config = {}) {
  const groupBy = ['project', 'priority', 'tag'].includes(config.group_by)
    ? config.group_by
    : 'priority';
  const projectFilters = Array.isArray(config.project_filters)
    ? config.project_filters.filter((value) => typeof value === 'string' && value.trim().length > 0)
    : [];

  return {
    vault_path: typeof config.vault_path === 'string' ? config.vault_path.trim() : '',
    max_notes: positiveInteger(config.max_notes, 200, MAX_NOTES_LIMIT),
    max_items: positiveInteger(config.max_items, 20, MAX_ITEMS_LIMIT),
    project_filters: projectFilters,
    group_by: groupBy,
    show_stale_days: Number.isSafeInteger(config.show_stale_days) && config.show_stale_days >= 0
      ? Math.min(config.show_stale_days, 3650)
      : 7,
    // 目录缺失时自动创建（含示例笔记），实现零配置即用；显式设为 false 可关闭。
    create_vault_if_missing: config.create_vault_if_missing !== false,
    // 任务看板（study_dashboard）的输出路径；留空则用默认位置
    dashboard_path: typeof config.dashboard_path === 'string' ? config.dashboard_path.trim() : '',
  };
}

export function expandPath(input, cwd = process.cwd(), env = process.env) {
  let expanded = input.trim();
  if (expanded === '~') {
    expanded = os.homedir();
  } else if (expanded.startsWith('~/') || expanded.startsWith('~\\')) {
    expanded = path.join(os.homedir(), expanded.slice(2));
  }

  expanded = expanded.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (_match, bracedName, plainName) => env[bracedName ?? plainName] ?? '');
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(cwd, expanded);
}

export async function collectNotes(root, maxNotes) {
  const limit = positiveInteger(maxNotes, 200, MAX_NOTES_LIMIT);
  const found = [];
  const queue = [root];

  while (queue.length > 0 && found.length < limit) {
    const directory = queue.shift();
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (found.length >= limit) break;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
        queue.push(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        found.push(fullPath);
      }
    }
  }
  return found;
}

export function parseMarkdownTasks(raw, fileMtime) {
  const items = [];
  let currentProject = 'default';
  const seen = new Map();

  for (const line of raw.split(/\r?\n/)) {
    const heading = HEADING.exec(line);
    if (heading?.[2]) {
      currentProject = heading[2].trim();
      continue;
    }

    const checkbox = CHECKBOX.exec(line);
    if (!checkbox) continue;

    const done = (checkbox[1] ?? ' ').toLowerCase() === 'x';
    const body = line.slice(checkbox[0].length);
    const priority = extractPriority(body);
    const dueDate = DUE_DATE_MARKER.exec(body)?.[1] ?? null;
    const tags = extractTags(body);
    const text = cleanText(body);
    if (text.length === 0) continue;

    items.push({
      id: uniqueId(currentProject, text, seen),
      text,
      done,
      project: currentProject,
      priority,
      tags,
      due_date: dueDate,
      updated_at: fileMtime,
      stale_days: 0,
    });
  }
  return items;
}

export function extractPriority(text) {
  const match = PRIORITY_MARKER.exec(text);
  const digit = match?.[1] ?? match?.[2] ?? match?.[3];
  if (digit === '1') return 'high';
  if (digit === '3') return 'low';
  return 'medium';
}

export function extractTags(text) {
  const tags = new Set();
  TAG_TOKEN.lastIndex = 0;
  for (const match of text.matchAll(TAG_TOKEN)) {
    const value = match[1] ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) tags.add(value);
  }
  return [...tags];
}

export function cleanText(text) {
  TAG_TOKEN.lastIndex = 0;
  return text
    .replace(PRIORITY_MARKER, ' ')
    .replace(DUE_DATE_MARKER, ' ')
    .replace(TAG_TOKEN, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function adaptNoteItems(items, notePath, vaultRoot) {
  const noteName = path.basename(notePath, path.extname(notePath));
  const relative = path.relative(vaultRoot, notePath).split(path.sep).join('/');
  return items.map((item) => ({
    ...item,
    id: `${relative}#${item.id}`,
    project: item.project === 'default' ? noteName : item.project,
  }));
}

export function daysBetween(fromIso, toDate) {
  const from = new Date(fromIso);
  const to = new Date(`${toDate}T00:00:00Z`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return 0;
  const difference = to.getTime() - from.getTime();
  return difference <= 0 ? 0 : Math.floor(difference / 86_400_000);
}

export function matchesProjectFilter(project, filters) {
  if (filters.length === 0) return true;
  return filters.some((pattern) => wildcardToRegExp(pattern).test(project));
}

export function wildcardToRegExp(pattern) {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\\\*/g, '.*')}$`, 'i');
}

function summarizeTodos(items, config, today) {
  const withStale = items.map((item) => ({
    ...item,
    stale_days: item.updated_at ? daysBetween(item.updated_at, today) : 0,
  }));
  const byProject = new Map();
  const byPriority = new Map();

  for (const item of withStale) {
    const projectStats = byProject.get(item.project) ?? { total: 0, pending: 0 };
    projectStats.total += 1;
    if (!item.done) projectStats.pending += 1;
    byProject.set(item.project, projectStats);
    byPriority.set(item.priority, (byPriority.get(item.priority) ?? 0) + 1);
  }

  const sorted = sortItems(withStale, config.group_by).slice(0, config.max_items);
  return {
    total: withStale.length,
    completed: withStale.filter((item) => item.done).length,
    pending: withStale.filter((item) => !item.done).length,
    by_project: [...byProject.entries()]
      .map(([project, stats]) => ({ project, total: stats.total, pending: stats.pending }))
      .sort((a, b) => b.pending - a.pending),
    by_priority: [...byPriority.entries()]
      .map(([priority, count]) => ({ priority, count }))
      .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority)),
    stale_items: withStale
      .filter((item) => !item.done && item.stale_days >= config.show_stale_days)
      .sort((a, b) => b.stale_days - a.stale_days),
    items: sorted,
  };
}

function sortItems(items, groupBy) {
  return [...items].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    const rankDifference = groupBy === 'priority'
      ? priorityRank(a.priority) - priorityRank(b.priority)
      : groupBy === 'tag'
        ? Number(Boolean(a.tags[0])) - Number(Boolean(b.tags[0]))
        : 0;
    if (rankDifference !== 0) return rankDifference;
    if (groupBy === 'project' && a.project !== b.project) return a.project.localeCompare(b.project);
    if (groupBy === 'tag') {
      const tagDifference = (a.tags[0] ?? '').localeCompare(b.tags[0] ?? '');
      if (tagDifference !== 0) return tagDifference;
    }
    return b.stale_days - a.stale_days;
  });
}

function priorityRank(priority) {
  if (priority === 'high') return 0;
  if (priority === 'medium') return 1;
  return 2;
}

function uniqueId(project, text, seen) {
  const base = createHash('sha256').update(`${project}|${text}`).digest('hex').slice(0, 8);
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

export async function readTodoSummary(config, today, signal) {
  if (config.vault_path.length === 0) {
    return { summary: null, warningCount: 0, noNotes: false, createdVault: false, errorCode: 'UNCONFIGURED' };
  }

  const vault = expandPath(config.vault_path);
  let createdVault = false;
  let isDirectory = true;
  try {
    isDirectory = (await stat(vault)).isDirectory();
  } catch {
    isDirectory = false;
  }

  if (!isDirectory) {
    if (!config.create_vault_if_missing) {
      return { summary: null, warningCount: 0, noNotes: false, createdVault: false, vaultPath: vault, errorCode: 'ENOENT' };
    }
    try {
      await ensureVault(vault);
      createdVault = true;
    } catch {
      return { summary: null, warningCount: 0, noNotes: false, createdVault: false, vaultPath: vault, errorCode: 'UNREADABLE' };
    }
  }

  let notes;
  try {
    notes = await collectNotes(vault, config.max_notes);
  } catch (error) {
    return {
      summary: null,
      warningCount: 0,
      noNotes: false,
      createdVault,
      vaultPath: vault,
      errorCode: error?.code === 'ENOENT' ? 'ENOENT' : 'UNREADABLE',
    };
  }

  if (notes.length === 0) {
    return { summary: summarizeTodos([], config, today), warningCount: 0, noNotes: true, createdVault, vaultPath: vault, errorCode: null };
  }

  const items = [];
  let failedNotes = 0;
  for (const notePath of notes) {
    if (signal?.aborted) {
      return { summary: null, warningCount: failedNotes, noNotes: false, createdVault, vaultPath: vault, errorCode: 'ABORTED' };
    }
    try {
      const raw = await readFile(notePath, { encoding: 'utf8', ...(signal ? { signal } : {}) });
      const fileMtime = (await stat(notePath)).mtime.toISOString();
      items.push(...adaptNoteItems(parseMarkdownTasks(raw, fileMtime), notePath, vault));
    } catch {
      if (signal?.aborted) {
        return { summary: null, warningCount: failedNotes, noNotes: false, createdVault, vaultPath: vault, errorCode: 'ABORTED' };
      }
      failedNotes += 1;
    }
  }

  if (failedNotes === notes.length) {
    return { summary: null, warningCount: failedNotes, noNotes: false, createdVault, vaultPath: vault, errorCode: 'UNREADABLE_NOTES' };
  }

  const filtered = items.filter((item) => matchesProjectFilter(item.project, config.project_filters));
  return {
    summary: summarizeTodos(filtered, config, today),
    warningCount: failedNotes,
    noNotes: false,
    createdVault,
    vaultPath: vault,
    errorCode: null,
  };
}

export function normalizeArguments(args) {
  return {
    query: typeof args?.query === 'string' ? args.query.slice(0, 200) : '',
    includeCompleted: args?.include_completed === true,
    vaultPath: typeof args?.vault_path === 'string' ? args.vault_path.slice(0, 400) : '',
    outputPath: typeof args?.output_path === 'string' ? args.output_path.slice(0, 400) : '',
  };
}

export function formatSummary(result, args) {
  if (result.errorCode === 'UNCONFIGURED') return '尚未配置 Obsidian Vault 路径，请设置 vault_path。';
  if (result.errorCode === 'ENOENT') return '找不到配置的 Vault，请检查 vault_path。';
  if (result.errorCode === 'ABORTED') return 'Vault 任务查询已取消。';
  if (result.errorCode) return '无法读取配置的 Vault 或部分笔记，请检查路径与文件读取权限。';

  const summary = result.summary;
  const needle = args.query.trim().toLocaleLowerCase();
  const items = summary.items.filter((item) => {
    if (!args.includeCompleted && item.done) return false;
    if (!needle) return true;
    return [item.text, item.project, ...item.tags]
      .some((value) => value.toLocaleLowerCase().includes(needle));
  });
  const lines = [
    `Obsidian 待办：共 ${summary.total} 项，未完成 ${summary.pending} 项，已完成 ${summary.completed} 项。`,
  ];
  if (result.createdVault) {
    lines.push(`已自动创建 Vault 目录${result.vaultPath ? `：${result.vaultPath}` : ''}，并写入示例笔记；可直接在其中记录待办。`);
  }
  if (result.noNotes) lines.push('Vault 中没有找到 Markdown 笔记。');
  if (result.warningCount > 0) lines.push(`有 ${result.warningCount} 篇笔记读取失败，其他任务仍可用。`);
  if (summary.total > 0) {
    lines.push(`优先级分布：${summary.by_priority.map((entry) => `${entry.priority} ${entry.count}`).join('、')}`);
    if (summary.by_project.length > 1) {
      lines.push(`项目分布（未完成/总数）：${summary.by_project.map((entry) => `${entry.project} ${entry.pending}/${entry.total}`).join('、')}`);
    }
  }
  if (needle) lines.push(`当前筛选：${args.query.trim()}`);
  if (items.length === 0) {
    if (!result.noNotes) lines.push(needle ? '没有符合筛选条件的任务。' : '没有可显示的未完成任务。');
    return lines.join('\n');
  }

  lines.push('', '任务列表：');
  for (const item of items) {
    const marker = item.done ? '[x]' : '[ ]';
    const tags = item.tags.length > 0 ? ` ${item.tags.map((tag) => `#${tag}`).join(' ')}` : '';
    const due = item.due_date ? `；截止 ${item.due_date}` : '';
    const stale = !item.done && item.stale_days > 0 ? `；${item.stale_days} 天未更新` : '';
    lines.push(`${marker} [${item.priority}] ${item.text}（${item.project}）${tags}${due}${stale}`);
    if (lines.join('\n').length >= MAX_OUTPUT_LENGTH) {
      lines.push('…结果达到输出上限，剩余任务已省略。');
      break;
    }
  }
  return lines.join('\n').slice(0, MAX_OUTPUT_LENGTH);
}

function localDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const value = (type) => parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

export function createToolDefinition(config, defineTool, todayProvider = localDate, defaultPathProvider = defaultVaultPath) {
  return defineTool({
    name: 'obsidian_tasks',
    description: '只读扫描 Obsidian Vault 中的 Markdown 复选框任务，返回统计与待办列表；不会修改笔记。未配置 Vault 路径时使用默认库并可按需自动创建。可按任务内容、项目名或标签筛选。',
    parameters: {
      query: {
        type: 'string',
        description: '可选关键词，匹配任务内容、项目名或标签。',
      },
      include_completed: {
        type: 'boolean',
        description: '是否包含已完成任务；默认 false。',
      },
      vault_path: {
        type: 'string',
        description: '可选：当插件配置未设置 vault_path 时，可在此直接传入要扫描的 Obsidian Vault 绝对路径；配置已设置则以配置为准。',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : '任务查询完成。' }],
    },
    async execute(args, exec) {
      const normalized = normalizeArguments(args);
      // 路径优先级：插件配置 > 工具参数 > 默认库路径（实现零配置即用）。
      // 配置优先是为了防止提示注入通过参数改路径。
      const effectivePath = config.vault_path.length > 0
        ? config.vault_path
        : (normalized.vaultPath || defaultPathProvider());
      const effectiveConfig = { ...config, vault_path: effectivePath };
      const result = await readTodoSummary(effectiveConfig, todayProvider(), exec.signal);
      return formatSummary(result, normalized);
    },
  });
}

export function registerObsidianTool(ctx, rawConfig, defineTool, todayProvider, defaultPathProvider) {
  const config = normalizeConfig(rawConfig);
  ctx.tools.register(createToolDefinition(config, defineTool, todayProvider, defaultPathProvider));
}

// ─────────────────────────────────────────────────────────────
// 任务看板（Vault → 自包含可交互 HTML）
//
// 为什么单独一个工具：DSH 对话里只能渲染文本，交互式看板必须用浏览器。
// 故把看板做成**本地 HTML 文件**：插件读 Vault → 生成一份自包含页面
// （KPI + 分布 + 分组任务列表 + 右下角任务小窗口）写到磁盘并返回路径，
// 用户用浏览器打开即可。看板不联网、不修改任何笔记。
// ─────────────────────────────────────────────────────────────

const DEFAULT_DASHBOARD_DIRNAME = '.dsh-study-daily';

/** 默认看板输出路径：用户主目录下的隐藏目录（刻意不写进 Vault，避免污染笔记） */
export function defaultDashboardPath() {
  return path.join(os.homedir(), DEFAULT_DASHBOARD_DIRNAME, 'dashboard.html');
}

/** HTML 转义：看板要展示 Vault 里的任务正文/项目名/标签，必须过这一层 */
export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 把 JSON 安全塞进 <script type="application/json">，防 </script> 提前闭合 */
export function escapeJsonForScript(json) {
  return json
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** 看板上下文：喂给小窗口的聚合量 + 任务清单（小窗口据此自己排计划） */
export function buildBoardContext(summary, meta) {
  return {
    vault: meta.vault,
    range: meta.range ?? '',
    generated_at: meta.generated_at,
    stale_days: meta.stale_days ?? 7,
    storage_key: meta.storage_key ?? meta.vault,
    total: summary.total,
    pending: summary.pending,
    completed: summary.completed,
    tasks: summary.items.map((item) => ({
      id: item.id,
      text: item.text,
      done: item.done,
      project: item.project,
      priority: item.priority,
      tags: item.tags,
      due_date: item.due_date,
      stale_days: item.stale_days,
    })),
  };
}

const TASK_BOARD_CSS = `  * { box-sizing: border-box; }
  body { margin: 0; padding: 28px 14px 96px; background: #0f1420; color: #e6eaf2; font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  .wrap { max-width: 960px; margin: 0 auto; }
  .hero { background: linear-gradient(135deg, #5b8cff, #a06bff); color: #fff; border-radius: 14px; padding: 22px 24px; margin-bottom: 16px; }
  .hero h1 { margin: 0 0 6px; font-size: 21px; }
  .hero p { margin: 0; font-size: 13px; opacity: .92; word-break: break-all; }
  .hero .dim { margin-top: 6px; font-size: 12px; opacity: .75; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 16px; }
  .kpi { background: #171d2b; border: 1px solid #232b3d; border-radius: 12px; padding: 14px 16px; }
  .kpi .k { color: #8b95a7; font-size: 12px; }
  .kpi .v { font-size: 22px; font-weight: 700; margin-top: 4px; }
  .card, .grp { background: #171d2b; border: 1px solid #232b3d; border-radius: 12px; padding: 16px 18px; margin-bottom: 14px; }
  .card p { margin: 6px 0; font-size: 13px; }
  .grp h3 { margin: 0 0 8px; font-size: 13px; color: #8b95a7; font-weight: 600; }
  .grp ul { list-style: none; margin: 0; padding: 0; }
  .tk { display: flex; align-items: flex-start; gap: 8px; padding: 7px 0; border-bottom: 1px solid #232b3d; font-size: 13px; }
  .tk:last-child { border-bottom: none; }
  .tk-box { flex: none; color: #34d399; }
  .tk.done .tk-text { text-decoration: line-through; color: #8b95a7; }
  .tk-text { flex: 1; word-break: break-word; }
  .tk-meta { flex: none; color: #8b95a7; font-size: 12px; }
  .dim { color: #8b95a7; }
  /* ── 任务小窗口 ── */
  .tw { position: fixed; right: 20px; bottom: 20px; z-index: 9999; }
  .tw[data-pos="bl"] { left: 20px; right: auto; }
  .tw-fab { width: 52px; height: 52px; border-radius: 50%; border: 1px solid #232b3d; background: #171d2b; color: #e6eaf2; cursor: pointer; padding: 0; box-shadow: 0 6px 20px rgba(0,0,0,.28); transition: transform .18s ease; display: grid; place-items: center; }
  .tw-fab:hover { transform: translateY(-2px); }
  .tw-fab:focus-visible { outline: 2px solid #5b8cff; outline-offset: 2px; }
  .tw-ring { width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; background: conic-gradient(#232b3d 0deg, #232b3d 360deg); }
  .tw-ring-inner { width: 26px; height: 26px; border-radius: 50%; background: #171d2b; display: grid; place-items: center; font-size: 11px; font-weight: 700; }
  .tw-panel { position: absolute; bottom: 64px; right: 0; width: 320px; max-width: calc(100vw - 32px); max-height: 70vh; display: flex; flex-direction: column; background: #171d2b; border: 1px solid #232b3d; border-radius: 14px; box-shadow: 0 18px 48px rgba(0,0,0,.4); overflow: hidden; transform-origin: bottom right; }
  .tw[data-pos="bl"] .tw-panel { left: 0; right: auto; transform-origin: bottom left; }
  .tw-panel[hidden] { display: none; }
  .tw-panel.is-enter { animation: tw-in .18s ease-out; }
  @keyframes tw-in { from { opacity: 0; transform: translateY(8px) scale(.98); } to { opacity: 1; transform: none; } }
  .tw-head { display: flex; align-items: center; gap: 6px; padding: 10px 12px; border-bottom: 1px solid #232b3d; }
  .tw-title { font-weight: 700; font-size: 14px; }
  .tw-sub { color: #8b95a7; font-size: 12px; flex: 1; }
  .tw-icon { border: none; background: transparent; color: #8b95a7; cursor: pointer; font-size: 16px; line-height: 1; padding: 2px 6px; border-radius: 6px; }
  .tw-icon:hover { background: #232b3d; color: #e6eaf2; }
  .tw-tabs { display: flex; gap: 6px; padding: 10px 12px 0; }
  .tw-tab { flex: 1; padding: 6px 8px; font-size: 12px; border: 1px solid #232b3d; background: transparent; color: #8b95a7; border-radius: 8px; cursor: pointer; }
  .tw-tab[aria-selected="true"] { background: #5b8cff; border-color: #5b8cff; color: #fff; font-weight: 600; }
  .tw-pane { padding: 10px 12px 0; }
  .tw-pane[hidden] { display: none; }
  .tw-actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .tw-btn { padding: 6px 10px; font-size: 12px; border-radius: 8px; border: 1px solid #232b3d; background: transparent; color: #e6eaf2; cursor: pointer; }
  .tw-btn:hover { border-color: #5b8cff; }
  .tw-btn:disabled { opacity: .55; cursor: default; }
  .tw-btn-primary { background: #5b8cff; border-color: #5b8cff; color: #fff; font-weight: 600; }
  .tw-addrow { display: flex; gap: 6px; }
  .tw-input { flex: 1; min-width: 0; padding: 6px 8px; font-size: 13px; border-radius: 8px; border: 1px solid #232b3d; background: #0f1420; color: #e6eaf2; }
  .tw-hint { color: #8b95a7; font-size: 11px; margin: 8px 0 0; }
  .tw-hint[hidden] { display: none; }
  .tw-list { list-style: none; margin: 10px 0 0; padding: 0 12px 12px; overflow-y: auto; }
  .tw-item { display: flex; align-items: flex-start; gap: 8px; padding: 7px 0; border-bottom: 1px solid #232b3d; font-size: 13px; }
  .tw-item:last-child { border-bottom: none; }
  .tw-check { margin-top: 2px; flex: none; width: 15px; height: 15px; accent-color: #34d399; cursor: pointer; }
  .tw-text { flex: 1; word-break: break-word; }
  .tw-item.is-done .tw-text { text-decoration: line-through; color: #8b95a7; }
  .tw-src { font-size: 10px; padding: 0 5px; border-radius: 8px; border: 1px solid #232b3d; color: #8b95a7; flex: none; }
  .tw-src[data-src="ai"] { color: #a06bff; border-color: #a06bff; }
  .tw-prio { font-size: 10px; padding: 0 5px; border-radius: 8px; flex: none; }
  .tw-prio[data-p="high"] { background: rgba(248,113,113,.16); color: #f87171; }
  .tw-prio[data-p="medium"] { background: rgba(251,191,36,.16); color: #fbbf24; }
  .tw-prio[data-p="low"] { background: rgba(52,211,153,.16); color: #34d399; }
  .tw-del { border: none; background: transparent; color: #8b95a7; cursor: pointer; font-size: 14px; line-height: 1; flex: none; padding: 0 2px; }
  .tw-del:hover { color: #f87171; }
  .tw-empty { color: #8b95a7; font-size: 12px; text-align: center; padding: 16px 12px; margin: 0; }
  .tw-empty[hidden] { display: none; }
  .tw-toast { margin: 0 12px 12px; padding: 7px 10px; border-radius: 8px; font-size: 12px; background: rgba(52,211,153,.16); color: #34d399; }
  .tw-toast[hidden] { display: none; }
  @media (max-width: 480px) { .tw-panel { width: calc(100vw - 32px); } }
  @media (prefers-color-scheme: light) {
    body { background: #f4f6fa; color: #1f2430; }
    .kpi, .card, .grp, .tw-fab, .tw-panel, .tw-ring-inner { background: #fff; border-color: #e6eaf2; }
    .tw-panel, .tw-ring-inner { color: #1f2430; }
    .tw-input { background: #f4f6fa; color: #1f2430; border-color: #e6eaf2; }
    .tw-src { color: #667085; border-color: #e6eaf2; }
    .tw-icon:hover { background: #eef1f6; }
    .dim, .kpi .k, .tw-sub, .grp h3 { color: #667085; }
  }
  @media (prefers-reduced-motion: reduce) { .tw-panel.is-enter { animation: none; } .tw-fab { transition: none; } }`;

const TASK_BOARD_MARKUP = `<button class="tw-fab" id="dsh-tw-fab" type="button" aria-expanded="false" aria-controls="dsh-tw-panel" aria-label="打开任务小窗">
  <span class="tw-ring" id="dsh-tw-ring" aria-hidden="true"><span class="tw-ring-inner" id="dsh-tw-ringlabel">0</span></span>
</button>
<section class="tw-panel" id="dsh-tw-panel" role="dialog" aria-label="任务管理小窗" hidden>
  <header class="tw-head">
    <span class="tw-title">任务</span>
    <span class="tw-sub" id="dsh-tw-sub"></span>
    <button class="tw-icon" id="dsh-tw-pos" type="button" aria-label="切换位置（左下/右下）" title="切换位置">⇄</button>
    <button class="tw-icon" id="dsh-tw-close" type="button" aria-label="收起小窗" title="收起">×</button>
  </header>
  <div class="tw-tabs" role="tablist" aria-label="任务来源">
    <button class="tw-tab" id="dsh-tw-tab-ai" role="tab" type="button" aria-selected="true" aria-controls="dsh-tw-pane-ai">推荐</button>
    <button class="tw-tab" id="dsh-tw-tab-manual" role="tab" type="button" aria-selected="false" aria-controls="dsh-tw-pane-manual">手动添加</button>
  </div>
  <div class="tw-pane" id="dsh-tw-pane-ai" role="tabpanel" aria-labelledby="dsh-tw-tab-ai">
    <div class="tw-actions">
      <button class="tw-btn tw-btn-primary" id="dsh-tw-plan" type="button">生成计划</button>
      <button class="tw-btn" id="dsh-tw-replan" type="button">重新生成</button>
      <button class="tw-btn" id="dsh-tw-clear-ai" type="button">清除推荐</button>
    </div>
    <p class="tw-hint" id="dsh-tw-thinking" hidden>规划中…</p>
    <p class="tw-hint" id="dsh-tw-plan-note"></p>
  </div>
  <div class="tw-pane" id="dsh-tw-pane-manual" role="tabpanel" aria-labelledby="dsh-tw-tab-manual" hidden>
    <form class="tw-addrow" id="dsh-tw-form">
      <input class="tw-input" id="dsh-tw-input" type="text" maxlength="120" placeholder="输入任务，回车添加" aria-label="新任务内容" autocomplete="off">
      <button class="tw-btn tw-btn-primary" type="submit">添加</button>
    </form>
    <p class="tw-hint">手动任务标记为"自定义"，与推荐任务分开保存。</p>
  </div>
  <ul class="tw-list" id="dsh-tw-list" role="list" aria-live="polite"></ul>
  <p class="tw-empty" id="dsh-tw-empty">还没有任务。点"生成计划"，或切到"手动添加"。</p>
  <div class="tw-toast" id="dsh-tw-toast" role="status" aria-live="polite" hidden></div>
</section>`;

const TASK_BOARD_JS = `(function () {
  'use strict';
  var ctxEl = document.getElementById('dsh-tw-context');
  var root = document.getElementById('dsh-tw');
  if (!ctxEl || !root) { return; }
  var ctx = {};
  try { ctx = JSON.parse(ctxEl.textContent || '{}') || {}; } catch (e) { ctx = {}; }

  var STORE_KEY = 'dsh-study-board:' + (ctx.storage_key || 'default');
  var state = { tasks: [], mode: 'ai', open: false, thinking: false, pos: 'br' };

  var els = {
    fab: document.getElementById('dsh-tw-fab'),
    ring: document.getElementById('dsh-tw-ring'),
    ringLabel: document.getElementById('dsh-tw-ringlabel'),
    panel: document.getElementById('dsh-tw-panel'),
    sub: document.getElementById('dsh-tw-sub'),
    close: document.getElementById('dsh-tw-close'),
    posBtn: document.getElementById('dsh-tw-pos'),
    tabAi: document.getElementById('dsh-tw-tab-ai'),
    tabManual: document.getElementById('dsh-tw-tab-manual'),
    paneAi: document.getElementById('dsh-tw-pane-ai'),
    paneManual: document.getElementById('dsh-tw-pane-manual'),
    plan: document.getElementById('dsh-tw-plan'),
    replan: document.getElementById('dsh-tw-replan'),
    clearAi: document.getElementById('dsh-tw-clear-ai'),
    thinking: document.getElementById('dsh-tw-thinking'),
    planNote: document.getElementById('dsh-tw-plan-note'),
    form: document.getElementById('dsh-tw-form'),
    input: document.getElementById('dsh-tw-input'),
    list: document.getElementById('dsh-tw-list'),
    empty: document.getElementById('dsh-tw-empty'),
    toast: document.getElementById('dsh-tw-toast')
  };

  function isArray(v) { return Object.prototype.toString.call(v) === '[object Array]'; }
  function uid() { return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function rank(p) { return p === 'high' ? 0 : p === 'low' ? 2 : 1; }

  function load() {
    try {
      var raw = window.localStorage.getItem(STORE_KEY);
      if (!raw) { return; }
      var saved = JSON.parse(raw) || {};
      if (isArray(saved.tasks)) { state.tasks = saved.tasks; }
      if (saved.pos === 'bl' || saved.pos === 'br') { state.pos = saved.pos; }
      if (saved.mode === 'ai' || saved.mode === 'manual') { state.mode = saved.mode; }
    } catch (e) { /* localStorage 不可用时降级为内存态 */ }
  }
  function save() {
    try { window.localStorage.setItem(STORE_KEY, JSON.stringify({ tasks: state.tasks, pos: state.pos, mode: state.mode })); } catch (e) {}
  }

  // 本地规划器：从 Vault 待办里挑"今天该做的"——未完成、优先级高、搁置久的优先
  function planFromVault(c) {
    var pending = (isArray(c.tasks) ? c.tasks : []).filter(function (t) { return !t.done; });
    pending.sort(function (a, b) {
      var d = rank(a.priority) - rank(b.priority);
      if (d !== 0) { return d; }
      return (b.stale_days || 0) - (a.stale_days || 0);
    });
    return pending.slice(0, 5).map(function (t) {
      return { text: t.text + '（' + (t.project || 'default') + '）', priority: t.priority || 'medium' };
    });
  }

  function plan(c) {
    return new Promise(function (resolve) { window.setTimeout(function () { resolve(planFromVault(c)); }, 350); });
  }

  function render() {
    var pending = 0, done = 0;
    state.tasks.forEach(function (t) { if (t.done) { done += 1; } else { pending += 1; } });
    var total = state.tasks.length;
    var deg = total > 0 ? Math.round((done / total) * 360) : 0;
    els.ring.style.background = 'conic-gradient(#34d399 ' + deg + 'deg, #232b3d ' + deg + 'deg)';
    els.ringLabel.textContent = String(pending);
    els.fab.setAttribute('aria-label', '任务小窗：' + pending + ' 项待办' + (total > 0 ? '，共 ' + total + ' 项' : ''));
    els.sub.textContent = total > 0 ? done + '/' + total : '暂无任务';

    els.list.textContent = '';
    state.tasks.forEach(function (t) {
      var li = document.createElement('li');
      li.className = 'tw-item' + (t.done ? ' is-done' : '');
      li.setAttribute('role', 'listitem');

      var cb = document.createElement('input');
      cb.type = 'checkbox'; cb.className = 'tw-check'; cb.checked = !!t.done;
      cb.setAttribute('aria-label', '完成任务：' + t.text);
      cb.addEventListener('change', function () { toggle(t.id); });

      var span = document.createElement('span');
      span.className = 'tw-text'; span.textContent = t.text;

      var src = document.createElement('span');
      src.className = 'tw-src'; src.setAttribute('data-src', t.source === 'custom' ? 'custom' : 'ai');
      src.textContent = t.source === 'custom' ? '自定义' : '推荐';

      var prio = document.createElement('span');
      prio.className = 'tw-prio';
      var p = t.priority === 'high' || t.priority === 'low' ? t.priority : 'medium';
      prio.setAttribute('data-p', p);
      prio.textContent = p === 'high' ? '高' : p === 'low' ? '低' : '中';

      var del = document.createElement('button');
      del.type = 'button'; del.className = 'tw-del'; del.setAttribute('aria-label', '删除任务：' + t.text);
      del.textContent = '×';
      del.addEventListener('click', function () { remove(t.id); });

      li.appendChild(cb); li.appendChild(span); li.appendChild(src); li.appendChild(prio); li.appendChild(del);
      els.list.appendChild(li);
    });
    els.empty.hidden = total > 0;
  }

  function setMode(mode) {
    state.mode = mode;
    var isAi = mode === 'ai';
    els.tabAi.setAttribute('aria-selected', isAi ? 'true' : 'false');
    els.tabManual.setAttribute('aria-selected', isAi ? 'false' : 'true');
    els.paneAi.hidden = !isAi;
    els.paneManual.hidden = isAi;
    save();
  }
  function setOpen(open) {
    state.open = open;
    els.panel.hidden = !open;
    els.fab.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      els.panel.classList.remove('is-enter');
      void els.panel.offsetWidth;
      els.panel.classList.add('is-enter');
    }
  }

  var toastTimer = null;
  function toast(message) {
    els.toast.textContent = message;
    els.toast.hidden = false;
    if (toastTimer) { window.clearTimeout(toastTimer); }
    toastTimer = window.setTimeout(function () { els.toast.hidden = true; }, 2200);
  }

  function addTasks(items, source) {
    var added = 0;
    items.forEach(function (item) {
      var text = item && item.text ? String(item.text).trim() : '';
      if (!text) { return; }
      var priority = item.priority === 'high' || item.priority === 'low' ? item.priority : 'medium';
      state.tasks.push({ id: uid(), text: text.slice(0, 120), done: false, source: source, priority: priority });
      added += 1;
    });
    if (added > 0) { save(); render(); }
    return added;
  }
  function toggle(id) {
    var task = null;
    state.tasks.forEach(function (t) { if (t.id === id) { task = t; } });
    if (!task) { return; }
    task.done = !task.done;
    save(); render();
    if (task.done) { toast('任务已完成 🎉'); }
  }
  function remove(id) {
    state.tasks = state.tasks.filter(function (t) { return t.id !== id; });
    save(); render();
  }

  function setThinking(on) {
    state.thinking = on;
    els.plan.disabled = on;
    els.replan.disabled = on;
    els.thinking.hidden = !on;
  }
  function runPlan(clearFirst) {
    if (state.thinking) { return; }
    if (clearFirst) {
      state.tasks = state.tasks.filter(function (t) { return t.source !== 'ai'; });
      save(); render();
    }
    setThinking(true);
    plan(ctx).then(function (items) {
      var n = addTasks(items, 'ai');
      setThinking(false);
      toast(n > 0 ? '已从待办挑出 ' + n + ' 项' : '没有可推荐的任务');
    }).catch(function () {
      setThinking(false);
      toast('生成失败，请稍后重试');
    });
  }

  els.fab.addEventListener('click', function () { setOpen(!state.open); });
  els.close.addEventListener('click', function () { setOpen(false); els.fab.focus(); });
  els.posBtn.addEventListener('click', function () {
    state.pos = state.pos === 'br' ? 'bl' : 'br';
    root.setAttribute('data-pos', state.pos);
    save();
  });
  els.tabAi.addEventListener('click', function () { setMode('ai'); });
  els.tabManual.addEventListener('click', function () { setMode('manual'); });
  els.plan.addEventListener('click', function () { runPlan(false); });
  els.replan.addEventListener('click', function () { runPlan(true); });
  els.clearAi.addEventListener('click', function () {
    var before = state.tasks.length;
    state.tasks = state.tasks.filter(function (t) { return t.source !== 'ai'; });
    save(); render();
    toast(before === state.tasks.length ? '没有推荐任务可清除' : '已清除推荐任务');
  });
  els.form.addEventListener('submit', function (event) {
    event.preventDefault();
    var n = addTasks([{ text: els.input.value, priority: 'medium' }], 'custom');
    if (n > 0) { els.input.value = ''; toast('已添加自定义任务'); }
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && state.open) { setOpen(false); els.fab.focus(); }
  });

  load();
  root.setAttribute('data-pos', state.pos);
  setMode(state.mode);
  render();
  if (els.planNote) {
    var count = (isArray(ctx.tasks) ? ctx.tasks : []).filter(function (t) { return !t.done; }).length;
    els.planNote.textContent = count > 0
      ? '点"生成计划"会从你的 ' + count + ' 项未完成待办里挑出今天该做的（按优先级 + 搁置天数）'
      : '当前没有未完成待办；可用"手动添加"记一条。';
  }
})();`;

/**
 * 渲染自包含的任务看板 HTML。
 * 所有进入页面的文本（任务正文/项目/标签）一律过 escapeHtml；
 * 上下文数据岛过 escapeJsonForScript。
 */
export function renderTaskBoardHtml(summary, meta) {
  const context = escapeJsonForScript(JSON.stringify(buildBoardContext(summary, meta)));
  const priorityLabel = { high: '高', medium: '中', low: '低' };
  const staleDays = meta.stale_days ?? 7;

  const groups = ['high', 'medium', 'low']
    .map((priority) => {
      const items = summary.items.filter((item) => item.priority === priority);
      if (items.length === 0) {
        return '';
      }
      const rows = items
        .map((item) => {
          const tags = item.tags.length > 0 ? ` ${item.tags.map((tag) => `#${escapeHtml(tag)}`).join(' ')}` : '';
          const due = item.due_date ? `；截止 ${escapeHtml(item.due_date)}` : '';
          const stale = !item.done && item.stale_days > 0 ? `；${item.stale_days} 天未更新` : '';
          return `<li class="tk${item.done ? ' done' : ''}"><span class="tk-box">${item.done ? '✔' : '○'}</span><span class="tk-text">${escapeHtml(item.text)}</span><span class="tk-meta">${escapeHtml(item.project)}${tags}${due}${stale}</span></li>`;
        })
        .join('');
      return `<section class="grp"><h3>${priorityLabel[priority]}优先级 · ${items.length}</h3><ul>${rows}</ul></section>`;
    })
    .join('');

  const priorityDist = summary.by_priority.map((entry) => `${escapeHtml(entry.priority)} ${entry.count}`).join('、');
  const projectDist = summary.by_project.map((entry) => `${escapeHtml(entry.project)} ${entry.pending}/${entry.total}`).join('、');
  const subtitle = `${meta.vault}${meta.range ? ` ｜ ${meta.range}` : ''}`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Obsidian 任务看板</title>
<style>
${TASK_BOARD_CSS}
</style>
</head>
<body>
<div class="wrap">
  <header class="hero">
    <h1>🗂️ Obsidian 任务看板</h1>
    <p>${escapeHtml(subtitle)}</p>
    <p class="dim">生成于 ${escapeHtml(meta.generated_at)} ｜ 由 @mmop/dsh-study-daily 生成（只读，不改笔记）</p>
  </header>
  <section class="kpis">
    <div class="kpi"><div class="k">任务总数</div><div class="v">${summary.total}</div></div>
    <div class="kpi"><div class="k">未完成</div><div class="v">${summary.pending}</div></div>
    <div class="kpi"><div class="k">已完成</div><div class="v">${summary.completed}</div></div>
    <div class="kpi"><div class="k">停滞 ≥${staleDays} 天</div><div class="v">${summary.stale_items.length}</div></div>
  </section>
  <section class="card">
    <p><strong>优先级分布：</strong>${priorityDist || '无'}</p>
    <p><strong>项目分布（未完成/总数）：</strong>${projectDist || '无'}</p>
  </section>
  ${groups || '<section class="card"><p class="dim">Vault 中没有可显示的待办。</p></section>'}
</div>
<script type="application/json" id="dsh-tw-context">${context}</script>
<div class="tw" id="dsh-tw" data-pos="br">
${TASK_BOARD_MARKUP}
</div>
<script>
${TASK_BOARD_JS}
</script>
</body>
</html>
`;
}

/** 工具：把 Vault 待办渲染成本地 HTML 看板并返回路径（只读 Vault） */
export function createDashboardToolDefinition(
  config,
  defineTool,
  todayProvider = localDate,
  defaultPathProvider = defaultVaultPath,
  dashboardPathProvider = defaultDashboardPath,
) {
  return defineTool({
    name: 'study_dashboard',
    description:
      '把 Obsidian Vault 的待办渲染成一份自包含、可交互的 HTML 任务看板（含右下角任务小窗口），写到本地文件并返回文件路径；只读 Vault，不修改笔记。用浏览器打开该路径即可查看。',
    parameters: {
      vault_path: {
        type: 'string',
        description: '可选：当插件配置未设置 vault_path 时，可在此直接传入要扫描的 Obsidian Vault 绝对路径；配置已设置则以配置为准。',
      },
      output_path: {
        type: 'string',
        description: '可选：看板 HTML 的写出路径；缺省写到用户主目录下的 ~/.dsh-study-daily/dashboard.html。',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : '任务看板已生成。' }],
    },
    async execute(args, exec) {
      const normalized = normalizeArguments(args);
      const effectivePath = config.vault_path.length > 0
        ? config.vault_path
        : (normalized.vaultPath || defaultPathProvider());
      const result = await readTodoSummary({ ...config, vault_path: effectivePath }, todayProvider(), exec.signal);
      if (result.errorCode) {
        return formatSummary(result, normalized);
      }

      const vault = result.vaultPath ?? expandPath(effectivePath);
      const outputPath = normalized.outputPath
        ? expandPath(normalized.outputPath)
        : (config.dashboard_path.length > 0 ? expandPath(config.dashboard_path) : dashboardPathProvider());
      const html = renderTaskBoardHtml(result.summary, {
        vault,
        generated_at: new Date().toISOString(),
        stale_days: config.show_stale_days,
        storage_key: vault,
      });

      try {
        await mkdir(path.dirname(outputPath), { recursive: true });
        await writeFile(outputPath, html, 'utf8');
      } catch {
        return `看板生成失败：无法写入 ${outputPath}（请检查目录权限或改用 output_path 指定其他位置）。`;
      }

      const summary = result.summary;
      return [
        `已生成 Obsidian 任务看板：${outputPath}`,
        `共 ${summary.total} 项（未完成 ${summary.pending}，已完成 ${summary.completed}，停滞 ≥${config.show_stale_days} 天 ${summary.stale_items.length} 项）。`,
        result.createdVault ? `（已自动创建 Vault 目录：${vault}）` : '',
        '用浏览器打开该文件即可查看；页面右下角悬浮球是任务小窗口（从待办里挑今天该做的 / 手动添加 / 勾选完成）。',
      ].filter((line) => line.length > 0).join('\n');
    },
  });
}

export function registerDashboardTool(
  ctx,
  rawConfig,
  defineTool,
  todayProvider,
  defaultPathProvider,
  dashboardPathProvider,
) {
  const config = normalizeConfig(rawConfig);
  ctx.tools.register(
    createDashboardToolDefinition(config, defineTool, todayProvider, defaultPathProvider, dashboardPathProvider),
  );
}

export const internals = {
  adaptNoteItems,
  buildBoardContext,
  collectNotes,
  cleanText,
  createDashboardToolDefinition,
  daysBetween,
  defaultDashboardPath,
  defaultVaultPath,
  ensureVault,
  escapeHtml,
  escapeJsonForScript,
  expandPath,
  extractPriority,
  extractTags,
  formatSummary,
  matchesProjectFilter,
  normalizeArguments,
  normalizeConfig,
  parseMarkdownTasks,
  positiveInteger,
  readTodoSummary,
  registerDashboardTool,
  registerObsidianTool,
  renderTaskBoardHtml,
  wildcardToRegExp,
};
