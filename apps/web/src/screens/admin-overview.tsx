/**
 * 管理端概览。
 *
 * 这一页以前不存在：管理员进来第一眼看到的是一张成员表，而他真正要知道的是
 * **「有没有需要我处理的事」**。所以「需要你处理」排在最上面，没有事的时候
 * 明确说没有 —— 空着会被读成"还没加载出来"。
 */
import {
  api,
  auditActionLabel,
  formatTime,
  formatTokens,
  who,
  type AdminUsage,
  type IdentityAuditView,
  type PolicyPackView,
  type PolicyReachView,
  type PublicModel,
} from '../api.js';
import { Async, Banner, Button, Icon, StatusDot } from '../components.js';
import { useAsync } from '../use-async.js';

interface OverviewData {
  readonly usage: AdminUsage;
  readonly models: readonly PublicModel[];
  readonly pack: PolicyPackView | null;
  readonly reach: PolicyReachView;
  readonly audit: readonly IdentityAuditView[];
  readonly admins: number;
  readonly members: number;
}

export function AdminOverview(props: { readonly onGo: (path: string) => void }) {
  const loaded = useAsync<OverviewData>(async () => {
    const [members, usage, models, pack, reach, audit] = await Promise.all([
      api<{ members: { role: string }[] }>('/v1/admin/members'),
      api<AdminUsage>('/v1/admin/usage'),
      api<{ models: PublicModel[] }>('/v1/admin/models'),
      api<{ current: PolicyPackView | null }>('/v1/admin/policy-pack'),
      api<PolicyReachView>('/v1/admin/policy-pack/reach'),
      api<{ events: IdentityAuditView[] }>('/v1/admin/audit'),
    ]);
    if (!members.ok) return members;
    if (!usage.ok) return usage;
    return {
      ok: true as const,
      data: {
        usage: usage.data,
        models: models.ok ? models.data.models : [],
        pack: pack.ok ? pack.data.current : null,
        reach: reach.ok ? reach.data : { total: 0, pulled: 0, stale: [] },
        audit: audit.ok ? audit.data.events.slice(0, 4) : [],
        admins: members.data.members.filter((m) => m.role === 'admin').length,
        members: members.data.members.length,
      },
    };
  }, []);

  return (
    <Async
      state={loaded.state}
      onRetry={loaded.reload}
      children={(data) => {
        const exhausted = data.usage.members.filter((m) => m.exhausted);
        const packDays = data.pack
          ? Math.ceil((data.pack.expiresAt * 1000 - Date.now()) / 86_400_000)
          : 0;
        const todo = exhausted.length > 0 || data.reach.stale.length > 0;
        return (
          <>
            <div className="ew-stats">
              <div className="ew-stat">
                <span className="ew-muted">成员</span>
                <span className="ew-stat-value">{data.members}</span>
                <span className="ew-micro">其中 {data.admins} 名管理员</span>
              </div>
              <div className="ew-stat">
                <span className="ew-muted">当期托管用量</span>
                <span className="ew-stat-value">{formatTokens(data.usage.tenantUsed)}</span>
                <span className="ew-micro">tokens · 按 token 计量</span>
              </div>
              <div className="ew-stat">
                <span className="ew-muted">默认模型</span>
                <span className="ew-stat-value">{data.models.length}</span>
                <span className="ew-micro">
                  {data.models.length === 0
                    ? '还没有配置'
                    : data.models.map((m) => m.displayName).join(' · ')}
                </span>
              </div>
              <div className="ew-stat">
                <span className="ew-muted">策略包</span>
                <span className="ew-stat-value">
                  <StatusDot tone={data.pack ? 'success' : 'neutral'} />
                  {data.pack ? '有效' : '未签发'}
                </span>
                <span className="ew-micro">
                  {data.pack ? `${packDays} 天后到期` : '设备当前没有企业策略'}
                </span>
              </div>
            </div>

            <div className="ew-cols">
              <div className="ew-col-main">
                <section className="ew-card">
                  <h2>需要你处理</h2>
                  {!todo ? <Banner tone="success">没有需要处理的事。</Banner> : null}
                  {exhausted.length > 0 ? (
                    <Banner
                      tone="warning"
                      action={
                        <Button size="sm" onClick={() => props.onGo('/admin/usage')}>
                          查看用量
                        </Button>
                      }
                    >
                      <b>{exhausted.length} 名成员的托管额度已耗尽</b>
                      ，他们的任务现在停在「需要你调整上限」—— 额度用尽不会自动换便宜的模型。
                    </Banner>
                  ) : null}
                  {data.reach.stale.length > 0 ? (
                    <Banner
                      tone="info"
                      action={
                        <Button size="sm" onClick={() => props.onGo('/admin/policy')}>
                          查看策略
                        </Button>
                      }
                    >
                      <b>{data.reach.stale.length} 台设备还没拉到当前策略包</b>
                      ，下发是拉取不是推送，它们要到下次启动或登录才会更新。
                    </Banner>
                  ) : null}
                </section>

                <section className="ew-card">
                  <span className="ew-card-head">
                    <h2>最近管理动作</h2>
                    <span className="ew-grow" />
                    <Button variant="quiet" size="sm" onClick={() => props.onGo('/admin/policy')}>
                      查看全部审计
                    </Button>
                  </span>
                  {data.audit.length === 0 ? (
                    <p className="ew-muted">还没有管理动作。</p>
                  ) : (
                    data.audit.map((row) => (
                      <span
                        className="ew-list-row"
                        key={`${row.at}-${row.action}-${row.targetRef ?? ''}`}
                      >
                        <span className="ew-muted">{formatTime(row.at)}</span>
                        <span className="ew-grow">
                          {auditActionLabel(row.action)}
                          {row.targetEmail || row.targetRef
                            ? ` · ${row.targetEmail ?? row.targetRef}`
                            : ''}
                        </span>
                        <span className="ew-muted">
                          {who({ email: row.actorEmail, phone: row.actorPhone })}
                        </span>
                      </span>
                    ))
                  )}
                </section>
              </div>

              <aside className="ew-col-side">
                <section className="ew-card" data-tone="accent">
                  <h2>这个管理端看不到什么</h2>
                  <p className="ew-muted">
                    不是「我们承诺不看」，是<b>结构上看不到</b>
                    ：内容从不上云，这些接口的返回类型里没有能装内容的字段。
                  </p>
                  <span className="ew-cell">
                    <Icon name="cross" size="sm" />
                    <span className="ew-muted">成员的任务、对话与 prompt</span>
                  </span>
                  <span className="ew-cell">
                    <Icon name="cross" size="sm" />
                    <span className="ew-muted">产物文件与工作空间路径</span>
                  </span>
                  <span className="ew-cell">
                    <Icon name="cross" size="sm" />
                    <span className="ew-muted">谁在什么时候用了产品（按天的用量曲线）</span>
                  </span>
                  <span className="ew-cell">
                    <Icon name="check" size="sm" />
                    <span className="ew-muted">
                      看得到的只有：成员、角色、当期 token 总量、管理动作审计
                    </span>
                  </span>
                </section>

                <section className="ew-card">
                  <h2>常用动作</h2>
                  <Button icon="plus" block onClick={() => props.onGo('/admin/members')}>
                    邀请成员
                  </Button>
                  <Button icon="plus" block onClick={() => props.onGo('/admin/models')}>
                    添加默认模型
                  </Button>
                  <Button icon="policy" block onClick={() => props.onGo('/admin/policy')}>
                    签发策略包
                  </Button>
                </section>
              </aside>
            </div>
          </>
        );
      }}
    />
  );
}
