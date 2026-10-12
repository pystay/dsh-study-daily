import type { Context } from '@deepseek-ai/cordis';

export interface PluginConfig {
  /** Absolute Vault path, or a path relative to the home directory / process working directory. */
  vault_path?: string;
  /** Maximum Markdown files scanned, 1–1000; default 200. */
  max_notes?: number;
  /** Maximum task rows returned, 1–100; default 20. */
  max_items?: number;
  /** Project-name filters; supports `*` wildcards. Empty means no filtering. */
  project_filters?: string[];
  group_by?: 'project' | 'priority' | 'tag';
  /** Stale threshold in days, 0–3650; default 7. */
  show_stale_days?: number;
  /** Create the Vault directory (with a sample note) when it is missing; default true. */
  create_vault_if_missing?: boolean;
  /** Where `study_dashboard` writes the task board HTML; empty means ~/.dsh-study-daily/dashboard.html */
  dashboard_path?: string;
}

export declare const name: '@mmop/dsh-study-daily';
export declare const inject: readonly ['tools'];
export declare function apply(ctx: Context, config?: PluginConfig): void;
