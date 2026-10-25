import { useCallback, useEffect, useRef, useState } from 'react';
import type { EvoworkBridge } from '../app.js';
import type { ComposerReferenceView } from '../../shared/ipc.js';
import type {
  SkillEvidenceView,
  SkillExtractionView,
  SkillSourceView,
} from '../../shared/skill-extraction.js';
import { renderMarkdown } from '../components/item-renderers.js';
import { Badge, Dialog, PillButton } from '../components/primitives.js';
import { SkillInstallDialog } from '../components/skill-install-dialog.js';

function markdown(draft: SkillExtractionView): string {
  const content = draft.content;
  return content
    ? `---\nname: ${content.slug}\ndescription: ${JSON.stringify(content.description)}\n---\n\n# ${content.name}\n\n${content.instructions.trim()}\n`
    : '';
}

/** Composes existing task, result, dialog, and installation primitives. */
export function useSkillExtraction(options: {
  bridge: EvoworkBridge;
  taskId: string | null;
  modelId: string | undefined;
  running: boolean;
  openTask: (id: string, itemId?: string) => void;
  useSkill: (input: {
    projectId: string | null;
    text: string;
    reference: ComposerReferenceView;
  }) => void;
  changed: () => void;
  failed: (error: unknown, fallback: string) => void;
}) {
  const { bridge, taskId } = options;
  const [draft, setDraft] = useState<SkillExtractionView | null>(null);
  const [source, setSource] = useState<SkillSourceView | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [focus, setFocus] = useState('');
  const [fromTurnId, setFromTurnId] = useState('');
  const [adjust, setAdjust] = useState(false);
  const [newDraft, setNewDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [file, setFile] = useState('preview');
  const [evidence, setEvidence] = useState<SkillEvidenceView | null>(null);
  const [detail, setDetail] = useState(false);
  const auditTarget = useRef<{ threadId: string; revision: number; scope: string } | null>(null);
  const [audit, setAudit] = useState<NonNullable<
    import('../../shared/ipc.js').CatalogMutationResult['audit']
  > | null>(null);
  const latest = useRef(options);
  latest.current = options;
  const epoch = useRef(0);
  const refresh = useCallback(async () => {
    const current = latest.current.taskId;
    if (!current || !bridge.getSkillExtraction) return;
    const generation = ++epoch.current;
    try {
      const value = await bridge.getSkillExtraction({ threadId: current });
      if (generation === epoch.current && current === latest.current.taskId) setDraft(value);
    } catch (error) {
      if (generation === epoch.current) latest.current.failed(error, '未能读取技能草稿。');
    }
  }, [bridge]);
  useEffect(() => {
    epoch.current++;
    setDraft(null);
    setSource(null);
    setSetupOpen(false);
    setFile('preview');
    setEvidence(null);
    setAudit(null);
    setDetail(false);
    setLocalError(null);
    void refresh();
  }, [taskId, refresh]);
  const inExtraction = Boolean(draft && draft.threadId === taskId);
  const enabled = Boolean(
    inExtraction &&
    draft?.state === 'saved' &&
    draft.installed?.revision === draft.revision &&
    draft.installed.scope === draft.scope,
  );
  const unavailable = busy || options.running;
  const scopeLabel =
    draft?.scope === 'project'
      ? `「${draft.source.projectName ?? '当前项目'}」项目`
      : '本机所有任务';
  const perform = async (action: () => Promise<void>) => {
    if (busy) return;
    const owner = latest.current.taskId;
    setBusy(true);
    setLocalError(null);
    try {
      await action();
    } catch (error) {
      if (owner === latest.current.taskId)
        setLocalError(error instanceof Error ? error.message : '操作未完成。');
    } finally {
      setBusy(false);
    }
  };
  const begin = () =>
    void perform(async () => {
      if (!taskId || !bridge.getSkillSource) return;
      const value = await bridge.getSkillSource({ threadId: taskId });
      if (latest.current.taskId !== taskId) return;
      setSource(value);
      setFromTurnId(value.turns[0]?.id ?? '');
      setFocus('');
      setAdjust(false);
      setNewDraft(false);
      setSetupOpen(true);
    });
  const start = () =>
    void perform(async () => {
      if (!source || !bridge.startSkillExtraction) return;
      const value = await bridge.startSkillExtraction({
        threadId: source.threadId,
        ...(fromTurnId ? { fromTurnId } : {}),
        ...(focus.trim() ? { focus: focus.trim() } : {}),
        ...(options.modelId ? { modelId: options.modelId } : {}),
        ...(newDraft ? { newDraft: true } : {}),
      });
      if (latest.current.taskId !== source.threadId) return;
      setSetupOpen(false);
      latest.current.openTask(value.threadId);
    });
  const save = (confirmed = false) =>
    void perform(async () => {
      if (!draft || !bridge.saveSkillExtraction) return;
      if (
        confirmed &&
        (auditTarget.current?.threadId !== draft.threadId ||
          auditTarget.current.revision !== draft.revision ||
          auditTarget.current.scope !== draft.scope)
      ) {
        setAudit(null);
        throw new Error('草稿版本或范围已变化，请重新检查能力后保存。');
      }
      const result = await bridge.saveSkillExtraction({
        threadId: draft.threadId,
        revision: draft.revision,
        ...(confirmed ? { acknowledge: true, confirmName: audit?.skillId ?? '' } : {}),
      });
      if (latest.current.taskId !== draft.threadId) return;
      setDraft(result.draft);
      setAudit(result.needsConfirm && result.audit ? result.audit : null);
      auditTarget.current = result.needsConfirm
        ? { threadId: draft.threadId, revision: draft.revision, scope: draft.scope }
        : null;
      if (result.error) setLocalError(result.error);
      if (result.draft.state === 'saved') latest.current.changed();
    });
  const sendQuick = (text: string) =>
    void perform(async () => {
      if (!draft) return;
      await bridge.send({
        threadId: draft.threadId,
        text,
        ...(options.modelId ? { modelId: options.modelId } : {}),
      });
    });
  const useSkill = () =>
    void perform(async () => {
      if (!draft?.installed || !draft.content) return;
      if (!bridge.getComposerContext) throw new Error('当前版本不能加载技能候选。');
      const context = await bridge.getComposerContext({
        ...(draft.source.projectId ? { workspaceId: draft.source.projectId } : {}),
      });
      if (latest.current.taskId !== draft.threadId) return;
      const candidate = context.mentions.find(
        (item) =>
          item.category === 'skill' &&
          item.name === draft.installed!.slug &&
          (item.path === draft.installed!.path + '/SKILL.md' ||
            (draft.scope === 'global' && item.scope === 'user')),
      );
      if (!candidate) throw new Error('当前范围找不到已启用的技能，请重新检查或启用。');
      latest.current.useSkill({
        projectId: draft.source.projectId,
        text: `$${candidate.label} 请使用这个技能处理新的输入：\n`,
        reference: { type: 'skill', name: candidate.name ?? candidate.label, path: candidate.path },
      });
    });

  const contextBar = draft ? (
    <div className="ew-skill-sourcebar">
      {inExtraction ? (
        <>
          <span>
            来源：{draft.source.title} · {draft.source.turns.length}轮 · 截至
            {new Date(draft.source.capturedAt).toLocaleTimeString('zh-CN', {
              hour: '2-digit',
              minute: '2-digit',
            })}
            {draft.sourceDeleted ? ' · 原任务已删除' : ''}
          </span>
          <div className="ew-skill-actions">
            <PillButton
              disabled={draft.sourceDeleted}
              onClick={() => options.openTask(draft.source.threadId)}
            >
              查看原任务
            </PillButton>
            <PillButton
              disabled={unavailable || draft.sourceDeleted}
              onClick={() =>
                void perform(async () => {
                  const next = await bridge.refreshSkillSource?.({ threadId: draft.threadId });
                  if (next && latest.current.taskId === draft.threadId) setDraft(next);
                })
              }
            >
              补充最新记录
            </PillButton>
          </div>
        </>
      ) : (
        <>
          <span>本任务已有{draft.state === 'saved' ? '可复用技能' : '技能草稿'}。</span>
          <PillButton onClick={() => options.openTask(draft.threadId)}>继续提炼</PillButton>
        </>
      )}
    </div>
  ) : null;

  const panel =
    inExtraction && draft ? (
      <section className="ew-skill-workspace" aria-label="技能草稿">
        <div className="ew-skill-panel-head">
          <strong>{draft.content?.name ?? '技能草稿'}</strong>
          <Badge variant={enabled ? 'success' : 'neutral'}>
            {enabled ? '已启用' : `修订${draft.revision}`}
          </Badge>
        </div>
        <div className="ew-skill-filebar">
          <label>
            查看内容
            <select
              className="ew-dialog-input"
              value={file}
              onChange={(event) => setFile(event.target.value)}
            >
              <option value="preview">可读预览</option>
              <option value="SKILL.md">SKILL.md</option>
              {draft.content?.files.map((resource) => (
                <option key={resource.path} value={resource.path}>
                  {resource.path}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="ew-skill-content">
          {!draft.content ? (
            <p role="status">
              {options.running
                ? '正在根据所选记录提炼技能…'
                : '还没有收到技能草稿。可在对话中要求继续提炼并发布草稿。'}
            </p>
          ) : file === 'preview' ? (
            <>
              <p className="ew-skill-description">{draft.content.description}</p>
              <div
                className="ew-markdown"
                dangerouslySetInnerHTML={renderMarkdown(draft.content.instructions)}
              />
              {draft.content.changes.length ? (
                <div className="ew-skill-changes">
                  <strong>本次变化</strong>
                  <ul>
                    {draft.content.changes.map((change, index) => (
                      <li key={index}>{change}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {draft.content.sources.length ? (
                <div className="ew-skill-evidence">
                  <strong>规则来源</strong>
                  {draft.content.sources.map((item, index) => (
                    <div key={index}>
                      <span>{item.rule}</span>
                      <PillButton
                        disabled={draft.sourceDeleted}
                        onClick={() =>
                          setEvidence(
                            draft.source.evidence.find((value) => value.id === item.evidenceId) ??
                              null,
                          )
                        }
                      >
                        查看来源
                      </PillButton>
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="ew-skill-actions">
                <PillButton
                  disabled={unavailable}
                  onClick={() =>
                    sendQuick('只保留分析方法，去掉报告生成要求。请更新并发布完整技能草稿。')
                  }
                >
                  只保留分析方法
                </PillButton>
                <PillButton
                  disabled={unavailable}
                  onClick={() =>
                    sendQuick(
                      '将阈值等本次任务参数改为每次使用时询问，不要固定为本次的值。请发布更新后的技能草稿。',
                    )
                  }
                >
                  参数每次指定
                </PillButton>
              </div>
            </>
          ) : (
            <pre className="ew-skill-code">
              {file === 'SKILL.md'
                ? markdown(draft)
                : (draft.content.files.find((resource) => resource.path === file)?.content ??
                  '该资源在当前修订中已移除。')}
            </pre>
          )}
        </div>
        <div className="ew-skill-savebar">
          {localError || draft.error ? (
            <p className="ew-skill-error" role="alert">
              {localError ?? draft.error}
            </p>
          ) : null}
          {enabled ? (
            <>
              <strong>已保存并启用</strong>
              <p>可在{scopeLabel}中使用 · 尚未在新任务中试用</p>
              <div className="ew-skill-actions">
                <PillButton variant="accent" disabled={busy} onClick={useSkill}>
                  用此技能新建任务
                </PillButton>
                <PillButton onClick={() => setDetail(true)}>查看技能</PillButton>
              </div>
            </>
          ) : (
            <>
              <fieldset disabled={unavailable} className="ew-skill-scope">
                <legend>使用范围</legend>
                {(['project', 'global'] as const).map((scope) => (
                  <label key={scope}>
                    <input
                      type="radio"
                      name="skill-extraction-scope"
                      value={scope}
                      checked={draft.scope === scope}
                      disabled={scope === 'project' && !draft.source.projectId}
                      onChange={() =>
                        void perform(async () => {
                          const value = await bridge.setSkillExtractionScope?.({
                            threadId: draft.threadId,
                            revision: draft.revision,
                            scope,
                          });
                          if (value && latest.current.taskId === draft.threadId) setDraft(value);
                        })
                      }
                    />
                    {scope === 'project'
                      ? `当前项目${draft.source.projectName ? ' · ' + draft.source.projectName : ''}`
                      : '所有任务'}
                  </label>
                ))}
              </fieldset>
              <p>
                {draft.source.projectId
                  ? `保存后可在${scopeLabel}中使用。`
                  : '来源任务未关联项目。所有任务指本机所有项目及无项目任务。'}
              </p>
              <div className="ew-skill-save-bottom">
                <span>
                  {draft.state === 'enable-failed'
                    ? '已保存，启用失败'
                    : draft.content
                      ? '草稿已自动保留，尚未成为技能'
                      : '等待草稿'}
                </span>
                <PillButton
                  variant="accent"
                  disabled={unavailable || !draft.content}
                  onClick={() => save()}
                >
                  {busy
                    ? '处理中…'
                    : options.running
                      ? '正在修改…'
                      : draft.state === 'enable-failed'
                        ? '重试启用'
                        : '保存并启用'}
                </PillButton>
              </div>
            </>
          )}
        </div>
      </section>
    ) : null;
  const dialogs = (
    <>
      {setupOpen && source ? (
        <Dialog
          title="从本任务提炼技能"
          confirmLabel={busy ? '正在创建…' : draft && !newDraft ? '继续已有草稿' : '开始提炼'}
          confirmDisabled={busy}
          onConfirm={
            draft && !newDraft
              ? () => {
                  setSetupOpen(false);
                  options.openTask(draft.threadId);
                }
              : start
          }
          onCancel={() => {
            if (!busy) setSetupOpen(false);
          }}
        >
          <div className="ew-skill-setup-source">
            <strong>{source.title}</strong>
            <p>{source.projectName ?? '无项目'} · 截至当前的完整记录</p>
          </div>
          {draft ? (
            <label className="ew-dialog-field">
              <span>
                <input
                  type="checkbox"
                  checked={newDraft}
                  onChange={(event) => setNewDraft(event.target.checked)}
                />{' '}
                另起一份技能草稿
              </span>
            </label>
          ) : null}
          <div className="ew-skill-actions">
            <span>
              记录范围：
              {source.turns.length -
                Math.max(
                  0,
                  source.turns.findIndex((turn) => turn.id === fromTurnId),
                )}
              轮
            </span>
            <PillButton onClick={() => setAdjust((value) => !value)}>
              {adjust ? '收起' : '调整'}
            </PillButton>
          </div>
          {adjust ? (
            <label className="ew-dialog-field">
              从哪一轮开始
              <select
                className="ew-dialog-input"
                value={fromTurnId}
                onChange={(event) => setFromTurnId(event.target.value)}
              >
                {source.turns.map((turn) => (
                  <option key={turn.id} value={turn.id}>
                    {turn.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="ew-dialog-field">
            提炼重点（可选）
            <textarea
              className="ew-dialog-input"
              rows={3}
              maxLength={4000}
              value={focus}
              onChange={(event) => setFocus(event.target.value)}
              placeholder="例如：保留分析方法和报告格式，去掉本次数据"
            />
          </label>
          <p>将创建关联提炼任务，使用当前配置的模型处理所选记录；原任务与交付物保持原样。</p>
          {localError ? <p role="alert">{localError}</p> : null}
        </Dialog>
      ) : null}
      {evidence && draft ? (
        <Dialog
          title="这条规则的来源"
          confirmLabel="在原任务中查看"
          confirmDisabled={draft.sourceDeleted}
          cancelLabel="关闭"
          onCancel={() => setEvidence(null)}
          onConfirm={() => {
            const item = evidence;
            setEvidence(null);
            options.openTask(item.threadId ?? draft.source.threadId, item.itemId);
          }}
        >
          <p>
            {evidence.threadId ? '本次提炼中的补充说明' : draft.source.title} ·{' '}
            {evidence.role === 'user'
              ? '用户要求'
              : evidence.role === 'assistant'
                ? '助手回复'
                : '执行记录'}
          </p>
          <blockquote className="ew-skill-quote">{evidence.text}</blockquote>
          {evidence.truncated ? <p>此片段已截断，不能据此认定完整执行成功。</p> : null}
        </Dialog>
      ) : null}
      {audit ? (
        <SkillInstallDialog
          audit={audit}
          confirmLabel="保存并启用"
          description={`保存后可在${scopeLabel}中使用，包含当前草稿列出的资源。`}
          onCancel={() => setAudit(null)}
          onConfirm={() => save(true)}
        />
      ) : null}
      {detail && draft ? (
        <Dialog
          title={draft.content?.name ?? '技能详情'}
          confirmLabel="用此技能新建任务"
          cancelLabel="关闭"
          onCancel={() => setDetail(false)}
          onConfirm={() => {
            setDetail(false);
            useSkill();
          }}
        >
          <p>已启用 · {scopeLabel}</p>
          <p>来源：{draft.source.title}</p>
          <p>尚未在新任务中试用。</p>
          <code>{draft.installed?.path}</code>
        </Dialog>
      ) : null}
    </>
  );
  return {
    refresh,
    draft,
    inExtraction,
    panel,
    contextBar: (
      <>
        {contextBar}
        {localError && !setupOpen && !inExtraction ? (
          <p className="ew-skill-error" role="alert">
            {localError}
          </p>
        ) : null}
      </>
    ),
    dialogs,
    begin: bridge.startSkillExtraction ? begin : undefined,
  };
}
