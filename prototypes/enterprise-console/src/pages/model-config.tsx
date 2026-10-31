import { useState } from 'react';
import { useConsole } from '../console';
import { formatTokens, type CatalogModel, type Provider, type ProviderKind } from '../model';
import { Badge, Button, Callout, Modal, Table } from '../ui';

function kindLabel(kind: ProviderKind) {
  return kind === 'bedrock' ? 'Amazon Bedrock' : 'OpenAI 兼容端点';
}

function blankProvider(): Provider {
  return {
    id: '',
    name: '',
    kind: 'bedrock',
    endpoint: 'ap-southeast-1',
    auth: 'iam',
    vaultRef: '',
    enabled: true,
    assessed: false,
    assessor: '',
    assessedOn: '',
  };
}

function blankModel(providerId: string): CatalogModel {
  return {
    id: '',
    name: '',
    providerId,
    version: '',
    context: 128000,
    price: '',
    place: '区域内',
    keep: '不留存',
    train: '不用于训练',
    tools: true,
    structured: false,
    enabled: false,
    assessed: false,
    assessor: '',
    assessedOn: '',
  };
}

export function ProvidersPanel({ editable }: { editable: boolean }) {
  const console = useConsole();
  const [draft, setDraft] = useState<Provider | null>(null);

  return (
    <div className="stack">
      {!editable ? (
        <Callout>提供商由平台管理员配置。你可以查看端点、认证方式和评估状态。</Callout>
      ) : null}
      <div className="row">
        <p className="tiny">新增的提供商默认未评估，不能被别名选中。密钥只填保险库引用。</p>
        <Button tone="primary" disabled={!editable} onClick={() => setDraft(blankProvider())}>
          新增提供商
        </Button>
      </div>
      <Table head={['名称', '类型', '端点', '认证', '状态', '']}>
        {console.providers.map((provider) => (
          <tr key={provider.id}>
            <td>{provider.name}</td>
            <td>{kindLabel(provider.kind)}</td>
            <td>{provider.endpoint}</td>
            <td>
              {provider.auth === 'iam' ? '客户 IAM 角色' : provider.vaultRef || '缺少保险库引用'}
            </td>
            <td>
              <Badge tone={!provider.enabled ? 'danger' : provider.assessed ? 'ok' : 'warn'}>
                {!provider.enabled ? '停用' : provider.assessed ? '已评估' : '未评估'}
              </Badge>
            </td>
            <td>
              <div className="actions">
                <Button
                  className="btn--small"
                  disabled={!editable}
                  onClick={() => console.testProvider(provider.id)}
                >
                  测试
                </Button>
                <Button
                  className="btn--small"
                  disabled={!editable}
                  onClick={() => setDraft({ ...provider })}
                >
                  编辑
                </Button>
                <Button
                  className="btn--small"
                  tone={provider.enabled ? 'danger' : 'primary'}
                  disabled={!editable}
                  onClick={() => console.setProviderEnabled(provider.id, !provider.enabled)}
                >
                  {provider.enabled ? '停用' : '启用'}
                </Button>
              </div>
            </td>
          </tr>
        ))}
      </Table>
      <Modal
        open={draft !== null}
        title={draft?.id ? '编辑提供商' : '新增提供商'}
        onClose={() => setDraft(null)}
      >
        {draft ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (console.saveProvider(draft)) setDraft(null);
            }}
          >
            <div className="form-grid">
              <label className="field field--full">
                名称
                <input
                  type="text"
                  value={draft.name}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                />
              </label>
              <label className="field">
                类型
                <select
                  value={draft.kind}
                  onChange={(event) =>
                    setDraft({ ...draft, kind: event.target.value as Provider['kind'] })
                  }
                >
                  <option value="bedrock">Amazon Bedrock</option>
                  <option value="openai">OpenAI 兼容端点</option>
                </select>
              </label>
              <label className="field">
                {draft.kind === 'bedrock' ? '区域' : '基址 URL'}
                <input
                  type={draft.kind === 'bedrock' ? 'text' : 'url'}
                  value={draft.endpoint}
                  onChange={(event) => setDraft({ ...draft, endpoint: event.target.value })}
                />
              </label>
              <label className="field">
                认证
                <select
                  value={draft.auth}
                  onChange={(event) =>
                    setDraft({ ...draft, auth: event.target.value as Provider['auth'] })
                  }
                >
                  <option value="iam">客户 IAM 角色</option>
                  <option value="vault">保险库引用</option>
                </select>
              </label>
              {draft.auth === 'vault' ? (
                <label className="field">
                  保险库引用
                  <input
                    type="text"
                    placeholder="vault/bedrock-prod"
                    value={draft.vaultRef}
                    onChange={(event) => setDraft({ ...draft, vaultRef: event.target.value })}
                  />
                </label>
              ) : (
                <p className="field tiny">不保存访问密钥。调用使用客户账号里的 IAM 角色。</p>
              )}
              <label className="check field--full">
                <input
                  type="checkbox"
                  checked={draft.assessed}
                  onChange={(event) => setDraft({ ...draft, assessed: event.target.checked })}
                />
                已评估。未评估时不能进入别名路由
              </label>
              {draft.assessed ? (
                <>
                  <label className="field">
                    评估人
                    <input
                      type="text"
                      value={draft.assessor}
                      onChange={(event) => setDraft({ ...draft, assessor: event.target.value })}
                    />
                  </label>
                  <label className="field">
                    评估日期
                    <input
                      type="date"
                      value={draft.assessedOn}
                      onChange={(event) => setDraft({ ...draft, assessedOn: event.target.value })}
                    />
                  </label>
                </>
              ) : null}
              <label className="check">
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
                />
                启用
              </label>
            </div>
            <div className="actions">
              <Button onClick={() => setDraft(null)}>取消</Button>
              <Button tone="primary" type="submit">
                保存
              </Button>
            </div>
          </form>
        ) : null}
      </Modal>
    </div>
  );
}

export function CatalogPanel({ editable }: { editable: boolean }) {
  const console = useConsole();
  const [draft, setDraft] = useState<CatalogModel | null>(null);
  const firstProvider = console.providers[0]?.id ?? '';

  return (
    <div className="stack">
      {!editable ? (
        <Callout>模型目录由平台管理员维护。别名只能指向已启用且已评估的模型。</Callout>
      ) : null}
      <div className="row">
        <p className="tiny">上下文长度、价格、处理位置、留存和是否用于训练都在编辑里填写。</p>
        <Button
          tone="primary"
          disabled={!editable || console.providers.length === 0}
          onClick={() => setDraft(blankModel(firstProvider))}
        >
          新增模型
        </Button>
      </div>
      <Table head={['模型', '提供商', '版本', '上下文', '处理位置', '状态', '']}>
        {console.models.map((model) => {
          const provider = console.providers.find((item) => item.id === model.providerId);
          const ready = model.enabled && model.assessed && provider?.enabled && provider.assessed;
          return (
            <tr key={model.id}>
              <td>{model.name}</td>
              <td>{provider?.name ?? '缺少提供商'}</td>
              <td>{model.version}</td>
              <td className="num">{formatTokens(model.context)}</td>
              <td>{model.place}</td>
              <td>
                <Badge tone={ready ? 'ok' : !model.enabled ? 'danger' : 'warn'}>
                  {ready ? '可路由' : !model.enabled ? '停用' : '未评估'}
                </Badge>
              </td>
              <td>
                <div className="actions">
                  <Button
                    className="btn--small"
                    disabled={!editable}
                    onClick={() => setDraft({ ...model })}
                  >
                    编辑
                  </Button>
                  <Button
                    className="btn--small"
                    tone={model.enabled ? 'danger' : 'primary'}
                    disabled={!editable}
                    onClick={() => console.setModelEnabled(model.id, !model.enabled)}
                  >
                    {model.enabled ? '停用' : '启用'}
                  </Button>
                </div>
              </td>
            </tr>
          );
        })}
      </Table>
      <Modal
        open={draft !== null}
        title={draft?.id ? '编辑模型' : '新增模型'}
        onClose={() => setDraft(null)}
      >
        {draft ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (console.saveModel(draft)) setDraft(null);
            }}
          >
            <div className="form-grid">
              <label className="field">
                名称
                <input
                  type="text"
                  value={draft.name}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                />
              </label>
              <label className="field">
                提供商
                <select
                  value={draft.providerId}
                  onChange={(event) => setDraft({ ...draft, providerId: event.target.value })}
                >
                  {console.providers.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                版本
                <input
                  type="text"
                  value={draft.version}
                  onChange={(event) => setDraft({ ...draft, version: event.target.value })}
                />
              </label>
              <label className="field">
                上下文长度
                <input
                  type="number"
                  min={1}
                  value={draft.context}
                  onChange={(event) => setDraft({ ...draft, context: Number(event.target.value) })}
                />
              </label>
              <label className="field field--full">
                价格说明
                <input
                  type="text"
                  value={draft.price}
                  placeholder="例如：输入 3 / 百万 token"
                  onChange={(event) => setDraft({ ...draft, price: event.target.value })}
                />
              </label>
              <label className="field">
                处理位置
                <input
                  type="text"
                  value={draft.place}
                  onChange={(event) => setDraft({ ...draft, place: event.target.value })}
                />
              </label>
              <label className="field">
                是否留存
                <select
                  value={draft.keep}
                  onChange={(event) => setDraft({ ...draft, keep: event.target.value })}
                >
                  <option>不留存</option>
                  <option>留存</option>
                  <option>客户自管</option>
                  <option>未知</option>
                </select>
              </label>
              <label className="field">
                是否用于训练
                <select
                  value={draft.train}
                  onChange={(event) => setDraft({ ...draft, train: event.target.value })}
                >
                  <option>不用于训练</option>
                  <option>可能用于训练</option>
                  <option>未知</option>
                </select>
              </label>
              <div className="field">
                <span>能力</span>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={draft.tools}
                    onChange={(event) => setDraft({ ...draft, tools: event.target.checked })}
                  />
                  工具调用
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={draft.structured}
                    onChange={(event) => setDraft({ ...draft, structured: event.target.checked })}
                  />
                  结构化输出
                </label>
              </div>
              <label className="check field--full">
                <input
                  type="checkbox"
                  checked={draft.assessed}
                  onChange={(event) => setDraft({ ...draft, assessed: event.target.checked })}
                />
                已评估。未勾选时即使启用，也不能映射到别名
              </label>
              {draft.assessed ? (
                <>
                  <label className="field">
                    评估人
                    <input
                      type="text"
                      value={draft.assessor}
                      onChange={(event) => setDraft({ ...draft, assessor: event.target.value })}
                    />
                  </label>
                  <label className="field">
                    评估日期
                    <input
                      type="date"
                      value={draft.assessedOn}
                      onChange={(event) => setDraft({ ...draft, assessedOn: event.target.value })}
                    />
                  </label>
                </>
              ) : null}
              <label className="check">
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
                />
                启用
              </label>
            </div>
            <div className="actions">
              <Button onClick={() => setDraft(null)}>取消</Button>
              <Button tone="primary" type="submit">
                保存
              </Button>
            </div>
          </form>
        ) : null}
      </Modal>
    </div>
  );
}
