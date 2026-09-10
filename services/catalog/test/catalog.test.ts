import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { auditSkillFiles, riskLabel } from '../src/audit.js';
import {
  BROWSER_CONNECTOR_ID,
  CONNECTOR_CAPTION,
  mergeConnectors,
  parseConnectorStore,
  patchMcpServersToml,
  removeConnector,
  trustConnector,
  upsertConnector,
} from '../src/connectors.js';
import { listApps } from '../src/apps.js';
import { listExperts, parseAgentToml, renderAgentToml } from '../src/agents.js';
import { filterSkills, listSkills, parseFrontmatter, rotateFeatured } from '../src/skills.js';
import { nodeCatalogIo } from './io-helper.js';

describe('审计会红的输入（05 §3.3）', () => {
  it('空目录是 P2：能力面未知，不是低风险', () => {
    const result = auditSkillFiles([]);
    expect(result.level).toBe('p2');
    expect(result.worstCase).toMatch(/无法判断/);
  });

  it('只有 SKILL.md 说明文字、没有脚本 → P0', () => {
    const result = auditSkillFiles([
      {
        relativePath: 'SKILL.md',
        text: '---\nname: note\ndescription: 只读说明\n---\n抄一段模板。',
      },
    ]);
    expect(result.level).toBe('p0');
    expect(result.worstCase).toBeUndefined();
  });

  it('含 render.py → P1（会执行命令），不是 P0', () => {
    const result = auditSkillFiles([
      { relativePath: 'SKILL.md', text: '---\nname: documents\n---\npython3 render.py' },
      { relativePath: 'container_tools/render.py', text: 'print("hi")' },
    ]);
    expect(result.level).toBe('p1');
    expect(result.findings.some((f) => f.code === 'commands')).toBe(true);
  });

  it('hooks.json → P2，并写清最坏能做什么', () => {
    const result = auditSkillFiles([
      { relativePath: 'SKILL.md', text: '---\nname: spy\n---\n' },
      { relativePath: 'hooks.json', text: '{}' },
    ]);
    expect(result.level).toBe('p2');
    expect(result.worstCase).toMatch(/工具调用/);
    expect(result.findings.some((f) => f.detail.includes('拦截'))).toBe(true);
  });

  it('提到 ~/.ssh → P2（工作空间外路径）', () => {
    const result = auditSkillFiles([
      { relativePath: 'SKILL.md', text: '把密钥写到 ~/.ssh/id_rsa' },
    ]);
    expect(result.level).toBe('p2');
    expect(result.findings.some((f) => f.code === 'outside-workspace')).toBe(true);
  });

  it('danger-full-access → P2', () => {
    const result = auditSkillFiles([
      { relativePath: 'SKILL.md', text: 'permissions: danger-full-access' },
    ]);
    expect(result.level).toBe('p2');
  });

  it('riskLabel 与级别一一对应', () => {
    expect(riskLabel('p0')).toBe('低风险');
    expect(riskLabel('p1')).toBe('需注意');
    expect(riskLabel('p2')).toBe('高风险');
  });
});

describe('技能扫描', () => {
  it('只把有 SKILL.md 的目录当成技能，跳过 _shared', () => {
    const root = mkdtempSync(join(tmpdir(), 'ew-skills-'));
    mkdirSync(join(root, 'documents'));
    writeFileSync(
      join(root, 'documents', 'SKILL.md'),
      '---\nname: documents\ndescription: 生成文档\n---\n',
    );
    writeFileSync(
      join(root, 'documents', 'interface.json'),
      '{"displayName":"文档","category":"办公","defaultPrompt":"写一份报告"}\n',
    );
    mkdirSync(join(root, '_shared'));
    writeFileSync(join(root, '_shared', 'SKILL.md'), '---\nname: shared\n---\n');
    const user = mkdtempSync(join(tmpdir(), 'ew-uskills-'));
    const skills = listSkills({ official: root, user }, nodeCatalogIo);
    expect(skills.map((s) => s.id)).toEqual(['documents']);
    expect(skills[0]?.interface.displayName).toBe('文档');
    expect(skills[0]?.source).toBe('official');
    expect(skills[0]?.installed).toBe(true);
  });

  it('搜索与已安装筛选断的是可见集合，不是中间字段', () => {
    const skills = listSkills(
      { official: '/nope', user: '/nope' },
      {
        readDir: () => [],
        readText: () => undefined,
        listFiles: () => [],
      },
    );
    expect(filterSkills(skills, '文档', { installedOnly: true })).toEqual([]);
  });

  it('换一换从精选池里取 3 个并循环', () => {
    const featured = [0, 1, 2, 3].map((i) => ({
      id: `s${i}`,
      path: `/s${i}`,
      name: `S${i}`,
      description: '',
      source: 'official' as const,
      installed: true,
      featured: true,
      interface: { displayName: `S${i}`, category: '办公' },
      audit: { level: 'p0' as const, findings: [] },
    }));
    expect(rotateFeatured(featured, 0).map((s) => s.id)).toEqual(['s0', 's1', 's2']);
    expect(rotateFeatured(featured, 1).map((s) => s.id)).toEqual(['s1', 's2', 's3']);
  });

  it('用户目录里的 .evowork-source=git 显示为 Git，不是本地目录', () => {
    const official = mkdtempSync(join(tmpdir(), 'ew-off-'));
    const user = mkdtempSync(join(tmpdir(), 'ew-git-'));
    mkdirSync(join(user, 'from-git'));
    writeFileSync(
      join(user, 'from-git', 'SKILL.md'),
      '---\nname: from-git\ndescription: 从仓库来\n---\n',
    );
    writeFileSync(join(user, 'from-git', '.evowork-source'), 'git\n');
    const skills = listSkills({ official, user }, nodeCatalogIo);
    expect(skills[0]?.source).toBe('git');
  });

  it('parseFrontmatter 读 name / description', () => {
    expect(parseFrontmatter('---\nname: charts\ndescription: 画图\n---\n正文')).toEqual({
      name: 'charts',
      description: '画图',
    });
  });
});

describe('连接器目录', () => {
  it('空仓库仍列出官方 browser，且未信任', () => {
    const list = mergeConnectors(parseConnectorStore(undefined), {
      command: 'node',
      args: ['/app/browser.mjs'],
    });
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(BROWSER_CONNECTOR_ID);
    expect(list[0]?.trusted).toBe(false);
    expect(list[0]?.status).toBe('untrusted');
  });

  it('信任之后才算已装应用', () => {
    const store = parseConnectorStore(undefined);
    const before = mergeConnectors(store, { command: 'node', args: ['b'] });
    expect(listApps([], before)).toEqual([]);
    const trusted = trustConnector(
      upsertConnector(store, {
        id: BROWSER_CONNECTOR_ID,
        name: '浏览器',
        kind: 'official',
        transport: 'stdio',
        command: 'node',
        args: ['b'],
        trusted: false,
        toolPolicy: {},
      }),
      BROWSER_CONNECTOR_ID,
    );
    const after = mergeConnectors(trusted, { command: 'node', args: ['b'] });
    expect(after[0]?.trusted).toBe(true);
    expect(listApps([], after).map((a) => a.id)).toEqual(['connector:browser']);
  });

  it('卸掉自定义连接器是真删；卸 browser 只取消信任', () => {
    let store = parseConnectorStore(
      JSON.stringify({
        connectors: [
          {
            id: 'browser',
            name: '浏览器',
            kind: 'official',
            transport: 'stdio',
            trusted: true,
            toolPolicy: {},
          },
          {
            id: 'mine',
            name: '我的',
            kind: 'custom',
            transport: 'stdio',
            trusted: true,
            toolPolicy: {},
          },
        ],
      }),
    );
    store = removeConnector(store, 'mine');
    expect(store.connectors.map((c) => c.id)).toEqual(['browser']);
    store = removeConnector(store, 'browser');
    expect(store.connectors.find((c) => c.id === 'browser')?.trusted).toBe(false);
  });

  it('patchMcpServersToml 用标记围住，再写不会堆两份', () => {
    const once = patchMcpServersToml('model = "x"\n', [
      { id: 'browser', transport: 'stdio', command: 'node', args: ['/b.mjs'] },
    ]);
    expect(once).toMatch(/mcp_servers\.browser/);
    const twice = patchMcpServersToml(once, [
      { id: 'browser', transport: 'stdio', command: 'node', args: ['/b.mjs'] },
    ]);
    expect(twice.split('[mcp_servers.browser]')).toHaveLength(2);
  });

  it('页面文案不虚构官方目录', () => {
    expect(CONNECTOR_CAPTION).toMatch(/官方连接器目录将在后续版本提供/);
  });
});

describe('专家 TOML', () => {
  it('缺 name 的文件不当成专家', () => {
    expect(parseAgentToml('description = "x"\n', '/a.toml', 'local')).toBeUndefined();
  });

  it('写出去的 TOML 能读回来', () => {
    const text = renderAgentToml({
      name: '财务分析专家',
      description: '看报表',
      category: '投资理财',
      sampleTasks: ['解读这份财报', '做一份预算表'],
      instructions: '用中文回答',
    });
    const parsed = parseAgentToml(text, '/finance.toml', 'local');
    expect(parsed?.name).toBe('财务分析专家');
    expect(parsed?.interface.sampleTasks).toEqual(['解读这份财报', '做一份预算表']);
    expect(parsed?.instructions).toBe('用中文回答');
  });

  it('官方目录空时列表为空，不是一份假专家', () => {
    const root = mkdtempSync(join(tmpdir(), 'ew-agents-'));
    expect(listExperts({ official: root, user: join(root, 'none') }, nodeCatalogIo)).toEqual([]);
  });
});
