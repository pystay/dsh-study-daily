import { defineTool } from '@deepseek-ai/dsh-tools';
import { registerDashboardTool, registerObsidianTool } from './core.js';

export const name = '@pystay/dsh-study-daily';
export const inject = ['tools'];

export function apply(ctx, config = {}) {
  // 两个工具：obsidian_tasks 查待办（文本）；study_dashboard 产出本地 HTML 看板
  registerObsidianTool(ctx, config, defineTool);
  registerDashboardTool(ctx, config, defineTool);
}
