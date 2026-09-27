/**
 * 策略与审计。
 *
 * 三件原先没有的事：
 *
 * 1. **签发向导 + diff** —— 这是全站唯一「点一下影响租户每台设备」的动作，
 *    原先却是九个字段的裸表单，停用模型还是**逗号分隔的自由文本**：
 *    打错一个 id 不会报错，它会安安静静下发到每台设备然后什么也没锁住。
 * 2. **生效面** —— 下发是拉取不是推送，「已签发」不等于「已生效」。
 * 3. **撤销要确认** —— 它解的是全租户每台设备的锁，原先点完即生效。
 *
 * 审计可以导出 CSV：这张表本来就是给审计看的。**用量明细不能导出**（Q43=A）——
 * 那是另一类数据，导出来就能拼出一条「谁什么时候在用」的时间线。
 */
import { useMemo, useState } from 'react';

import {
  api,
  auditActionLabel,
  auditToCsv,
  daysUntil,
  formatDay,
  formatTime,
  who,
  type IdentityAuditView,
  type PolicyPackView,
  type PolicyReachView,
  type PublicModel,
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
  StatusDot,
} from '../components.js';
import { useAction, useAsync } from '../use-async.js';

/** 权限档的对外文案与 `services/policy` 的 `PROFILE_COPY` 同源，别在这里另造名字。 */
const PROFILES = [
  { id: 'evowork-ask', name: '只读' },
  { id: 'evowork-plan', name: '只读 + 联网' },
  { id: 'evowork-workspace', name: '默认权限' },
  { id: 'evowork-full', name: '完全访问' },
];

interface PolicyData {
  readonly current: PolicyPackView | null;
  readonly history: readonly PolicyPackView[];
  readonly reach: PolicyReachView;
  readonly audit: readonly IdentityAuditView[];
  readonly models: readonly PublicModel[];
}

export function AdminPolicy(props: {
  readonly wizardOpen: boolean;
  readonly onWizardOpen: (open: boolean) => void;
  readonly onToast: (text: string) => void;
}) {
  const action = useAction();
  const [revoking, setRevoking] = useState(false);

  const loaded = useAsync<PolicyData>(async () => {
    const [packs, reach, audit, models] = await Promise.all([
      api<{ current: PolicyPackView | null; history: PolicyPackView[] }>('/v1/admin/policy-pack'),
      api<PolicyReachView>('/v1/admin/policy-pack/reach'),
      api<{ events: IdentityAuditView[] }>('/v1/admin/audit'),
      api<{ models: PublicModel[] }>('/v1/admin/models'),
    ]);
    if (!packs.ok) return packs;
    return {
      ok: true as const,
      data: {
        current: packs.data.current,
        history: packs.data.history,
        reach: reach.ok ? reach.data : { total: 0, pulled: 0, stale: [] },
        audit: audit.ok ? audit.data.events : [],
        models: models.ok ? models.data.models : [],
      },
    };
  }, []);

  return (
    <>
      {action.error ? <Banner tone="danger">{action.error}</Banner> : null}
      <Async
        state={loaded.state}
        onRetry={loaded.reload}
        children={(data) => (
          <>
            {data.current ? (
              <CurrentPack pack={data.current} onRevoke={() => setRevoking(true)} />
            ) : (
              <section className="ew-card">
                <h2>当前没有生效的策略包</h2>
                <p className="ew-muted">
                  设备上没有企业策略：成员可以用自己的模型、用全部权限档。
                  签发一份之后，设备会在下次启动或登录时拉到。
                </p>
                <div className="ew-actions">
                  <Button variant="primary" icon="policy" onClick={() => props.onWizardOpen(true)}>
                    签发策略包
                  </Button>
                </div>
              </section>
            )}

            {data.current ? <Reach reach={data.reach} /> : null}

            <section className="ew-card">
              <h2>签发历史</h2>
              {data.history.length === 0 ? (
                <p className="ew-muted">还没有签发记录。</p>
              ) : (
                data.history.map((pack) => (
                  <span className="ew-timeline-row" key={pack.id}>
                    <span
                      className="ew-timeline-dot"
                      data-current={
                        !pack.revoked && pack.id === data.current?.id ? 'true' : undefined
                      }
                    />
                    <span className="ew-grow">
                      {formatTime(pack.issuedAt)} ·{' '}
                      {who({ email: pack.actorEmail, phone: pack.actorPhone })} 签发
                      <span className="ew-muted">
                        {' '}
                        · 自定义模型{pack.allowCustom ? '允许' : '已锁定'}
                        {pack.disabledModels.length > 0
                          ? ` · 停用 ${pack.disabledModels.join('、')}`
                          : ''}
                      </span>
                    </span>
                    {pack.revoked ? (
                      <Badge tone="danger">已撤销</Badge>
                    ) : pack.id === data.current?.id ? (
                      <Badge tone="success">生效中</Badge>
                    ) : (
                      <Badge>已被覆盖</Badge>
                    )}
                  </span>
                ))
              )}
            </section>

            <AuditTable rows={data.audit} />

            {props.wizardOpen ? (
              <IssueWizard
                models={data.models}
                current={data.current}
                deviceCount={data.reach.total}
                staleCount={data.reach.stale.length}
                busy={action.busy}
                error={action.error}
                onCancel={() => props.onWizardOpen(false)}
                onSubmit={(body) =>
                  void action.run(
                    () =>
                      api('/v1/admin/policy-pack', { method: 'POST', body: JSON.stringify(body) }),
                    () => {
                      props.onWizardOpen(false);
                      props.onToast(`已签发 · ${data.reach.total} 台设备下次启动时拉取`);
                      loaded.reload();
                    },
                  )
                }
              />
            ) : null}

            {revoking ? (
              <RevokeDialog
                deviceCount={data.reach.total}
                busy={action.busy}
                onCancel={() => setRevoking(false)}
                onConfirm={() =>
                  void action.run(
                    () => api('/v1/admin/policy-pack/revoke', { method: 'POST', body: '{}' }),
                    () => {
                      setRevoking(false);
                      props.onToast('已撤销当前策略包');
                      loaded.reload();
                    },
                  )
                }
              />
            ) : null}
          </>
        )}
      />
    </>
  );
}

function CurrentPack(props: { readonly pack: PolicyPackView; readonly onRevoke: () => void }) {
  const pack = props.pack;
  const total = Math.max(1, Math.round((pack.expiresAt - pack.issuedAt) / 86_400));
  const left = daysUntil(pack.expiresAt);
  const elapsed = Math.max(0, Math.min(100, Math.round(((total - left) / total) * 100)));

  return (
    <section className="ew-card">
      <span className="ew-cell">
        <StatusDot tone={left > 0 ? 'success' : 'warning'} />
        <span className="ew-cell-stack ew-grow">
          <h2>当前生效的策略包</h2>
          <span className="ew-muted">
            {who({ email: pack.actorEmail, phone: pack.actorPhone })} 于 {formatTime(pack.issuedAt)}{' '}
            签发 · <span className="ew-mono">kid={pack.kid}</span>
          </span>
        </span>
        <Button variant="danger-ghost" onClick={props.onRevoke}>
          撤销…
        </Button>
      </span>

      <div className="ew-cell-stack">
        <span className="ew-cell">
          <span className="ew-strong">
            {total} 天有效期{left > 0 ? `已过 ${total - left} 天` : '已到期'}
          </span>
          <span className="ew-grow" />
          <span className="ew-muted">
            {formatDay(pack.expiresAt)}到期
            {pack.graceUntil !== undefined
              ? ` · 宽限至 ${formatDay(pack.graceUntil)}，之后设备转只读`
              : ' · 之后设备转只读'}
          </span>
        </span>
        <ProgressBar
          percent={elapsed}
          tone={left <= 3 ? 'warning' : 'accent'}
          label="策略包有效期"
        />
      </div>

      <dl className="ew-kv">
        <div className="ew-kv-row">
          <dt>停用模型</dt>
          <dd className="ew-mono">
            {pack.disabledModels.length > 0 ? pack.disabledModels.join('、') : '无'}
          </dd>
        </div>
        <div className="ew-kv-row">
          <dt>停用权限档</dt>
          <dd className="ew-mono">
            {pack.disabledProfiles.length > 0 ? pack.disabledProfiles.join('、') : '无'}
          </dd>
        </div>
        <div className="ew-kv-row">
          <dt>自定义模型</dt>
          <dd className={pack.allowCustom ? undefined : 'ew-error'}>
            {pack.allowCustom ? '允许' : '已锁定'}
          </dd>
        </div>
        <div className="ew-kv-row">
          <dt>只允许管理员 hooks</dt>
          <dd>{pack.allowManagedHooksOnly ? '是' : '否'}</dd>
        </div>
        <div className="ew-kv-row">
          <dt>禁用分享</dt>
          <dd>{pack.disableShare ? '是' : '否'}</dd>
        </div>
        <div className="ew-kv-row">
          <dt>强制审计</dt>
          <dd>{pack.forceAudit ? '是' : '否'}</dd>
        </div>
      </dl>

      {pack.reason ? (
        <Banner tone="warning">
          给用户看的原因：<b>「{pack.reason}」</b> ——
          客户端会原样显示这句话，所以它必须说清这是策略，不是「你没配密钥」。
        </Banner>
      ) : null}
    </section>
  );
}

function Reach(props: { readonly reach: PolicyReachView }) {
  const percent =
    props.reach.total === 0 ? 0 : Math.round((props.reach.pulled / props.reach.total) * 100);
  return (
    <section className="ew-card">
      <span className="ew-card-head">
        <h2>这份包生效到哪了</h2>
        <span className="ew-muted">
          {props.reach.total} 台设备中 {props.reach.pulled} 台已拉取
        </span>
        <span className="ew-grow" />
        <span className="ew-muted">设备下次启动或登录时拉取，不是推送</span>
      </span>
      <ProgressBar
        percent={percent}
        tone={props.reach.stale.length > 0 ? 'warning' : 'accent'}
        label="策略包生效进度"
      />
      {props.reach.stale.length === 0 ? (
        <p className="ew-muted">所有设备都已经拿到这一份。</p>
      ) : (
        props.reach.stale.map((device) => (
          <span className="ew-list-row" key={device.deviceId}>
            <StatusDot tone="warning" />
            <span className="ew-grow">
              {device.name}
              {device.ownerEmail ? <span className="ew-muted"> · {device.ownerEmail}</span> : null}
            </span>
            <span className="ew-muted">
              {device.pulledAt === undefined
                ? '从没拉过策略包'
                : `仍是 ${formatDay(device.pulledAt)}拉的包`}{' '}
              · 最后活跃 {formatTime(device.lastSeenAt)}
            </span>
          </span>
        ))
      )}
    </section>
  );
}

function AuditTable(props: { readonly rows: readonly IdentityAuditView[] }) {
  const [days, setDays] = useState(30);
  const cutoff = Date.now() - days * 86_400_000;
  const rows = useMemo(
    () => props.rows.filter((row) => (row.at < 1e12 ? row.at * 1000 : row.at) >= cutoff),
    [props.rows, cutoff],
  );

  function exportCsv() {
    const blob = new Blob([` ${auditToCsv(rows)}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `evowork-audit-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="ew-card">
      <span className="ew-card-head">
        <h2>管理动作审计</h2>
        <span className="ew-muted">时间按你所在时区显示</span>
        <span className="ew-grow" />
        <select
          className="ew-select"
          aria-label="时间范围"
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
        >
          <option value={7}>最近 7 天</option>
          <option value={30}>最近 30 天</option>
          <option value={365}>最近一年</option>
        </select>
        <Button icon="download" onClick={exportCsv}>
          导出 CSV
        </Button>
      </span>

      {rows.length === 0 ? (
        <p className="ew-muted">这段时间里没有管理动作。</p>
      ) : (
        <div className="ew-table-wrap">
          <table className="ew-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>动作</th>
                <th>操作人</th>
                <th>对象</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.at}-${row.action}-${row.targetRef ?? row.targetEmail ?? ''}`}>
                  <td className="ew-muted">{formatTime(row.at)}</td>
                  <td>{auditActionLabel(row.action)}</td>
                  <td className="ew-muted">
                    {who({ email: row.actorEmail, phone: row.actorPhone })}
                  </td>
                  <td className="ew-muted">
                    {row.targetEmail ?? row.targetPhone ?? ''}
                    {row.targetRef ? <span className="ew-mono"> {row.targetRef}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="ew-micro">
        这张表只记<b>身份与策略动作</b>
        ：谁授予/收回了管理员、改了默认模型密钥、签发或撤销了策略包、邀请了谁。
        它可以导出，因为它本来就是给审计看的。<b>用量明细不能导出</b> —— 那是另一类数据。
      </p>
    </section>
  );
}

/* ───────────────────────────── 签发向导 ───────────────────────────── */

export interface PackDraft {
  readonly disabledModels: readonly string[];
  readonly disabledProfiles: readonly string[];
  readonly allowCustom: boolean;
  readonly allowManagedHooksOnly: boolean;
  readonly disableShare: boolean;
  readonly forceAudit: boolean;
  readonly expiresInDays: number;
  readonly graceInDays: string;
  readonly reason: string;
}

const EMPTY_DRAFT: PackDraft = {
  disabledModels: [],
  disabledProfiles: [],
  allowCustom: true,
  allowManagedHooksOnly: false,
  disableShare: false,
  forceAudit: false,
  expiresInDays: 30,
  graceInDays: '',
  reason: '',
};

function toggle(list: readonly string[], value: string): readonly string[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

export function IssueWizard(props: {
  readonly models: readonly PublicModel[];
  readonly current: PolicyPackView | null;
  readonly deviceCount: number;
  readonly staleCount: number;
  readonly busy: boolean;
  readonly error: string | undefined;
  readonly onCancel: () => void;
  readonly onSubmit: (body: Record<string, unknown>) => void;
}) {
  const [step, setStep] = useState(1);
  const [draft, setDraft] = useState<PackDraft>(() =>
    props.current
      ? {
          ...EMPTY_DRAFT,
          disabledModels: props.current.disabledModels,
          disabledProfiles: props.current.disabledProfiles,
          allowCustom: props.current.allowCustom,
          allowManagedHooksOnly: props.current.allowManagedHooksOnly,
          disableShare: props.current.disableShare,
          forceAudit: props.current.forceAudit,
          reason: props.current.reason ?? '',
        }
      : EMPTY_DRAFT,
  );

  const diff = useMemo(() => buildDiff(props.current, draft), [props.current, draft]);
  const reasonNeeded = !draft.allowCustom || draft.disabledModels.length > 0;
  const canIssue = draft.expiresInDays >= 1 && (!reasonNeeded || draft.reason.trim() !== '');

  return (
    <Dialog
      title="签发策略包"
      wide
      confirmLabel={step < 3 ? '下一步' : `签发并下发给 ${props.deviceCount} 台设备`}
      busy={props.busy}
      confirmDisabled={step === 3 && !canIssue}
      confirmDisabledReason="锁掉模型或自定义模型时，必须填一句给用户看的原因"
      cancelLabel={step === 1 ? '取消' : '上一步'}
      onCancel={() => (step === 1 ? props.onCancel() : setStep((n) => n - 1))}
      onConfirm={() => {
        if (step < 3) {
          setStep((n) => n + 1);
          return;
        }
        props.onSubmit({
          expiresInDays: draft.expiresInDays,
          ...(draft.graceInDays ? { graceInDays: Number(draft.graceInDays) } : {}),
          disabledModels: draft.disabledModels,
          disabledProfiles: draft.disabledProfiles,
          allowCustom: draft.allowCustom,
          ...(draft.reason.trim() ? { reason: draft.reason.trim() } : {}),
          allowManagedHooksOnly: draft.allowManagedHooksOnly,
          disableShare: draft.disableShare,
          disableSlots: false,
          forceAudit: draft.forceAudit,
        });
      }}
    >
      <div className="ew-steps">
        <span className="ew-step" data-state={step === 1 ? 'current' : 'done'}>
          ① 选择限制
        </span>
        <span className="ew-step" data-state={step === 2 ? 'current' : step > 2 ? 'done' : 'idle'}>
          ② 有效期与原因
        </span>
        <span className="ew-step" data-state={step === 3 ? 'current' : 'idle'}>
          ③ 确认
        </span>
      </div>

      {step === 1 ? (
        <>
          <fieldset className="ew-field">
            <legend className="ew-label">停用哪些模型</legend>
            <p className="ew-muted">
              从这个租户已经配好的模型里选。<b>不再是逗号分隔的自由文本</b> —— 打错一个 id
              不会报错，它会安安静静下发到每台设备然后什么也没锁住。
            </p>
            {props.models.length === 0 ? (
              <p className="ew-muted">还没有配置默认模型，没有可停用的。</p>
            ) : (
              <div className="ew-actions">
                {props.models.map((model) => (
                  <Checkbox
                    key={model.id}
                    label={model.displayName}
                    checked={draft.disabledModels.includes(model.id)}
                    onChange={() =>
                      setDraft((d) => ({
                        ...d,
                        disabledModels: toggle(d.disabledModels, model.id),
                      }))
                    }
                  />
                ))}
              </div>
            )}
          </fieldset>

          <fieldset className="ew-field">
            <legend className="ew-label">停用哪些权限档</legend>
            <div className="ew-actions">
              {PROFILES.map((profile) => (
                <Checkbox
                  key={profile.id}
                  label={profile.name}
                  checked={draft.disabledProfiles.includes(profile.id)}
                  onChange={() =>
                    setDraft((d) => ({
                      ...d,
                      disabledProfiles: toggle(d.disabledProfiles, profile.id),
                    }))
                  }
                />
              ))}
            </div>
          </fieldset>

          <fieldset className="ew-field">
            <legend className="ew-label">其他开关</legend>
            <Checkbox
              label="锁定自定义模型"
              checked={!draft.allowCustom}
              onChange={(checked) => setDraft((d) => ({ ...d, allowCustom: !checked }))}
              why="锁上之后，没被加入租户的人会一个模型都没有 —— 第 ② 步的原因会原样显示给他们"
            />
            <Checkbox
              label="只允许管理员配置的 hooks"
              checked={draft.allowManagedHooksOnly}
              onChange={(checked) => setDraft((d) => ({ ...d, allowManagedHooksOnly: checked }))}
            />
            <Checkbox
              label="禁用分享"
              checked={draft.disableShare}
              onChange={(checked) => setDraft((d) => ({ ...d, disableShare: checked }))}
            />
            <Checkbox
              label="强制审计"
              checked={draft.forceAudit}
              onChange={(checked) => setDraft((d) => ({ ...d, forceAudit: checked }))}
            />
          </fieldset>
        </>
      ) : null}

      {step === 2 ? (
        <>
          <Field
            label="有效天数"
            name="expiresInDays"
            required
            value={String(draft.expiresInDays)}
            onChange={(value) => setDraft((d) => ({ ...d, expiresInDays: Number(value) || 0 }))}
            hint="到期之后设备转只读。1–3650 天。"
          />
          <Field
            label="宽限天数（可留空）"
            name="graceInDays"
            value={draft.graceInDays}
            onChange={(value) => setDraft((d) => ({ ...d, graceInDays: value }))}
            hint="到期后的缓冲期，方便你在这段时间里补签一份新的。"
          />
          <div className="ew-field">
            <label className="ew-label" htmlFor="pack-reason">
              给用户看的原因{reasonNeeded ? '（必填）' : '（可选）'}
            </label>
            <textarea
              id="pack-reason"
              className="ew-textarea"
              rows={2}
              value={draft.reason}
              onChange={(e) => setDraft((d) => ({ ...d, reason: e.target.value }))}
            />
            <span className="ew-muted">
              客户端会原样显示这句话。必须让人看出这是<b>公司策略</b>，而不是「你没配密钥」。
            </span>
          </div>
        </>
      ) : null}

      {step === 3 ? (
        <>
          <h3>与当前生效包的差异</h3>
          <div className="ew-diff">
            {diff.length === 0 ? (
              <span className="ew-muted">和当前生效的包完全一样。</span>
            ) : (
              diff.map((row) => (
                <span className="ew-diff-row" data-kind={row.kind} key={row.text}>
                  <span className="ew-diff-mark">{MARK[row.kind]}</span>
                  <span className="ew-grow">{row.text}</span>
                  <span className="ew-muted">{row.note}</span>
                </span>
              ))
            )}
          </div>

          <Banner tone="info">
            将下发给 <b>{props.deviceCount} 台设备</b>，它们在下次启动或登录时拉取。
            {props.staleCount > 0 ? (
              <>
                {' '}
                其中 <b>{props.staleCount} 台</b> 连当前这一份都还没拉到，会更晚生效。
              </>
            ) : null}
          </Banner>

          {reasonNeeded && draft.reason.trim() === '' ? (
            <Banner tone="warning">
              这份包锁掉了模型或自定义模型，<b>必须填一句给用户看的原因</b>
              ，否则他们只会看到一个点不动的下拉。
            </Banner>
          ) : null}

          {props.error ? <p className="ew-error ew-muted">{props.error}</p> : null}
        </>
      ) : null}
    </Dialog>
  );
}

const MARK: Record<DiffKind, string> = { add: '+', remove: '−', change: '~', same: '=' };

type DiffKind = 'add' | 'remove' | 'change' | 'same';

interface DiffRow {
  readonly kind: DiffKind;
  readonly text: string;
  readonly note: string;
}

/**
 * 与当前生效包的差异。
 *
 * **移除一条限制也要显式画出来**（`−`）：管理员最容易漏掉的不是"我加了什么"，
 * 而是"我这一份里没勾的那条，会把设备上已有的限制解开"。
 */
export function buildDiff(current: PolicyPackView | null, draft: PackDraft): readonly DiffRow[] {
  const rows: DiffRow[] = [];
  const before = current ?? {
    disabledModels: [] as readonly string[],
    disabledProfiles: [] as readonly string[],
    allowCustom: true,
    allowManagedHooksOnly: false,
    disableShare: false,
    forceAudit: false,
  };

  for (const id of draft.disabledModels) {
    if (!before.disabledModels.includes(id)) {
      rows.push({ kind: 'add', text: `停用模型 ${id}`, note: '新增' });
    }
  }
  for (const id of before.disabledModels) {
    if (!draft.disabledModels.includes(id)) {
      rows.push({ kind: 'remove', text: `停用模型 ${id}`, note: '移除 · 设备将恢复该模型' });
    }
  }
  for (const id of draft.disabledProfiles) {
    if (!before.disabledProfiles.includes(id)) {
      rows.push({ kind: 'add', text: `停用权限档 ${id}`, note: '新增' });
    }
  }
  for (const id of before.disabledProfiles) {
    if (!draft.disabledProfiles.includes(id)) {
      rows.push({ kind: 'remove', text: `停用权限档 ${id}`, note: '移除 · 设备将恢复该权限档' });
    }
  }

  const flags: readonly [keyof PackDraft & keyof typeof before, string][] = [
    ['allowCustom', '允许自定义模型'],
    ['allowManagedHooksOnly', '只允许管理员 hooks'],
    ['disableShare', '禁用分享'],
    ['forceAudit', '强制审计'],
  ];
  for (const [key, label] of flags) {
    const next = draft[key] as boolean;
    const prev = before[key] as boolean;
    rows.push(
      next === prev
        ? { kind: 'same', text: `${label} ${next ? '是' : '否'}`, note: '不变' }
        : {
            kind: 'change',
            text: `${label} ${prev ? '是' : '否'} → ${next ? '是' : '否'}`,
            note: '变更',
          },
    );
  }

  return rows;
}

function RevokeDialog(props: {
  readonly deviceCount: number;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const [understood, setUnderstood] = useState(false);
  return (
    <Dialog
      title="撤销当前策略包？"
      confirmLabel="撤销"
      confirmVariant="danger"
      busy={props.busy}
      confirmDisabled={!understood}
      confirmDisabledReason="先确认你知道这会解除全部限制"
      onCancel={props.onCancel}
      onConfirm={props.onConfirm}
    >
      <p className="ew-muted">
        {props.deviceCount} 台设备会在下次启动或登录时<b>解除全部限制</b>
        ，回到「没有策略」的状态 —— <b>不是回到上一份包</b>。
      </p>
      <Checkbox
        label="我知道自定义模型与被停用的权限档会重新可用"
        checked={understood}
        onChange={setUnderstood}
      />
    </Dialog>
  );
}
