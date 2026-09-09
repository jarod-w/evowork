/**
 * 目录宿主 I/O（05 §3.3）。不经过 sqlite：打开库会把「这台机器有没有 fts5」
 * 混进安装审计，而那是另一条路径。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  addConnector,
  createExpert,
  createFsCatalogPorts,
  installSkill,
  missingPortsResult,
  readCatalog,
  removeConnectorAction,
  trustConnectorAction,
  uninstallSkill,
} from '../src/main/catalog-host.js';

describe('技能目录安装审计（05 §3.3）', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ew-catalog-host-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function ports() {
    return createFsCatalogPorts({
      pluginsDir: join(root, 'plugins'),
      userRoot: join(root, 'user'),
      kernelHome: join(root, 'kernel'),
    });
  }

  function writeSkill(dir: string, name: string, extraFile?: { name: string; text: string }) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: x\n---\n说明\n`);
    if (extraFile) writeFileSync(join(dir, extraFile.name), extraFile.text);
  }

  it('P1 未勾选「我已了解」不会拷贝目录', async () => {
    const src = join(root, 'src-p1');
    writeSkill(src, 'note', { name: 'run.py', text: 'print(1)\n' });
    const p = ports();
    const first = await installSkill(p, { kind: 'directory', path: src });
    expect(first.ok).toBe(false);
    expect(first.needsConfirm).toBe(true);
    expect(first.audit?.level).toBe('p1');
    expect(existsSync(join(root, 'user', 'skills', 'note'))).toBe(false);

    const second = await installSkill(p, { kind: 'directory', path: src, acknowledge: true });
    expect(second.ok).toBe(true);
    expect(existsSync(join(root, 'user', 'skills', 'note'))).toBe(true);
    expect(existsSync(join(root, 'kernel', 'skills', 'note', 'SKILL.md'))).toBe(true);
  });

  it('P2 不输入技能名不会拷贝；输对才装', async () => {
    const src = join(root, 'src-p2');
    writeSkill(src, 'spy', { name: 'hooks.json', text: '{}\n' });
    const p = ports();
    const first = await installSkill(p, { kind: 'directory', path: src });
    expect(first.needsConfirm).toBe(true);
    expect(first.audit?.level).toBe('p2');
    expect(existsSync(join(root, 'user', 'skills', 'spy'))).toBe(false);

    const wrong = await installSkill(p, {
      kind: 'directory',
      path: src,
      acknowledge: true,
      confirmName: 'nope',
    });
    expect(wrong.ok).toBe(false);
    expect(existsSync(join(root, 'user', 'skills', 'spy'))).toBe(false);

    const ok = await installSkill(p, {
      kind: 'directory',
      path: src,
      acknowledge: true,
      confirmName: 'spy',
    });
    expect(ok.ok).toBe(true);
    expect(existsSync(join(root, 'user', 'skills', 'spy'))).toBe(true);
    expect(
      readFileSync(join(root, 'user', 'skills', 'spy', '.evowork-source'), 'utf8').trim(),
    ).toBe('local');
  });

  it('官方技能不能卸载', async () => {
    mkdirSync(join(root, 'plugins', 'skills', 'documents'), { recursive: true });
    writeFileSync(
      join(root, 'plugins', 'skills', 'documents', 'SKILL.md'),
      '---\nname: documents\ndescription: 文档\n---\n',
    );
    const result = uninstallSkill(ports(), 'documents');
    expect(result.ok).toBe(false);
    expect(result.refused).toMatch(/不能卸载/);
    expect(existsSync(join(root, 'plugins', 'skills', 'documents', 'SKILL.md'))).toBe(true);
  });

  it('读目录能看见随包技能；没端口时如实拒绝', () => {
    mkdirSync(join(root, 'plugins', 'skills', 'documents'), { recursive: true });
    writeFileSync(
      join(root, 'plugins', 'skills', 'documents', 'SKILL.md'),
      '---\nname: documents\ndescription: 生成文档\n---\n',
    );
    writeFileSync(
      join(root, 'plugins', 'skills', 'documents', 'interface.json'),
      '{"displayName":"文档","category":"办公"}\n',
    );
    const catalog = readCatalog(ports());
    expect(catalog.skills.map((s) => s.name)).toEqual(['文档']);
    expect(catalog.connectors.some((c) => c.id === 'browser')).toBe(true);
    expect(catalog.experts).toEqual([]);
    const missing = missingPortsResult();
    expect(missing.ok).toBe(false);
    expect(missing.refused).toMatch(/还没有技能目录/);
  });

  it('P0 没有脚本时一键安装，不弹出确认', async () => {
    const src = join(root, 'src-p0');
    writeSkill(src, 'readme');
    const result = await installSkill(ports(), { kind: 'directory', path: src });
    expect(result.ok).toBe(true);
    expect(result.needsConfirm).toBeUndefined();
    expect(existsSync(join(root, 'user', 'skills', 'readme', 'SKILL.md'))).toBe(true);
  });

  it('Git 安装把来源标成 git，失败时不落盘', async () => {
    const p = createFsCatalogPorts({
      pluginsDir: join(root, 'plugins'),
      userRoot: join(root, 'user'),
      kernelHome: join(root, 'kernel'),
      gitClone: async (url, dest) => {
        if (url === 'https://git.example/empty.git') return { ok: true };
        mkdirSync(dest, { recursive: true });
        writeSkill(dest, 'from-git');
        return { ok: true };
      },
    });
    const empty = await installSkill(p, { kind: 'git', url: 'https://git.example/empty.git' });
    expect(empty.ok).toBe(false);
    expect(empty.refused).toMatch(/没有 SKILL.md/);
    expect(existsSync(join(root, 'user', 'skills', 'from-git'))).toBe(false);

    const ok = await installSkill(p, { kind: 'git', url: 'https://git.example/skill.git' });
    expect(ok.ok).toBe(true);
    expect(
      readFileSync(join(root, 'user', 'skills', 'from-git', '.evowork-source'), 'utf8').trim(),
    ).toBe('git');
    expect(ok.catalog.skills.some((s) => s.source === 'git' && s.id === 'from-git')).toBe(true);
  });
});

describe('连接器信任只落配置、不启动进程', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ew-catalog-conn-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function ports() {
    return createFsCatalogPorts({
      pluginsDir: join(root, 'plugins'),
      userRoot: join(root, 'user'),
      kernelHome: join(root, 'kernel'),
    });
  }

  it('添加自定义 MCP 后是待信任，config.toml 还没有 mcp_servers', () => {
    const p = ports();
    const added = addConnector(p, {
      name: '我的服务',
      transport: 'stdio',
      command: 'npx',
      args: '-y demo',
    });
    expect(added.ok).toBe(true);
    const mine = added.catalog.connectors.find((c) => c.name === '我的服务');
    expect(mine?.status).toBe('untrusted');
    expect(mine?.trusted).toBe(false);
    expect(existsSync(join(root, 'kernel', 'config.toml'))).toBe(false);
  });

  it('信任之后才写入 mcp_servers，重复信任不会堆两份', () => {
    const p = ports();
    addConnector(p, { name: '我的服务', transport: 'stdio', command: '/usr/bin/demo' });
    const id = readCatalog(p).connectors.find((c) => c.name === '我的服务')?.id;
    expect(id).toBeDefined();
    const result = trustConnectorAction(p, id as string);
    expect(result.ok).toBe(true);
    const row = result.catalog.connectors.find((c) => c.id === id);
    expect(row?.trusted).toBe(true);
    expect(row?.status).toBe('disconnected');
    expect(row?.toolPolicy).toEqual({});
    const toml = readFileSync(join(root, 'kernel', 'config.toml'), 'utf8');
    expect(toml).toMatch(/# evowork-mcp-begin/);
    expect(toml).toMatch(/mcp_servers\./);
    expect(toml).toMatch(/command = "\/usr\/bin\/demo"/);
    trustConnectorAction(p, id as string);
    const twice = readFileSync(join(root, 'kernel', 'config.toml'), 'utf8');
    expect(twice.split('# evowork-mcp-begin')).toHaveLength(2);
  });

  it('官方 browser 不能删掉，取消信任后不再写进 mcp_servers', () => {
    const p = ports();
    const trusted = trustConnectorAction(p, 'browser');
    expect(trusted.ok).toBe(true);
    expect(trusted.catalog.connectors.find((c) => c.id === 'browser')?.trusted).toBe(true);
    expect(readFileSync(join(root, 'kernel', 'config.toml'), 'utf8')).toMatch(
      /mcp_servers\.browser/,
    );

    const removed = removeConnectorAction(p, 'browser');
    expect(removed.ok).toBe(true);
    const browser = removed.catalog.connectors.find((c) => c.id === 'browser');
    expect(browser).toBeTruthy();
    expect(browser?.trusted).toBe(false);
    expect(readFileSync(join(root, 'kernel', 'config.toml'), 'utf8')).not.toMatch(
      /mcp_servers\.browser/,
    );
  });
});

describe('专家不预置角色包', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ew-catalog-exp-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('空目录没有专家；新建后能读回来', () => {
    const p = createFsCatalogPorts({
      pluginsDir: join(root, 'plugins'),
      userRoot: join(root, 'user'),
      kernelHome: join(root, 'kernel'),
    });
    expect(readCatalog(p).experts).toEqual([]);
    const created = createExpert(p, {
      name: '财务分析专家',
      description: '看报表',
      category: '投资理财',
      sampleTasks: '解读这份财报, 做一份预算表',
      instructions: '用中文回答',
    });
    expect(created.ok).toBe(true);
    expect(created.catalog.experts).toHaveLength(1);
    expect(created.catalog.experts[0]?.name).toBe('财务分析专家');
    expect(created.catalog.experts[0]?.sampleTasks).toEqual(['解读这份财报', '做一份预算表']);
    expect(existsSync(join(root, 'user', 'agents', '财务分析专家.toml'))).toBe(true);
  });
});
