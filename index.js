import { defineTool } from '@deepseek-ai/dsh-tools';
import { registerObsidianTool } from './core.js';

export const name = '@pystay/dsh-study-daily';
export const inject = ['tools'];

export function apply(ctx, config = {}) {
  registerObsidianTool(ctx, config, defineTool);
}
