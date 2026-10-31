import { useState, type FormEvent, type ReactNode } from 'react';
import { useConsole } from './console';
import { PATH, PERSONAS, SPACES, adminNav, canKill, persona, searchTarget } from './model';
import { Button, Modal } from './ui';

function active(href: string, pathname: string) {
  if (href === PATH.home) return pathname === PATH.home || pathname.startsWith('/tasks/');
  if (href === PATH.dept) return pathname === PATH.dept || pathname.startsWith(`${PATH.dept}/`);
  if (href === PATH.admin) return pathname === PATH.admin;
  if (href === PATH.models) return pathname.startsWith(PATH.models);
  if (href === PATH.data) return pathname.startsWith(PATH.data);
  if (href === PATH.agents) return pathname.startsWith(PATH.agents);
  if (href === PATH.policy)
    return pathname === PATH.policy || pathname.startsWith(`${PATH.policy}/`);
  return pathname === href;
}

export function Shell({ children }: { children: ReactNode }) {
  const console = useConsole();
  const who = persona(console.role);
  const member = console.role === 'user' || console.role === 'dept';
  const admin = !member;
  const items = admin
    ? adminNav(console.role)
    : [
        { href: PATH.home, label: '工作台' },
        ...(console.role === 'dept' ? [{ href: PATH.dept, label: '部门' }] : []),
        { href: PATH.connections, label: '我的连接' },
        ...(console.selfService ? [{ href: PATH.memory, label: '我的记忆' }] : []),
        { href: PATH.me, label: '我的' },
      ];

  return (
    <>
      <div className="proto">
        <strong>原型</strong>
        <span>正式产品里没有这条切换栏</span>
        <label>
          查看身份
          <select
            aria-label="查看身份"
            value={console.role}
            onChange={(event) => console.setRole(event.target.value as typeof console.role)}
          >
            {PERSONAS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title} · {item.name}
              </option>
            ))}
          </select>
        </label>
        <span className="proto__spacer" />
        <Button className="btn--small" onClick={console.reset}>
          重置演示数据
        </Button>
      </div>
      <div className="shell">
        <nav className="nav" aria-label={admin ? '管理端' : '成员'}>
          <div className="brand">
            <div className="brand__mark" aria-hidden="true">
              澜
            </div>
            <div>
              <div className="brand__name">瀚澜资本</div>
              <div className="brand__sub">{admin ? '管理端' : '成员网页'}</div>
            </div>
          </div>
          <ul className="nav__list">
            {items.map((item) => (
              <li key={item.href}>
                <button
                  type="button"
                  className={
                    active(item.href, console.pathname) ? 'nav__btn is-active' : 'nav__btn'
                  }
                  onClick={() => console.navigate(item.href)}
                >
                  {item.label}
                </button>
              </li>
            ))}
          </ul>
          <div className="nav__foot">
            {who.name} · {who.title}
          </div>
        </nav>
        <div className="main">
          {admin ? <AdminBar /> : null}
          <div className="page">
            {console.egressStopped ? (
              <div className="callout callout--danger">
                全部外发已停止。模型回答不受影响，邮件和对外发送会被拒绝。
              </div>
            ) : null}
            {children}
          </div>
        </div>
      </div>
      <div className="toasts" aria-live="polite">
        {console.toasts.map((item) => (
          <div className="toast" key={item.id}>
            {item.text}
          </div>
        ))}
      </div>
    </>
  );
}

function AdminBar() {
  const console = useConsole();
  const [open, setOpen] = useState(false);
  const [armed, setArmed] = useState(false);
  const [restore, setRestore] = useState(false);

  function onSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const query = String(data.get('q') ?? '');
    console.navigate(searchTarget(console.role, query), query.trim());
  }

  return (
    <div className="topbar">
      <label>
        空间
        <select
          aria-label="空间"
          value={console.spaceId}
          onChange={(event) => console.setSpace(event.target.value as 'sea' | 'jp')}
        >
          {SPACES.map((space) => (
            <option key={space.id} value={space.id}>
              {space.name}
            </option>
          ))}
        </select>
      </label>
      <form className="search" onSubmit={onSearch}>
        <input name="q" type="search" placeholder="搜索成员、Agent 或 trace ID" aria-label="搜索" />
      </form>
      {canKill(console.role) ? (
        console.egressStopped ? (
          <Button tone="primary" onClick={() => setRestore(true)}>
            恢复外发
          </Button>
        ) : (
          <Button tone="danger" onClick={() => setOpen(true)}>
            停止全部外发
          </Button>
        )
      ) : null}
      <Modal open={open} title="停止全部外发" onClose={() => setOpen(false)}>
        <p className="muted">邮件、消息和文件外发会被拒绝。模型调用不停止。这次操作记入审计。</p>
        <label className="check">
          <input
            type="checkbox"
            checked={armed}
            onChange={(event) => setArmed(event.target.checked)}
          />
          我确认要停止
        </label>
        <div className="actions">
          <Button onClick={() => setOpen(false)}>取消</Button>
          <Button
            tone="danger"
            disabled={!armed}
            onClick={() => {
              console.killEgress();
              setOpen(false);
              setArmed(false);
            }}
          >
            停止外发
          </Button>
        </div>
      </Modal>
      <Modal open={restore} title="恢复外发" onClose={() => setRestore(false)}>
        <p className="muted">恢复后，仍要遵守原来的审批规则和白名单。</p>
        <div className="actions">
          <Button onClick={() => setRestore(false)}>取消</Button>
          <Button
            tone="primary"
            onClick={() => {
              console.restoreEgress();
              setRestore(false);
            }}
          >
            恢复
          </Button>
        </div>
      </Modal>
    </div>
  );
}
