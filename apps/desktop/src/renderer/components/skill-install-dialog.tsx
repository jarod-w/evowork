import { useState } from 'react';
import type { CatalogMutationResult } from '../../shared/ipc.js';
import { Dialog } from './primitives.js';

/** 附件安装复用目录安装的审计结果与确认要求。 */
export function SkillInstallDialog(props: {
  readonly audit: NonNullable<CatalogMutationResult['audit']>;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const [ack, setAck] = useState(false);
  const [name, setName] = useState('');
  const { audit } = props;
  return (
    <Dialog
      title={audit.level === 'p2' ? '高风险技能' : '安装前请确认'}
      confirmLabel="安装为全局技能"
      variant={audit.level === 'p2' ? 'danger' : 'default'}
      confirmDisabled={audit.level === 'p2' ? name.trim() !== audit.skillId : !ack}
      onCancel={props.onCancel}
      onConfirm={props.onConfirm}
    >
      <p>
        安装后可在所有新旧任务中使用。单文件安装只包含这份 SKILL.md；有脚本或资源时请从目录安装。
      </p>
      <ul className="ew-catalog-findings">
        {audit.findings.map((finding) => (
          <li key={finding}>{finding}</li>
        ))}
      </ul>
      {audit.worstCase ? <p>{audit.worstCase}</p> : null}
      {audit.level === 'p2' ? (
        <label className="ew-dialog-field">
          输入技能名「{audit.skillId}」确认
          <input
            className="ew-dialog-input"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
      ) : (
        <label className="ew-dialog-field">
          <input type="checkbox" checked={ack} onChange={(event) => setAck(event.target.checked)} />{' '}
          我已了解
        </label>
      )}
    </Dialog>
  );
}
