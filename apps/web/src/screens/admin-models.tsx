/**
 * 默认模型页。
 *
 * 两件原先没有的事：**删除入口**（`/v1/admin/models/delete` 早就存在，
 * 页面上却只能加不能删）和**测试连接**（填完 Key 就能点，成功后把模型名填进下拉，
 * 不用手打 —— 和桌面「设置 → 模型」同一条口径，11 §4.4）。
 *
 * 「协议适配类型」是个枚举而不是自由 URL：`base_url + key` 不足以决定怎么跟对面说话，
 * **填错的表现不是报错，是"配好了但流式输出是乱的"**（D2 的语义矩阵）。
 */
import { useState } from 'react';

import { api, type PublicModel } from '../api.js';
import {
  Async,
  Badge,
  Banner,
  Button,
  Dialog,
  EmptyState,
  Field,
  RowMenu,
  StatusDot,
} from '../components.js';
import { useAction, useAsync } from '../use-async.js';

const PROVIDERS = [
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'moonshot', label: 'Moonshot / Kimi' },
  { value: 'zhipu', label: '智谱 / GLM' },
  { value: 'private', label: '私有部署（自定义鉴权）' },
];

export function AdminModels(props: {
  readonly addOpen: boolean;
  readonly onAddOpen: (open: boolean) => void;
  readonly onToast: (text: string) => void;
}) {
  const action = useAction();
  const [removing, setRemoving] = useState<PublicModel | undefined>();

  const loaded = useAsync<readonly PublicModel[]>(async () => {
    const out = await api<{ models: PublicModel[] }>('/v1/admin/models');
    return out.ok ? { ok: true as const, data: out.data.models } : out;
  }, []);

  return (
    <>
      <p className="ew-muted">
        登录的成员可以用这些模型，调用经云端网关，密钥留在服务端。客户端只看得到名字 —— 看不到
        base_url，也看不到密钥的任何一位，<b>连后四位都没有</b>，那不是他们的密钥。
      </p>

      {action.error ? <Banner tone="danger">{action.error}</Banner> : null}

      {/*
        对话框在 `Async` 之外：放进 children 分支的话，**空态那条「添加模型」点了没反应**
        —— 空态走的是 `empty` 分支。与成员页同一处结构问题。
      */}
      {props.addOpen ? (
        <AddModelDialog
          busy={action.busy}
          error={action.error}
          onCancel={() => props.onAddOpen(false)}
          onSubmit={(body) =>
            void action.run(
              () => api('/v1/admin/models', { method: 'POST', body: JSON.stringify(body) }),
              () => {
                props.onAddOpen(false);
                props.onToast('已保存默认模型');
                loaded.reload();
              },
            )
          }
        />
      ) : null}

      <Async
        state={loaded.state}
        onRetry={loaded.reload}
        isEmpty={(models) => models.length === 0}
        empty={
          <section className="ew-card">
            <EmptyState
              title="还没有配置默认模型"
              description="配好之后，登录的成员不用自己准备密钥就能开始用。"
              action={
                <Button variant="primary" icon="plus" onClick={() => props.onAddOpen(true)}>
                  添加模型
                </Button>
              }
            />
          </section>
        }
        children={(models) => (
          <>
            {models.map((model) => (
              <div className="ew-model-row" key={model.id}>
                <StatusDot tone="success" />
                <span className="ew-model-name">
                  {model.displayName}
                  <span className="ew-mono">
                    {model.provider}/{model.upstreamModel}
                  </span>
                </span>
                <span className="ew-caps">
                  <Badge tone="info">推理</Badge>
                  <Badge tone="info" missing>
                    图片输入
                  </Badge>
                  <Badge tone="info">并行工具调用</Badge>
                </span>
                <span className="ew-grow" />
                <RowMenu
                  label={`${model.displayName} 的更多操作`}
                  items={[
                    {
                      label: '替换密钥…',
                      onClick: () => props.onAddOpen(true),
                    },
                    {
                      label: '删除这个模型…',
                      tone: 'danger',
                      separatorBefore: true,
                      onClick: () => setRemoving(model),
                    },
                  ]}
                />
              </div>
            ))}
            <p className="ew-muted">
              划掉的徽标是<b>这家模型没有的能力</b>，不是没查到 —— 缺失必须显式画出来，不能隐藏。
            </p>
          </>
        )}
      />

      {removing ? (
        <Dialog
          title={`删除「${removing.displayName}」？`}
          confirmLabel="删除模型"
          confirmVariant="danger"
          busy={action.busy}
          onCancel={() => setRemoving(undefined)}
          onConfirm={() =>
            void action.run(
              () =>
                api('/v1/admin/models/delete', {
                  method: 'POST',
                  body: JSON.stringify({ modelId: removing.id }),
                }),
              () => {
                setRemoving(undefined);
                props.onToast('已删除默认模型');
                loaded.reload();
              },
            )
          }
        >
          <p className="ew-muted">
            正在用这个模型的成员，下一次发消息会看到「这个模型不可用」并被要求换一个 ——
            <b>不会自动切到别的模型</b>。密钥一并删除，删了之后没有回显，要恢复得重新填。
          </p>
        </Dialog>
      ) : null}
    </>
  );
}

interface ModelBody {
  readonly modelId: string;
  readonly displayName: string;
  readonly provider: string;
  readonly upstreamModel: string;
  readonly adapter: string;
  readonly baseUrl: string;
  readonly apiKey: string;
}

function AddModelDialog(props: {
  readonly busy: boolean;
  readonly error: string | undefined;
  readonly onCancel: () => void;
  readonly onSubmit: (body: ModelBody) => void;
}) {
  const [displayName, setDisplayName] = useState('');
  const [provider, setProvider] = useState('deepseek');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [upstreamModel, setUpstreamModel] = useState('');
  const [probe, setProbe] = useState<
    | { status: 'idle' }
    | { status: 'busy' }
    | { status: 'ok'; models: readonly string[] }
    | { status: 'fail'; message: string }
  >({ status: 'idle' });

  const ready =
    displayName.trim() !== '' &&
    baseUrl.trim() !== '' &&
    apiKey.trim() !== '' &&
    upstreamModel.trim() !== '';

  /**
   * 「测试连接」走**服务端探针**，不是浏览器直连上游。
   *
   * 浏览器直连是跨源请求，厂商不会给我们的域发 CORS 头 —— 那个按钮在真浏览器里
   * 会永远失败，而在 jsdom 里会"成功"（测试里的 fetch 是假的）。桌面端没这个问题
   * （主进程发的请求），照抄过来正好踩坑。
   */
  async function testConnection() {
    setProbe({ status: 'busy' });
    const out = await api<{ ok: boolean; models?: string[]; message?: string }>(
      '/v1/admin/models/probe',
      { method: 'POST', body: JSON.stringify({ baseUrl, apiKey }) },
    );
    if (!out.ok) {
      setProbe({ status: 'fail', message: out.error.message });
      return;
    }
    if (!out.data.ok) {
      setProbe({ status: 'fail', message: out.data.message ?? '连不上这个 base_url。' });
      return;
    }
    const ids = out.data.models ?? [];
    setProbe({ status: 'ok', models: ids });
    if (ids.length > 0 && upstreamModel === '') setUpstreamModel(ids[0] ?? '');
  }

  return (
    <Dialog
      title="添加默认模型"
      wide
      confirmLabel="保存模型"
      busy={props.busy}
      confirmDisabled={!ready}
      confirmDisabledReason="显示名、base_url、密钥和模型名都要填"
      onCancel={props.onCancel}
      onConfirm={() =>
        props.onSubmit({
          modelId: upstreamModel,
          displayName,
          provider,
          upstreamModel,
          adapter: provider,
          baseUrl,
          apiKey,
        })
      }
    >
      <p className="ew-muted">保存后密钥只写不读。要换密钥只能整条覆盖，页面上永远不回显。</p>

      <Field
        label="显示名"
        name="displayName"
        required
        value={displayName}
        onChange={setDisplayName}
      />

      <div className="ew-field">
        <label className="ew-label" htmlFor="model-provider">
          协议适配类型
        </label>
        <select
          id="model-provider"
          className="ew-select"
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
        >
          {PROVIDERS.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
        <span className="ew-muted">
          决定网关怎么跟对面说话（流式重排、工具调用降级、reasoning 占位）。
          <b>填错的表现不是报错，是「配好了但输出是乱的」</b>。
        </span>
      </div>

      <Field
        label="上游 base_url"
        name="baseUrl"
        type="url"
        required
        mono
        value={baseUrl}
        onChange={setBaseUrl}
        placeholder="https://api.deepseek.com"
      />

      <div className="ew-field">
        <label className="ew-label" htmlFor="model-key">
          上游 API 密钥
        </label>
        <span className="ew-actions">
          <input
            id="model-key"
            className="ew-input ew-grow"
            type="password"
            autoComplete="off"
            data-mono="true"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <Button
            size="lg"
            busy={probe.status === 'busy'}
            busyLabel="测试中…"
            disabled={baseUrl.trim() === '' || apiKey.trim() === ''}
            disabledReason="先填 base_url 与密钥"
            onClick={() => void testConnection()}
          >
            测试连接
          </Button>
        </span>
        {probe.status === 'ok' ? (
          <span className="ew-ok ew-muted">连接成功 · 拉到 {probe.models.length} 个模型</span>
        ) : null}
        {probe.status === 'fail' ? (
          <span className="ew-error ew-muted">{probe.message}</span>
        ) : null}
      </div>

      {probe.status === 'ok' && probe.models.length > 0 ? (
        <div className="ew-field">
          <label className="ew-label" htmlFor="model-name">
            模型名称
          </label>
          <select
            id="model-name"
            className="ew-select"
            value={upstreamModel}
            onChange={(e) => setUpstreamModel(e.target.value)}
          >
            {probe.models.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
          <span className="ew-muted">从刚才那次「测试连接」拉回来的清单里选，不用手打。</span>
        </div>
      ) : (
        <Field
          label="模型名称"
          name="upstreamModel"
          required
          mono
          value={upstreamModel}
          onChange={setUpstreamModel}
          hint="点「测试连接」可以直接从上游拉一份清单。"
        />
      )}

      {props.error ? <p className="ew-error ew-muted">{props.error}</p> : null}
    </Dialog>
  );
}
