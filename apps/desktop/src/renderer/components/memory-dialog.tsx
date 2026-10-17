import { useEffect, useState } from 'react';
import type { MemorySettingsView } from '../../shared/ipc.js';
import { Dialog, PillButton } from './primitives.js';

export type MemoryReadChoice = 'default' | 'enabled' | 'disabled';

export function MemoriesDialog(props: {
  readonly readChoice: MemoryReadChoice;
  readonly task?: { readonly generateMemories?: boolean | undefined } | undefined;
  readonly load: () => Promise<MemorySettingsView>;
  readonly onSave: (changes: {
    readonly readChoice: MemoryReadChoice;
    readonly generateMemories?: boolean;
  }) => Promise<void>;
  readonly onClose: () => void;
  readonly onGlobalSettings: () => void;
  readonly onImportMemories?: (() => void) | undefined;
}) {
  const [memory, setMemory] = useState<MemorySettingsView | null>(null);
  const [error, setError] = useState<string>();
  const [loadingAttempt, setLoadingAttempt] = useState(0);
  const [readChoice, setReadChoice] = useState(props.readChoice);
  const [generateMemories, setGenerateMemories] = useState<boolean>();
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let active = true;
    setError(undefined);
    void props
      .load()
      .then((value) => {
        if (active) setMemory(value);
      })
      .catch(() => {
        if (active) setError('无法读取记忆设置，请重试。');
      });
    return () => {
      active = false;
    };
  }, [props.load, loadingAttempt]);

  const save = async () => {
    if (!memory?.enabled || saving) return;
    setSaving(true);
    setError(undefined);
    try {
      await props.onSave({
        readChoice,
        ...(generateMemories === undefined ? {} : { generateMemories }),
      });
      props.onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '记忆设置没有保存，请重试。');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      title="记忆设置"
      confirmLabel={saving ? '正在保存…' : '保存'}
      confirmDisabled={!memory?.enabled || saving}
      onConfirm={() => void save()}
      onCancel={() => {
        if (!saving) props.onClose();
      }}
    >
      {!memory && !error ? <p role="status">正在读取记忆设置…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {!memory && error ? (
        <PillButton onClick={() => setLoadingAttempt((attempt) => attempt + 1)}>重试</PillButton>
      ) : null}
      {memory ? (
        <>
          {!memory.enabled ? <p>本地记忆已关闭，可在全局设置中启用。</p> : null}
          {props.task ? (
            <>
              <p>当前任务的记忆读取在创建时确定。更改读取方式请新建任务。</p>
              <label className="ew-checkbox">
                <input
                  type="checkbox"
                  checked={
                    generateMemories ?? props.task.generateMemories ?? memory.generateMemories
                  }
                  disabled={!memory.enabled || !memory.taskModeSupported || saving}
                  onChange={(event) => setGenerateMemories(event.target.checked)}
                />
                <span>允许当前任务贡献新记忆</span>
              </label>
              {!memory.taskModeSupported ? <p>当前内核不支持任务级贡献设置。</p> : null}
            </>
          ) : (
            <>
              <fieldset className="ew-memory-read-options" disabled={!memory.enabled || saving}>
                <legend>新任务读取已有记忆</legend>
                {(
                  [
                    ['default', `跟随全局设置（当前${memory.useMemories ? '开启' : '关闭'}）`],
                    ['enabled', '读取已有记忆'],
                    ['disabled', '不读取已有记忆'],
                  ] as const
                ).map(([value, label]) => (
                  <label className="ew-checkbox" key={value}>
                    <input
                      type="radio"
                      name="memory-read"
                      value={value}
                      checked={readChoice === value}
                      onChange={() => setReadChoice(value)}
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </fieldset>
              <p>只对即将创建的任务生效。新任务是否贡献记忆使用全局设置，创建后可在此单独调整。</p>
            </>
          )}
        </>
      ) : null}
      {props.onImportMemories ? (
        <PillButton disabled={saving} onClick={props.onImportMemories}>
          导入已有记忆
        </PillButton>
      ) : null}
      <PillButton disabled={saving} onClick={props.onGlobalSettings}>
        打开全局记忆设置
      </PillButton>
    </Dialog>
  );
}
