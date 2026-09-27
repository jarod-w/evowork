/**
 * 账号页：身份 · 托管额度 · 设备 · 注销入口。
 *
 * 这一页**没有任务、没有产物、没有充值**（Q42 / D10）。
 */
import { useState } from 'react';

import {
  api,
  formatQuota,
  formatTime,
  quotaPercent,
  readSession,
  type DeviceRow,
  type QuotaView,
} from '../api.js';
import {
  Badge,
  Banner,
  BrandMark,
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  Icon,
  ProgressBar,
  Async,
} from '../components.js';
import { useAction, useAsync } from '../use-async.js';

export function AccountTopbar(props: {
  readonly email: string;
  readonly onGo: (path: string) => void;
  readonly onSignOut: () => void;
}) {
  return (
    <header className="ew-topbar">
      <span className="ew-brandmark">
        <BrandMark />
        EvoWork 账号
      </span>
      <span className="ew-grow" />
      <span className="ew-muted">{props.email}</span>
      <Button size="sm" onClick={props.onSignOut}>
        退出
      </Button>
    </header>
  );
}

interface AccountData {
  readonly quota: QuotaView;
  readonly devices: readonly DeviceRow[];
  readonly warnOptOut: boolean;
}

export function AccountHome(props: {
  readonly onGo: (path: string) => void;
  readonly onSignOut: () => void;
}) {
  const session = readSession();
  const action = useAction();
  const [confirmRevokeAll, setConfirmRevokeAll] = useState(false);

  const loaded = useAsync<AccountData>(async () => {
    const [quota, devices, alerts] = await Promise.all([
      api<QuotaView>('/v1/quota'),
      api<{ devices: DeviceRow[] }>('/v1/devices'),
      api<{ warnOptOut: boolean }>('/v1/alerts'),
    ]);
    if (!quota.ok) return quota;
    if (!devices.ok) return devices;
    return {
      ok: true as const,
      data: {
        quota: quota.data,
        devices: devices.data.devices,
        warnOptOut: alerts.ok ? alerts.data.warnOptOut : false,
      },
    };
  }, []);

  if (!session) {
    return (
      <div className="ew-content">
        <h1>账号</h1>
        <Banner
          tone="warning"
          action={
            <Button size="sm" onClick={() => props.onGo('/signin')}>
              去登录
            </Button>
          }
        >
          请先登录。
        </Banner>
      </div>
    );
  }

  return (
    <div className="ew-page">
      <AccountTopbar email="我的账号" onGo={props.onGo} onSignOut={props.onSignOut} />
      <div className="ew-content">
        <div className="ew-cell-stack">
          <h1>账号</h1>
          <p className="ew-muted">任务和产物在你的电脑上。这里只管理登录凭据和托管额度。</p>
        </div>

        {session.mustChangePassword ? (
          <Banner
            tone="warning"
            action={
              <Button size="sm" onClick={() => props.onGo('/account/password')}>
                去改密
              </Button>
            }
          >
            引导账号必须先改密，改完之前不能做管理动作。
          </Banner>
        ) : null}

        {action.error ? <Banner tone="danger">{action.error}</Banner> : null}

        <Async
          state={loaded.state}
          onRetry={loaded.reload}
          children={(data) => (
            <>
              <section className="ew-card">
                <span className="ew-card-head">
                  <h2>本月托管额度</h2>
                  <span className="ew-grow" />
                  <span className="ew-muted">班级「{data.quota.quotaClass ?? 'default'}」</span>
                </span>
                <div className="ew-cell-stack">
                  <span className="ew-cell">
                    <span className="ew-stat-value">
                      {data.quota.limit <= 0
                        ? data.quota.used.toLocaleString('zh-CN')
                        : formatQuota(data.quota.used, data.quota.limit).split(' / ')[0]}
                    </span>
                    <span className="ew-muted">
                      {data.quota.limit <= 0
                        ? 'tokens · 不设上限'
                        : `/ ${data.quota.limit.toLocaleString('zh-CN')} tokens`}
                    </span>
                    <span className="ew-grow" />
                    {data.quota.limit > 0 ? (
                      <span className="ew-strong">
                        已用 {quotaPercent(data.quota.used, data.quota.limit)}%
                      </span>
                    ) : null}
                  </span>
                  {data.quota.limit > 0 ? (
                    <ProgressBar
                      percent={quotaPercent(data.quota.used, data.quota.limit)}
                      tone={
                        data.quota.used >= data.quota.limit
                          ? 'danger'
                          : quotaPercent(data.quota.used, data.quota.limit) >= 80
                            ? 'warning'
                            : 'accent'
                      }
                      label="本月托管额度"
                    />
                  ) : null}
                </div>
                <Banner>
                  额度用尽后<b>不会自动换成便宜的模型</b>
                  。你可以改用自己的模型密钥继续，或联系管理员调整上限。这里没有充值或升级入口。
                </Banner>
                <Checkbox
                  label="用量到 80% 时邮件提醒我"
                  checked={!data.warnOptOut}
                  onChange={(checked) => {
                    loaded.set({ ...data, warnOptOut: !checked });
                    void action.run(() =>
                      api('/v1/alerts', {
                        method: 'POST',
                        body: JSON.stringify({ warnOptOut: !checked }),
                      }),
                    );
                  }}
                  why="提醒里只有用了多少这一个数字，没有任何任务信息。"
                />
              </section>

              <section className="ew-card">
                <span className="ew-card-head">
                  <h2>已登录的设备</h2>
                  <span className="ew-grow" />
                  <span className="ew-muted">{data.devices.length} 台</span>
                </span>
                {data.devices.length === 0 ? (
                  <EmptyState
                    title="还没有设备登录过"
                    description="在 EvoWork 桌面版里登录之后，这台机器会出现在这里。"
                  />
                ) : (
                  <div className="ew-table-wrap">
                    <table className="ew-table">
                      <thead>
                        <tr>
                          <th>设备</th>
                          <th>平台</th>
                          <th>最后活跃</th>
                          <th data-align="right">操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.devices.map((device) => (
                          <tr key={device.id}>
                            <td>
                              <span className="ew-cell">
                                {device.name}
                                {device.revoked ? <Badge tone="neutral">已吊销</Badge> : null}
                              </span>
                            </td>
                            <td className="ew-muted">{device.platform}</td>
                            <td className="ew-muted">{formatTime(device.lastSeenAt)}</td>
                            <td data-align="right">
                              {device.revoked ? null : (
                                <Button
                                  size="sm"
                                  busy={action.busy}
                                  onClick={() => {
                                    void action.run(
                                      () =>
                                        api('/v1/devices/revoke', {
                                          method: 'POST',
                                          body: JSON.stringify({ deviceId: device.id }),
                                        }),
                                      loaded.reload,
                                    );
                                  }}
                                >
                                  吊销
                                </Button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <span className="ew-cell">
                  <Button variant="danger-ghost" onClick={() => setConfirmRevokeAll(true)}>
                    吊销其他全部设备
                  </Button>
                  <span className="ew-muted">
                    吊销只作废云端登录。那台机器上的任务、产物和自定义模型密钥都不会被删。
                  </span>
                </span>
              </section>

              <section className="ew-card" data-tone="danger">
                <span className="ew-cell">
                  <span className="ew-cell-stack ew-grow">
                    <h2>注销账号</h2>
                    <span className="ew-muted">
                      只删除云端登录凭据、租户成员关系与托管额度账。本机数据一行都不动。
                    </span>
                  </span>
                  <Button variant="danger-ghost" onClick={() => props.onGo('/account/delete')}>
                    注销账号…
                  </Button>
                </span>
              </section>
            </>
          )}
        />

        <div className="ew-actions">
          <Button onClick={() => props.onGo('/account/password')}>修改密码</Button>
        </div>
      </div>

      {confirmRevokeAll ? (
        <Dialog
          title="吊销其他全部设备？"
          confirmLabel="吊销其他设备"
          confirmVariant="danger"
          busy={action.busy}
          onCancel={() => setConfirmRevokeAll(false)}
          onConfirm={() => {
            void action.run(
              () => api('/v1/devices/revoke-others', { method: 'POST', body: '{}' }),
              () => {
                setConfirmRevokeAll(false);
                loaded.reload();
              },
            );
          }}
        >
          <p className="ew-muted">
            除了你正在用的这一台，其他设备上的登录会立刻失效，需要重新登录。
            <b>本机数据不受影响</b> —— 任务、产物和自定义模型密钥都在各自的机器上。
          </p>
        </Dialog>
      ) : null}
    </div>
  );
}

export function SignedOutNotice(props: { readonly onGo: (path: string) => void }) {
  return (
    <div className="ew-content">
      <h1>需要登录</h1>
      <Banner
        tone="warning"
        action={
          <Button size="sm" variant="primary" onClick={() => props.onGo('/signin')}>
            去登录
          </Button>
        }
      >
        <span className="ew-cell">
          <Icon name="info" size="sm" />
          这一页要先登录才能看。
        </span>
      </Banner>
    </div>
  );
}
