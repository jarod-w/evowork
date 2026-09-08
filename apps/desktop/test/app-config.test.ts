/**
 * `app.toml`：mode 是权威，上游 URL 由它派生（11 §3.2）。
 *
 * 盯的是「用 URL 反推拓扑」会在企业私有形态下判错 —— 表现是一个 401，
 * 而真正的网关在别人的机器上。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_APP_CONFIG,
  ensureAppConfig,
  inferModeFromKernelBaseUrl,
  parseAppToml,
  writeAppConfig,
  writeSecretFallback,
} from '../src/main/app-config.js';

describe('parseAppToml', () => {
  it('缺段缺键退到 local，不抛', () => {
    expect(parseAppToml('')).toEqual(DEFAULT_APP_CONFIG);
    expect(parseAppToml('[other]\nmode = "hosted"\n').gateway.mode).toBe('local');
  });

  it('非法 mode 不当成 hosted —— 猜错会去找还不存在的 identity', () => {
    expect(parseAppToml('[gateway]\nmode = "cloud"\n').gateway.mode).toBe('local');
  });

  it('读到的就是写进去的', () => {
    const parsed = parseAppToml(`
[gateway]
mode = "private"
upstream_base_url = "https://gw.corp.example/v1"
`);
    expect(parsed.gateway).toEqual({
      mode: 'private',
      upstreamBaseUrl: 'https://gw.corp.example/v1',
    });
  });
});

describe('一次性 URL 反推', () => {
  it('环回地址 → local，不把 loopback 写进 upstream', () => {
    expect(inferModeFromKernelBaseUrl('http://127.0.0.1:8787/v1')).toEqual({
      mode: 'local',
      upstreamBaseUrl: '',
    });
    expect(inferModeFromKernelBaseUrl('http://localhost:8787/v1')).toEqual({
      mode: 'local',
      upstreamBaseUrl: '',
    });
  });

  it('非环回 → private（保留 staticTokenAuth，不要求我们的账号）', () => {
    expect(inferModeFromKernelBaseUrl('https://gw.corp.example/v1')).toEqual({
      mode: 'private',
      upstreamBaseUrl: 'https://gw.corp.example/v1',
    });
  });
});

describe('ensureAppConfig 只反推一次', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ew-app-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('没有文件时按内核 base_url 写一份，再读不再推断', () => {
    const path = join(dir, 'app.toml');
    const first = ensureAppConfig(path, 'https://gw.corp.example/v1');
    expect(first.written).toBe(true);
    expect(first.config.gateway.mode).toBe('private');

    writeFileSync(path, '[gateway]\nmode = "local"\nupstream_base_url = ""\n');
    const second = ensureAppConfig(path, 'https://gw.corp.example/v1');
    expect(second.written).toBe(false);
    expect(second.config.gateway.mode).toBe('local');
  });

  it('密钥库兜底选择写进文件，下次启动不再问', () => {
    const path = join(dir, 'app.toml');
    writeAppConfig(path, DEFAULT_APP_CONFIG);
    const next = writeSecretFallback(path, 'plaintext');
    expect(next.secrets?.fallback).toBe('plaintext');
    expect(readFileSync(path, 'utf8')).toContain('fallback = "plaintext"');
    expect(existsSync(path)).toBe(true);
  });
});
