import { useEffect, useState } from 'react';
import type { MemorySettingsView } from '../../shared/ipc.js';
import { PillButton } from './primitives.js';

export function memoryPreparationLabel(memory: MemorySettingsView): string {
  if (!memory.enabled) return '本地记忆已关闭。';
  if (memory.version === 'v1') return '当前记忆管线（V1）不提供整理进度；使用与生成设置仍然有效。';
  if (!memory.statusSupported) return '当前版本不提供记忆准备进度；设置仍然有效。';
  return memory.ready
    ? `记忆已就绪，已整理 ${memory.consolidatedThreads} 个任务。`
    : `尚未达到记忆就绪条件，已整理 ${memory.consolidatedThreads} 个任务。`;
}

export function MemoryPreparation({
  read,
}: {
  readonly read?: (() => Promise<MemorySettingsView>) | undefined;
}) {
  const [memory, setMemory] = useState<MemorySettingsView>();
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!read) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const value = await read();
        if (!active) return;
        setMemory(value);
        setError(false);
        if (value.enabled && value.statusSupported) timer = setTimeout(() => void refresh(), 5000);
      } catch {
        if (active) setError(true);
      }
    };
    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [read, revision]);
  if (!read) return null;
  return (
    <section aria-label="记忆整理状态">
      <p role="status">
        {error
          ? '无法读取整理状态，请重试。'
          : memory
            ? memoryPreparationLabel(memory)
            : '正在读取整理状态…'}
      </p>
      <p>这是整体记忆状态，不能确认某次导入的整理进度或完成时间。</p>
      <PillButton variant="ghost" onClick={() => setRevision((v) => v + 1)}>
        刷新整理状态
      </PillButton>
    </section>
  );
}
