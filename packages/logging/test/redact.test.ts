import { describe, expect, it } from 'vitest';

import { BodyFreeError, digest, errorFields, pathFields } from '../src/redact.js';

const WORKSPACE = '/Users/x/work/weekly';
const EVOWORK_HOME = '/Users/x/.evowork';

describe('pathFields —— 记类别与摘要，不记文件名', () => {
  it('文件名不出现在任何返回字段里（客户名经常就是文件名本身）', () => {
    const sensitive = `${WORKSPACE}/鹏程公司-2026Q2-逾期清单.xlsx`;
    const f = pathFields(sensitive, { workspaceRoots: [WORKSPACE], evoworkHome: EVOWORK_HOME });
    const serialized = JSON.stringify(f);
    expect(serialized).not.toContain('鹏程');
    expect(serialized).not.toContain('逾期');
    expect(f.pathKind).toBe('workspace');
    expect(f.extension).toBe('xlsx');
    expect(f.pathDigest).toMatch(/^[0-9a-f]{16}$/);
  });

  it('工作空间内的 uploads/ 单独归类（08 §3.5：由服务层写入，不是 agent 写的）', () => {
    const f = pathFields(`${WORKSPACE}/uploads/20260905-report/original.pdf`, {
      workspaceRoots: [WORKSPACE],
    });
    expect(f.pathKind).toBe('upload');
  });

  it('工作空间之外 → outside（10 §2.3 第二级：需逐次审批）', () => {
    const f = pathFields('/Users/x/Downloads/invoices/a.pdf', { workspaceRoots: [WORKSPACE] });
    expect(f.pathKind).toBe('outside');
  });

  it('硬拦截清单 → blocked（10 §2.3：对 danger-full-access 也生效）', () => {
    const cases = [
      '/Users/x/.ssh/id_ed25519',
      '/Users/x/.aws/credentials',
      '/System/Library/Frameworks/Foo',
      '/usr/bin/python3',
      '/Users/x/Library/Keychains/login.keychain-db',
      '/Users/x/Library/Application Support/Google/Chrome/Default/Cookies',
      `${EVOWORK_HOME}/config.toml`,
      `${EVOWORK_HOME}/requirements.toml`,
      'C:\\Windows\\System32\\cmd.exe',
    ];
    for (const p of cases) {
      expect(
        pathFields(p, { workspaceRoots: [WORKSPACE], evoworkHome: EVOWORK_HOME }).pathKind,
      ).toBe('blocked');
    }
  });

  it('硬拦截优先于工作空间归属 —— 把 .ssh 软链进工作空间也不放行', () => {
    const f = pathFields(`${WORKSPACE}/.ssh/id_rsa`, { workspaceRoots: [WORKSPACE] });
    expect(f.pathKind).toBe('blocked');
  });

  it('EvoWork 自己的目录（非配置文件）归 evowork 类', () => {
    const f = pathFields(`${EVOWORK_HOME}/library/notes.md`, {
      workspaceRoots: [WORKSPACE],
      evoworkHome: EVOWORK_HOME,
    });
    expect(f.pathKind).toBe('evowork');
  });

  it('畸形扩展名宁可不记也不记成畸形值', () => {
    expect(pathFields('/w/a.7z', { workspaceRoots: ['/w'] }).extension).toBeUndefined();
    expect(pathFields('/w/noext', { workspaceRoots: ['/w'] }).extension).toBeUndefined();
  });

  it('digest 稳定且不可读', () => {
    expect(digest('同一份文件')).toBe(digest('同一份文件'));
    expect(digest('a')).not.toBe(digest('b'));
    expect(digest('帮我写一份周报')).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('errorFields —— 不记 message 原文，不记 stack', () => {
  it('第三方错误把请求体 echo 进 message 时不泄露（Q14 第三条路径）', () => {
    const echoed = new Error(
      'Bad Request: {"messages":[{"role":"user","content":"帮我分析鹏程公司的逾期账款"}]}',
    );
    const f = errorFields(echoed);
    const serialized = JSON.stringify(f);
    expect(serialized).not.toContain('鹏程公司');
    expect(serialized).not.toContain('content');
    expect(f.errorClass).toBe('Error');
    expect(f.messageDigest).toMatch(/^[0-9a-f]{16}$/);
    expect(f.messageLength).toBe(echoed.message.length);
  });

  it('BodyFreeError 可以带自己的错误码（我们自己抛的，声明了不含正文）', () => {
    const f = errorFields(new BodyFreeError('upstream returned no choices', 'GW_EMPTY_CHOICES'));
    expect(f.errorClass).toBe('BodyFreeError');
    expect(f.errorCode).toBe('GW_EMPTY_CHOICES');
  });

  it('node 风格的 err.code 被保留（它是码不是文）', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1455'), {
      code: 'ECONNREFUSED',
    });
    expect(errorFields(err).errorCode).toBe('ECONNREFUSED');
  });

  it('非 Error 的 throw 也不泄露', () => {
    const f = errorFields({ requestBody: '帮我把这份合同改成三年期' });
    expect(JSON.stringify(f)).not.toContain('合同');
    expect(f.errorClass).toBe('NonError');
  });

  it('返回字段里没有 stack —— 堆栈第一行就是 message', () => {
    const f = errorFields(new Error('secret body here'));
    expect(Object.keys(f)).not.toContain('stack');
  });
});
