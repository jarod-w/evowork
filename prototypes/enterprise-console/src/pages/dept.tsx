import { useState } from 'react';
import { useConsole } from '../console';
import { AGENTS, DEPT_NAME, MEMBERS, PATH, type KnowledgeSource } from '../model';
import { Badge, Button, Callout, Modal, PageHead, Table, Tabs, toneFor } from '../ui';

type SourceDraft = { id: string; name: string; level: '内部' | '机密'; note: string };

const EMPTY_SOURCE: SourceDraft = { id: '', name: '', level: '内部', note: '' };

export function DeptHome() {
  const console = useConsole();
  const mine = console.sources.filter((source) => source.dept === DEPT_NAME);
  const failed = mine.filter((source) => source.enabled && source.state === '失败').length;
  return (
    <>
      <PageHead
        title="工作台"
        lede="你是财务共享中心的部门管理员，也是一名成员。对话仍在 EvoWork 客户端里进行。"
      />
      <Callout>
        部门配置在「部门」。你能改本部门的知识库、查看本部门成员，以及决定成员能用哪些已发布的
        Agent。模型、出口和角色不在这里。
      </Callout>
      <div className="grid-2" style={{ marginTop: 16 }}>
        <section className="card">
          <h2>本部门知识库</h2>
          <p className="muted">
            {mine.length} 个数据源
            {failed > 0 ? `，其中 ${failed} 个同步失败` : '，同步正常'}
          </p>
          <Button tone="primary" onClick={() => console.navigate(PATH.dept)}>
            配置知识库
          </Button>
        </section>
        <section className="card">
          <h2>本部门成员</h2>
          <p className="muted">
            {MEMBERS.filter((member) => member.dept === DEPT_NAME).length}{' '}
            人。角色由平台管理员维护。
          </p>
          <Button onClick={() => console.navigate(PATH.deptPeople)}>查看成员</Button>
        </section>
      </div>
    </>
  );
}

export function DeptPages({ pathname }: { pathname: string }) {
  const tab = pathname.startsWith(PATH.deptAgents)
    ? 'agents'
    : pathname.startsWith(PATH.deptPeople)
      ? 'people'
      : 'knowledge';
  return (
    <>
      <PageHead
        title="部门"
        lede="范围只有财务共享中心。合规、投行和日本子公司的数据源不在这里。"
      />
      <Tabs
        items={[
          { href: PATH.dept, label: '知识库' },
          { href: PATH.deptPeople, label: '成员' },
          { href: PATH.deptAgents, label: '可用 Agent' },
        ]}
      />
      {tab === 'knowledge' ? <KnowledgePanel /> : null}
      {tab === 'people' ? <PeoplePanel /> : null}
      {tab === 'agents' ? <AgentsPanel /> : null}
    </>
  );
}

function KnowledgePanel() {
  const console = useConsole();
  const [draft, setDraft] = useState<SourceDraft | null>(null);
  const rows = console.sources.filter(
    (source) =>
      source.dept === DEPT_NAME &&
      (!console.query ||
        source.name.includes(console.query) ||
        source.note.includes(console.query)),
  );
  return (
    <div className="stack">
      <Callout>
        这里的数据源只给财务共享中心检索。员工电脑上的个人资料库不在此列。分级用平台已经定义的级别，不能新建级别。
      </Callout>
      <div className="actions">
        <Button tone="primary" onClick={() => setDraft(EMPTY_SOURCE)}>
          新增数据源
        </Button>
      </div>
      <Table head={['数据源', '状态', '时间', '分级', '说明', '操作']}>
        {rows.map((source) => (
          <tr key={source.id}>
            <td>{source.name}</td>
            <td>
              <Badge tone={source.enabled ? toneFor(source.state) : 'neutral'}>
                {source.enabled ? source.state : '已停用'}
              </Badge>
            </td>
            <td>{source.when}</td>
            <td>
              <Badge tone="info">{source.level}</Badge>
            </td>
            <td>{source.note}</td>
            <td>
              <div className="actions">
                <Button className="btn--small" onClick={() => setDraft(toDraft(source))}>
                  编辑
                </Button>
                {source.enabled && source.state === '失败' ? (
                  <Button className="btn--small" onClick={() => console.retrySource(source.id)}>
                    重试
                  </Button>
                ) : null}
                <Button
                  className="btn--small"
                  tone={source.enabled ? 'danger' : 'primary'}
                  onClick={() => console.setSourceEnabled(source.id, !source.enabled)}
                >
                  {source.enabled ? '停用' : '启用'}
                </Button>
              </div>
            </td>
          </tr>
        ))}
      </Table>
      <SourceModal
        draft={draft}
        onClose={() => setDraft(null)}
        onChange={setDraft}
        onSave={() => {
          if (!draft) return;
          if (console.saveSource(draft)) setDraft(null);
        }}
      />
    </div>
  );
}

function toDraft(source: KnowledgeSource): SourceDraft {
  return { id: source.id, name: source.name, level: source.level, note: source.note };
}

function SourceModal({
  draft,
  onClose,
  onChange,
  onSave,
}: {
  draft: SourceDraft | null;
  onClose: () => void;
  onChange: (draft: SourceDraft) => void;
  onSave: () => void;
}) {
  if (!draft) return null;
  return (
    <Modal open title={draft.id ? '编辑数据源' : '新增数据源'} onClose={onClose}>
      <div className="stack">
        <label className="field">
          名称
          <input
            type="text"
            value={draft.name}
            onChange={(event) => onChange({ ...draft, name: event.target.value })}
          />
        </label>
        <label className="field">
          分级
          <select
            value={draft.level}
            onChange={(event) =>
              onChange({ ...draft, level: event.target.value as SourceDraft['level'] })
            }
          >
            <option value="内部">内部</option>
            <option value="机密">机密</option>
          </select>
        </label>
        <label className="field">
          说明
          <textarea
            value={draft.note}
            onChange={(event) => onChange({ ...draft, note: event.target.value })}
          />
        </label>
        <p className="tiny">
          高度机密要由安全管理员在数据分级里处理。这里不能接上未评估的外部系统。
        </p>
        <div className="actions">
          <Button onClick={onClose}>取消</Button>
          <Button tone="primary" onClick={onSave}>
            保存
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function PeoplePanel() {
  const people = MEMBERS.filter((member) => member.dept === DEPT_NAME);
  return (
    <div className="stack">
      <Callout>名单来自身份源。邀请、停用和改角色要由平台管理员在组织里做。</Callout>
      <Table head={['姓名', '邮箱', '角色', '状态']}>
        {people.map((member) => (
          <tr key={member.email}>
            <td>{member.name}</td>
            <td>{member.email}</td>
            <td>{member.role}</td>
            <td>
              <Badge tone="ok">{member.status}</Badge>
            </td>
          </tr>
        ))}
      </Table>
    </div>
  );
}

function AgentsPanel() {
  const console = useConsole();
  const published = console.changes.publish === 'approved';
  return (
    <div className="stack">
      <Callout>
        只能开关已经发布的
        Agent。未发布的要等安全管理员批准。关掉之后，财务共享中心的成员工作台不再显示它。
      </Callout>
      <ul className="list">
        {AGENTS.filter((agent) => agent.space === 'sea').map((agent) => {
          const live = agent.gate === 'open' || published;
          const stopped = console.stoppedAgents.includes(agent.id);
          const off = console.deptAgentsOff.includes(agent.id);
          const on = live && !stopped && !off;
          return (
            <li key={agent.id} className="card">
              <div className="row">
                <div>
                  <strong>{agent.name}</strong>
                  <div className="tiny">{agent.purpose}</div>
                </div>
                <Badge tone={on ? 'ok' : 'neutral'}>
                  {!live ? '未发布' : stopped ? '平台已停用' : off ? '本部门关闭' : '本部门可用'}
                </Badge>
              </div>
              <div className="actions" style={{ marginTop: 12 }}>
                <Button
                  disabled={!live || stopped}
                  tone={off ? 'primary' : 'danger'}
                  onClick={() => console.toggleDeptAgent(agent.id)}
                >
                  {off ? '对本部门开放' : '从本部门收回'}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
