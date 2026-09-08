/**
 * `~/.evowork/gateway.env` 的**解析**（M10a 之后这个模块只剩解析）。
 *
 * 守两件事：
 *   ① 解析错或"不认的键漏进子进程"会让装好的 App 报「连不上模型网关」，
 *      而真正的原因隔着一层；
 *   ② **这个模块里不许再出现写盘函数** —— 见文件末尾那条。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { envHasProviderKey, parseGatewayEnv } from '../src/main/gateway-env.js';

describe('解析 gateway.env', () => {
  it('跳过注释和空行，接受 export 前缀与引号', () => {
    const parsed = parseGatewayEnv(`
# 这不是密钥
export DEEPSEEK_API_KEY="sk-a"
MOONSHOT_API_KEY='sk-b'
ZHIPU_API_KEY=sk-c

EVOWORK_GATEWAY_TOKEN=tok
`);
    expect(parsed).toEqual({
      DEEPSEEK_API_KEY: 'sk-a',
      MOONSHOT_API_KEY: 'sk-b',
      ZHIPU_API_KEY: 'sk-c',
      EVOWORK_GATEWAY_TOKEN: 'tok',
    });
  });

  it('不认的键丢掉 —— PORT 进子进程会盖掉按 base_url 算好的端口', () => {
    const parsed = parseGatewayEnv('PORT=9999\nDEEPSEEK_API_KEY=sk\nPATH=/tmp\n');
    expect(parsed).toEqual({ DEEPSEEK_API_KEY: 'sk' });
    expect(parsed.PORT).toBeUndefined();
  });

  it('空值不当成配好了', () => {
    expect(parseGatewayEnv('DEEPSEEK_API_KEY=\nMOONSHOT_API_KEY=   \n')).toEqual({});
  });
});

describe('有没有配密钥', () => {
  it('空白不算配了 —— 否则会起一个每次请求都 401 的网关', () => {
    expect(envHasProviderKey({ DEEPSEEK_API_KEY: '   ' })).toBe(false);
    expect(envHasProviderKey({ DEEPSEEK_API_KEY: 'sk' })).toBe(true);
  });
});

/*
 * ── Q34 的机制化：**这里不能再有写明文密钥的入口** ──
 *
 * 2026-09-08 删掉了三个写盘函数（`writeGatewayEnvKeys` / `ensureGatewayTokenFile` /
 * `tokenFromEnvFile`）。删它们的理由不是"没人调用"，而是留着就等于留着一条写明文
 * 密钥的路 —— 而 Q34=A 的整个意义是让那条路不存在。
 *
 * 这条断言扫源码而不是查导出：`export` 检查绕不过"内部写一下"这种写法，
 * 而真正要防的是**这个模块碰到磁盘**。
 */
describe('Q34：这个模块不写盘', () => {
  const source = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src/main/gateway-env.ts'),
    'utf8',
  );

  it('源码里没有任何写文件调用（密钥的家是钥匙串，不是这个文件）', () => {
    for (const forbidden of ['writeFileSync', 'appendFileSync', 'createWriteStream', 'chmodSync']) {
      expect(
        source,
        `gateway-env.ts 里出现了 ${forbidden} —— 明文密钥不该再有写入口`,
      ).not.toContain(forbidden);
    }
  });

  it('也没有自己签令牌（randomBytes）—— 签令牌是密钥库那一侧的事', () => {
    expect(source).not.toContain('randomBytes');
  });
});
