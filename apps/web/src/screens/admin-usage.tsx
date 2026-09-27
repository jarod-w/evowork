/**
 * 用量与配额。
 *
 * **只有当期聚合**（Q43=A）：没有按人按天的曲线，也没有明细导出 ——
 * 那会在云端拼出一条「谁什么时候在用产品」的时间线，而那正是这个产品承诺不做的事。
 * 这句话画在页面上，不只写在文档里：它是对外承诺的一部分。
 *
 * 额度提醒的开关在这一页：用尽不自动换便宜模型（Q11），所以**必须提前说**，
 * 否则用户的第一感知是任务跑一半停住。
 */
import { useState, type FormEvent } from 'react';

import {
  api,
  formatQuota,
  formatTokens,
  quotaPercent,
  who,
  type AdminUsage,
  type QuotaClassView,
  type TenantSettingsView,
} from '../api.js';
import {
  Async,
  Badge,
  Banner,
  Button,
  Checkbox,
  Dialog,
  Field,
  ProgressBar,
} from '../components.js';
import { useAction, useAsync } from '../use-async.js';

interface UsageData {
  readonly usage: AdminUsage;
  readonly classes: readonly QuotaClassView[];
  readonly settings: TenantSettingsView;
}

export function AdminUsagePage(props: { readonly onToast: (text: string) => void }) {
  const action = useAction();
  const [newClass, setNewClass] = useState(false);

  const loaded = useAsync<UsageData>(async () => {
    const [usage, classes, settings] = await Promise.all([
      api<AdminUsage>('/v1/admin/usage'),
      api<{ classes: QuotaClassView[] }>('/v1/admin/quota-classes'),
      api<TenantSettingsView>('/v1/admin/settings'),
    ]);
    if (!usage.ok) return usage;
    return {
      ok: true as const,
      data: {
        usage: usage.data,
        classes: classes.ok ? classes.data.classes : [],
        settings: settings.ok
          ? settings.data
          : { warnMember: true, warnPercent: 80, warnAdmin: true },
      },
    };
  }, []);

  return (
    <>
      {action.error ? <Banner tone="danger">{action.error}</Banner> : null}
      <Async
        state={loaded.state}
        onRetry={loaded.reload}
        children={(data) => {
          const sorted = [...data.usage.members].sort((a, b) => b.used - a.used);
          return (
            <>
              <div className="ew-cols">
                <section className="ew-card ew-col-main">
                  <span className="ew-cell-stack">
                    <span className="ew-muted">本租户当期总量</span>
                    <span className="ew-stat-value">{formatTokens(data.usage.tenantUsed)}</span>
                    <span className="ew-muted">tokens · 按 token 计量，不折算成套餐</span>
                  </span>
                </section>
                <section className="ew-card ew-col-side" data-tone="sunken">
                  <p className="ew-muted">
                    这一页<b>只有当期聚合</b>
                    。没有按人按天的曲线，也没有明细导出 ——
                    那会在云端拼出一条「谁什么时候在用产品」的时间线，而那正是这个产品承诺不做的事。
                  </p>
                </section>
              </div>

              <div className="ew-cols">
                <div className="ew-col-main">
                  <div className="ew-table-wrap">
                    <table className="ew-table">
                      <thead>
                        <tr>
                          <th>用户</th>
                          <th>当期累计 / 上限</th>
                          <th>班级</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sorted.map((row) => (
                          <tr key={row.id}>
                            <td>{who(row)}</td>
                            <td>
                              <span className="ew-cell">
                                <span className="ew-cell-stack">
                                  <span className="ew-muted">
                                    {formatQuota(row.used, row.limit)}
                                  </span>
                                  {row.limit > 0 ? (
                                    <ProgressBar
                                      percent={quotaPercent(row.used, row.limit)}
                                      tone={row.exhausted ? 'danger' : 'accent'}
                                      label={`${who(row)} 的额度`}
                                    />
                                  ) : null}
                                </span>
                                {row.exhausted ? <Badge tone="danger">已耗尽</Badge> : null}
                              </span>
                            </td>
                            <td className="ew-muted">{row.quotaClass}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className="ew-table-foot">
                      <span className="ew-muted">
                        按当期累计排序 · 共 {data.usage.members.length} 人
                      </span>
                    </div>
                  </div>
                </div>

                <aside className="ew-col-side">
                  <section className="ew-card">
                    <span className="ew-card-head">
                      <h2>配额班级</h2>
                      <span className="ew-grow" />
                      <Button variant="quiet" size="sm" onClick={() => setNewClass(true)}>
                        新建班级
                      </Button>
                    </span>
                    {data.classes.map((cls) => (
                      <span className="ew-list-row" key={cls.name}>
                        <span className="ew-grow">{cls.name}</span>
                        <span className="ew-muted">
                          {cls.tokensLimit <= 0
                            ? '不设上限'
                            : `${cls.tokensLimit.toLocaleString('zh-CN')} tokens`}
                        </span>
                      </span>
                    ))}
                    <p className="ew-micro">
                      班级只配上限，不收款。单人可以在成员页覆盖。没有充值、升级或套餐。
                    </p>
                  </section>

                  <section className="ew-card">
                    <h2>用尽之前提醒</h2>
                    <Checkbox
                      label={`成员到 ${data.settings.warnPercent}% 时邮件提醒本人`}
                      checked={data.settings.warnMember}
                      onChange={(checked) => {
                        loaded.set({
                          ...data,
                          settings: { ...data.settings, warnMember: checked },
                        });
                        void action.run(() =>
                          api('/v1/admin/settings', {
                            method: 'POST',
                            body: JSON.stringify({ warnMember: checked }),
                          }),
                        );
                      }}
                    />
                    <Checkbox
                      label="有人耗尽时汇总提醒管理员"
                      checked={data.settings.warnAdmin}
                      onChange={(checked) => {
                        loaded.set({
                          ...data,
                          settings: { ...data.settings, warnAdmin: checked },
                        });
                        void action.run(() =>
                          api('/v1/admin/settings', {
                            method: 'POST',
                            body: JSON.stringify({ warnAdmin: checked }),
                          }),
                        );
                      }}
                    />
                    <p className="ew-micro">
                      用尽不会自动换成便宜的模型，所以必须提前说。提醒只带「用了多少」这一个数字，
                      不带任何任务信息。
                    </p>
                  </section>
                </aside>
              </div>

              {newClass ? (
                <ClassDialog
                  busy={action.busy}
                  onCancel={() => setNewClass(false)}
                  onSubmit={(name, tokensLimit) =>
                    void action.run(
                      () =>
                        api('/v1/admin/quota-classes', {
                          method: 'POST',
                          body: JSON.stringify({ name, tokensLimit }),
                        }),
                      () => {
                        setNewClass(false);
                        props.onToast('已保存配额班级');
                        loaded.reload();
                      },
                    )
                  }
                />
              ) : null}
            </>
          );
        }}
      />
    </>
  );
}

function ClassDialog(props: {
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: (name: string, tokensLimit: number) => void;
}) {
  const [name, setName] = useState('');
  const [limit, setLimit] = useState('');
  const parsed = Number(limit.replace(/[,\s]/g, ''));
  const valid = name.trim() !== '' && limit.trim() !== '' && Number.isFinite(parsed) && parsed >= 0;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (valid) props.onSubmit(name.trim(), parsed);
  }

  return (
    <Dialog
      title="新建配额班级"
      confirmLabel="保存班级"
      busy={props.busy}
      confirmDisabled={!valid}
      confirmDisabledReason="班级名和上限都要填"
      onCancel={props.onCancel}
      onConfirm={() => props.onSubmit(name.trim(), parsed)}
    >
      <form onSubmit={submit}>
        <Field label="班级名" name="name" required value={name} onChange={setName} />
        <Field
          label="token 上限"
          name="tokensLimit"
          required
          value={limit}
          onChange={setLimit}
          hint={
            <>
              填 <b>0 表示不限</b>。
            </>
          }
        />
      </form>
    </Dialog>
  );
}
