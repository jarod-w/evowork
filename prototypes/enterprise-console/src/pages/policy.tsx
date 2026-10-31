import { Fragment, useState } from 'react';
import { useConsole } from '../console';
import { PATH, canEditPolicy, issuedPolicy, type PolicyBody, type PolicyPack } from '../model';
import { Badge, Button, Callout, Modal, PageHead, Table } from '../ui';

function bodyOf(pack: PolicyPack): PolicyBody {
  return {
    name: pack.name,
    note: pack.note,
    reason: pack.reason,
    expiresInDays: pack.expiresInDays,
    confidentialNeedsAssessedModel: pack.confidentialNeedsAssessedModel,
    highSecretNoMemory: pack.highSecretNoMemory,
    allowCustomModel: pack.allowCustomModel,
    userMemorySea: pack.userMemorySea,
    userMemoryJp: pack.userMemoryJp,
    teamMemory: pack.teamMemory,
    defaultToolsNone: pack.defaultToolsNone,
  };
}

function lines(body: PolicyBody) {
  return [
    ['名称', body.name],
    ['说明', body.note || '—'],
    ['给成员看的原因', body.reason],
    ['有效期', `${body.expiresInDays} 天。到期后客户端转为只读`],
    ['机密数据', body.confidentialNeedsAssessedModel ? '只能走已评估模型' : '可以走未评估模型'],
    ['高度机密', body.highSecretNoMemory ? '不写入长期记忆' : '可以写入长期记忆'],
    ['成员自备模型', body.allowCustomModel ? '允许' : '禁止'],
    [
      '用户级记忆',
      `东南亚总部${body.userMemorySea ? '开' : '关'}，日本子公司${body.userMemoryJp ? '开' : '关'}`,
    ],
    ['团队级记忆', body.teamMemory ? '开' : '关'],
    ['工具默认', body.defaultToolsNone ? '关闭，逐个授权' : '放开'],
  ] as const;
}

function changedLines(base: PolicyBody, next: PolicyBody) {
  const before = new Map(lines(base).map((row) => [row[0], row[1]]));
  return lines(next)
    .filter((row) => before.get(row[0]) !== row[1])
    .map((row) => `${row[0]}：${before.get(row[0])} → ${row[1]}`);
}

export function PolicyPage() {
  const console = useConsole();
  const current = issuedPolicy(console.packs);
  const draft = console.policyDraft;
  const editable = canEditPolicy(console.role);
  const mine = draft?.createdRole === console.role;
  const [signing, setSigning] = useState(false);
  const [armed, setArmed] = useState(false);
  const diff = draft ? changedLines(bodyOf(current), draft) : [];

  return (
    <>
      <PageHead
        title="策略"
        lede="先保存草稿，再由另一名管理员签发。签发后设备下次启动时拉取，概览只看有没有跟上。"
      />
      <div className="stack">
        <section className="card">
          <div className="row">
            <h2>当前生效 · v{current.version}</h2>
            <Badge tone="ok">已签发</Badge>
          </div>
          <p className="tiny">
            {current.createdBy} 于 {current.createdAt} 创建，{current.signedBy} 于{' '}
            {current.signedAt} 签发。签名有效。
          </p>
          <PolicyFacts body={current} />
        </section>
        {draft ? (
          <section className="card">
            <div className="row">
              <h2>草稿</h2>
              <Badge tone="warn">未签发</Badge>
            </div>
            <p className="tiny">
              {draft.createdBy} 于 {draft.createdAt} 创建。设备仍使用 v{current.version}。
            </p>
            <PolicyFacts body={draft} />
            {diff.length > 0 ? (
              <Callout tone="warn">
                相对 v{current.version}：{diff.join('；')}
              </Callout>
            ) : (
              <Callout>内容和当前生效的策略一样。</Callout>
            )}
            {editable ? (
              <div className="actions">
                {mine ? (
                  <>
                    <Button onClick={() => console.navigate(PATH.policyNew)}>继续编辑</Button>
                    <Button tone="danger" onClick={() => console.discardPolicyDraft('drop')}>
                      放弃草稿
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      tone="primary"
                      onClick={() => {
                        setArmed(false);
                        setSigning(true);
                      }}
                    >
                      签发
                    </Button>
                    <Button onClick={() => console.discardPolicyDraft('return')}>退回草稿</Button>
                  </>
                )}
              </div>
            ) : null}
          </section>
        ) : null}
        {editable && !draft ? (
          <div className="actions">
            <Button tone="primary" onClick={() => console.navigate(PATH.policyNew)}>
              创建草稿
            </Button>
          </div>
        ) : null}
        <section className="card">
          <h2>已签发的版本</h2>
          <Table head={['版本', '名称', '创建', '签发']}>
            {console.packs.map((pack) => (
              <tr key={pack.id}>
                <td>v{pack.version}</td>
                <td>{pack.name}</td>
                <td>
                  {pack.createdBy} · {pack.createdAt}
                </td>
                <td>
                  {pack.signedBy} · {pack.signedAt}
                </td>
              </tr>
            ))}
          </Table>
        </section>
      </div>
      <Modal
        open={signing}
        title={`签发草稿，成为 v${current.version + 1}`}
        onClose={() => setSigning(false)}
      >
        <p className="muted">
          签发之后设备下次启动时拉取。还没拉到的电脑继续用 v{current.version}
          。起草人不能给自己的草稿签发。
        </p>
        <label className="check">
          <input
            type="checkbox"
            checked={armed}
            onChange={(event) => setArmed(event.target.checked)}
          />
          我确认签发
        </label>
        <div className="actions">
          <Button onClick={() => setSigning(false)}>取消</Button>
          <Button
            tone="primary"
            disabled={!armed}
            onClick={() => {
              console.signPolicy();
              setSigning(false);
            }}
          >
            签发
          </Button>
        </div>
      </Modal>
    </>
  );
}

export function PolicyDraftPage() {
  const console = useConsole();
  const current = issuedPolicy(console.packs);
  const existing = console.policyDraft;
  const locked = existing !== null && existing.createdRole !== console.role;
  const [body, setBody] = useState<PolicyBody>(() =>
    existing ? { ...existing } : bodyOf(current),
  );

  if (!canEditPolicy(console.role) || locked) {
    return (
      <>
        <PageHead title="创建策略" lede="这份草稿不能在当前身份下修改。" />
        <Button onClick={() => console.navigate(PATH.policy)}>返回策略</Button>
      </>
    );
  }

  function set<K extends keyof PolicyBody>(key: K, value: PolicyBody[K]) {
    setBody((currentBody) => ({ ...currentBody, [key]: value }));
  }

  return (
    <>
      <PageHead
        title={existing ? '编辑草稿' : '创建策略'}
        lede="保存后只是草稿。签发在策略页，并且必须由另一名管理员来做。"
      />
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          if (console.savePolicyDraft(body)) console.navigate(PATH.policy);
        }}
      >
        <section className="card">
          <div className="form-grid">
            <label className="field">
              名称
              <input
                type="text"
                value={body.name}
                onChange={(event) => set('name', event.target.value)}
              />
            </label>
            <label className="field">
              有效天数
              <input
                type="number"
                min={1}
                max={3650}
                value={body.expiresInDays}
                onChange={(event) => set('expiresInDays', Number(event.target.value))}
              />
            </label>
          </div>
          <label className="field">
            说明
            <textarea value={body.note} onChange={(event) => set('note', event.target.value)} />
          </label>
          <label className="field">
            给成员看的原因
            <textarea value={body.reason} onChange={(event) => set('reason', event.target.value)} />
          </label>
          <p className="tiny">这句话会出现在客户端。要让人看得出是公司策略，而不是没配密钥。</p>
        </section>
        <section className="card">
          <h2>限制</h2>
          <Check
            label="机密及以上只能走已评估模型"
            checked={body.confidentialNeedsAssessedModel}
            onChange={(checked) => set('confidentialNeedsAssessedModel', checked)}
          />
          <Check
            label="高度机密不写入长期记忆"
            checked={body.highSecretNoMemory}
            onChange={(checked) => set('highSecretNoMemory', checked)}
          />
          <Check
            label="允许成员自备模型"
            checked={body.allowCustomModel}
            onChange={(checked) => set('allowCustomModel', checked)}
          />
          <Check
            label="东南亚总部打开用户级记忆"
            checked={body.userMemorySea}
            onChange={(checked) => set('userMemorySea', checked)}
          />
          <Check
            label="日本子公司打开用户级记忆"
            checked={body.userMemoryJp}
            onChange={(checked) => set('userMemoryJp', checked)}
          />
          <Check
            label="打开团队级记忆"
            checked={body.teamMemory}
            onChange={(checked) => set('teamMemory', checked)}
          />
          <Check
            label="工具默认关闭，逐个授权"
            checked={body.defaultToolsNone}
            onChange={(checked) => set('defaultToolsNone', checked)}
          />
        </section>
        <div className="actions">
          <Button onClick={() => console.navigate(PATH.policy)}>取消</Button>
          <Button tone="primary" type="submit">
            保存草稿
          </Button>
        </div>
      </form>
    </>
  );
}

function PolicyFacts({ body }: { body: PolicyBody }) {
  return (
    <dl className="kv">
      {lines(body).map((row) => (
        <Fragment key={row[0]}>
          <dt>{row[0]}</dt>
          <dd>{row[1]}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

function Check({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="check">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  );
}
