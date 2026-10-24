/**
 * 结果区的验收步。给人三句话：交付了什么、改了什么、拦住了什么，再决定是否接受这一版。
 * 决定只记在这台电脑上，交付一变就作废。
 */
import { useEffect, useState } from 'react';

import type { AttentionItem } from '../attention.js';
import type { TaskStatusView } from '../shared/ipc.js';
import { Badge, EmptyState, PillButton } from './primitives.js';

const STORAGE_KEY = 'evowork.delivery-acceptance';

export type AcceptanceDecision = 'accepted' | 'changes-requested';

export interface StoredAcceptance {
  readonly fingerprint: string;
  readonly decision: AcceptanceDecision;
}

export function deliveryFingerprint(input: {
  readonly artifacts: readonly { readonly id: string; readonly version: number }[];
  readonly files: readonly { readonly path: string }[];
}): string {
  return JSON.stringify({
    artifacts: input.artifacts.map((item) => [item.id, item.version]),
    files: input.files.map((item) => item.path),
  });
}

function readAll(): Record<string, StoredAcceptance> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    if (!value || typeof value !== 'object') return {};
    return value as Record<string, StoredAcceptance>;
  } catch {
    return {};
  }
}

export function readStoredAcceptance(threadId: string): StoredAcceptance | undefined {
  const stored = readAll()[threadId];
  if (!stored || (stored.decision !== 'accepted' && stored.decision !== 'changes-requested'))
    return undefined;
  if (typeof stored.fingerprint !== 'string') return undefined;
  return stored;
}

export function writeStoredAcceptance(threadId: string, value: StoredAcceptance): void {
  const all = readAll();
  all[threadId] = value;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}

export function clearStoredAcceptance(threadId: string): void {
  const all = readAll();
  delete all[threadId];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}

function statusLead(status: TaskStatusView): string {
  if (status === 'running' || status === 'planning' || status === 'pending')
    return '还在进行。下面是目前为止的交付，接受只针对这一版。';
  if (status === 'failed' || status === 'interrupted')
    return '这一轮没有完成。可以接受已经交付的部分，或退回继续改。';
  return '这一轮已经结束。看完下面三件事后再决定。';
}

export function AcceptancePanel(props: {
  readonly threadId: string;
  readonly status: TaskStatusView;
  readonly artifacts: readonly {
    readonly id: string;
    readonly name: string;
    readonly version: number;
    readonly artifactType: string;
  }[];
  readonly files: readonly { readonly path: string }[];
  readonly notes?: readonly string[] | undefined;
  readonly blocked: readonly AttentionItem[];
  readonly onOpenArtifact?: ((id: string) => void) | undefined;
  readonly onShowChanges?: (() => void) | undefined;
  readonly onRequestChanges?: (() => void) | undefined;
}) {
  const fingerprint = deliveryFingerprint({
    artifacts: props.artifacts,
    files: props.files,
  });
  const [stored, setStored] = useState<StoredAcceptance | undefined>(() =>
    readStoredAcceptance(props.threadId),
  );
  useEffect(() => {
    setStored(readStoredAcceptance(props.threadId));
  }, [props.threadId, fingerprint]);

  const canDecide = props.artifacts.length > 0 || props.files.length > 0;
  const matches = stored?.fingerprint === fingerprint;
  const decision = matches ? stored.decision : undefined;
  const stale = stored !== undefined && !matches;
  const shownFiles = props.files.slice(0, 6);
  const hiddenFiles = props.files.length - shownFiles.length;

  const decide = (next: AcceptanceDecision): void => {
    const value = { fingerprint, decision: next };
    writeStoredAcceptance(props.threadId, value);
    setStored(value);
    if (next === 'changes-requested') props.onRequestChanges?.();
  };

  return (
    <section className="ew-acceptance" aria-label="验收">
      <p className="ew-acceptance-lead">{statusLead(props.status)}</p>
      {stale ? (
        <p className="ew-acceptance-stale" role="status">
          交付已经变了，上次的决定不再算数。
        </p>
      ) : null}

      <h3>交付了什么</h3>
      {props.artifacts.length === 0 ? (
        <p className="ew-acceptance-empty">还没有登记产物。</p>
      ) : (
        <ul className="ew-result-artifacts">
          {props.artifacts.map((artifact) => (
            <li key={artifact.id}>
              <button
                type="button"
                className="ew-result-artifact"
                onClick={() => props.onOpenArtifact?.(artifact.id)}
              >
                <span>{artifact.name}</span>
                <span>
                  {artifact.artifactType} · 版本 {artifact.version}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <h3>改了什么</h3>
      {props.files.length === 0 ? (
        <p className="ew-acceptance-empty">还没有可列出的文件变更。</p>
      ) : (
        <>
          <ul className="ew-acceptance-files">
            {shownFiles.map((file) => (
              <li key={file.path}>{file.path.split(/[\\/]/).at(-1) || file.path}</li>
            ))}
          </ul>
          {hiddenFiles > 0 ? (
            <p className="ew-acceptance-empty">还有 {hiddenFiles} 个文件。</p>
          ) : null}
          {props.onShowChanges ? (
            <PillButton onClick={props.onShowChanges}>查看变更</PillButton>
          ) : null}
        </>
      )}
      {(props.notes ?? []).map((note) => (
        <p key={note} className="ew-acceptance-empty" role="status">
          {note}
        </p>
      ))}

      <h3>拦住了什么</h3>
      {props.blocked.length === 0 ? (
        <p className="ew-acceptance-empty">没有待批准、超预算或被拦住的操作。</p>
      ) : (
        <ul className="ew-acceptance-files">
          {props.blocked.map((item) => (
            <li key={item.id}>{item.detail}</li>
          ))}
        </ul>
      )}

      <div className="ew-acceptance-decision">
        {decision === 'accepted' ? <Badge variant="success">已接受这一版</Badge> : null}
        {decision === 'changes-requested' ? <Badge variant="warning">已退回修改</Badge> : null}
        {decision === undefined ? (
          canDecide ? (
            <>
              <PillButton variant="accent" onClick={() => decide('accepted')}>
                接受这一版
              </PillButton>
              <PillButton onClick={() => decide('changes-requested')}>退回修改</PillButton>
            </>
          ) : (
            <EmptyState
              title="还没有可以验收的交付"
              hint="出现产物或文件变更后，才能接受或退回这一版。"
            />
          )
        ) : (
          <PillButton
            onClick={() => {
              clearStoredAcceptance(props.threadId);
              setStored(undefined);
            }}
          >
            撤回决定
          </PillButton>
        )}
      </div>
      <p className="ew-acceptance-empty">接受只记在这台电脑上，不会上传。</p>
    </section>
  );
}
