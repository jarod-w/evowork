import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { useConsole } from './console';

export function useTitle(title: string) {
  useEffect(() => {
    document.title = `${title} · EvoWork`;
  }, [title]);
}

export function Button({
  tone = 'ghost',
  className,
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'primary' | 'ghost' | 'danger' }) {
  return (
    <button
      type={type}
      className={['btn', `btn--${tone}`, className].filter(Boolean).join(' ')}
      {...rest}
    />
  );
}

export function Badge({
  tone,
  children,
}: {
  tone: 'ok' | 'warn' | 'danger' | 'info' | 'neutral';
  children: ReactNode;
}) {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}

export function PageHead({
  title,
  lede,
  children,
}: {
  title: string;
  lede?: string;
  children?: ReactNode;
}) {
  useTitle(title);
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        {lede ? <p className="lede">{lede}</p> : null}
      </div>
      {children ? <div className="page-head__actions">{children}</div> : null}
    </header>
  );
}

export function Tabs({ items }: { items: { href: string; label: string }[] }) {
  const { pathname, navigate } = useConsole();
  return (
    <div className="tabs" role="tablist">
      {items.map((item) => {
        const current = pathname === item.href;
        return (
          <button
            key={item.href}
            type="button"
            role="tab"
            aria-selected={current}
            className={current ? 'tab is-active' : 'tab'}
            onClick={() => navigate(item.href)}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

export function Callout({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warn' | 'danger';
  children: ReactNode;
}) {
  return <div className={`callout callout--${tone}`}>{children}</div>;
}

export function Meter({ used, limit }: { used: number; limit: number }) {
  const pct = limit <= 0 ? 0 : Math.min(100, Math.round((used / limit) * 100));
  const hot = pct >= 80;
  return (
    <div className="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} role="meter">
      <div className={hot ? 'meter__bar is-hot' : 'meter__bar'} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {head.map((item) => (
              <th key={item} scope="col">
                {item}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Modal({
  open,
  title,
  children,
  onClose,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const [node, setNode] = useState<HTMLDialogElement | null>(null);
  useEffect(() => {
    if (!open || !node) return;
    if (!node.open) node.showModal();
    return () => {
      if (node.open) node.close();
    };
  }, [open, node]);
  if (!open) return null;
  return (
    <dialog ref={setNode} className="modal" aria-label={title} onClose={onClose}>
      <h2>{title}</h2>
      {children}
    </dialog>
  );
}

export function downloadText(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function toneFor(text: string): 'ok' | 'warn' | 'danger' | 'info' | 'neutral' {
  if (['正常', '已应用', '已批准', '已发布', '生产', '同步成功', '低', '成功'].includes(text))
    return 'ok';
  if (['中', '待审批', '待处理', '延迟', '未应用', '未授权'].includes(text)) return 'warn';
  if (['高', '已停止', '失败', '已拦截', '已拒绝'].includes(text)) return 'danger';
  if (text === '内部' || text === '机密' || text === '高度机密') return 'info';
  return 'neutral';
}
