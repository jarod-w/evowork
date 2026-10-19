import { useEffect, useRef, useState } from 'react';
import type {
  FilePreviewView,
  ImageOperationView,
  ImageSettingsView,
  SaveImageSettingsInput,
} from '../../shared/ipc.js';
import { Banner, Dialog, PillButton } from './primitives.js';
import { InlineSelect } from './menu.js';
import {
  SettingsRow,
  SettingsFeedback,
  useSettingsAction,
  type SettingsFormState,
} from './settings-controls.js';
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
export function ImageSettings({
  ports,
  onFormState,
  resetRevision = 0,
}: {
  readonly ports?: ImageUiPorts | undefined;
  readonly onFormState?: ((state: SettingsFormState) => void) | undefined;
  readonly resetRevision?: number | undefined;
}) {
  const [saved, setSaved] = useState<ImageSettingsView>();
  const [draft, setDraft] = useState<ImageSettingsView>();
  const [key, setKey] = useState('');
  const [pendingEnabled, setPendingEnabled] = useState<boolean | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const action = useSettingsAction();
  const revision = useRef(resetRevision);
  const verification = useRef('');
  const dirty =
    !!saved &&
    !!draft &&
    (key !== '' || draft.model !== saved.model || draft.baseUrl !== saved.baseUrl);
  useEffect(() => {
    let active = true;
    setLoadError(undefined);
    void ports
      ?.getImageSettings?.()
      .then((view) => {
        if (active) {
          setSaved(view);
          setDraft(view);
        }
      })
      .catch(() => {
        if (active) setLoadError('未能读取图片设置，请重试。');
      });
    return () => {
      active = false;
    };
  }, [ports, attempt]);
  useEffect(() => {
    onFormState?.({ dirty, busy: action.busy });
  }, [dirty, action.busy, onFormState]);
  useEffect(
    () => () => {
      onFormState?.({ dirty: false, busy: false });
    },
    [onFormState],
  );
  useEffect(() => {
    if (revision.current === resetRevision) return;
    revision.current = resetRevision;
    setDraft(saved);
    setKey('');
    setExpanded(false);
  }, [resetRevision, saved]);
  async function save(clearKey = false) {
    if (!draft || !ports?.saveImageSettings) return;
    const input: SaveImageSettingsInput = {
      enabled: draft.enabled,
      model: draft.model,
      baseUrl: draft.baseUrl.trim(),
      ...(key.trim() ? { apiKey: key.trim() } : {}),
      ...(clearKey ? { clearKey: true } : {}),
    };
    const ok = await action.run(
      async () => {
        const next = await ports.saveImageSettings!(input);
        setSaved(next);
        setDraft(next);
        setKey('');
      },
      clearKey ? '图片密钥已移除。' : '已保存。图片工具对新任务生效；已有任务请重新打开。',
    );
    if (ok) {
      setExpanded(false);
      setConfirmRemove(false);
    }
  }
  if (!ports?.getImageSettings)
    return <p className="ew-settings-note">当前版本不支持图片模型配置。</p>;
  if (loadError)
    return (
      <Banner
        tone="danger"
        action={<PillButton onClick={() => setAttempt((value) => value + 1)}>重试</PillButton>}
      >
        {loadError}
      </Banner>
    );
  if (!saved || !draft)
    return (
      <p className="ew-settings-note" role="status">
        正在读取图片设置…
      </p>
    );
  return (
    <div className="ew-settings-section ew-image-settings">
      <SettingsRow
        label="启用 AI 图片"
        htmlFor="settings-image-enabled"
        description="在任务中生成图片或通过文字编辑图片。"
      >
        <input
          id="settings-image-enabled"
          className="ew-settings-switch"
          type="checkbox"
          checked={pendingEnabled ?? saved.enabled}
          disabled={action.busy || dirty || !ports.saveImageSettings}
          onChange={(event) => {
            const enabled = event.target.checked;
            setPendingEnabled(enabled);
            void action
              .run(async () => {
                const next = await ports.saveImageSettings!({
                  enabled,
                  model: saved.model,
                  baseUrl: saved.baseUrl,
                });
                setSaved(next);
                setDraft(next);
              })
              .finally(() => setPendingEnabled(null));
          }}
        />
      </SettingsRow>
      <SettingsRow
        label={saved.models.find((model) => model.id === saved.model)?.name ?? saved.model}
        description={
          <>
            <p>独立于对话模型</p>
            <p>{saved.hasKey ? '密钥已保存' : '尚未配置密钥'}</p>
          </>
        }
      >
        <PillButton
          disabled={action.busy}
          onClick={() => setExpanded((value) => !value)}
          expanded={expanded}
        >
          配置图片模型
        </PillButton>
      </SettingsRow>
      {expanded ? (
        <div className="ew-settings-form">
          <div className="ew-field">
            <span>图片模型</span>
            <InlineSelect
              ariaLabel="图片模型"
              value={draft.model}
              placeholder="选择图片模型"
              options={draft.models.map((model) => ({ id: model.id, label: model.name }))}
              disabled={action.busy}
              onChange={(model) => setDraft({ ...draft, model })}
            />
          </div>
          <label className="ew-field">
            <span>接口地址</span>
            <input
              aria-label="图片接口地址"
              value={draft.baseUrl}
              disabled={action.busy}
              onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
            />
          </label>
          <label className="ew-field">
            <span>Ark API Key</span>
            <input
              aria-label="Ark API Key"
              type="password"
              autoComplete="off"
              value={key}
              disabled={action.busy}
              onChange={(event) => setKey(event.target.value)}
              placeholder={saved.hasKey ? '已保存；留空保持' : '粘贴密钥'}
            />
          </label>
          <p className="ew-settings-note">
            更改参数后需要保存。图片工具对新任务生效；已有任务请重新打开。
          </p>
          <div className="ew-settings-form-actions">
            <PillButton
              disabled={
                action.busy ||
                dirty ||
                !saved.enabled ||
                !saved.hasKey ||
                !ports.verifyImageConnection
              }
              disabledReason={dirty ? '请先保存配置，再测试已保存的型号与凭据。' : undefined}
              onClick={() =>
                void action.run(
                  async () => {
                    verification.current = await ports.verifyImageConnection!();
                  },
                  () => verification.current,
                  '正在测试已保存配置…',
                )
              }
            >
              测试已保存配置
            </PillButton>
            <span className="ew-settings-note" role="status">
              {dirty ? '未保存' : null}
            </span>
            <PillButton
              disabled={action.busy}
              onClick={() => {
                setDraft(saved);
                setKey('');
                setExpanded(false);
              }}
            >
              取消
            </PillButton>
            <PillButton
              variant="accent"
              disabled={action.busy || !dirty || !draft.baseUrl.trim() || !ports.saveImageSettings}
              onClick={() => void save()}
            >
              {action.busy ? '正在保存…' : '保存图片设置'}
            </PillButton>
          </div>
          <PillButton
            variant="danger"
            disabled={action.busy || dirty || !saved.hasKey || !ports.saveImageSettings}
            onClick={() => setConfirmRemove(true)}
          >
            移除图片密钥
          </PillButton>
        </div>
      ) : null}
      <SettingsFeedback feedback={action.feedback} />
      {saved.secretBackend === 'plaintext-fallback' || saved.secretBackend === 'unavailable' ? (
        <Banner tone="warning">
          {saved.secretBackend === 'plaintext-fallback'
            ? '图片密钥以明文文件保存，请留意这台电脑的访问权限。'
            : '系统密钥库不可用，图片密钥无法加密保存。'}
        </Banner>
      ) : null}
      <p className="ew-settings-note">
        使用自备凭据，费用由服务商收取，金额暂不能确认。每次上传与付费调用前均需确认。默认每个任务最多
        4 次，同时运行 1 次。
      </p>
      {confirmRemove ? (
        <Dialog
          title="移除图片密钥？"
          confirmLabel="确认移除"
          variant="danger"
          confirmDisabled={action.busy}
          onCancel={() => {
            if (!action.busy) setConfirmRemove(false);
          }}
          onConfirm={() => void save(true)}
        >
          <p>移除后需要重新填写密钥才能生成图片。已有图片和任务历史不会被删除。</p>
        </Dialog>
      ) : null}
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
