import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import {
  adaptNoteItems,
  collectNotes,
  createToolDefinition,
  daysBetween,
  defaultVaultPath,
  extractPriority,
  extractTags,
  formatSummary,
  normalizeArguments,
  normalizeConfig,
  parseMarkdownTasks,
  readTodoSummary,
  registerObsidianTool,
  wildcardToRegExp,
} from '../core.js';

const temporaryRoots = [];

after(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

async function makeVault() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-study-daily-'));
  temporaryRoots.push(root);
  return root;
}

describe('standalone package contract', () => {
  it('has no local-root runtime dependency and declares the pinned DSH bundle contract', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
    const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');

    assert.equal(packageJson.name, '@pystay/dsh-study-daily');
    assert.equal(packageJson.private, undefined);
    assert.equal(packageJson.dsh.bundle.patch, './cordis.patch.yml');
    assert.equal(packageJson.peerDependencies['@deepseek-ai/dsh-tools'], '0.2.0-rc.2');
    assert.equal(packageJson.peerDependencies['@deepseek-ai/cordis'], '~4.0.4');
    assert.equal(packageJson.engines.node, '^22.19.0 || >=24.0.0');
    assert.equal(packageJson.dependencies, undefined);
    assert.doesNotMatch(source, /personal-learning-briefing-officer|link:\.\.\/\.\./);
    assert.match(source, /from '@deepseek-ai\/dsh-tools'/);
    assert.match(patch, /id: dsh-study-daily/);
    assert.match(patch, /name: '@pystay\/dsh-study-daily'/);
    assert.match(patch, /max_notes: 200/);
    assert.match(patch, /group_by: priority/);
  });
});

describe('Markdown task parsing', () => {
  it('parses checkboxes, headings, priority, due date, tags, and duplicate ids', () => {
    const rows = parseMarkdownTasks([
      '# Work',
      '- [ ] Fix parser !!P1!! #release @2030-01-02',
      '* [X] Close old issue (P3) @done',
      '- [ ] Fix parser !!P1!! #release @2030-01-02',
      'not a task',
    ].join('\n'), '2030-01-01T00:00:00.000Z');

    assert.equal(rows.length, 3);
    assert.deepEqual(rows[0], {
      id: rows[0].id,
      text: 'Fix parser',
      done: false,
      project: 'Work',
      priority: 'high',
      tags: ['release'],
      due_date: '2030-01-02',
      updated_at: '2030-01-01T00:00:00.000Z',
      stale_days: 0,
    });
    assert.equal(rows[1].done, true);
    assert.equal(rows[1].priority, 'low');
    assert.equal(rows[1].text, 'Close old issue');
    assert.notEqual(rows[0].id, rows[2].id);
  });

  it('extracts priorities and de-duplicates tags while ignoring date tokens', () => {
    assert.equal(extractPriority('A P2 task'), 'medium');
    assert.equal(extractPriority('!!P3!! later'), 'low');
    assert.deepEqual(extractTags('#a @a @2030-01-02 #中文-tag'), ['a', '中文-tag']);
  });

  it('adapts default projects and prefixes task ids with vault-relative note paths', () => {
    const rows = parseMarkdownTasks('- [ ] Task', '2030-01-01T00:00:00.000Z');
    const adapted = adaptNoteItems(rows, path.join('vault', 'projects', 'study.md'), 'vault');
    assert.equal(adapted[0].project, 'study');
    assert.match(adapted[0].id, /^projects\/study\.md#/);
  });
});

describe('Vault scanning and aggregation', () => {
  it('recursively scans markdown deterministically and skips hidden / resource folders', async () => {
    const vault = await makeVault();
    await mkdir(path.join(vault, 'z'), { recursive: true });
    await mkdir(path.join(vault, '.obsidian'), { recursive: true });
    await mkdir(path.join(vault, 'attachments'), { recursive: true });
    await mkdir(path.join(vault, 'node_modules'), { recursive: true });
    await writeFile(path.join(vault, 'b.md'), '- [ ] B');
    await writeFile(path.join(vault, 'z', 'a.MD'), '- [ ] A');
    await writeFile(path.join(vault, '.obsidian', 'hidden.md'), '- [ ] Hidden');
    await writeFile(path.join(vault, 'attachments', 'attachment.md'), '- [ ] Attachment');
    await writeFile(path.join(vault, 'node_modules', 'dep.md'), '- [ ] Dependency');

    const notes = await collectNotes(vault, 20);
    assert.deepEqual(notes.map((item) => path.relative(vault, item).split(path.sep).join('/')), ['b.md', 'z/a.MD']);
    assert.deepEqual(await collectNotes(vault, 1), [path.join(vault, 'b.md')]);
  });

  it('applies project filters, counts all matching rows, sorts and caps returned items', async () => {
    const vault = await makeVault();
    await mkdir(path.join(vault, 'projects'));
    const note = path.join(vault, 'projects', 'work.md');
    await writeFile(note, '# Frontend\n- [ ] High P1\n- [ ] Low P3\n- [x] Done P2\n\n# Backend\n- [ ] Hidden project');
    await utimes(note, new Date('2026-10-01T00:00:00Z'), new Date('2026-10-01T00:00:00Z'));

    const config = normalizeConfig({
      vault_path: vault,
      project_filters: ['*front*'],
      max_items: 1,
      show_stale_days: 5,
    });
    const result = await readTodoSummary(config, '2026-10-11', new AbortController().signal);
    assert.equal(result.errorCode, null);
    assert.equal(result.summary.total, 3);
    assert.equal(result.summary.pending, 2);
    assert.equal(result.summary.completed, 1);
    assert.equal(result.summary.items.length, 1);
    assert.equal(result.summary.items[0].priority, 'high');
    assert.equal(result.summary.stale_items.length, 2);
  });

  it('renders priority and project distribution in the summary output', async () => {
    const vault = await makeVault();
    await writeFile(
      path.join(vault, 'plan.md'),
      '# Alpha\n- [ ] A1 P1\n- [ ] A2 P3\n\n# Beta\n- [ ] B1 P2',
    );
    const result = await readTodoSummary(normalizeConfig({ vault_path: vault }), '2026-10-11');
    const output = formatSummary(result, normalizeArguments({}));
    assert.match(output, /优先级分布：high 1、medium 1、low 1/);
    assert.match(output, /项目分布（未完成\/总数）：Alpha 2\/2、Beta 1\/1/);
  });

  it('normalizes invalid limits and wildcard project filters', () => {
    const config = normalizeConfig({ max_notes: 100_000, max_items: 0, show_stale_days: 99_000, group_by: 'bad' });
    assert.equal(config.max_notes, 1000);
    assert.equal(config.max_items, 20);
    assert.equal(config.show_stale_days, 3650);
    assert.equal(config.group_by, 'priority');
    assert.equal(wildcardToRegExp('*front*').test('My Frontend'), true);
    assert.equal(daysBetween('2026-10-01T00:00:00.000Z', '2026-10-11'), 10);
  });

  it('does not expose the absolute Vault path in an error result', async () => {
    const vault = path.join(os.tmpdir(), `missing-vault-${Date.now()}`);
    const result = await readTodoSummary(
      normalizeConfig({ vault_path: vault, create_vault_if_missing: false }),
      '2026-10-11',
    );
    const output = formatSummary(result, normalizeArguments({}));
    assert.match(output, /找不到配置的 Vault/);
    assert.equal(output.includes(vault), false);
  });

  it('observes cancellation and does not write to note files', async () => {
    const vault = await makeVault();
    const note = path.join(vault, 'tasks.md');
    await writeFile(note, '- [ ] Read-only task');
    const before = await readFile(note, 'utf8');
    const controller = new AbortController();
    const result = await readTodoSummary(normalizeConfig({ vault_path: vault }), '2026-10-11', controller.signal);
    assert.equal(result.summary.total, 1);
    assert.equal(await readFile(note, 'utf8'), before);
    controller.abort();
    assert.equal((await readTodoSummary(normalizeConfig({ vault_path: vault }), '2026-10-11', controller.signal)).errorCode, 'ABORTED');
  });

  it('registers the host tool through the injected factory and never accepts a Vault path argument', async () => {
    const vault = await makeVault();
    await writeFile(path.join(vault, 'tasks.md'), '- [ ] Configured task');
    const otherVault = await makeVault();
    await writeFile(path.join(otherVault, 'tasks.md'), '- [ ] Untrusted argument path task');

    let registered;
    const ctx = { tools: { register(tool) { registered = tool; } } };
    const config = { vault_path: vault };
    registerObsidianTool(ctx, config, (definition) => definition, () => '2026-10-11');
    assert.equal(registered.name, 'obsidian_tasks');
    assert.deepEqual(Object.keys(registered.parameters), ['query', 'include_completed', 'vault_path']);
    const output = await registered.execute({ vault_path: otherVault, query: '' }, { signal: new AbortController().signal });
    assert.match(output, /Configured task/);
    assert.doesNotMatch(output, /Untrusted argument path task/);
  });

  it('falls back to a tool argument when no vault_path is configured', async () => {
    const vault = await makeVault();
    await writeFile(path.join(vault, 'tasks.md'), '- [ ] Fallback argument task');
    let registered;
    const ctx = { tools: { register(tool) { registered = tool; } } };
    // 不配置 vault_path（与 DSH 默认空字符串一致）
    registerObsidianTool(ctx, { vault_path: '' }, (definition) => definition, () => '2026-10-11');
    assert.equal(registered.name, 'obsidian_tasks');
    const output = await registered.execute({ vault_path: vault, query: '' }, { signal: new AbortController().signal });
    assert.match(output, /Fallback argument task/);
  });

  it('auto-creates a missing Vault directory and seeds a welcome note', async () => {
    const root = await makeVault();
    const vault = path.join(root, 'brand-new-vault');
    const result = await readTodoSummary(normalizeConfig({ vault_path: vault }), '2026-10-11');
    assert.equal(result.createdVault, true);
    assert.equal(result.summary.total, 2);
    const welcome = await readFile(path.join(vault, '欢迎.md'), 'utf8');
    assert.match(welcome, /DSH Study Daily/);
    const output = formatSummary(result, normalizeArguments({}));
    assert.match(output, /已自动创建 Vault 目录/);
  });

  it('does not create the Vault when create_vault_if_missing is false', async () => {
    const root = await makeVault();
    const vault = path.join(root, 'not-created');
    const result = await readTodoSummary(
      normalizeConfig({ vault_path: vault, create_vault_if_missing: false }),
      '2026-10-11',
    );
    assert.equal(result.errorCode, 'ENOENT');
    await assert.rejects(readFile(path.join(vault, '欢迎.md'), 'utf8'));
  });

  it('uses the injected default Vault path when nothing is configured', async () => {
    const vault = await makeVault();
    await writeFile(path.join(vault, 'tasks.md'), '- [ ] Default vault task');
    let registered;
    const ctx = { tools: { register(tool) { registered = tool; } } };
    registerObsidianTool(ctx, { vault_path: '' }, (definition) => definition, () => '2026-10-11', () => vault);
    const output = await registered.execute({ query: '' }, { signal: new AbortController().signal });
    assert.match(output, /Default vault task/);
  });

  it('resolves the built-in default Vault path and enables auto-create by default', () => {
    assert.equal(defaultVaultPath(), path.join(os.homedir(), 'Documents', 'Obsidian'));
    assert.equal(normalizeConfig({}).create_vault_if_missing, true);
    assert.equal(normalizeConfig({ create_vault_if_missing: false }).create_vault_if_missing, false);
  });
});
