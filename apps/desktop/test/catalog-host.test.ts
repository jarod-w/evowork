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
  refreshOfficialConnectors,
  removeConnectorAction,
  setConnectorToolPolicyAction,
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

  it('直接安装 SKILL.MD 只复制所选文件，供用户目录和内核使用', async () => {
    const src = join(root, 'downloads');
    mkdirSync(src);
    const text = '---\nname: coach\ndescription: 工作教练\n---\n帮助整理工作。';
    const path = join(src, 'SKILL.MD');
    writeFileSync(path, text);
    writeFileSync(join(src, 'private.txt'), '同目录无关资料');
    const result = await installSkill(ports(), { kind: 'file', path });
    expect(result.ok).toBe(true);
    expect(result.catalog.skills.some((skill) => skill.id === 'coach')).toBe(true);
    for (const base of ['user', 'kernel']) {
      const dest = join(root, base, 'skills', 'coach');
      expect(readFileSync(join(dest, 'SKILL.md'), 'utf8')).toBe(text);
      expect(existsSync(join(dest, 'private.txt'))).toBe(false);
    }
  });

  it('单文件正文同样审计；P2 确认前不写入用户或内核技能根', async () => {
    const path = join(root, 'SKILL.md');
    writeFileSync(path, '---\nname: risky\ndescription: 测试\n---\nnetwork: any\n');
    const p = ports();
    const first = await installSkill(p, { kind: 'file', path });
    expect(first.audit?.level).toBe('p2');
    expect(first.needsConfirm).toBe(true);
    expect(existsSync(join(root, 'user', 'skills', 'risky'))).toBe(false);
    expect(existsSync(join(root, 'kernel', 'skills', 'risky'))).toBe(false);
    expect(
      (await installSkill(p, { kind: 'file', path, acknowledge: true, confirmName: 'wrong' })).ok,
    ).toBe(false);
    expect(
      (await installSkill(p, { kind: 'file', path, acknowledge: true, confirmName: 'risky' })).ok,
    ).toBe(true);
  });

  it.each(['普通资料', '---\nname: coach\n---\n', '---\nname: ../escape\ndescription: x\n---\n'])(
    '缺少元数据或带路径的技能名不能作为单文件安装：%s',
    async (text) => {
      const path = join(root, 'SKILL.md');
      writeFileSync(path, text);
      const result = await installSkill(ports(), { kind: 'file', path });
      expect(result.ok).toBe(false);
      expect(existsSync(join(root, 'user', 'skills'))).toBe(false);
      expect(existsSync(join(root, 'kernel', 'skills'))).toBe(false);
    },
  );

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

  it('逐工具权限写入内核原生 approval_mode，恢复默认时删除覆盖', () => {
    const p = ports();
    addConnector(p, { name: '日历', transport: 'http', url: 'https://mcp.example.test' });
    const id = readCatalog(p).connectors.find((c) => c.name === '日历')?.id as string;
    trustConnectorAction(p, id);

    expect(
      setConnectorToolPolicyAction(p, { id, tool: 'create_event', policy: 'approve' }).ok,
    ).toBe(true);
    let toml = readFileSync(join(root, 'kernel', 'config.toml'), 'utf8');
    expect(toml).toContain(`[mcp_servers."${id}".tools.create_event]`);
    expect(toml).toContain('approval_mode = "prompt"');

    setConnectorToolPolicyAction(p, { id, tool: 'create_event', policy: 'allow' });
    toml = readFileSync(join(root, 'kernel', 'config.toml'), 'utf8');
    expect(toml).toContain('approval_mode = "approve"');

    const reset = setConnectorToolPolicyAction(p, {
      id,
      tool: 'create_event',
      policy: 'default',
    });
    expect(reset.catalog.connectors.find((c) => c.id === id)?.toolPolicy).toEqual({});
    expect(readFileSync(join(root, 'kernel', 'config.toml'), 'utf8')).not.toContain(
      'tools.create_event',
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

describe('官方 browser 连接器在用户机器上起得来（没有 node）', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ew-browser-launch-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const ports = () =>
    createFsCatalogPorts({
      pluginsDir: join(root, 'Resources', 'plugins'),
      userRoot: join(root, 'user'),
      kernelHome: join(root, 'kernel'),
      nodeCommand: '/Applications/EvoWork.app/Contents/MacOS/EvoWork',
      nodeEnv: { ELECTRON_RUN_AS_NODE: '1' },
    });

  it('信任后写进 config.toml 的是 Electron 自己 + ELECTRON_RUN_AS_NODE，不是 node', () => {
    trustConnectorAction(ports(), 'browser');
    const config = readFileSync(join(root, 'kernel', 'config.toml'), 'utf8');
    expect(config).toMatch(/command = "\/Applications\/EvoWork\.app\/Contents\/MacOS\/EvoWork"/);
    expect(config).toMatch(/env = \{ ELECTRON_RUN_AS_NODE = "1" \}/);
  });

  it('旧版本存下的 `node`（以及旧的随包路径）在启动时被换成这次安装的，并重写 config.toml', () => {
    mkdirSync(join(root, 'user'), { recursive: true });
    writeFileSync(
      join(root, 'user', 'connectors.json'),
      JSON.stringify({
        connectors: [
          {
            id: 'browser',
            name: '浏览器',
            kind: 'official',
            transport: 'stdio',
            command: 'node',
            args: ['/old/EvoWork 0.0.3.app/plugins/connectors/browser/server.mjs'],
            trusted: true,
            toolPolicy: { browser_navigate: 'approve' },
          },
        ],
      }),
    );
    const p = ports();
    expect(readCatalog(p).connectors.find((c) => c.id === 'browser')?.command).toBe(p.nodeCommand);
    expect(refreshOfficialConnectors(p)).toBe(true);
    const config = readFileSync(join(root, 'kernel', 'config.toml'), 'utf8');
    expect(config).not.toMatch(/command = "node"/);
    expect(config).toMatch(/Resources\/plugins\/connectors\/browser\/server\.mjs/);
    // 用户的选择（信任、逐工具权限）不动
    expect(config).toMatch(/approval_mode = "prompt"/);
    // 第二次没有变化，不写盘
    expect(refreshOfficialConnectors(p)).toBe(false);
  });
});
