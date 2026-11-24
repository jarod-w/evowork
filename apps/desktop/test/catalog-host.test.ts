/**
 * 目录宿主 I/O（05 §3.3）。不经过 sqlite：打开库会把「这台机器有没有 fts5」
 * 混进安装审计，而那是另一条路径。
 */
import {
  existsSync,
  lstatSync,
  realpathSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrateSkillMirrors, skillContentHash } from '../src/main/skill-storage.js';

import {
  addConnector,
  createExpert,
  createFsCatalogPorts,
  installSkill,
  setSkillInvocation,
  mergeDiscoveredSkills,
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

  it('精选版本覆盖后仍正确标注内核返回的旧内置副本，不误标为用户共享', () => {
    const p = ports();
    const path = join(root, 'plugins', 'skills', 'charts', 'SKILL.md');
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, '---\nname: charts\ndescription: 内置图表\n---\n');
    const rows = mergeDiscoveredSkills(
      p,
      [],
      [{ name: 'charts', description: '内置图表', path, scope: 'user', enabled: false }],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'official', sourceLabel: '官方内置', enabled: false });
    expect(rows[0]?.uninstallDisabledReason).toBeUndefined();
  });

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

  it('Git 确认使用同一份审计快照，只克隆一次并记录提交', async () => {
    const p = ports();
    const gitClone = vi.fn(async (_url: string, destination: string) => {
      writeSkill(destination, 'reviewed', { name: 'run.py', text: 'print("reviewed")' });
      return { ok: true as const, revision: 'a'.repeat(40) };
    });
    const host = { ...p, gitClone };
    const input = { kind: 'git' as const, url: 'https://example.test/skills.git' };
    const review = await installSkill(host, input);
    expect(review.needsConfirm).toBe(true);
    const installed = await installSkill(host, {
      ...input,
      acknowledge: true,
      reviewToken: review.audit?.reviewToken,
    });
    expect(installed.ok).toBe(true);
    expect(gitClone).toHaveBeenCalledTimes(1);
    expect(
      installed.catalog.skills.find((skill) => skill.id === 'reviewed')?.findings.join(' '),
    ).not.toContain('example.test');
    const directory = join(root, 'user', 'skills', 'reviewed');
    const provenance = JSON.parse(readFileSync(join(directory, '.evowork-install.json'), 'utf8'));
    expect(provenance).toMatchObject({
      source: 'git',
      commit: 'a'.repeat(40),
      url: input.url,
      contentHash: skillContentHash(directory),
    });
  });

  it('确认后源目录变化不会改变已审计安装内容，凭据不能跨来源使用', async () => {
    const p = ports();
    const source = join(root, 'source');
    writeSkill(source, 'reviewed', { name: 'run.py', text: 'original' });
    const input = { kind: 'directory' as const, path: source };
    const review = await installSkill(p, input);
    writeFileSync(join(source, 'run.py'), 'changed');
    const wrong = await installSkill(p, {
      ...input,
      path: join(root, 'other'),
      acknowledge: true,
      reviewToken: review.audit?.reviewToken,
    });
    expect(wrong.ok).toBe(false);
    expect(
      (
        await installSkill(p, {
          ...input,
          acknowledge: true,
          reviewToken: review.audit?.reviewToken,
        })
      ).ok,
    ).toBe(true);
    expect(readFileSync(join(root, 'kernel', 'skills', 'reviewed', 'run.py'), 'utf8')).toBe(
      'original',
    );
    expect(
      (
        await installSkill(p, {
          ...input,
          acknowledge: true,
          reviewToken: review.audit?.reviewToken,
        })
      ).ok,
    ).toBe(false);
  });

  it('旧镜像只在完整内容一致时迁移，冲突原样保留，迁移可重复运行', () => {
    const p = ports();
    for (const name of ['same', 'conflict']) {
      writeSkill(join(root, 'user', 'skills', name), name);
      writeSkill(join(root, 'kernel', 'skills', name), name);
    }
    writeFileSync(join(root, 'kernel', 'skills', 'conflict', 'extra.txt'), 'keep');
    writeSkill(join(root, 'user', 'skills', 'empty-dir-conflict'), 'empty-dir-conflict');
    writeSkill(join(root, 'kernel', 'skills', 'empty-dir-conflict'), 'empty-dir-conflict');
    mkdirSync(join(root, 'kernel', 'skills', 'empty-dir-conflict', 'required-empty'));
    expect(migrateSkillMirrors(p)).toEqual(['conflict', 'empty-dir-conflict']);
    expect(realpathSync(join(root, 'kernel', 'skills', 'same'))).toBe(
      realpathSync(join(root, 'user', 'skills', 'same')),
    );
    expect(readFileSync(join(root, 'kernel', 'skills', 'conflict', 'extra.txt'), 'utf8')).toBe(
      'keep',
    );
    expect(migrateSkillMirrors(p)).toEqual(['conflict', 'empty-dir-conflict']);
  });

  it('启动可恢复受管技能丢失的兼容链接，但不激活吊销或未登记文件', () => {
    const p = ports();
    for (const [name, marker] of [
      ['managed', 'local'],
      ['revoked', 'hub-revoked'],
      ['unmanaged', ''],
    ] as const) {
      const directory = join(root, 'user', 'skills', name);
      writeSkill(directory, name);
      if (marker) writeFileSync(join(directory, '.evowork-source'), marker);
    }
    expect(migrateSkillMirrors(p)).toEqual([]);
    expect(realpathSync(join(root, 'kernel', 'skills', 'managed'))).toBe(
      realpathSync(join(root, 'user', 'skills', 'managed')),
    );
    expect(existsSync(join(root, 'kernel', 'skills', 'revoked'))).toBe(false);
    expect(existsSync(join(root, 'kernel', 'skills', 'unmanaged'))).toBe(false);
  });

  it('仅手动调用保留原策略和界面信息，外部技能不可修改', async () => {
    const p = ports();
    const source = join(root, 'source');
    writeSkill(source, 'manual');
    mkdirSync(join(source, 'agents'));
    writeFileSync(
      join(source, 'agents', 'openai.yaml'),
      'interface:\n  display_name: 保留\npolicy:\n  other: keep\n',
    );
    expect((await installSkill(p, { kind: 'directory', path: source })).ok).toBe(true);
    const path = join(root, 'kernel', 'skills', 'manual', 'SKILL.md');
    const changed = setSkillInvocation(p, path, false);
    expect(changed.ok).toBe(true);
    expect(
      changed.catalog.skills.find((entry) => entry.id === 'manual')?.allowImplicitInvocation,
    ).toBe(false);
    const yaml = readFileSync(
      join(root, 'user', 'skills', 'manual', 'agents', 'openai.yaml'),
      'utf8',
    );
    expect(yaml).toContain('display_name: 保留');
    expect(yaml).toContain('other: keep');
    expect(setSkillInvocation(p, join(source, 'SKILL.md'), true).ok).toBe(false);
    expect(setSkillInvocation(p, path, true).ok).toBe(true);
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

  it('带引号技能名与多行描述可安装，目录元数据缺失不能报成功', async () => {
    const path = join(root, 'SKILL.md');
    writeFileSync(
      path,
      '\uFEFF---\nname: "quoted-coach"\ndescription: >-\n  帮助整理\n  工作\n---\n说明',
    );
    expect((await installSkill(ports(), { kind: 'file', path })).ok).toBe(true);
    expect(readFileSync(path, 'utf8').startsWith('\uFEFF')).toBe(true);
    for (const base of ['user', 'kernel']) {
      const saved = readFileSync(join(root, base, 'skills', 'quoted-coach', 'SKILL.md'), 'utf8');
      expect(saved.startsWith('---\n')).toBe(true);
      expect(saved).toBe(readFileSync(path, 'utf8').slice(1));
    }
    const src = join(root, 'bad-dir');
    mkdirSync(src);
    writeFileSync(join(src, 'SKILL.md'), '---\nname: missing-desc\n---\n');
    const result = await installSkill(ports(), { kind: 'directory', path: src });
    expect(result.ok).toBe(false);
    expect(existsSync(join(root, 'kernel', 'skills', 'missing-desc'))).toBe(false);
  });

  it('从已安装目录再次安装会保留来源文件与资源', async () => {
    const p = ports();
    const src = join(root, 'src');
    writeSkill(src, 'coach', { name: 'resource.txt', text: '技能资源' });
    expect((await installSkill(p, { kind: 'directory', path: src })).ok).toBe(true);
    const installed = join(root, 'user', 'skills', 'coach');
    expect((await installSkill(p, { kind: 'directory', path: installed })).ok).toBe(true);
    expect(readFileSync(join(installed, 'resource.txt'), 'utf8')).toBe('技能资源');
    expect(readFileSync(join(root, 'kernel', 'skills', 'coach', 'resource.txt'), 'utf8')).toBe(
      '技能资源',
    );
  });

  it('更新的兼容链接建立失败时，旧版本和旧路径都保留', async () => {
    const p = ports();
    const src = join(root, 'src');
    writeSkill(src, 'coach');
    await installSkill(p, { kind: 'directory', path: src });
    const previous = readFileSync(join(src, 'SKILL.md'), 'utf8');
    writeFileSync(join(src, 'SKILL.md'), `${previous}\n新版本`);
    const result = await installSkill(
      {
        ...p,
        linkDir: () => {
          throw new Error('模拟链接失败');
        },
      },
      { kind: 'directory', path: src },
    );
    expect(result.ok).toBe(false);
    for (const base of ['user', 'kernel'])
      expect(readFileSync(join(root, base, 'skills', 'coach', 'SKILL.md'), 'utf8')).toBe(previous);
  });

  it.each([false, true])('内核替换失败回滚两份目录（已有版本：%s）', async (existing) => {
    const p = ports();
    const src = join(root, 'src');
    writeSkill(src, 'coach');
    const previous = readFileSync(join(src, 'SKILL.md'), 'utf8');
    if (existing) expect((await installSkill(p, { kind: 'directory', path: src })).ok).toBe(true);
    writeFileSync(join(src, 'SKILL.md'), `${previous}\n更新内容`);
    const result = await installSkill(
      {
        ...p,
        renamePath: (from, to) => {
          if (/[\\/]next$/.test(from) && to.startsWith(join(root, 'kernel')))
            throw new Error('模拟替换失败');
          p.renamePath(from, to);
        },
      },
      { kind: 'directory', path: src },
    );
    expect(result.ok).toBe(false);
    for (const base of ['user', 'kernel']) {
      const dest = join(root, base, 'skills', 'coach', 'SKILL.md');
      if (existing) expect(readFileSync(dest, 'utf8')).toBe(previous);
      else expect(existsSync(dest)).toBe(false);
      expect(readdirSync(join(root, base)).some((name) => name.startsWith('.skill-'))).toBe(false);
    }
  });

  it('目录中的 SKILL.MD 统一保存为 SKILL.md；缺少 name 时按目录名安装', async () => {
    const src = join(root, 'folder-coach');
    mkdirSync(src);
    const text = '---\ndescription: 工作教练\n---\n说明';
    writeFileSync(join(src, 'SKILL.MD'), text);
    const result = await installSkill(ports(), { kind: 'directory', path: src });
    expect(result.ok).toBe(true);
    expect(readdirSync(src)).toEqual(['SKILL.MD']);
    for (const base of ['user', 'kernel']) {
      const dest = join(root, base, 'skills', 'folder-coach');
      expect(readdirSync(dest)).toContain('SKILL.md');
      expect(readdirSync(dest)).not.toContain('SKILL.MD');
      expect(readFileSync(join(dest, 'SKILL.md'), 'utf8')).toBe(text);
    }
  });

  it('目录别名和元数据符号链接不会让安装回写来源文件', async () => {
    const src = join(root, 'source');
    mkdirSync(src);
    const original = join(root, 'original.md');
    const text = '\uFEFF---\nname: coach\ndescription: 工作教练\n---\n';
    writeFileSync(original, text);
    const marker = join(root, 'original-marker');
    writeFileSync(marker, '不能改写');
    symlinkSync(original, join(src, 'SKILL.md'));
    symlinkSync(marker, join(src, '.evowork-source'));
    const alias = join(root, 'alias');
    symlinkSync(src, alias, 'dir');
    expect((await installSkill(ports(), { kind: 'directory', path: alias })).ok).toBe(true);
    expect(readFileSync(original, 'utf8')).toBe(text);
    expect(readFileSync(marker, 'utf8')).toBe('不能改写');
    for (const base of ['user', 'kernel']) {
      const dest = join(root, base, 'skills', 'coach');
      expect(lstatSync(dest).isSymbolicLink()).toBe(base === 'kernel');
      expect(realpathSync(dest)).toBe(realpathSync(join(root, 'user', 'skills', 'coach')));
      expect(lstatSync(join(dest, 'SKILL.md')).isSymbolicLink()).toBe(false);
      expect(readFileSync(join(dest, 'SKILL.md'), 'utf8')).toBe(text.slice(1));
      expect(readFileSync(join(dest, '.evowork-source'), 'utf8')).toBe('local\n');
    }
  });

  it('卸载内核副本失败会恢复用户目录，重试成功后两边都移除', async () => {
    const p = ports();
    const src = join(root, 'src');
    writeSkill(src, 'coach');
    await installSkill(p, { kind: 'directory', path: src });
    const result = uninstallSkill(
      {
        ...p,
        renamePath: (from, to) => {
          if (from === join(root, 'kernel', 'skills', 'coach')) throw new Error('模拟卸载失败');
          p.renamePath(from, to);
        },
      },
      'coach',
    );
    expect(result.ok).toBe(false);
    for (const base of ['user', 'kernel'])
      expect(existsSync(join(root, base, 'skills', 'coach', 'SKILL.md'))).toBe(true);
    expect(uninstallSkill(p, 'coach').ok).toBe(true);
    for (const base of ['user', 'kernel'])
      expect(existsSync(join(root, base, 'skills', 'coach'))).toBe(false);
  });

  it('安装后修改技能名不能让卸载越出技能目录，也不会遗留原内核副本', async () => {
    const p = ports();
    const src = join(root, 'src');
    writeSkill(src, 'coach');
    await installSkill(p, { kind: 'directory', path: src });
    const outside = join(root, 'kernel', 'important.txt');
    writeFileSync(outside, '保留数据');
    writeFileSync(
      join(root, 'user', 'skills', 'coach', 'SKILL.md'),
      '---\nname: ../important.txt\ndescription: 工作教练\n---\n',
    );
    expect(uninstallSkill(p, '../important.txt').ok).toBe(true);
    expect(readFileSync(outside, 'utf8')).toBe('保留数据');
    for (const base of ['user', 'kernel'])
      expect(existsSync(join(root, base, 'skills', 'coach'))).toBe(false);
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
    const clonedPaths: string[] = [];
    const p = createFsCatalogPorts({
      pluginsDir: join(root, 'plugins'),
      userRoot: join(root, 'user'),
      kernelHome: join(root, 'kernel'),
      gitClone: async (url, dest) => {
        clonedPaths.push(dest);
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
    expect(clonedPaths.every((path) => !existsSync(path))).toBe(true);
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
    expect(config.replace(/\\\\/g, '/')).toMatch(
      /Resources\/plugins\/connectors\/browser\/server\.mjs/,
    );
    // 用户的选择（信任、逐工具权限）不动
    expect(config).toMatch(/approval_mode = "prompt"/);
    // 第二次没有变化，不写盘
    expect(refreshOfficialConnectors(p)).toBe(false);
  });
});
