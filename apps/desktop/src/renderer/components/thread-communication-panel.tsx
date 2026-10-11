import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CommunicationActions,
  CommunicationRecordView,
  RendererEvent,
} from '../../shared/ipc.js';

const labels: Record<string, string> = {
  queued: '等待投递',
  dispatching: '正在发送',
  waiting: '等待回复',
  'reply-queued': '回复等待汇总',
  'reply-dispatching': '正在汇总回复',
  completed: '已完成',
  failed: '未完成',
  unknown: '投递结果待核对',
  'reply-unknown': '回复投递待核对',
  cancelled: '已取消',
};
export function ThreadCommunicationPanel({
  threadId,
  actions,
}: {
  threadId: string;
  actions: Partial<CommunicationActions> & {
    onUiEvent?: (handler: (event: RendererEvent) => void) => () => void;
  };
}) {
  const [open, setOpen] = useState(false);
  const [cross, setCross] = useState(false);
  const [target, setTarget] = useState('');
  const [text, setText] = useState('');
  const [targets, setTargets] = useState<
    Awaited<ReturnType<CommunicationActions['getCommunicationTargets']>>
  >([]);
  const [records, setRecords] = useState<readonly CommunicationRecordView[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const clientId = useRef<string | null>(null);
  const generation = useRef(0);
  const reload = useCallback(async () => {
    const current = ++generation.current;
    try {
      const [choices, rows] = await Promise.all([
        actions.getCommunicationTargets!({ threadId, includeOtherProjects: cross }),
        actions.getCommunicationRecords!({ threadId }),
      ]);
      if (current !== generation.current) return;
      setTargets(choices);
      setRecords(rows);
    } catch (e) {
      if (current === generation.current)
        setError(e instanceof Error ? e.message : '无法读取会话通信。');
    }
  }, [actions, threadId, cross]);
  useEffect(() => {
    if (!open) return;
    void reload();
    const off = actions.onUiEvent?.((event) => {
      if (event.type === 'task-communication-updated' && event.taskId === threadId) void reload();
    });
    return () => {
      generation.current += 1;
      off?.();
    };
  }, [open, reload, actions, threadId]);
  async function act(operation: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await operation();
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : '会话通信失败。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="ew-communication" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>会话通信</summary>
      {open ? (
        <div className="ew-communication-body">
          <label className="ew-communication-scope">
            <input
              type="checkbox"
              checked={cross}
              disabled={busy}
              onChange={(event) => {
                setCross(event.target.checked);
                setTarget('');
                clientId.current = null;
              }}
            />
            允许选择其他项目的会话
          </label>
          <label>
            目标会话
            <select
              aria-label="通信目标会话"
              value={target}
              disabled={busy}
              onChange={(event) => {
                setTarget(event.target.value);
                clientId.current = null;
              }}
            >
              <option value="">请选择会话</option>
              {targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title} · {t.id.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
          {!targets.length ? (
            <p>当前范围没有其他会话。无项目任务可勾选上方选项后明确选择目标。</p>
          ) : null}
          <label>
            请求内容
            <textarea
              aria-label="会话请求内容"
              value={text}
              maxLength={12000}
              disabled={busy}
              onChange={(event) => {
                setText(event.target.value);
                clientId.current = null;
              }}
            />
          </label>
          <p>仅发送以下内容。必要摘要与文件引用请写在请求中；目标空闲时会执行，结果自动回传。</p>
          <button
            className="ew-pill-button"
            type="button"
            disabled={busy || !target || !text.trim() || !targets.some((t) => t.id === target)}
            onClick={() => {
              void act(async () => {
                clientId.current ??= crypto.randomUUID();
                await actions.sendCommunication!({
                  sourceThreadId: threadId,
                  targetThreadId: target,
                  text,
                  clientId: clientId.current,
                });
                setText('');
                clientId.current = null;
              });
            }}
          >
            发送会话请求
          </button>
          {error ? <p role="alert">{error}</p> : null}
          <ul aria-label="会话通信记录">
            {records.map((r) => (
              <li key={r.id}>
                <strong>
                  {r.sourceThreadId === threadId ? '发出' : '收到'} · {labels[r.status] ?? r.status}
                </strong>
                <p>{r.text}</p>
                {r.reply ? <p>回复：{r.reply}</p> : null}
                {r.error ? <p>{r.error}</p> : null}
                {r.status === 'queued' && r.sourceThreadId === threadId ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void act(() => actions.cancelCommunication!({ threadId, requestId: r.id }))
                    }
                  >
                    取消请求
                  </button>
                ) : null}
                {['unknown', 'reply-unknown', 'waiting', 'reply-dispatching'].includes(r.status) ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void act(() => actions.checkCommunication!({ threadId, requestId: r.id }))
                    }
                  >
                    核对投递状态
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </details>
  );
}
