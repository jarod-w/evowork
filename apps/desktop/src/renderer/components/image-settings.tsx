import { useEffect, useState } from 'react';
import type {
  FilePreviewView,
  ImageOperationView,
  ImageSettingsView,
  SaveImageSettingsInput,
} from '../../shared/ipc.js';
import { Banner, PillButton, SectionHeader } from './primitives.js';
export interface ImageUiPorts {
  verifyImageConnection?(): Promise<string>;
  getImageSettings?(): Promise<ImageSettingsView>;
  saveImageSettings?(input: SaveImageSettingsInput): Promise<ImageSettingsView>;
  getImageOperations?(input: { threadId: string }): Promise<ImageOperationView[]>;
  recoverImageFiles?(): Promise<void>;
  acknowledgeImageOutcome?(input: { threadId: string; operationId: string }): Promise<void>;
  extendImageBudget?(input: { threadId: string }): Promise<void>;
  readResultPreview?(input: { artifactId: string }): Promise<FilePreviewView>;
}
export function ImageSettings({ ports }: { ports?: ImageUiPorts | undefined }) {
  const [view, setView] = useState<ImageSettingsView>();
  const [key, setKey] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    void ports
      ?.getImageSettings?.()
      .then(setView)
      .catch(() => setMessage('未能读取图片设置。'));
  }, [ports]);
  async function save(clearKey = false) {
    if (!view || !ports?.saveImageSettings) return;
    setBusy(true);
    const apiKey = key;
    setKey('');
    try {
      setView(await ports.saveImageSettings({ ...view, ...(apiKey ? { apiKey } : {}), clearKey }));
      setMessage('已保存。图片工具对新任务生效；已有任务请重新打开。');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : '图片设置未保存。');
    } finally {
      setBusy(false);
    }
  }
  if (!ports?.getImageSettings) return null;
  return (
    <div className="ew-settings-section ew-image-settings">
      <SectionHeader title="AI 图片" />
      <p>
        图片模型独立于对话模型。单张生成、自然语言编辑、连续修改；每次上传和服务商费用均先确认。
      </p>
      {view ? (
        <>
          <label>
            <input
              type="checkbox"
              checked={view.enabled}
              onChange={(e) => setView({ ...view, enabled: e.target.checked })}
            />{' '}
            启用 AI 图片
          </label>
          <label>
            图片模型{' '}
            <select
              aria-label="图片模型"
              value={view.model}
              onChange={(e) => setView({ ...view, model: e.target.value })}
            >
              {view.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            接口地址{' '}
            <input
              aria-label="图片接口地址"
              value={view.baseUrl}
              onChange={(e) => setView({ ...view, baseUrl: e.target.value })}
            />
          </label>
          <label>
            Ark API Key{' '}
            <input
              aria-label="Ark API Key"
              type="password"
              autoComplete="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={view.hasKey ? '已保存；留空保持' : '粘贴密钥'}
            />
          </label>
          <p>
            密钥存储：{view.secretBackend}。自带凭据，费用金额暂不能确认。默认每个任务最多 4
            次，单人同时 1 次。
          </p>
          <div className="ew-settings-actions">
            <PillButton disabled={busy} onClick={() => void save()}>
              保存图片设置
            </PillButton>
            <PillButton
              disabled={busy || !view.enabled || !view.hasKey}
              onClick={() => {
                setBusy(true);
                void ports
                  .verifyImageConnection?.()
                  .then(setMessage)
                  .catch((e: unknown) =>
                    setMessage(e instanceof Error ? e.message : '图片连接验证失败。'),
                  )
                  .finally(() => setBusy(false));
              }}
            >
              验证型号与凭据
            </PillButton>
            <PillButton disabled={busy || !view.hasKey} onClick={() => void save(true)}>
              移除图片密钥
            </PillButton>
          </div>
        </>
      ) : (
        <p>正在读取…</p>
      )}
      {message ? <Banner tone="warning">{message}</Banner> : null}
    </div>
  );
}
const STATES: Record<string, string> = {
  awaitingApproval: '等待上传与费用确认',
  submitting: '服务商正在生成',
  saving: '文件保存需要恢复',
  completed: '图片已完成',
  failed: '生成失败',
  cancelled: '已取消',
  outcomeUnknown: '结果未知，可能已计费',
};
export function ImageOperationCard({
  ports,
  threadId,
  callId,
  onOpen,
  onEdit,
}: {
  ports?: ImageUiPorts | undefined;
  threadId?: string | undefined;
  callId: string;
  onOpen?: ((id: string) => void) | undefined;
  onEdit?: ((id: string) => void) | undefined;
}) {
  const [operations, setOperations] = useState<ImageOperationView[]>([]),
    [preview, setPreview] = useState(''),
    [error, setError] = useState(''),
    [confirm, setConfirm] = useState<string>();
  useEffect(() => {
    if (!threadId || !ports?.getImageOperations) return;
    let active = true;
    const refresh = () =>
      void ports.getImageOperations!({ threadId })
        .then((rows) => {
          if (active) setOperations(rows);
        })
        .catch(() => {
          if (active) setError('未能读取图片操作状态。');
        });
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [ports, threadId]);
  const operation =
    operations.find((o) => o.id === callId) ?? operations.find((o) => o.callId === callId);
  useEffect(() => {
    let active = true;
    setPreview('');
    if (operation?.artifactId)
      void ports
        ?.readResultPreview?.({ artifactId: operation.artifactId })
        .then((p) => {
          if (active && p.kind === 'image' && p.content?.startsWith('data:image/'))
            setPreview(p.content);
        })
        .catch(() => {
          if (active) setError('图片预览不可用，可从结果面板打开。');
        });
    return () => {
      active = false;
    };
  }, [operation?.artifactId, ports]);
  async function resolve() {
    if (!threadId || !operation) return;
    try {
      if (confirm === 'retry')
        await ports?.acknowledgeImageOutcome?.({ threadId, operationId: operation.id });
      else await ports?.extendImageBudget?.({ threadId });
      setConfirm(undefined);
      setError('已确认。再次发送编辑或生成要求会发起新操作。');
    } catch {
      setError('操作未完成。');
    }
  }
  return (
    <div className="ew-image-operation" aria-label="AI 图片操作">
      <strong>
        {operation ? (STATES[operation.status] ?? operation.status) : '正在核对图片操作…'}
      </strong>
      {operation ? (
        <p>
          {operation.model} ·{' '}
          {operation.width && operation.height
            ? `${operation.width} × ${operation.height} · PNG`
            : '单张图片'}{' '}
          · 服务商金额未知
        </p>
      ) : null}
      {preview ? (
        <img src={preview} alt="AI 生成的图片" style={{ maxWidth: '100%', maxHeight: 400 }} />
      ) : null}
      {operation?.artifactId ? (
        <div>
          <PillButton onClick={() => onOpen?.(operation.artifactId!)}>打开图片</PillButton>
          <PillButton onClick={() => onEdit?.(operation.artifactId!)}>继续修改</PillButton>
        </div>
      ) : null}
      {operation?.status === 'outcomeUnknown' ? (
        <PillButton onClick={() => setConfirm('retry')}>确认可能重复计费后再生成</PillButton>
      ) : null}
      {operation?.status === 'saving' ? (
        <PillButton
          onClick={() =>
            void ports?.recoverImageFiles?.().catch(() => setError('本机文件恢复失败。'))
          }
        >
          恢复本机文件交付
        </PillButton>
      ) : null}
      {operation ? (
        <PillButton onClick={() => setConfirm('budget')}>增加本任务 4 次额度</PillButton>
      ) : null}
      {confirm ? (
        <div role="alert">
          <p>
            {confirm === 'retry'
              ? '原请求可能已经计费。确认允许随后发起新的付费请求？'
              : '增加本任务 4 次付费请求额度？每次仍需费用确认。'}
          </p>
          <PillButton onClick={() => void resolve()}>确认</PillButton>
          <PillButton onClick={() => setConfirm(undefined)}>取消</PillButton>
        </div>
      ) : null}
      {operation?.errorCode ? <p>{operation.errorCode}</p> : null}
      {error ? <p role="status">{error}</p> : null}
    </div>
  );
}
