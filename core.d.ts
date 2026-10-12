export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
  project: string;
  priority: 'high' | 'medium' | 'low';
  tags: string[];
  due_date: string | null;
  updated_at: string | null;
  stale_days: number;
}

export interface TodoSummary {
  total: number;
  completed: number;
  pending: number;
  by_project: Array<{ project: string; total: number; pending: number }>;
  by_priority: Array<{ priority: TodoItem['priority']; count: number }>;
  stale_items: TodoItem[];
  items: TodoItem[];
}

export interface NormalizedConfig {
  vault_path: string;
  max_notes: number;
  max_items: number;
  project_filters: string[];
  group_by: 'project' | 'priority' | 'tag';
  show_stale_days: number;
  create_vault_if_missing: boolean;
}

export interface ReadResult {
  summary: TodoSummary | null;
  warningCount: number;
  noNotes: boolean;
  createdVault: boolean;
  vaultPath?: string;
  errorCode: 'UNCONFIGURED' | 'ENOENT' | 'ABORTED' | 'UNREADABLE' | 'UNREADABLE_NOTES' | null;
}

export interface NormalizedArguments {
  query: string;
  includeCompleted: boolean;
  vaultPath: string;
}

export interface ToolDefinitionLike {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: {
    schema: { type: 'string' };
    render(args: unknown, value: unknown): Array<{ type: 'text'; text: string }>;
  };
  execute(args: unknown, exec: { signal: AbortSignal }): Promise<string>;
}

export interface PluginContextLike {
  tools: { register(tool: ToolDefinitionLike): unknown };
}

export function positiveInteger(value: unknown, fallback: number, maximum: number): number;
export function normalizeConfig(config?: Record<string, unknown>): NormalizedConfig;
export function expandPath(input: string, cwd?: string, env?: Record<string, string | undefined>): string;
export function defaultVaultPath(): string;
export function ensureVault(root: string): Promise<void>;
export function collectNotes(root: string, maxNotes: number): Promise<string[]>;
export function parseMarkdownTasks(raw: string, fileMtime: string): TodoItem[];
export function extractPriority(text: string): TodoItem['priority'];
export function extractTags(text: string): string[];
export function cleanText(text: string): string;
export function adaptNoteItems(items: TodoItem[], notePath: string, vaultRoot: string): TodoItem[];
export function daysBetween(fromIso: string, toDate: string): number;
export function matchesProjectFilter(project: string, filters: string[]): boolean;
export function wildcardToRegExp(pattern: string): RegExp;
export function readTodoSummary(config: NormalizedConfig, today: string, signal?: AbortSignal): Promise<ReadResult>;
export function normalizeArguments(args: unknown): NormalizedArguments;
export function formatSummary(result: ReadResult, args: NormalizedArguments): string;
export function createToolDefinition(
  config: NormalizedConfig,
  defineTool: (definition: ToolDefinitionLike) => ToolDefinitionLike,
  todayProvider?: () => string,
  defaultPathProvider?: () => string,
): ToolDefinitionLike;
export function registerObsidianTool(
  ctx: PluginContextLike,
  rawConfig: Record<string, unknown>,
  defineTool: (definition: ToolDefinitionLike) => ToolDefinitionLike,
  todayProvider?: () => string,
  defaultPathProvider?: () => string,
): void;
export const internals: Record<string, unknown>;
