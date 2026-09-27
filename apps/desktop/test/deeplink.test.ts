/**
 * `evowork://` 深链（02 §8）。
 *
 * 断言写**后果**：
 *   · 解析结果里出现能装内容的字段 = 规则 1 破了，链接可以夹带文件
 *   · `prompt` 被当成"要发送的东西" = 一条外部链接能直接触发执行（规则 2）
 *   · 找不到时回空 = 用户看到空白页，以为程序坏了（规则 3）
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { deeplinkFromArgv, parseDeeplink, resolveDeeplink } from '../src/main/deeplink.js';

const ALL_PRESENT = {
  hasTask: () => true,
  hasAutomation: () => true,
  hasArtifact: () => true,
  hasShare: () => true,
};

const NONE_PRESENT = {
  hasTask: () => false,
  hasAutomation: () => false,
  hasArtifact: () => false,
  hasShare: () => false,
};

describe('解析五条路由（02 §8）', () => {
  it.each([
    ['evowork://task/thr_1', { kind: 'task', threadId: 'thr_1' }],
    ['evowork://automation/auto_1', { kind: 'automation', automationId: 'auto_1' }],
    ['evowork://library/art_1', { kind: 'library', nodeId: 'art_1' }],
    ['evowork://share/shr_1', { kind: 'share', shareId: 'shr_1' }],
  ])('%s', (raw, expected) => {
    const out = parseDeeplink(raw);
    expect(out.ok && out.target).toMatchObject(expected);
  });

  it('三斜线形式也认 —— 有的系统会把 host 递成空', () => {
    expect(parseDeeplink('evowork:///task/thr_1')).toMatchObject({
      ok: true,
      target: { kind: 'task', threadId: 'thr_1' },
    });
  });

  it('别的 scheme 一律不认', () => {
    expect(parseDeeplink('https://evil.example/task/x').ok).toBe(false);
    expect(parseDeeplink('file:///etc/passwd').ok).toBe(false);
    expect(parseDeeplink('不是链接').ok).toBe(false);
  });

  it('认不出来时给**具体**原因，不是一句"打不开"', () => {
    const out = parseDeeplink('evowork://whatever/x');
    expect(out.ok).toBe(false);
    expect(!out.ok && out.reason).toContain('whatever');
  });

  it('解析出来的 id 里永远不含分隔符 —— 它会被拿去查库、拼路由', () => {
    // `..` 在这里不是漏洞：URL 解析会先把它规范化掉，剩下的只是一个查不到的 id。
    // 真正要挡的是**编码过的分隔符**，它绕得过 split
    expect(parseDeeplink('evowork://library/a%2Fb').ok).toBe(false);
    expect(parseDeeplink('evowork://task/a%5Cb').ok).toBe(false);
    expect(parseDeeplink('evowork://task/').ok).toBe(false);

    const normalized = parseDeeplink('evowork://task/../../etc');
    // 规范化之后它是一个普通 id，查不到 —— 下面「未知 ID」那组负责它的去向
    expect(normalized.ok && normalized.target).toMatchObject({ kind: 'task', threadId: 'etc' });
    if (normalized.ok && normalized.target.kind === 'task') {
      expect(normalized.target.threadId).not.toMatch(/[/\\]/);
    }
  });
});

describe('规则 2：prompt 只写入 Composer，不自动发送', () => {
  it('字段叫 prefill，不叫 prompt', () => {
    const out = parseDeeplink('evowork://home?scenario=office&prompt=%E5%86%99%E5%91%A8%E6%8A%A5');
    expect(out.ok).toBe(true);
    if (!out.ok || out.target.kind !== 'home') throw new Error('应当解析成 home');
    expect(out.target.prefill).toBe('写周报');
    expect(out.target.scenario).toBe('office');
    // 名字本身就是这条规则最便宜的守卫
    expect(Object.keys(out.target)).not.toContain('prompt');
  });

  it('源码里没有把 prefill 接到发送上的名字', () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../src/main/deeplink.ts'),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '');
    expect(src).not.toMatch(/\bsend\s*\(/);
    expect(src).not.toMatch(/autoSend|submit/i);
  });

  it('超长提示词被截断 —— 外部链接不该能往 Composer 灌一本书', () => {
    const out = parseDeeplink(`evowork://home?prompt=${'a'.repeat(9000)}`);
    if (!out.ok || out.target.kind !== 'home') throw new Error('应当解析成 home');
    expect(out.target.prefill?.length).toBe(4000);
  });

  it('怪场景名不放行，但不因此丢掉整条链接', () => {
    const out = parseDeeplink('evowork://home?scenario=../../x&prompt=hi');
    if (!out.ok || out.target.kind !== 'home') throw new Error('应当解析成 home');
    expect(out.target.scenario).toBeUndefined();
    expect(out.target.prefill).toBe('hi');
  });
});

describe('规则 1：不携带任何文件内容', () => {
  it('解析结果的类型里没有能装内容的字段', () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../src/main/deeplink.ts'),
      'utf8',
    );
    const start = src.indexOf('export type DeeplinkTarget');
    const block = src.slice(start, src.indexOf('export type DeeplinkParse'));
    for (const forbidden of ['content', 'bytes', 'path', 'body', 'file']) {
      expect(block.toLowerCase(), `DeeplinkTarget 出现了 ${forbidden}`).not.toMatch(
        new RegExp(`readonly ${forbidden}`, 'i'),
      );
    }
  });
});

describe('规则 3：未知 ID 给明确错误，不是空白页', () => {
  it('任务不在本机时说清是"可能创建于其他设备"', () => {
    const out = resolveDeeplink('evowork://task/thr_x', NONE_PRESENT);
    expect(out.ok).toBe(false);
    expect(!out.ok && out.reason).toContain('其他设备');
  });

  it('分享的产物不在本机时，把人指回网页上的下载', () => {
    const out = resolveDeeplink('evowork://share/shr_x', NONE_PRESENT);
    expect(out.ok).toBe(false);
    // 点这个按钮的多半是**接收方**，他本机当然没有这份产物
    expect(!out.ok && out.reason).toContain('下载');
  });

  it('资料不在本机时说清分享的文件不会自动同步过来（D6 / Q17）', () => {
    const out = resolveDeeplink('evowork://library/art_x', NONE_PRESENT);
    expect(!out.ok && out.reason).toContain('不会自动同步');
  });

  it('本机有就放行', () => {
    expect(resolveDeeplink('evowork://task/thr_1', ALL_PRESENT).ok).toBe(true);
    expect(resolveDeeplink('evowork://share/shr_1', ALL_PRESENT).ok).toBe(true);
  });

  it('home 不需要查任何东西', () => {
    expect(resolveDeeplink('evowork://home?prompt=hi', NONE_PRESENT).ok).toBe(true);
  });
});

describe('从命令行参数里挑深链（Windows / Linux）', () => {
  it('挑出 scheme 那一个，忽略 electron 自己的开关与入口路径', () => {
    expect(
      deeplinkFromArgv([
        '/Applications/EvoWork.app/Contents/MacOS/EvoWork',
        '--no-sandbox',
        'evowork://task/thr_1',
      ]),
    ).toBe('evowork://task/thr_1');
  });

  it('没有就是没有', () => {
    expect(deeplinkFromArgv(['/app/EvoWork', '--inspect'])).toBeUndefined();
  });
});

/**
 * 冷启动为什么不能推（`service-host.ts` 的 `pendingDeeplink`）。
 *
 * 这一组守的是一个**看不见的**失败：冷启动那一刻 React 还没挂载、还没订阅事件，
 * `webContents.send` 推过去就丢了 —— 用户那一侧是"点了链接什么都没发生"，
 * 而日志里一切正常。所以冷启动走拉，热路径走推。
 */
describe('冷启动走拉、热路径走推', () => {
  it('bootstrap 冷启动那一次调的是 queueDeeplink，不是 send', () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../src/main/bootstrap.ts'),
      'utf8',
    );
    // 冷启动那一行显式传了 cold=true
    expect(src).toMatch(/handleDeeplink\(deeplinkFromArgv\(process\.argv\),\s*true\)/);
    // 而 cold 那一支走 queue
    expect(src).toMatch(/if \(cold\)[\s\S]{0,400}host\.queueDeeplink\(delivery\)/);
  });

  it('领一次就没了 —— 不清掉的话热重载会让它反复触发', () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../src/main/service-host.ts'),
      'utf8',
    );
    expect(src).toMatch(/pendingDeeplink = undefined;/);
  });
});
