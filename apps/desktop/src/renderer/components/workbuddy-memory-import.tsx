import { useEffect, useRef, useState } from 'react';
import type {
  WorkBuddyImportInput,
  WorkBuddyImportResult,
  WorkBuddyImportStatusView,
} from '../../shared/ipc.js';
import { Dialog, PillButton } from './primitives.js';

export interface WorkBuddyImportPorts {
  getWorkBuddyImportStatus?(): Promise<WorkBuddyImportStatusView>;
  importWorkBuddyText?(input: WorkBuddyImportInput): Promise<WorkBuddyImportResult>;
}

export function WorkBuddyHistory({ status }: { readonly status: WorkBuddyImportStatusView }) {
  return (
    <section aria-label="WorkBuddy 导入历史">
      {status.history.length ? <h3>WorkBuddy 导入历史</h3> : null}
      {status.history.map((r) => (
        <p key={r.id} className="ew-memory-import-record">
          {new Date(r.createdAt).toLocaleString()} · {r.scope === 'personal' ? '个人偏好' : r.scope}
          ：{r.state === 'saved' ? '资料已保存，等待后续整理' : '结果未确认，请勿重复提交'}
        </p>
      ))}
    </section>
  );
}

export function WorkBuddyMemoryImport(props: {
  readonly ports: WorkBuddyImportPorts;
  readonly onClose: () => void;
  readonly onBack: () => void;
}) {
  const [status, setStatus] = useState<WorkBuddyImportStatusView>();
  const [text, setText] = useState('');
  const [model, setModel] = useState('');
  const [projectId, setProjectId] = useState('');
  const [step, setStep] = useState<'edit' | 'confirm' | 'result'>('edit');
  const [result, setResult] = useState<WorkBuddyImportResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const revision = useRef(0);
  useEffect(() => {
    let live = true;
    void props.ports
      .getWorkBuddyImportStatus?.()
      .then((s) => {
        if (live) {
          setStatus(s);
          setModel(s.models[0]?.id ?? '');
        }
      })
      .catch(() => {
        if (live) setError('无法读取文本导入能力，请关闭后重试。');
      });
    return () => {
      live = false;
      revision.current++;
    };
  }, [props.ports]);
  const tooLarge = new TextEncoder().encode(text).length > 65536;
  const run = async () => {
    if (busy || !props.ports.importWorkBuddyText) return;
    setBusy(true);
    setError(undefined);
    try {
      const response = await props.ports.importWorkBuddyText({
        text,
        model,
        ...(projectId ? { projectId } : {}),
      });
      setResult(response);
      setStep('result');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '导入未完成，请检查历史后再操作。');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="导入 WorkBuddy 记忆"
      confirmLabel={
        busy
          ? '正在导入…'
          : step === 'edit'
            ? '预览并继续'
            : step === 'confirm'
              ? '确认导入文本'
              : '完成'
      }
      confirmDisabled={
        busy || (step !== 'result' && (!status?.supported || !model || !text.trim() || tooLarge))
      }
      cancelLabel={step === 'result' ? '关闭' : '取消'}
      onCancel={() => {
        if (!busy) props.onClose();
      }}
      onConfirm={() => {
        if (step === 'edit') setStep('confirm');
        else if (step === 'confirm') void run();
        else props.onClose();
      }}
    >
      {error ? <p role="alert">{error}</p> : null}
      {!status ? (
        <p role="status">正在检查文本导入能力…</p>
      ) : !status.supported ? (
        <p role="status">当前内核或受信任的写入回执不可用，不能导入文本记忆。</p>
      ) : null}
      {step === 'edit' ? (
        <>
          <p>
            从 WorkBuddy「设置 → 记忆」复制可查看的内容，或选择 UTF-8 Markdown/TXT
            文件。这里导入的是你提供的快照。
          </p>
          <label className="ew-memory-text-field">
            选择记忆文件
            <input
              type="file"
              accept=".md,.txt,text/plain,text/markdown"
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                const current = ++revision.current;
                setError(undefined);
                if (!file) return;
                if (!/\.(md|txt)$/iu.test(file.name) || file.size > 65536) {
                  setError('请选择最多 64 KiB 的 Markdown/TXT 文件。');
                  event.target.value = '';
                  return;
                }
                void file
                  .arrayBuffer()
                  .then((buffer) => {
                    const value = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
                    if (revision.current === current) setText(value);
                  })
                  .catch(() => {
                    if (revision.current === current)
                      setError('文件不是有效的 UTF-8 文本，请转为 UTF-8 后重试。');
                  });
                event.target.value = '';
              }}
            />
          </label>
          <label className="ew-memory-text-field">
            记忆文本
            <textarea
              aria-label="WorkBuddy 记忆文本"
              rows={10}
              value={text}
              onChange={(e) => {
                revision.current++;
                setText(e.target.value);
              }}
            />
          </label>
          {tooLarge ? <p role="alert">记忆文本超过 64 KiB，请删减后继续。</p> : null}
          <label className="ew-memory-text-field">
            导入模型
            <select aria-label="导入模型" value={model} onChange={(e) => setModel(e.target.value)}>
              {status?.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          {status && !status.models.length ? (
            <p role="status">请先在设置 → 模型添加可用模型。</p>
          ) : null}
          <label className="ew-memory-text-field">
            记忆归属
            <select
              aria-label="记忆归属"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
            >
              <option value="">个人偏好（跨项目）</option>
              {status?.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <p>项目归属用于指导记忆使用，当前不提供严格的跨项目不可见保证。混合内容请分开导入。</p>
          <PillButton variant="ghost" onClick={props.onBack}>
            返回来源
          </PillButton>
        </>
      ) : null}
      {step === 'confirm' ? (
        <>
          <p>来源：WorkBuddy 文本快照</p>
          <p>
            归属：
            {projectId
              ? status?.projects.find((p) => p.id === projectId)?.name
              : '个人偏好（跨项目）'}
          </p>
          <p>模型：{status?.models.find((m) => m.id === model)?.label}</p>
          <pre className="ew-memory-text-preview">{text}</pre>
          <p>
            确认后会通过所选模型服务发送以上文本并消耗模型用量，保存为本机记忆资料；不会改变全局读取、生成和模型设置。
          </p>
          <p>
            资料保存后等待内核后续整理，可能受六小时冷却期等限制。不会立即影响当前任务，也不会自动同步
            WorkBuddy。
          </p>
          <p>修改后的文本作为新快照追加，旧记忆不会自动删除。</p>
          <PillButton variant="ghost" disabled={busy} onClick={() => setStep('edit')}>
            返回编辑
          </PillButton>
        </>
      ) : null}
      {step === 'result' ? (
        <>
          {result?.duplicate ? <p>相同文本与归属已有导入登记，本次没有重复提交。</p> : null}
          {result?.record.state === 'saved' ? (
            <p role="status">
              资料已保存，等待内核后续整理。保存成功不代表已经整理就绪；请在后续新任务中使用。
            </p>
          ) : (
            <p role="alert">
              结果未确认。请到设置 → 导入核对历史，不要直接重复提交。模型回复不作为保存成功的依据。
            </p>
          )}
          <p>原始 WorkBuddy 记忆保持不变。读取关闭时不会自动开启。</p>
        </>
      ) : null}
    </Dialog>
  );
}
