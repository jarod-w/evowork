/**
 * `~/.evowork/gateway.env` 的读写。
 *
 * 守的是「从访达启动也能拿到密钥」这件事：文件解析错、不认的键漏进子进程、
 * 覆盖写入把另一家的密钥抹掉，三种都会让装好的 App 报「连不上模型网关」，
 * 而真正的原因隔着一层。
 */
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ensureGatewayTokenFile,
  envHasProviderKey,
  mergeGatewayEnv,
  parseGatewayEnv,
  readGatewayEnvFile,
  tokenFromEnvFile,
  writeGatewayEnvKeys,
} from '../src/main/gateway-env.js';

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

describe('合并：进程环境优先，文件补缺', () => {
  it('从访达启动时进程环境是空的，文件就是唯一来源', () => {
    const merged = mergeGatewayEnv({ DEEPSEEK_API_KEY: 'from-file' }, {});
    expect(merged.DEEPSEEK_API_KEY).toBe('from-file');
  });

  it('终端里已经 export 的不被文件盖掉（dotenv 同一条）', () => {
    const merged = mergeGatewayEnv(
      { DEEPSEEK_API_KEY: 'from-file' },
      { DEEPSEEK_API_KEY: 'from-shell' },
    );
    expect(merged.DEEPSEEK_API_KEY).toBe('from-shell');
  });
});

describe('写回时不抹掉没改的那一家', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'evowork-env-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('只填 DeepSeek 时 Kimi 的已有密钥还在', () => {
    const path = join(dir, 'gateway.env');
    writeFileSync(path, 'MOONSHOT_API_KEY=keep-me\nDEEPSEEK_API_KEY=old\n', 'utf8');
    writeGatewayEnvKeys(path, { DEEPSEEK_API_KEY: 'new' });
    const next = readGatewayEnvFile(path);
    expect(next.DEEPSEEK_API_KEY).toBe('new');
    expect(next.MOONSHOT_API_KEY).toBe('keep-me');
  });

  it('空字符串不覆盖 —— 三个框只填了一个时另外两家不该变成空', () => {
    const path = join(dir, 'gateway.env');
    writeGatewayEnvKeys(path, { DEEPSEEK_API_KEY: 'sk' });
    writeGatewayEnvKeys(path, { MOONSHOT_API_KEY: '' });
    expect(readGatewayEnvFile(path)).toEqual({ DEEPSEEK_API_KEY: 'sk' });
  });

  it('写完是 600：从访达启动的密钥文件不能被同机其他用户读', () => {
    const path = join(dir, 'gateway.env');
    writeGatewayEnvKeys(path, { DEEPSEEK_API_KEY: 'sk' });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe('本机访问令牌：没有就签一个', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'evowork-tok-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('已有令牌不改写 —— 企业可能已经配过', () => {
    const path = join(dir, 'gateway-token');
    const result = ensureGatewayTokenFile(path, 'already');
    expect(result).toEqual({ token: 'already', minted: false });
    expect(readGatewayEnvFile(path)).toEqual({});
  });

  it('没有就写下文件，下次读到同一个', () => {
    const path = join(dir, 'gateway-token');
    const first = ensureGatewayTokenFile(path, undefined);
    expect(first.minted).toBe(true);
    expect(first.token.length).toBeGreaterThan(16);
    const again = ensureGatewayTokenFile(path, first.token);
    expect(again).toEqual({ token: first.token, minted: false });
  });

  it('文件里的 EVOWORK_GATEWAY_TOKENS 取第一个', () => {
    expect(tokenFromEnvFile({ EVOWORK_GATEWAY_TOKENS: 'a,b' })).toBe('a');
    expect(tokenFromEnvFile({ EVOWORK_GATEWAY_TOKEN: 'one' })).toBe('one');
  });
});

describe('有没有配密钥', () => {
  it('空白不算配了 —— 否则会起一个每次请求都 401 的网关', () => {
    expect(envHasProviderKey({ DEEPSEEK_API_KEY: '   ' })).toBe(false);
    expect(envHasProviderKey({ DEEPSEEK_API_KEY: 'sk' })).toBe(true);
    expect(envHasProviderKey({ EVOWORK_MODEL_KEY_evowork_my_llama: 'sk' })).toBe(true);
    expect(envHasProviderKey({ EVOWORK_MODEL_KEY_evowork_my_llama: '  ' })).toBe(false);
  });
});
