/**
 * 成员页：邀请 · 行内动作 · 搜索筛选分页。
 *
 * 行内动作收进 ⋯ 菜单，而不是一行并排三个按钮加两个表单 —— 那是原先的样子，
 * 一个 `<td>` 里塞了两个 `<form>`。
 *
 * 「收回管理员」在只剩一名管理员时**禁用并给原因**（01 §6.3），
 * 不是让人点了再吃一个 403。
 */
import { useMemo, useState, type FormEvent } from 'react';

import {
  api,
  formatDay,
  formatQuota,
  quotaPercent,
  who,
  type AdminInvite,
  type AdminMember,
  type AdminUsage,
  type AdminUsageMember,
  type QuotaClassView,
} from '../api.js';
import {
  Async,
  Badge,
  Banner,
  Button,
  Dialog,
  EmptyState,
  Field,
  FilterChip,
  ProgressBar,
  RowMenu,
  SearchInput,
  type MenuItem,
} from '../components.js';
import { useAction, useAsync } from '../use-async.js';

interface MembersData {
  readonly members: readonly AdminMember[];
  readonly invites: readonly AdminInvite[];
  readonly classes: readonly QuotaClassView[];
  readonly usage: AdminUsage;
}

type Filter = 'all' | 'admin' | 'exhausted' | 'pending';

const PAGE_SIZE = 8;

export function AdminMembers(props: {
  readonly inviteOpen: boolean;
  readonly onInviteOpen: (open: boolean) => void;
  readonly onToast: (text: string) => void;
}) {
  const action = useAction();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [page, setPage] = useState(0);
  const [quotaFor, setQuotaFor] = useState<AdminMember | undefined>();
  const [classFor, setClassFor] = useState<AdminMember | undefined>();
  const [revokeAdminFor, setRevokeAdminFor] = useState<AdminMember | undefined>();

  const loaded = useAsync<MembersData>(async () => {
    const [members, invites, classes, usage] = await Promise.all([
      api<{ members: AdminMember[] }>('/v1/admin/members'),
      api<{ invites: AdminInvite[] }>('/v1/admin/invites'),
      api<{ classes: QuotaClassView[] }>('/v1/admin/quota-classes'),
      api<AdminUsage>('/v1/admin/usage'),
    ]);
    if (!members.ok) return members;
    return {
      ok: true as const,
      data: {
        members: members.data.members,
        invites: invites.ok ? invites.data.invites : [],
        classes: classes.ok ? classes.data.classes : [],
        usage: usage.ok ? usage.data : { tenantUsed: 0, members: [] },
      },
    };
  }, []);

  /**
   * 对话框渲染在 `Async` 之外。
   *
   * 原先它们写在 children 分支里，于是**空态那条「邀请成员」点了没反应** ——
   * 空态走的是 `empty` 分支，children 根本没渲染。
   * 两个模块各自都对，合起来才是错的（CLAUDE.md §9.1）。
   */
  const classes =
    loaded.state.status === 'ready' ? loaded.state.data.classes : ([] as readonly QuotaClassView[]);

  return (
    <>
      {action.error ? <Banner tone="danger">{action.error}</Banner> : null}
      <Async
        state={loaded.state}
        onRetry={loaded.reload}
        isEmpty={(data) => data.members.length <= 1 && data.invites.length === 0}
        empty={
          <section className="ew-card">
            <EmptyState
              title="这个租户里只有你"
              description="邀请同事之后，他们登录就能用你配的默认模型。"
              action={
                <Button variant="primary" icon="plus" onClick={() => props.onInviteOpen(true)}>
                  邀请成员
                </Button>
              }
            />
          </section>
        }
        children={(data) => {
          const adminCount = data.members.filter((m) => m.role === 'admin').length;
          const usageOf = new Map<string, AdminUsageMember>(
            data.usage.members.map((row) => [row.id, row]),
          );
          const exhaustedCount = data.usage.members.filter((m) => m.exhausted).length;

          const matched = data.members.filter((member) => {
            const text = who(member).toLowerCase();
            if (query && !text.includes(query.toLowerCase())) return false;
            if (filter === 'admin') return member.role === 'admin';
            if (filter === 'exhausted') return usageOf.get(member.id)?.exhausted === true;
            if (filter === 'pending') return false;
            return true;
          });
          const pageRows = matched.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
          const showInvites = filter === 'all' || filter === 'pending';

          return (
            <>
              <div className="ew-actions">
                <SearchInput
                  label="搜索成员"
                  placeholder="搜索邮箱或姓名"
                  value={query}
                  onChange={(value) => {
                    setQuery(value);
                    setPage(0);
                  }}
                />
                <FilterChip
                  selected={filter === 'all'}
                  onClick={() => {
                    setFilter('all');
                    setPage(0);
                  }}
                >
                  全部 {data.members.length}
                </FilterChip>
                <FilterChip selected={filter === 'admin'} onClick={() => setFilter('admin')}>
                  管理员 {adminCount}
                </FilterChip>
                <FilterChip
                  selected={filter === 'exhausted'}
                  onClick={() => setFilter('exhausted')}
                >
                  已耗尽 {exhaustedCount}
                </FilterChip>
                <FilterChip selected={filter === 'pending'} onClick={() => setFilter('pending')}>
                  邀请中 {data.invites.length}
                </FilterChip>
              </div>

              <div className="ew-table-wrap">
                <table className="ew-table">
                  <thead>
                    <tr>
                      <th>用户</th>
                      <th>角色</th>
                      <th>配额班级</th>
                      <th>当期用量</th>
                      <th data-align="right">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {showInvites
                      ? data.invites.map((invite) => (
                          <tr key={invite.id} data-tone="pending">
                            <td>
                              <span className="ew-cell-stack">
                                <span>{invite.email}</span>
                                <span className="ew-micro">
                                  {formatDay(invite.expiresAt)}前有效
                                  {invite.invitedByEmail ? ` · ${invite.invitedByEmail} 发出` : ''}
                                </span>
                              </span>
                            </td>
                            <td>
                              <Badge tone="info">邀请中</Badge>
                            </td>
                            <td className="ew-muted">{invite.quotaClass}</td>
                            <td className="ew-muted">—</td>
                            <td data-align="right">
                              <span className="ew-actions" data-align="end">
                                <Button
                                  size="sm"
                                  busy={action.busy}
                                  onClick={() =>
                                    void action.run(
                                      () =>
                                        api('/v1/admin/invites/resend', {
                                          method: 'POST',
                                          body: JSON.stringify({ inviteId: invite.id }),
                                        }),
                                      () => {
                                        props.onToast('已重发邀请，旧链接立刻失效');
                                        loaded.reload();
                                      },
                                    )
                                  }
                                >
                                  重发
                                </Button>
                                <Button
                                  size="sm"
                                  variant="danger-ghost"
                                  busy={action.busy}
                                  onClick={() =>
                                    void action.run(
                                      () =>
                                        api('/v1/admin/invites/revoke', {
                                          method: 'POST',
                                          body: JSON.stringify({ inviteId: invite.id }),
                                        }),
                                      () => {
                                        props.onToast('已撤回邀请');
                                        loaded.reload();
                                      },
                                    )
                                  }
                                >
                                  撤回
                                </Button>
                              </span>
                            </td>
                          </tr>
                        ))
                      : null}

                    {pageRows.map((member) => {
                      const usage = usageOf.get(member.id);
                      const lastAdmin = member.role === 'admin' && adminCount <= 1;
                      const items: readonly MenuItem[] = [
                        {
                          label: '设置额度上限…',
                          onClick: () => setQuotaFor(member),
                        },
                        {
                          label: '分配配额班级…',
                          onClick: () => setClassFor(member),
                        },
                        member.role === 'admin'
                          ? {
                              label: '收回管理员权限…',
                              separatorBefore: true,
                              disabled: lastAdmin,
                              disabledReason: '不能收回最后一名管理员，否则没人能进管理端了',
                              onClick: () => setRevokeAdminFor(member),
                            }
                          : {
                              label: '授予管理员权限',
                              separatorBefore: true,
                              onClick: () =>
                                void action.run(
                                  () =>
                                    api('/v1/admin/grant', {
                                      method: 'POST',
                                      body: JSON.stringify({ userId: member.id }),
                                    }),
                                  () => {
                                    props.onToast('已授予管理员');
                                    loaded.reload();
                                  },
                                ),
                            },
                      ];
                      return (
                        <tr key={member.id}>
                          <td>
                            <span className="ew-cell">
                              <span className="ew-avatar">
                                {who(member).slice(0, 1).toUpperCase()}
                              </span>
                              <span className="ew-cell-stack">
                                <span>{who(member)}</span>
                              </span>
                            </span>
                          </td>
                          <td>
                            {member.role === 'admin' ? (
                              <Badge tone="accent">管理员</Badge>
                            ) : (
                              <span className="ew-muted">成员</span>
                            )}
                          </td>
                          <td className="ew-muted">{member.quotaClass}</td>
                          <td>
                            {usage ? (
                              <span className="ew-cell">
                                <span className="ew-cell-stack">
                                  <span className="ew-muted">
                                    {formatQuota(usage.used, usage.limit)}
                                  </span>
                                  {usage.limit > 0 ? (
                                    <ProgressBar
                                      percent={quotaPercent(usage.used, usage.limit)}
                                      tone={usage.exhausted ? 'danger' : 'accent'}
                                      label={`${who(member)} 的额度`}
                                    />
                                  ) : null}
                                </span>
                                {usage.exhausted ? <Badge tone="danger">已耗尽</Badge> : null}
                              </span>
                            ) : (
                              <span className="ew-muted">—</span>
                            )}
                          </td>
                          <td data-align="right">
                            <RowMenu label={`${who(member)} 的更多操作`} items={items} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <div className="ew-table-foot">
                  <span className="ew-muted">
                    显示 {matched.length === 0 ? 0 : page * PAGE_SIZE + 1}–
                    {Math.min(matched.length, (page + 1) * PAGE_SIZE)}，共 {matched.length} 人
                  </span>
                  <span className="ew-grow" />
                  <Button
                    size="sm"
                    disabled={page === 0}
                    disabledReason="已经是第一页"
                    onClick={() => setPage((n) => n - 1)}
                  >
                    上一页
                  </Button>
                  <Button
                    size="sm"
                    disabled={(page + 1) * PAGE_SIZE >= matched.length}
                    disabledReason="已经是最后一页"
                    onClick={() => setPage((n) => n + 1)}
                  >
                    下一页
                  </Button>
                </div>
              </div>
            </>
          );
        }}
      />

      {props.inviteOpen ? (
        <InviteDialog
          classes={classes}
          busy={action.busy}
          error={action.error}
          onCancel={() => props.onInviteOpen(false)}
          onSubmit={(body) =>
            void action.run(
              () => api('/v1/admin/invites', { method: 'POST', body: JSON.stringify(body) }),
              () => {
                props.onInviteOpen(false);
                props.onToast(`邀请已发往 ${body.email}`);
                loaded.reload();
              },
            )
          }
        />
      ) : null}

      {quotaFor ? (
        <QuotaDialog
          member={quotaFor}
          busy={action.busy}
          onCancel={() => setQuotaFor(undefined)}
          onSubmit={(limit) =>
            void action.run(
              () =>
                api('/v1/admin/quota', {
                  method: 'POST',
                  body: JSON.stringify({ userId: quotaFor.id, limit }),
                }),
              () => {
                setQuotaFor(undefined);
                props.onToast('已更新额度上限');
                loaded.reload();
              },
            )
          }
        />
      ) : null}

      {classFor ? (
        <ClassDialog
          member={classFor}
          classes={classes}
          busy={action.busy}
          onCancel={() => setClassFor(undefined)}
          onSubmit={(quotaClass) =>
            void action.run(
              () =>
                api('/v1/admin/quota-class', {
                  method: 'POST',
                  body: JSON.stringify({ userId: classFor.id, quotaClass }),
                }),
              () => {
                setClassFor(undefined);
                props.onToast('已分配配额班级');
                loaded.reload();
              },
            )
          }
        />
      ) : null}

      {revokeAdminFor ? (
        <Dialog
          title="收回管理员权限？"
          confirmLabel="收回"
          confirmVariant="danger"
          busy={action.busy}
          onCancel={() => setRevokeAdminFor(undefined)}
          onConfirm={() =>
            void action.run(
              () =>
                api('/v1/admin/revoke', {
                  method: 'POST',
                  body: JSON.stringify({ userId: revokeAdminFor.id }),
                }),
              () => {
                setRevokeAdminFor(undefined);
                props.onToast('已收回管理员');
                loaded.reload();
              },
            )
          }
        >
          <p className="ew-muted">
            {who(revokeAdminFor)} 将变回普通成员，<b>人还在租户里</b>
            ，只是不能再配模型、加成员或签发策略包。撤的是权限，不是账号。
          </p>
        </Dialog>
      ) : null}
    </>
  );
}

function InviteDialog(props: {
  readonly classes: readonly QuotaClassView[];
  readonly busy: boolean;
  readonly error: string | undefined;
  readonly onCancel: () => void;
  readonly onSubmit: (body: { email: string; role: string; quotaClass: string }) => void;
}) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('member');
  const [quotaClass, setQuotaClass] = useState(props.classes[0]?.name ?? 'default');
  const valid = useMemo(() => /.+@.+\..+/.test(email), [email]);

  return (
    <Dialog
      title="邀请成员"
      confirmLabel="发出邀请"
      busy={props.busy}
      confirmDisabled={!valid}
      confirmDisabledReason="先填一个有效的邮箱"
      onCancel={props.onCancel}
      onConfirm={() => props.onSubmit({ email, role, quotaClass })}
    >
      <p className="ew-muted">
        对方<b>不需要先注册</b>
        ：邮件里的链接能同时建号并加入租户。链接 7 天有效，重发会让旧链接立刻失效。
      </p>
      <Field
        label="邮箱"
        name="email"
        type="email"
        required
        value={email}
        onChange={setEmail}
        placeholder="name@company.com"
      />
      <div className="ew-field">
        <label className="ew-label" htmlFor="invite-role">
          角色
        </label>
        <select
          id="invite-role"
          className="ew-select"
          value={role}
          onChange={(e) => setRole(e.target.value)}
        >
          <option value="member">成员</option>
          <option value="admin">管理员</option>
        </select>
      </div>
      <div className="ew-field">
        <label className="ew-label" htmlFor="invite-class">
          配额班级
        </label>
        <select
          id="invite-class"
          className="ew-select"
          value={quotaClass}
          onChange={(e) => setQuotaClass(e.target.value)}
        >
          {props.classes.map((cls) => (
            <option key={cls.name} value={cls.name}>
              {cls.name}
            </option>
          ))}
        </select>
      </div>
      {props.error ? <p className="ew-error ew-muted">{props.error}</p> : null}
    </Dialog>
  );
}

function QuotaDialog(props: {
  readonly member: AdminMember;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: (limit: number) => void;
}) {
  const [value, setValue] = useState('');
  const parsed = Number(value.replace(/[,\s]/g, ''));
  const valid = value.trim() !== '' && Number.isFinite(parsed) && parsed >= 0;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (valid) props.onSubmit(parsed);
  }

  return (
    <Dialog
      title={`设置 ${who(props.member)} 的额度上限`}
      confirmLabel="保存上限"
      busy={props.busy}
      confirmDisabled={!valid}
      confirmDisabledReason="填一个不小于 0 的数字"
      onCancel={props.onCancel}
      onConfirm={() => props.onSubmit(parsed)}
    >
      <form onSubmit={submit}>
        <Field
          label="token 上限"
          name="limit"
          value={value}
          onChange={setValue}
          placeholder="5000000"
          hint={
            <>
              填 <b>0 表示不限</b>。这里只配上限，不收款 —— 没有充值、升级或套餐。
            </>
          }
        />
      </form>
    </Dialog>
  );
}

function ClassDialog(props: {
  readonly member: AdminMember;
  readonly classes: readonly QuotaClassView[];
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: (quotaClass: string) => void;
}) {
  const [value, setValue] = useState(props.member.quotaClass);
  return (
    <Dialog
      title={`把 ${who(props.member)} 分到哪个班级`}
      confirmLabel="保存班级"
      busy={props.busy}
      onCancel={props.onCancel}
      onConfirm={() => props.onSubmit(value)}
    >
      <div className="ew-field">
        <label className="ew-label" htmlFor="assign-class">
          配额班级
        </label>
        <select
          id="assign-class"
          className="ew-select"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        >
          {props.classes.map((cls) => (
            <option key={cls.name} value={cls.name}>
              {cls.name} · {cls.tokensLimit <= 0 ? '不限' : `${cls.tokensLimit} tokens`}
            </option>
          ))}
        </select>
      </div>
      <p className="ew-muted">班级决定默认上限；单人的上限覆盖优先于班级。</p>
    </Dialog>
  );
}
