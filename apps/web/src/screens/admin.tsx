/**
 * 管理端入口：选分区、装外壳、挂 toast。
 *
 * `mustChangePassword` 为真时**只渲染改密**（11 §12 第 23 条）——
 * 服务端那一半是 `/v1/admin/*` 一律 403，这里是它的界面面。
 */
import { useState } from 'react';

import { api, readSession } from '../api.js';
import { Banner, Button, Toasts, useToasts } from '../components.js';
import { useAsync } from '../use-async.js';
import { AuthCard, ChangePasswordForm } from './auth.js';
import { AdminMembers } from './admin-members.js';
import { AdminModels } from './admin-models.js';
import { AdminOverview } from './admin-overview.js';
import { AdminPolicy } from './admin-policy.js';
import { AdminShell, type AdminSection } from './admin-shell.js';
import { AdminUsagePage } from './admin-usage.js';

const TITLES: Record<AdminSection, string> = {
  overview: '概览',
  members: '成员',
  models: '默认模型',
  usage: '用量与配额',
  policy: '策略与审计',
};

interface ShellInfo {
  readonly tenantName: string;
  readonly actorEmail: string;
  readonly members: number;
  readonly models: number;
}

export function AdminPage(props: {
  readonly section: AdminSection;
  readonly onGo: (path: string) => void;
  readonly onSignOut: () => void;
  readonly onSessionChanged?: (() => void) | undefined;
}) {
  const session = readSession();
  const toasts = useToasts();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [addModelOpen, setAddModelOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);

  const blocked = !session || session.role !== 'admin' || session.mustChangePassword;

  const info = useAsync<ShellInfo>(async () => {
    if (blocked) {
      return {
        ok: true as const,
        data: { tenantName: '—', actorEmail: '—', members: 0, models: 0 },
      };
    }
    const [me, members, models] = await Promise.all([
      api<{ email?: string; tenantId: string | null }>('/v1/me'),
      api<{ members: unknown[] }>('/v1/admin/members'),
      api<{ models: unknown[] }>('/v1/admin/models'),
    ]);
    return {
      ok: true as const,
      data: {
        tenantName: me.ok ? (me.data.tenantId ?? '未加入租户') : '—',
        actorEmail: me.ok ? (me.data.email ?? '—') : '—',
        members: members.ok ? members.data.members.length : 0,
        models: models.ok ? models.data.models.length : 0,
      },
    };
  }, [blocked]);

  if (!session || session.role !== 'admin') {
    return (
      <AuthCard title="管理端">
        <Banner
          tone="warning"
          action={
            <Button size="sm" variant="primary" onClick={() => props.onGo('/signin')}>
              去登录
            </Button>
          }
        >
          这一页需要租户管理员。客户端里没有管理界面 —— 授权在服务端。
        </Banner>
      </AuthCard>
    );
  }

  if (session.mustChangePassword) {
    return (
      <AuthCard title="租户管理">
        <Banner tone="warning">
          引导账号必须先改密。改完之前<b>不能配模型、加成员、改额度或签发策略包</b>。
        </Banner>
        <ChangePasswordForm onChanged={() => props.onSessionChanged?.()} />
      </AuthCard>
    );
  }

  const shell = info.state.status === 'ready' ? info.state.data : undefined;

  return (
    <>
      <AdminShell
        section={props.section}
        title={TITLES[props.section]}
        tenantName={shell?.tenantName ?? '…'}
        actorEmail={shell?.actorEmail ?? '…'}
        counts={{ members: shell?.members ?? 0, models: shell?.models ?? 0 }}
        onGo={props.onGo}
        onSignOut={props.onSignOut}
        headerActions={
          props.section === 'members' ? (
            <Button variant="primary" icon="plus" onClick={() => setInviteOpen(true)}>
              邀请成员
            </Button>
          ) : props.section === 'models' ? (
            <Button variant="primary" icon="plus" onClick={() => setAddModelOpen(true)}>
              添加模型
            </Button>
          ) : props.section === 'policy' ? (
            <Button variant="primary" icon="policy" onClick={() => setWizardOpen(true)}>
              签发新策略包
            </Button>
          ) : undefined
        }
      >
        {props.section === 'overview' ? <AdminOverview onGo={props.onGo} /> : null}
        {props.section === 'members' ? (
          <AdminMembers
            inviteOpen={inviteOpen}
            onInviteOpen={setInviteOpen}
            onToast={toasts.push}
          />
        ) : null}
        {props.section === 'models' ? (
          <AdminModels addOpen={addModelOpen} onAddOpen={setAddModelOpen} onToast={toasts.push} />
        ) : null}
        {props.section === 'usage' ? <AdminUsagePage onToast={toasts.push} /> : null}
        {props.section === 'policy' ? (
          <AdminPolicy wizardOpen={wizardOpen} onWizardOpen={setWizardOpen} onToast={toasts.push} />
        ) : null}
      </AdminShell>
      <Toasts items={toasts.items} />
    </>
  );
}
