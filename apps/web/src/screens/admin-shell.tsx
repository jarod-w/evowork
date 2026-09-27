/**
 * 管理端骨架：左导航 + 内容区。
 *
 * 五个分区 = D9 四条云端职责的界面面，**不多不少**（11 §13.10）。
 * 原先是一页六段竖着堆 900 行 —— 那个顺序是后端端点的顺序，不是管理员的任务顺序。
 */
import type { ReactNode } from 'react';

import { BrandMark, Icon, type IconName } from '../components.js';

export type AdminSection = 'overview' | 'members' | 'models' | 'usage' | 'policy';

export const ADMIN_SECTIONS: readonly {
  readonly id: AdminSection;
  readonly label: string;
  readonly path: string;
  readonly icon: IconName;
}[] = [
  { id: 'overview', label: '概览', path: '/admin', icon: 'overview' },
  { id: 'members', label: '成员', path: '/admin/members', icon: 'members' },
  { id: 'models', label: '默认模型', path: '/admin/models', icon: 'models' },
  { id: 'usage', label: '用量与配额', path: '/admin/usage', icon: 'usage' },
  { id: 'policy', label: '策略与审计', path: '/admin/policy', icon: 'policy' },
];

export function AdminShell(props: {
  readonly section: AdminSection;
  readonly title: string;
  readonly tenantName: string;
  readonly actorEmail: string;
  readonly counts?: Partial<Record<AdminSection, number>> | undefined;
  readonly headerActions?: ReactNode | undefined;
  readonly onGo: (path: string) => void;
  readonly onSignOut: () => void;
  readonly children: ReactNode;
}) {
  return (
    <div className="ew-admin">
      <nav className="ew-nav" aria-label="管理端导航">
        <div className="ew-nav-brand">
          <BrandMark />
          <span className="ew-strong">EvoWork</span>
          <span className="ew-badge">管理端</span>
        </div>

        <ul className="ew-nav-list">
          {ADMIN_SECTIONS.map((item) => (
            <li key={item.id}>
              <a
                className="ew-nav-item"
                href={item.path}
                aria-current={item.id === props.section ? 'page' : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  props.onGo(item.path);
                }}
              >
                <Icon name={item.icon} />
                {item.label}
                {props.counts?.[item.id] !== undefined ? (
                  <>
                    <span className="ew-grow" />
                    <span className="ew-nav-count">{props.counts[item.id]}</span>
                  </>
                ) : null}
              </a>
            </li>
          ))}
        </ul>

        <span className="ew-grow" />

        <button className="ew-nav-foot" type="button" onClick={props.onSignOut}>
          <span className="ew-avatar" data-tone="accent" data-shape="square">
            {props.tenantName.slice(0, 1)}
          </span>
          <span className="ew-nav-foot-text">
            <span className="ew-strong">{props.tenantName}</span>
            <span className="ew-micro">{props.actorEmail}</span>
          </span>
          <Icon name="more" />
        </button>
      </nav>

      <div className="ew-main">
        <header className="ew-header">
          <h1>{props.title}</h1>
          <span className="ew-grow" />
          {props.headerActions}
        </header>
        <main className="ew-body">{props.children}</main>
      </div>
    </div>
  );
}
