/**
 * 启动失败时给用户看的那句话（在线升级提案 §4 A1）。
 *
 * 此前打包后的应用遇到任何启动失败都是一闪就没，什么都不说。这里守两件事：
 * 用户能自己处理的失败要说清**该怎么做**；写给开发者的文案不许漏给用户。
 */
import { describe, expect, it } from 'vitest';

import { AuthoritativeMigrationFailed, SchemaNewerThanApp } from '@evowork/store';

import { describeStartupFailure } from '../src/main/startup-failure.js';

describe('describeStartupFailure', () => {
  it('库比应用新：说出该装哪一版，并说明这次没有动过数据', () => {
    const notice = describeStartupFailure(new SchemaNewerThanApp(4, 3, '0.0.9'), '0.0.4');
    expect(notice?.title).toBe('EvoWork 无法打开');
    expect(notice?.body).toContain('请安装 EvoWork 0.0.9 或更新的版本');
    expect(notice?.body).toContain('当前安装的 0.0.4');
    expect(notice?.body).toContain('没有做任何改动');
  });

  it('库里没记版本（来自加这个键之前）：仍然给出能照做的一步，而不是编一个版本号', () => {
    const notice = describeStartupFailure(new SchemaNewerThanApp(4, 3, undefined), '0.0.4');
    expect(notice?.body).toContain('请安装最新版本的 EvoWork');
    expect(notice?.body).not.toMatch(/EvoWork undefined/);
  });

  it('不认识的失败不编文案 —— 开发者文案（备份路径、设计文档章节号）不给用户看', () => {
    const devFacing = new AuthoritativeMigrationFailed(2, 3, '/x/evowork.db.bak.2', new Error());
    expect(describeStartupFailure(devFacing, '0.0.4')).toBeUndefined();
    expect(describeStartupFailure(new Error('ENOENT'), '0.0.4')).toBeUndefined();
  });
});
