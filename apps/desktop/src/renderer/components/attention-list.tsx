/**
 * 跨任务待办的一行。侧栏和首页用同一份，点进去才到任务或自动化。
 */
import type { AttentionItem, AttentionKind } from '../attention.js';
import { Badge, type BadgeVariant } from './primitives.js';

const KIND_LABEL: Readonly<Record<AttentionKind, string>> = {
  approval: '待批准',
  budget: '超出预算',
  blocked: '已拦住',
  automation: '已暂停',
};

const KIND_BADGE: Readonly<Record<AttentionKind, BadgeVariant>> = {
  approval: 'warning',
  budget: 'warning',
  blocked: 'danger',
  automation: 'neutral',
};

export function AttentionList(props: {
  readonly items: readonly AttentionItem[];
  readonly onOpen: (item: AttentionItem) => void;
}) {
  if (props.items.length === 0) return null;
  return (
    <ul className="ew-attention-list">
      {props.items.map((item) => (
        <li key={item.id}>
          <button type="button" className="ew-attention-row" onClick={() => props.onOpen(item)}>
            <Badge variant={KIND_BADGE[item.kind]}>{KIND_LABEL[item.kind]}</Badge>
            <span className="ew-attention-copy">
              <strong>{item.title}</strong>
              <span>{item.detail}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
