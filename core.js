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

本 Vault 由 @pystay/dsh-study-daily 插件在首次使用时自动创建。
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

export const internals = {
  adaptNoteItems,
  collectNotes,
  cleanText,
  daysBetween,
  defaultVaultPath,
  ensureVault,
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
  registerObsidianTool,
  wildcardToRegExp,
};
