/**
 * 账号页有密码框；管理端看不到内容面；没有分享页（Q41 跟分享上传同一切片）。
 *
 * 断言写**后果**：改密之后还能进管理端、401 之后按钮还能用、撤销之前必须确认。
 * 这些都是"改掉它就破坏了某条决策"的地方，不是形状快照。
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { App, routeOf } from '../src/app.js';
import {
  api,
  auditToCsv,
  formatQuota,
  parsePkce,
  passwordStrength,
  readSession,
  writeSession,
} from '../src/api.js';
import { buildDiff } from '../src/screens/admin-policy.js';

const ADMIN_SESSION = {
  accessToken: 't',
  refreshToken: 'r',
  role: 'admin' as const,
  mustChangePassword: false,
};

/** 按路径路由的 fetch 假体。没列到的路径返回空集合，不是 404 —— 免得空态与错误态混淆。 */
function mockApi(routes: Record<string, unknown>, status: Record<string, number> = {}) {
  const fetchMock = vi.mocked(fetch);
  fetchMock.mockImplementation(async (input) => {
    const url = new URL(String(input), 'http://x');
    const path = url.pathname;
    const code = status[path] ?? 200;
    const body = routes[path] ?? EMPTY;
    return new Response(JSON.stringify(body), { status: code });
  });
  return fetchMock;
}

const EMPTY = {
  members: [],
  invites: [],
  models: [],
  classes: [],
  events: [],
  devices: [],
  current: null,
  history: [],
  stale: [],
  total: 0,
  pulled: 0,
  tenantUsed: 0,
  used: 0,
  limit: 0,
  role: 'admin',
  mustChangePassword: false,
  tenantId: 'ten_1',
  warnMember: true,
  warnPercent: 80,
  warnAdmin: true,
  warnOptOut: false,
};

describe('路由', () => {
  it('没有分享页路径（Q41 跟分享上传同一切片）', () => {
    expect(routeOf('/s/abc')).toBe('/s/abc');
    render(<App initialPath="/s/abc" />);
    expect(screen.queryByText(/下载/)).toBeNull();
    expect(screen.getByRole('heading', { name: '登录 EvoWork' })).toBeTruthy();
  });
});

describe('登录表单', () => {
  it('密码框在 WEB 上（Q32=B / Q33=A）', () => {
    render(<App initialPath="/signin" />);
    expect((screen.getByLabelText('密码') as HTMLInputElement).type).toBe('password');
  });

  it('登录页把三条对外承诺摆在门面上，不藏在登录之后', () => {
    render(<App initialPath="/signin" />);
    expect(screen.getByText(/任务和产物在你的电脑上/)).toBeTruthy();
    expect(screen.getByText(/结构上看不到/)).toBeTruthy();
    expect(screen.getByText(/不登录也能用/)).toBeTruthy();
  });

  it('PKCE 回调只接受 loopback redirect_uri', () => {
    expect(
      parsePkce('?code_challenge=abc&redirect_uri=http://evil.example/cb&state=s&device_id=dev'),
    ).toBeUndefined();
    expect(
      parsePkce(
        '?code_challenge=abc&redirect_uri=http://127.0.0.1:4390/callback&state=s&device_id=dev',
      ),
    ).toMatchObject({ deviceId: 'dev', redirectUri: 'http://127.0.0.1:4390/callback' });
  });

  it('PKCE 登录页说清这次登录是为桌面版做的', () => {
    render(
      <App
        initialPath="/signin"
        initialSearch="?code_challenge=abc&redirect_uri=http://127.0.0.1:4390/cb&state=s&device_id=dev"
      />,
    );
    expect(screen.getByText(/EvoWork 桌面版/)).toBeTruthy();
  });
});

describe('access 令牌续期（15 分钟那个缺陷）', () => {
  it('401 先续期再重放原请求，调用方看不到失败', async () => {
    writeSession(ADMIN_SESSION);
    const fetchMock = vi.mocked(fetch);
    let quotaCalls = 0;
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/v1/oauth/token')) {
        return new Response(JSON.stringify({ accessToken: 't2', refreshToken: 'r2' }), {
          status: 200,
        });
      }
      if (url.endsWith('/v1/quota')) {
        quotaCalls += 1;
        if (quotaCalls === 1) {
          return new Response(JSON.stringify({ error: { message: '过期', code: 'expired' } }), {
            status: 401,
          });
        }
        const auth = new Headers(init?.headers).get('authorization');
        return new Response(JSON.stringify({ used: 1, limit: 2, auth }), { status: 200 });
      }
      return new Response(JSON.stringify(EMPTY), { status: 200 });
    });

    const out = await api<{ used: number; auth: string }>('/v1/quota');
    expect(out.ok).toBe(true);
    // 重放那一次带的是**新**令牌；带旧的等于白续
    expect(out.ok && out.data.auth).toBe('Bearer t2');
    expect(readSession()?.accessToken).toBe('t2');
    expect(quotaCalls).toBe(2);
  });

  it('续不上才算真过期：清会话并广播，不是静默的「请求失败」', async () => {
    writeSession(ADMIN_SESSION);
    mockApi({}, { '/v1/quota': 401, '/v1/oauth/token': 401 });
    const out = await api('/v1/quota');
    expect(out.ok).toBe(false);
    expect(!out.ok && out.error.code).toBe('session-expired');
    expect(readSession()).toBeUndefined();
  });

  it('续不上时页面弹「登录已过期」，而不是让每个按钮各自变成失败', async () => {
    writeSession({ ...ADMIN_SESSION, role: 'member' });
    mockApi({}, { '/v1/quota': 401, '/v1/devices': 401, '/v1/oauth/token': 401 });
    render(<App initialPath="/account" />);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '登录已过期' })).toBeTruthy();
    });
    expect(screen.getByText('重新登录')).toBeTruthy();
  });
});

describe('管理端', () => {
  it('概览把「看不到什么」写在管理员每天看得到的地方，且没有充值', async () => {
    writeSession(ADMIN_SESSION);
    mockApi({});
    render(<App initialPath="/admin" />);
    await waitFor(() => {
      expect(screen.getByText(/结构上看不到/)).toBeTruthy();
    });
    expect(screen.getByText(/成员的任务、对话与 prompt/)).toBeTruthy();
    expect(screen.queryByText(/充值/)).toBeNull();
    expect(screen.queryByText(/升级套餐/)).toBeNull();
  });

  it('mustChangePassword 为真时只渲染改密，不渲染任何管理动作（11 §12 第 23 条）', () => {
    writeSession({ ...ADMIN_SESSION, mustChangePassword: true });
    render(<App initialPath="/admin" />);
    expect(screen.getByLabelText('当前密码')).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: '管理端导航' })).toBeNull();
    expect(screen.queryByText('邀请成员')).toBeNull();
    expect(screen.queryByText('签发新策略包')).toBeNull();
  });

  it('五个分区 = D9 四条云端职责的界面面，不多不少', async () => {
    writeSession(ADMIN_SESSION);
    mockApi({});
    render(<App initialPath="/admin" />);
    const nav = await screen.findByRole('navigation', { name: '管理端导航' });
    const labels = within(nav)
      .getAllByRole('link')
      .map((node) => node.textContent?.replace(/\d+$/, '').trim());
    expect(labels).toEqual(['概览', '成员', '默认模型', '用量与配额', '策略与审计']);
  });

  it('邀请成员只按邮箱，不要求手粘 userId', async () => {
    writeSession(ADMIN_SESSION);
    mockApi({
      '/v1/admin/members': {
        members: [{ id: 'u1', email: 'a@b.c', role: 'admin', quotaClass: 'default' }],
      },
    });
    render(<App initialPath="/admin/members" />);
    fireEvent.click(await screen.findByText('邀请成员'));
    expect(await screen.findByLabelText('邮箱')).toBeTruthy();
    expect(screen.queryByLabelText('已注册用户 id')).toBeNull();
    expect(screen.queryByLabelText('用户 id')).toBeNull();
    // 被邀请的人不需要先注册 —— 这正是原先卡住企业第一天的那一步
    expect(screen.getByText(/不需要先注册/)).toBeTruthy();
  });

  it('用量页只有当期聚合：没有按天曲线，也没有明细导出（Q43=A / 第 24 条）', async () => {
    writeSession(ADMIN_SESSION);
    mockApi({ '/v1/admin/usage': { tenantUsed: 42, members: [] } });
    render(<App initialPath="/admin/usage" />);
    await waitFor(() => {
      expect(screen.getByText(/本租户当期总量/)).toBeTruthy();
    });
    // 断言的是**没有那个能力**，不是没有那两个字 ——
    // 这一页恰恰要把「不给按天曲线」明说出来，所以不能用字面扫描。
    expect(screen.queryByRole('button', { name: /导出/ })).toBeNull();
    expect(screen.queryByRole('table', { name: /按天|趋势/ })).toBeNull();
    expect(screen.getByText(/没有按人按天的曲线/)).toBeTruthy();
  });

  it('审计可以导出、用量不能 —— 两类数据的分界要写在页面上', async () => {
    writeSession(ADMIN_SESSION);
    mockApi({});
    render(<App initialPath="/admin/policy" />);
    await waitFor(() => {
      expect(screen.getByText('导出 CSV')).toBeTruthy();
    });
    expect(screen.getByText(/用量明细不能导出/)).toBeTruthy();
  });

  it('一段加载失败时说清「空不是因为没有数据」，并给重试', async () => {
    writeSession(ADMIN_SESSION);
    mockApi({}, { '/v1/admin/members': 500 });
    render(<App initialPath="/admin/members" />);
    await waitFor(() => {
      expect(screen.getByText(/不是因为没有数据/)).toBeTruthy();
    });
    expect(screen.getByText('重试')).toBeTruthy();
  });

  it('只剩一名管理员时「收回管理员」禁用并给原因，不是点了再吃 403', async () => {
    writeSession(ADMIN_SESSION);
    mockApi({
      '/v1/admin/members': {
        members: [
          { id: 'u1', email: 'admin@x.com', role: 'admin', quotaClass: 'default' },
          { id: 'u2', email: 'b@x.com', role: 'member', quotaClass: 'default' },
        ],
      },
    });
    render(<App initialPath="/admin/members" />);
    fireEvent.click(await screen.findByLabelText('admin@x.com 的更多操作'));
    const item = await screen.findByRole('menuitem', { name: '收回管理员权限…' });
    expect((item as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/不能收回最后一名管理员/)).toBeTruthy();
  });

  it('撤销策略包要先确认，并说清它回到的是「没有策略」而不是上一份', async () => {
    writeSession(ADMIN_SESSION);
    mockApi({
      '/v1/admin/policy-pack': {
        current: {
          id: 'p1',
          kid: 'k1',
          issuedAt: 1_700_000_000,
          expiresAt: 1_800_000_000,
          disabledModels: [],
          disabledProfiles: [],
          allowCustom: false,
          allowManagedHooksOnly: false,
          disableShare: false,
          disableSlots: false,
          forceAudit: false,
          revoked: false,
        },
        history: [],
      },
      '/v1/admin/policy-pack/reach': { total: 3, pulled: 1, stale: [] },
    });
    render(<App initialPath="/admin/policy" />);
    fireEvent.click(await screen.findByText('撤销…'));
    expect(await screen.findByRole('heading', { name: '撤销当前策略包？' })).toBeTruthy();
    expect(screen.getByText(/不是回到上一份包/)).toBeTruthy();
    // 勾之前不许撤 —— 这个按钮解的是全租户每台设备的锁
    expect((screen.getByText('撤销').closest('button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('策略包生效面把「已签发」和「已生效」分开说', async () => {
    writeSession(ADMIN_SESSION);
    mockApi({
      '/v1/admin/policy-pack': {
        current: {
          id: 'p1',
          kid: 'k1',
          issuedAt: 1_700_000_000,
          expiresAt: 1_800_000_000,
          disabledModels: [],
          disabledProfiles: [],
          allowCustom: true,
          allowManagedHooksOnly: false,
          disableShare: false,
          disableSlots: false,
          forceAudit: false,
          revoked: false,
        },
        history: [],
      },
      '/v1/admin/policy-pack/reach': {
        total: 3,
        pulled: 1,
        stale: [
          { deviceId: 'd2', name: '会议室共用机', platform: 'win', lastSeenAt: 1_700_000_000 },
          { deviceId: 'd3', name: '刘洋的 Air', platform: 'mac', lastSeenAt: 1_700_000_000 },
        ],
      },
    });
    render(<App initialPath="/admin/policy" />);
    await waitFor(() => {
      expect(screen.getByText(/3 台设备中 1 台已拉取/)).toBeTruthy();
    });
    expect(screen.getByText(/拉取，不是推送/)).toBeTruthy();
    expect(screen.getByText('会议室共用机')).toBeTruthy();
  });
});

describe('改密', () => {
  it('/account/password 有当前密码与新密码（11 §12 第 23 条）', () => {
    writeSession({ ...ADMIN_SESSION, mustChangePassword: true });
    render(<App initialPath="/account/password" />);
    expect(screen.getByRole('heading', { name: '修改密码' })).toBeTruthy();
    expect(screen.getByLabelText('当前密码')).toBeTruthy();
    expect(screen.getByLabelText('新密码')).toBeTruthy();
    expect(screen.getByLabelText('确认新密码')).toBeTruthy();
  });

  it('改密成功后用 /v1/me 翻掉 mustChangePassword，不靠前端自记', async () => {
    writeSession({ ...ADMIN_SESSION, mustChangePassword: true });
    mockApi({ '/v1/me': { role: 'admin', mustChangePassword: false, tenantId: 'ten_1' } });
    render(<App initialPath="/account/password" />);
    fireEvent.change(screen.getByLabelText('当前密码'), { target: { value: 'change-me' } });
    fireEvent.change(screen.getByLabelText('新密码'), { target: { value: 'new-password-1' } });
    fireEvent.change(screen.getByLabelText('确认新密码'), { target: { value: 'new-password-1' } });
    fireEvent.submit(screen.getByLabelText('当前密码').closest('form')!);
    await waitFor(() => {
      expect(readSession()?.mustChangePassword).toBe(false);
    });
  });

  it('两次密码不一致时按钮禁用并给原因，不让服务端来拒', () => {
    writeSession({ ...ADMIN_SESSION, mustChangePassword: true });
    render(<App initialPath="/account/password" />);
    fireEvent.change(screen.getByLabelText('新密码'), { target: { value: 'aaaaaaaaaaaa' } });
    fireEvent.change(screen.getByLabelText('确认新密码'), { target: { value: 'bbbbbbbbbbbb' } });
    const button = screen.getByText('更新密码').closest('button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText('两次输入的密码不一样。')).toBeTruthy();
  });
});

describe('账号页', () => {
  it('声明没有充值或升级入口（Q42）', async () => {
    writeSession({ ...ADMIN_SESSION, role: 'member' });
    mockApi({ '/v1/quota': { used: 10, limit: 100, quotaClass: '标准' } });
    render(<App initialPath="/account" />);
    await waitFor(() => {
      expect(screen.getByText(/没有充值或升级入口/)).toBeTruthy();
    });
  });

  it('吊销其他全部设备要先确认，并说清本机数据不动（Q40）', async () => {
    writeSession({ ...ADMIN_SESSION, role: 'member' });
    mockApi({
      '/v1/quota': { used: 10, limit: 100 },
      '/v1/devices': {
        devices: [
          { id: 'd1', name: '本机', platform: 'mac', lastSeenAt: 1_700_000_000, revoked: false },
        ],
      },
    });
    render(<App initialPath="/account" />);
    fireEvent.click(await screen.findByText('吊销其他全部设备'));
    expect(await screen.findByRole('heading', { name: '吊销其他全部设备？' })).toBeTruthy();
    expect(screen.getByText(/本机数据不受影响/)).toBeTruthy();
  });
});

describe('邀请页', () => {
  it('不读会话、不带 authorization —— 收件人还没登录（与分享页同一条理由）', async () => {
    writeSession(ADMIN_SESSION);
    const fetchMock = mockApi({
      '/v1/invite': {
        email: 'new@x.com',
        tenantName: '示例科技',
        registered: false,
        expiresAt: 1_800_000_000,
      },
    });
    render(<App initialPath="/invite" initialSearch="?token=abc" />);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '加入「示例科技」' })).toBeTruthy();
    });
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/v1/invite'));
    const headers = new Headers(call?.[1]?.headers);
    expect(headers.get('authorization')).toBeNull();
  });

  it('没注册过的人要设密码，注册过的人不碰密码', async () => {
    mockApi({
      '/v1/invite': {
        email: 'old@x.com',
        tenantName: '示例科技',
        registered: true,
        expiresAt: 1_800_000_000,
      },
    });
    render(<App initialPath="/invite" initialSearch="?token=abc" />);
    await waitFor(() => {
      expect(screen.getByText(/不会改你的密码/)).toBeTruthy();
    });
    expect(screen.queryByLabelText('设置密码')).toBeNull();
  });
});

describe('展示口径', () => {
  it('limit <= 0 是「不限」，不是「/ 0」—— 两处显示过口径不一致', () => {
    expect(formatQuota(1240500, 0)).toContain('不设上限');
    expect(formatQuota(1240500, 0)).not.toContain('/ 0');
    expect(formatQuota(10, 100)).toBe('10 / 100 tokens');
  });

  it('密码强度规则只有一份，三处表单共用', () => {
    expect(passwordStrength('').score).toBe(0);
    expect(passwordStrength('short').hint).toContain('太短');
    expect(passwordStrength('correct-horse-1').score).toBeGreaterThanOrEqual(3);
  });

  it('审计导出是身份面的事：CSV 里没有任务 / 产物 / prompt', () => {
    const csv = auditToCsv([
      { at: 1_700_000_000, action: 'invite-member', actorEmail: 'a@x.com', targetRef: 'b@x.com' },
    ]);
    expect(csv).toContain('邀请成员');
    expect(csv).not.toMatch(/thread|artifact|prompt|cwd/i);
  });

  it('diff 把「移除一条限制」显式画出来 —— 那是管理员最容易漏看的一条', () => {
    const rows = buildDiff(
      {
        id: 'p',
        kid: 'k',
        issuedAt: 0,
        expiresAt: 0,
        disabledModels: ['glm'],
        disabledProfiles: ['evowork-full'],
        allowCustom: false,
        allowManagedHooksOnly: false,
        disableShare: false,
        disableSlots: false,
        forceAudit: false,
        revoked: false,
      },
      {
        disabledModels: [],
        disabledProfiles: ['evowork-full'],
        allowCustom: false,
        allowManagedHooksOnly: false,
        disableShare: false,
        forceAudit: false,
        expiresInDays: 30,
        graceInDays: '',
        reason: 'x',
      },
    );
    const removed = rows.find((row) => row.kind === 'remove');
    expect(removed?.text).toContain('glm');
    expect(removed?.note).toContain('设备将恢复');
  });
});

describe('添加模型', () => {
  it('「测试连接」走服务端探针，不从浏览器直连上游（那会被 CORS 挡死）', async () => {
    writeSession(ADMIN_SESSION);
    const fetchMock = mockApi({
      '/v1/admin/models/probe': { ok: true, models: ['deepseek-v4', 'deepseek-r2'] },
    });
    render(<App initialPath="/admin/models" />);
    fireEvent.click(await screen.findByText('添加模型'));
    fireEvent.change(await screen.findByLabelText('上游 base_url'), {
      target: { value: 'https://api.deepseek.com' },
    });
    fireEvent.change(screen.getByLabelText('上游 API 密钥'), { target: { value: 'sk-x' } });
    fireEvent.click(screen.getByText('测试连接'));

    await waitFor(() => {
      expect(screen.getByText(/拉到 2 个模型/)).toBeTruthy();
    });
    // 请求打在我们自己的 identity 上；厂商域名不该出现在浏览器发起的任何一次调用里
    const hosts = fetchMock.mock.calls.map((call) => new URL(String(call[0]), 'http://x').hostname);
    expect(hosts).not.toContain('api.deepseek.com');
  });
});
