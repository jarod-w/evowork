import { useCallback, useRef, useState } from 'react';

import { Badge, Dialog, GhostButton, PillButton, SectionHeader } from '../components/primitives.js';

const CONNECTION_KEY = 'evowork.mail-summary-trial.connected';

export interface CatalogMailTrial {
  readonly connected: boolean;
  readonly onConnectionChange: (connected: boolean) => void;
  readonly onOpenTask: () => void;
}

export function useMailTrialConnection() {
  const [connected, setConnected] = useState(() => {
    try {
      return localStorage.getItem(CONNECTION_KEY) === 'true';
    } catch {
      return false;
    }
  });
  function onConnectionChange(next: boolean) {
    try {
      if (next) localStorage.setItem(CONNECTION_KEY, 'true');
      else localStorage.removeItem(CONNECTION_KEY);
    } catch {
      // 页面存储不可用时，内置示例仍可在本次会话中使用。
    }
    setConnected(next);
  }
  return { connected, onConnectionChange };
}

const SAMPLE_MAIL = [
  {
    sender: '产品组',
    subject: '周五发布评审',
    body: '本周五 14:00 评审新版控制台，请在周四下班前提交演示稿。',
    highlight: '新版控制台发布评审定于周五 14:00。',
    todo: '周四下班前提交发布演示稿。',
  },
  {
    sender: '设计组',
    subject: '插件卡片设计稿已更新',
    body: '新版设计稿补齐了空态和错误状态，本轮无需确认。',
    highlight: '插件卡片设计稿已补齐空态和错误状态。',
  },
  {
    sender: '客户成功组',
    subject: '试点问题清单',
    body: '试点用户希望看清邮件连接的访问范围，请周三前补一张权限页截图。',
    highlight: '试点用户希望了解邮件连接的访问范围。',
    todo: '周三前补充邮件权限页截图。',
  },
];

export function MailTrialPermissions({
  connected,
  onClose,
  onConnect,
  onContinue,
  onDisconnect,
}: {
  readonly connected: boolean;
  readonly onClose: () => void;
  readonly onConnect: () => void;
  readonly onContinue?: (() => void) | undefined;
  readonly onDisconnect?: (() => void) | undefined;
}) {
  const [step, setStep] = useState<'permissions' | 'connected' | 'disconnect'>('permissions');
  if (step === 'disconnect' && onDisconnect) {
    return (
      <Dialog
        key="disconnect"
        title="断开示例邮箱？"
        variant="danger"
        confirmLabel="确认断开"
        onCancel={() => setStep('permissions')}
        onConfirm={onDisconnect}
      >
        <p>断开后会清除试用结果。重新连接后才能生成摘要。</p>
      </Dialog>
    );
  }
  if (step === 'connected') {
    return (
      <Dialog
        key="connected"
        title="示例邮箱已连接"
        cancelLabel="关闭"
        confirmLabel={onContinue ? '在任务中试用' : '返回任务'}
        onCancel={onClose}
        onConfirm={onContinue ?? onClose}
      >
        <p>连接权限为只读。可以在任务中用三封示例邮件生成摘要。</p>
      </Dialog>
    );
  }

  return (
    <Dialog
      key="permissions"
      title="邮件摘要 · 权限"
      cancelLabel="关闭"
      confirmLabel={connected ? (onContinue ? '在任务中试用' : '完成') : '模拟连接'}
      onCancel={onClose}
      onConfirm={
        connected
          ? (onContinue ?? onClose)
          : () => {
              onConnect();
              setStep('connected');
            }
      }
    >
      <dl className="ew-mail-trial-permissions">
        <dt>访问范围</dt>
        <dd>只读内置的 3 封示例邮件，包括发件人、主题和正文。</dd>
        <dt>写入权限</dt>
        <dd>无。试用只生成摘要与待办，不发送、删除或修改邮件。</dd>
        <dt>连接状态</dt>
        <dd>
          <Badge variant={connected ? 'success' : 'neutral'}>
            {connected ? '已连接' : '未连接'}
          </Badge>{' '}
          示例邮箱，无需登录。
        </dd>
      </dl>
      {connected && onDisconnect ? (
        <PillButton variant="ghost" onClick={() => setStep('disconnect')}>
          断开连接
        </PillButton>
      ) : null}
    </Dialog>
  );
}

export function MailSummaryTrialPage({
  connected,
  onConnectionChange,
  onBack,
}: {
  readonly connected: boolean;
  readonly onConnectionChange: (connected: boolean) => void;
  readonly onBack: () => void;
}) {
  const [showPermissions, setShowPermissions] = useState(false);
  const [generated, setGenerated] = useState(false);
  const page = useRef<HTMLDivElement>(null);
  const result = useRef<HTMLElement>(null);
  const summaryReady = connected && generated;
  const showResult = useCallback((section: HTMLElement | null) => {
    result.current = section;
    if (!section || !page.current) return;
    section.focus({ preventScroll: true });
    const viewport = page.current.getBoundingClientRect();
    const bounds = section.getBoundingClientRect();
    if (bounds.top < viewport.top || bounds.bottom > viewport.bottom) {
      page.current.scrollTop += bounds.top - viewport.top;
    }
  }, []);

  return (
    <div className="ew-page ew-catalog ew-mail-trial" ref={page}>
      <div className="ew-content-column">
        <GhostButton label="返回插件目录" onClick={onBack} />
        <SectionHeader title="邮件摘要试用" actions={<Badge variant="info">示例任务</Badge>} />
        <div className="ew-mail-trial-access">
          <strong>示例邮箱</strong>
          <Badge variant={connected ? 'success' : 'neutral'}>
            {connected ? '已连接' : '未连接'}
          </Badge>
          <PillButton onClick={() => setShowPermissions(true)}>查看权限</PillButton>
        </div>
        {connected ? (
          <div className="ew-mail-trial-grid">
            <section className="ew-mail-trial-panel" aria-label="示例收件箱">
              <SectionHeader title="示例收件箱" />
              <ul className="ew-mail-trial-messages">
                {SAMPLE_MAIL.map((mail) => (
                  <li key={mail.subject}>
                    <strong>{mail.subject}</strong>
                    <p className="ew-catalog-muted">{mail.sender}</p>
                    <p>{mail.body}</p>
                  </li>
                ))}
              </ul>
              <PillButton
                variant="accent"
                onClick={() => {
                  if (generated) showResult(result.current);
                  else setGenerated(true);
                }}
              >
                生成摘要
              </PillButton>
            </section>
            <section
              className="ew-mail-trial-panel"
              aria-label="摘要结果"
              tabIndex={-1}
              ref={summaryReady ? showResult : undefined}
            >
              <SectionHeader title="摘要结果" />
              {summaryReady ? (
                <div role="status">
                  <h3>重点</h3>
                  <ul>
                    {SAMPLE_MAIL.map((mail) => (
                      <li key={mail.subject}>{mail.highlight}</li>
                    ))}
                  </ul>
                  <h3>待办事项</h3>
                  <ul>
                    {SAMPLE_MAIL.flatMap((mail) =>
                      mail.todo ? [<li key={mail.subject}>{mail.todo}</li>] : [],
                    )}
                  </ul>
                </div>
              ) : (
                <p className="ew-catalog-muted">生成后会显示重点与待办事项。</p>
              )}
            </section>
          </div>
        ) : (
          <>
            <p role="status">连接示例邮箱后即可生成摘要。</p>
            <div>
              <PillButton variant="accent" disabled>
                生成摘要
              </PillButton>
            </div>
          </>
        )}
      </div>
      {showPermissions ? (
        <MailTrialPermissions
          connected={connected}
          onClose={() => setShowPermissions(false)}
          onConnect={() => onConnectionChange(true)}
          onDisconnect={() => {
            setGenerated(false);
            onConnectionChange(false);
            setShowPermissions(false);
          }}
        />
      ) : null}
    </div>
  );
}
