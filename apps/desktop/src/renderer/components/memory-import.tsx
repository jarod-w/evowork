import { useEffect, useRef, useState } from 'react';
import type {
  MemoryImportDetectionView,
  MemoryImportHistoryView,
  MemoryImportInput,
  MemoryImportResult,
  MemoryImportStatusView,
  MemorySettingsView,
  MemoryImportSyncView,
} from '../../shared/ipc.js';
import { MemoryPreparation } from './memory-preparation.js';
import { Dialog, PillButton } from './primitives.js';
import {
  WorkBuddyMemoryImport,
  WorkBuddyHistory,
  type WorkBuddyImportPorts,
} from './workbuddy-memory-import.js';
import type { WorkBuddyImportStatusView } from '../../shared/ipc.js';

export interface MemoryImportPorts extends WorkBuddyImportPorts {
  getMemoryImportStatus?(): Promise<MemoryImportStatusView>;
  setMemoryImportSync?(input: { readonly enabled: boolean }): Promise<MemoryImportSyncView>;
  detectMemoryImport?(): Promise<MemoryImportDetectionView>;
  importMemories?(input: MemoryImportInput): Promise<MemoryImportResult>;
  getMemoryImportHistory?(): Promise<readonly MemoryImportHistoryView[]>;
  getMemorySettings?(): Promise<MemorySettingsView>;
  enableMemoryReading?(): Promise<MemorySettingsView>;
}

function ImportHistory({ records }: { readonly records: readonly MemoryImportHistoryView[] }) {
  return (
    <div aria-label="记忆导入历史">
      <h3>导入历史</h3>
      {!records.length ? <p>还没有项目记忆导入记录。</p> : null}
      {records.map((record) => (
        <div key={record.id} className="ew-memory-import-record">
          <p>{new Date(record.completedAt).toLocaleString()} · Claude Code</p>
          <ul>
            {record.projects.map((project, index) => (
              <li key={`${project.key}-${index}`}>
                {project.key}：{project.ok ? '资料已导入' : (project.reason ?? '导入失败')}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function MemoryImportOverview(props: {
  readonly ports: MemoryImportPorts;
  readonly onStart: () => void;
  readonly refreshKey?: number | undefined;
}) {
  const [status, setStatus] = useState<MemoryImportStatusView>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [syncBusy, setSyncBusy] = useState(false);
  const [workbuddy, setWorkbuddy] = useState<WorkBuddyImportStatusView>();
  useEffect(() => {
    let active = true;
    setError(undefined);
    void props.ports
      .getWorkBuddyImportStatus?.()
      .then((value) => {
        if (active) setWorkbuddy(value);
      })
      .catch(() => {});
    void props.ports
      .getMemoryImportStatus?.()
      .then((value) => {
        if (active) setStatus(value);
      })
      .catch(() => {
        if (active) setError('无法读取导入历史，请重试。');
      });
    return () => {
      active = false;
    };
  }, [props.ports, props.refreshKey, attempt]);
  useEffect(() => {
    if (!status?.sync?.enabled) return;
    const timer = setInterval(() => setAttempt((value) => value + 1), 3000);
    return () => clearInterval(timer);
  }, [status?.sync?.enabled]);
  const setSync = async (enabled: boolean) => {
    if (syncBusy || !props.ports.setMemoryImportSync) return;
    setSyncBusy(true);
    setError(undefined);
    const previous = status?.sync;
    setStatus((value) => (value?.sync ? { ...value, sync: { ...value.sync, enabled } } : value));
    try {
      const sync = await props.ports.setMemoryImportSync({ enabled });
      setStatus((previous) => (previous ? { ...previous, sync } : previous));
      setAttempt((value) => value + 1);
    } catch (cause) {
      if (previous) setStatus((value) => (value ? { ...value, sync: previous } : value));
      setError(cause instanceof Error ? cause.message : '同步设置未保存，请重试。');
    } finally {
      setSyncBusy(false);
    }
  };
  return (
    <>
      <p className="ew-settings-note">
        从 Claude Code 导入本机项目记忆，或导入 WorkBuddy 文本快照，在后续新任务中继续使用。
      </p>
      {!props.ports.getMemoryImportStatus ? <p>当前版本不支持记忆导入。</p> : null}
      {status && !status.supported ? <p role="status">{status.reason}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <PillButton disabled={!status?.supported && !workbuddy?.supported} onClick={props.onStart}>
        导入已有记忆
      </PillButton>
      <PillButton variant="ghost" onClick={() => setAttempt((value) => value + 1)}>
        刷新导入历史
      </PillButton>
      {status?.sync && props.ports.setMemoryImportSync ? (
        <section aria-label="记忆自动同步">
          <p>自动同步仅适用于 Claude Code 项目。WorkBuddy 文本快照需要手动重新导入。</p>
          <label className="ew-checkbox">
            <input
              type="checkbox"
              checked={status.sync.enabled}
              disabled={
                syncBusy ||
                (!status.sync.enabled &&
                  (!status.supported || !status.history.some((r) => r.projects.some((p) => p.ok))))
              }
              onChange={(event) => void setSync(event.target.checked)}
            />
            自动更新已导入的项目记忆
          </label>
          <p>
            开启后每分钟检查以下已导入项目。同步包括来源文件的删减；后台整理会使用已配置模型并消耗用量。新增项目需要重新确认同步范围。
          </p>
          <ul>
            {(status.sync.enabled
              ? status.sync.projectKeys
              : [
                  ...new Set(
                    status.history.flatMap((r) => r.projects.filter((p) => p.ok).map((p) => p.key)),
                  ),
                ]
            ).map((key) => (
              <li key={key}>{key}</li>
            ))}
          </ul>
          {status.sync.pending ? <p role="status">同步资料已提交，正在核对导入结果。</p> : null}
          {status.sync.error ? <p role="alert">{status.sync.error}</p> : null}
          {status.sync.lastCheckedAt ? (
            <p>最近检查：{new Date(status.sync.lastCheckedAt).toLocaleString()}</p>
          ) : null}
          {status.sync.lastCompletedAt ? (
            <p>
              最近同步完成：{new Date(status.sync.lastCompletedAt).toLocaleString()}
              。资料同步完成不代表整理就绪。
            </p>
          ) : null}
          <p>
            关闭后停止后续同步，已经提交的操作仍可能完成。删除来源项目不会自动清除已学到的记忆。
          </p>
        </section>
      ) : null}
      {status ? <ImportHistory records={status.history} /> : null}
      {workbuddy ? <WorkBuddyHistory status={workbuddy} /> : null}
    </>
  );
}

export function MemoryImportDialog(props: {
  readonly ports: MemoryImportPorts;
  readonly onClose: () => void;
  readonly onNewTask: () => void;
  readonly onReadingEnabled: (memory: MemorySettingsView) => void;
}) {
  const [step, setStep] = useState<'source' | 'select' | 'confirm' | 'result'>('source');
  const [status, setStatus] = useState<MemoryImportStatusView>();
  const [memory, setMemory] = useState<MemorySettingsView>();
  const [detection, setDetection] = useState<MemoryImportDetectionView>();
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [result, setResult] = useState<MemoryImportHistoryView>();
  const [importId, setImportId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [uncertain, setUncertain] = useState(false);
  const [workbuddy, setWorkbuddy] = useState(false);
  const mounted = useRef(true);
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Step actions can disappear (e.g. "开启读取"); retain keyboard focus in the modal.
    if (!busy) content.current?.focus();
  }, [step, busy]);
  useEffect(() => {
    mounted.current = true;
    void Promise.all([props.ports.getMemoryImportStatus?.(), props.ports.getMemorySettings?.()])
      .then(([state, settings]) => {
        if (mounted.current) {
          setStatus(state);
          setMemory(settings);
        }
      })
      .catch(() => {
        if (mounted.current) setError('无法读取导入设置，请关闭后重试。');
      });
    return () => {
      mounted.current = false;
    };
  }, [props.ports]);

  // The native history is authoritative, including after a lost response or application restart.
  useEffect(() => {
    if (!importId || result) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let attempts = 0;
    const deadline = Date.now() + 20_000;
    const check = async () => {
      try {
        const records = await props.ports.getMemoryImportHistory?.();
        if (!active) return;
        const record = records?.find((item) => item.id === importId);
        if (record) {
          setResult(record);
          return;
        }
      } catch {
        /* A transient read failure must not replay the import. */
      }
      if (active && ++attempts < 20 && Date.now() < deadline)
        timer = setTimeout(() => void check(), 1000);
      else if (active) setUncertain(true);
    };
    void check();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [props.ports, importId, result]);

  const detect = async () => {
    if (busy || !props.ports.detectMemoryImport) return;
    setBusy(true);
    setError(undefined);
    try {
      const found = await props.ports.detectMemoryImport();
      if (!mounted.current) return;
      setDetection(found);
      setSelected([]);
      setStep('select');
      setImportId(undefined);
      setResult(undefined);
      setUncertain(false);
    } catch (cause) {
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : '无法检测来源项目，请重试。');
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const run = async () => {
    if (busy || !detection || !props.ports.importMemories) return;
    setBusy(true);
    setError(undefined);
    try {
      const response = await props.ports.importMemories({
        selectionId: detection.selectionId,
        projectKeys: selected,
      });
      if (mounted.current && response.refused) {
        setError(response.refused);
        setStep('source');
        return;
      }
      if (mounted.current) {
        setUncertain(!response.importId);
        setImportId(response.importId);
        setStep('result');
      }
    } catch {
      if (mounted.current) {
        setUncertain(true);
        setStep('result');
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const enableReading = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const settings = await props.ports.enableMemoryReading?.();
      if (mounted.current && settings) {
        setMemory(settings);
        props.onReadingEnabled(settings);
      }
    } catch {
      if (mounted.current) setError('读取设置没有保存，请重试。');
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const anySuccess = result?.projects.some((project) => project.ok);
  if (workbuddy)
    return (
      <WorkBuddyMemoryImport
        ports={props.ports}
        onClose={props.onClose}
        onBack={() => setWorkbuddy(false)}
      />
    );
  return (
    <Dialog
      title="导入项目记忆"
      confirmLabel={
        busy
          ? '正在处理…'
          : step === 'source'
            ? '检测项目'
            : step === 'select'
              ? '继续'
              : step === 'confirm'
                ? '确认导入'
                : '完成'
      }
      confirmDisabled={
        busy || (step === 'source' && !status?.supported) || (step === 'select' && !selected.length)
      }
      cancelLabel={step === 'result' ? '关闭' : '取消'}
      onCancel={() => {
        if (!busy) props.onClose();
      }}
      onConfirm={() => {
        if (step === 'source') void detect();
        else if (step === 'select') setStep('confirm');
        else if (step === 'confirm') void run();
        else props.onClose();
      }}
    >
      <div ref={content} tabIndex={-1}>
        <p className="ew-settings-note">
          {step === 'source'
            ? '1 / 4 · 选择来源'
            : step === 'select'
              ? '2 / 4 · 选择项目'
              : step === 'confirm'
                ? '3 / 4 · 确认导入'
                : '4 / 4 · 导入结果'}
        </p>
        {error ? <p role="alert">{error}</p> : null}
        {step === 'source' ? (
          <>
            <p>
              <strong>Claude Code</strong>
            </p>
            <p>检测这台电脑上的项目记忆。原应用的文件保持不变。</p>
            <PillButton variant="ghost" onClick={() => setWorkbuddy(true)}>
              WorkBuddy 文本
            </PillButton>
            {!status && !error ? <p role="status">正在检查导入能力…</p> : null}
            {status && !status.supported ? <p role="status">{status.reason}</p> : null}
            {!props.ports.getMemoryImportStatus ? <p>当前版本不支持记忆导入。</p> : null}
          </>
        ) : null}
        {step === 'select' ? (
          <>
            <p>选择要导入或更新的项目。项目记忆保持原有项目范围。</p>
            {!detection?.projects.length ? (
              <p role="status">
                未找到有可靠项目目录且需要更新的记忆。已导入且未变化的项目不会重复显示。
              </p>
            ) : null}
            <div className="ew-memory-import-projects">
              {detection?.projects.map((project) => (
                <label className="ew-checkbox" key={project.key}>
                  <input
                    type="checkbox"
                    checked={selected.includes(project.key)}
                    onChange={(event) =>
                      setSelected((previous) =>
                        event.target.checked
                          ? [...previous, project.key]
                          : previous.filter((key) => key !== project.key),
                      )
                    }
                  />
                  <span>
                    <strong>{project.key}</strong>
                    <br />
                    {project.path ?? '原项目目录由执行内核识别并保留'}
                  </span>
                </label>
              ))}
            </div>
            <PillButton variant="ghost" disabled={busy} onClick={() => void detect()}>
              重新检测
            </PillButton>
          </>
        ) : null}
        {step === 'confirm' ? (
          <>
            <p>
              从 Claude Code 导入 {selected.length} 个项目的记忆资料，保存到本机 EvoWork 记忆中。
            </p>
            <ul>
              {selected.map((key) => (
                <li key={key}>{key}</li>
              ))}
            </ul>
            <p>
              后台整理会通过已配置的模型服务处理所选记忆，并消耗模型用量。整理后用于后续新任务；当前任务不会立即更新。
            </p>
            <p>已有记忆的读取、生成和模型设置保持原值。不会同时迁移会话、配置、插件或指令。</p>
            <p>更新已导入项目时，会按当前来源同步副本，包括来源文件的删减。</p>
            <PillButton variant="ghost" disabled={busy} onClick={() => setStep('select')}>
              返回选择项目
            </PillButton>
          </>
        ) : null}
        {step === 'result' ? (
          <>
            {!result && !uncertain ? <p role="status">正在核对导入结果…</p> : null}
            {uncertain ? (
              <p role="alert">
                导入结果尚未确认。请到设置 → 导入刷新历史，核对后再重新检测；不要直接重复提交。
              </p>
            ) : null}
            {result ? <ImportHistory records={[result]} /> : null}
            {anySuccess ? (
              <>
                <p>资料已导入；后台整理后可在后续新任务中使用。本页不代表记忆已经整理就绪。</p>
                <MemoryPreparation
                  key={String(memory?.enabled)}
                  read={props.ports.getMemorySettings}
                />
                {memory && (!memory.enabled || !memory.useMemories) ? (
                  <>
                    <p>当前未开启“使用已有记忆”。</p>
                    <PillButton disabled={busy} onClick={() => void enableReading()}>
                      开启读取
                    </PillButton>
                    <p>也可以保持关闭，稍后在个性化设置中开启。</p>
                  </>
                ) : null}
                <PillButton variant="ghost" onClick={props.onNewTask}>
                  新建任务
                </PillButton>
              </>
            ) : null}
            <PillButton variant="ghost" disabled={busy} onClick={() => void detect()}>
              重新检测项目
            </PillButton>
          </>
        ) : null}
      </div>
    </Dialog>
  );
}
