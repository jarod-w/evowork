import { useEffect, useRef, useState, type ReactNode } from 'react';
import { actionErrorText } from '../action-error.js';

export type SettingsAction = () => void | Promise<void>;
export interface SettingsFormState {
  readonly dirty: boolean;
  readonly busy: boolean;
}
export type SettingsLeaveGuard = () => Promise<boolean>;

/** 01 §5.37：名称、说明与控件共享对齐，长内容在窄窗下换行。 */
export function SettingsRow({
  label,
  description,
  children,
  htmlFor,
  danger = false,
}: {
  readonly label: string;
  readonly description?: ReactNode | undefined;
  readonly children: ReactNode;
  readonly htmlFor?: string | undefined;
  readonly danger?: boolean | undefined;
}) {
  return (
    <div className="ew-settings-row" data-danger={danger || undefined}>
      <div className="ew-settings-row-copy">
        {htmlFor ? (
          <label className="ew-settings-row-label" htmlFor={htmlFor}>
            {label}
          </label>
        ) : (
          <p className="ew-settings-row-label">{label}</p>
        )}
        {description ? <div className="ew-settings-row-description">{description}</div> : null}
      </div>
      <div className="ew-settings-row-control">{children}</div>
    </div>
  );
}

export function SettingsFeedback({
  feedback,
}: {
  readonly feedback: { text: string; error: boolean } | null;
}) {
  return feedback ? (
    <p
      className="ew-settings-feedback"
      data-error={feedback.error || undefined}
      role={feedback.error ? 'alert' : 'status'}
    >
      {feedback.text}
    </p>
  ) : null;
}

/** 只有真实动作完成才确认保存；失败不吞掉，也不并发提交旧的全量设置。 */
export function useSettingsAction() {
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ text: string; error: boolean } | null>(null);
  const active = useRef(true);
  const running = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const run = async (
    action: SettingsAction,
    success: string | (() => string) = '已保存。',
    pending = '正在保存…',
  ): Promise<boolean> => {
    if (running.current) return false;
    running.current = true;
    setBusy(true);
    setFeedback({ text: pending, error: false });
    try {
      await action();
      if (active.current)
        setFeedback({ text: typeof success === 'function' ? success() : success, error: false });
      return true;
    } catch (error) {
      if (active.current)
        setFeedback({
          text: actionErrorText(error, '未能保存，请重试。'),
          error: true,
        });
      return false;
    } finally {
      running.current = false;
      if (active.current) setBusy(false);
    }
  };
  return { busy, feedback, run };
}
