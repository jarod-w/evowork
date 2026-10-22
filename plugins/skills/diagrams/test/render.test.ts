import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  EXIT,
  makeTempDir,
  parseFailure,
  removeDir,
  runPython,
  writeContent,
} from '../../_shared/test-helpers.js';

const RENDER = resolve(dirname(fileURLToPath(import.meta.url)), '../container_tools/render.py');

let dir: string;
beforeEach(() => {
  dir = makeTempDir('evowork-diagram-');
});
afterEach(() => removeDir(dir));

function run(content: unknown, out: string) {
  return runPython(RENDER, ['--content', writeContent(dir, content), '--out', join(dir, out)]);
}

const FLOW = {
  diagram: 'flowchart',
  title: '报销流程',
  nodes: [
    { id: 'submit', text: '提交' },
    { id: 'approve', text: '审批' },
    { id: 'pay', text: '付款' },
  ],
  edges: [
    { from: 'submit', to: 'approve' },
    { from: 'approve', to: 'pay' },
  ],
};

describe('图示只画三种结构', () => {
  it('流程图 svg 含有每个节点，且不是统计图', () => {
    expect(run(FLOW, 'flow.svg').status).toBe(EXIT.ok);
    const svg = readFileSync(join(dir, 'flow.svg'), 'utf8');
    expect(svg).toContain('<svg');
    expect(svg).toContain('提交');
    expect(svg).toContain('审批');
    expect(svg).toContain('付款');
  });

  it('连到不存在的节点时拒绝', () => {
    const result = run({ ...FLOW, edges: [{ from: 'submit', to: 'missing' }] }, 'bad.svg');
    expect(result.status).toBe(EXIT.invalidContent);
    expect(parseFailure(result.stderr).message).toContain('已有节点');
    expect(result.stderr).not.toContain('报销流程');
  });

  it('组织关系把下级画出来', () => {
    const result = run(
      {
        diagram: 'org',
        title: '财务部',
        root: { text: '财务总监', children: [{ text: '会计' }, { text: '出纳' }] },
      },
      'org.svg',
    );
    expect(result.status).toBe(EXIT.ok);
    const svg = readFileSync(join(dir, 'org.svg'), 'utf8');
    expect(svg).toContain('财务总监');
    expect(svg).toContain('会计');
    expect(svg).toContain('出纳');
  });

  it('排期结束早于开始时拒绝', () => {
    const result = run(
      {
        diagram: 'gantt',
        title: '上线',
        rows: [{ name: '方案', start: '2026-09-05', end: '2026-09-01' }],
      },
      'gantt.svg',
    );
    expect(result.status).toBe(EXIT.invalidContent);
    expect(parseFailure(result.stderr).message).toContain('结束日');
  });

  it('不接受柱状图', () => {
    expect(run({ diagram: 'bar', title: '营收' }, 'bar.svg').status).toBe(EXIT.invalidContent);
  });

  it('节点超过上限时拒绝，不写出截断后的图', () => {
    const nodes = Array.from({ length: 25 }, (_, index) => ({
      id: `n${index}`,
      text: `步骤${index}`,
    }));
    const result = run(
      {
        diagram: 'flowchart',
        title: '太长的流程',
        nodes,
        edges: [{ from: 'n0', to: 'n1' }],
      },
      'too-many.svg',
    );
    expect(result.status).toBe(EXIT.invalidContent);
    expect(parseFailure(result.stderr).message).toContain('24');
    expect(existsSync(join(dir, 'too-many.svg'))).toBe(false);
  });

  it('组织关系超过 4 层时拒绝', () => {
    const result = run(
      {
        diagram: 'org',
        title: '层级',
        root: {
          text: '一层',
          children: [
            {
              text: '二层',
              children: [
                { text: '三层', children: [{ text: '四层', children: [{ text: '五层' }] }] },
              ],
            },
          ],
        },
      },
      'deep.svg',
    );
    expect(result.status).toBe(EXIT.invalidContent);
    expect(parseFailure(result.stderr).message).toContain('4');
    expect(existsSync(join(dir, 'deep.svg'))).toBe(false);
  });

  it('排期跨度超过 366 天时拒绝', () => {
    const result = run(
      {
        diagram: 'gantt',
        title: '长计划',
        rows: [{ name: '全程', start: '2026-01-01', end: '2027-01-02' }],
      },
      'long.svg',
    );
    expect(result.status).toBe(EXIT.invalidContent);
    expect(parseFailure(result.stderr).message).toContain('366');
    expect(existsSync(join(dir, 'long.svg'))).toBe(false);
  });

  it('没有中文时 png 不依赖中文字体', () => {
    const result = runPython(
      RENDER,
      [
        '--content',
        writeContent(dir, {
          diagram: 'flowchart',
          title: 'Pay',
          nodes: [
            { id: 'a', text: 'Send' },
            { id: 'b', text: 'Done' },
          ],
          edges: [{ from: 'a', to: 'b' }],
        }),
        '--out',
        join(dir, 'flow.png'),
      ],
      { EVOWORK_CJK_FONT: '/nonexistent/evowork-cjk.ttf' },
    );
    expect(result.status, result.stderr).toBe(EXIT.ok);
    expect(readFileSync(join(dir, 'flow.png')).subarray(0, 4)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
  });

  it('没有中文字体时不写出含中文的 png', () => {
    const result = runPython(
      RENDER,
      ['--content', writeContent(dir, FLOW), '--out', join(dir, 'flow.png')],
      { EVOWORK_CJK_FONT: '/nonexistent/evowork-cjk.ttf' },
    );
    expect(result.status).toBe(EXIT.runtimeMissing);
    expect(parseFailure(result.stderr).message).toContain('中文字体');
    expect(existsSync(join(dir, 'flow.png'))).toBe(false);
    expect(result.stderr).not.toContain('报销流程');
  });
});
