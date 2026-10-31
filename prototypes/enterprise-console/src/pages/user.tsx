import { useState } from 'react';
import { useConsole } from '../console';
import {
  AGENTS,
  CONNECTIONS,
  DEPT_ADMIN_LIMIT,
  DEPT_ADMIN_MEMORIES,
  DEPT_ADMIN_USAGE,
  DEPT_ADMIN_USED,
  MEMORIES,
  PATH,
  PERSONAL_LIMIT,
  PERSONAL_USAGE,
  PERSONAL_USED,
  SESSIONS,
  TASKS,
  formatTokens,
  percent,
} from '../model';
import { DeptHome, DeptPages } from './dept';
import { Badge, Button, Callout, Meter, Modal, PageHead } from '../ui';

export function UserPages({ pathname }: { pathname: string }) {
  const console = useConsole();
  if (console.role === 'dept' && (pathname === PATH.dept || pathname.startsWith(`${PATH.dept}/`))) {
    return <DeptPages pathname={pathname} />;
  }
  if (console.role === 'dept' && pathname === PATH.home) return <DeptHome />;
  if (pathname.startsWith('/tasks/')) return <TaskPage id={pathname.slice('/tasks/'.length)} />;
  if (pathname === PATH.connections) return <ConnectionsPage />;
  if (pathname === PATH.memory) return <MemoryPage />;
  if (pathname === PATH.me) return <AccountPage />;
  return <Workbench />;
}

function visibleAgents(publishApproved: boolean, stopped: string[], off: string[]) {
  return AGENTS.filter(
    (agent) => (agent.gate === 'open' || publishApproved) && !off.includes(agent.id),
  ).map((agent) => ({
    ...agent,
    stopped: stopped.includes(agent.id),
  }));
}

function Workbench() {
  const console = useConsole();
  const [agentId, setAgentId] = useState<string | null>(null);
  const agents = visibleAgents(
    console.changes.publish === 'approved',
    console.stoppedAgents,
    console.deptAgentsOff,
  );
  const selected = agents.find((agent) => agent.id === agentId) ?? null;
  const pending = TASKS.filter((task) => task.approval && !console.taskDecisions[task.id]);
  const pct = percent(PERSONAL_USED, PERSONAL_LIMIT);

  return (
    <>
      <PageHead
        title="工作台"
        lede="这里查看你能用的 Agent、任务状态和额度。对话在 EvoWork 客户端里进行，这个网页不运行 Agent。"
      />
      <div className="grid-2">
        <section className="card">
          <h2>本期额度</h2>
          <p className="muted">
            {formatTokens(PERSONAL_USED)} / {formatTokens(PERSONAL_LIMIT)} token · {pct}%
          </p>
          <Meter used={PERSONAL_USED} limit={PERSONAL_LIMIT} />
          <p className="tiny">
            未到 80% 提醒线。用尽后新任务会被拒绝，不会改走别的模型。单价不在这里显示。
          </p>
        </section>
        <section className="card">
          <h2>待我审批</h2>
          {pending.length === 0 ? (
            <p className="muted">没有要你处理的动作。</p>
          ) : (
            <ul className="list">
              {pending.map((task) => (
                <li key={task.id}>
                  <button
                    type="button"
                    className="task-link"
                    onClick={() => console.navigate(`/tasks/${task.id}`)}
                  >
                    <strong>{task.title}</strong>
                    <div className="tiny">{task.approval?.action}</div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      <h2 style={{ margin: '20px 0 12px', fontSize: 16 }}>我能用的 Agent</h2>
      <div className="agent-grid">
        {agents.map((agent) => (
          <button
            key={agent.id}
            type="button"
            className="agent"
            onClick={() => setAgentId(agent.id)}
          >
            <div className="row">
              <h3>{agent.name}</h3>
              <Badge
                tone={
                  agent.stopped
                    ? 'danger'
                    : agent.risk === '高'
                      ? 'danger'
                      : agent.risk === '中'
                        ? 'warn'
                        : 'ok'
                }
              >
                {agent.stopped ? '已停用' : `风险${agent.risk}`}
              </Badge>
            </div>
            <p className="muted">{agent.purpose}</p>
            <span className="tiny">
              {agent.owner} · {agent.version}
            </span>
          </button>
        ))}
      </div>
      <h2 style={{ margin: '20px 0 12px', fontSize: 16 }}>最近任务</h2>
      <ul className="list">
        {TASKS.map((task) => (
          <li key={task.id}>
            <button
              type="button"
              className="task-link"
              onClick={() => console.navigate(`/tasks/${task.id}`)}
            >
              <div className="row">
                <strong>{task.title}</strong>
                <span className="tiny">{task.updated}</span>
              </div>
              <div className="tiny">
                {console.taskDecisions[task.id] ? '你已处理审批' : task.status}
              </div>
            </button>
          </li>
        ))}
      </ul>
      <Modal open={selected !== null} title={selected?.name ?? ''} onClose={() => setAgentId(null)}>
        {selected ? (
          <>
            <p>{selected.purpose}</p>
            <p className="tiny">
              负责人 {selected.owner} · 版本 {selected.version} · 风险 {selected.risk}
            </p>
            <h3>会碰到的数据</h3>
            <ul>
              {selected.data.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <h3>工具</h3>
            <ul>
              {selected.tools.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <h3>限制</h3>
            <ul>
              {selected.limits.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <div className="actions">
              <Button onClick={() => setAgentId(null)}>关闭</Button>
              <Button
                tone="primary"
                disabled={selected.stopped}
                onClick={() => {
                  console.toast('原型不会打开本机客户端。正式产品从这里唤起 EvoWork。');
                  setAgentId(null);
                }}
              >
                在客户端中打开
              </Button>
            </div>
          </>
        ) : null}
      </Modal>
    </>
  );
}

function TaskPage({ id }: { id: string }) {
  const console = useConsole();
  const task = TASKS.find((item) => item.id === id);
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState('抄送只留主管，去掉其他收件人。');
  if (!task) return <PageHead title="找不到这个任务" />;
  const decision = console.taskDecisions[task.id];
  const agentStopped = console.stoppedAgents.includes(task.agentId);
  const sendBlocked =
    console.egressStopped ||
    console.revokedTools.includes('outlook') ||
    console.granted.outlook === false;
  let blockReason = '';
  if (console.egressStopped) blockReason = '管理员已停止全部外发。';
  else if (console.revokedTools.includes('outlook'))
    blockReason = '管理员没有把「发送邮件」授权给这个 Agent。';
  else if (console.granted.outlook === false) blockReason = '你已撤销 Outlook。';

  return (
    <>
      <PageHead
        title={task.title}
        lede={`${task.updated} · 本任务约 ${formatTokens(task.tokens)} token`}
      >
        <Button onClick={() => console.navigate(PATH.home)}>返回工作台</Button>
      </PageHead>
      <Callout tone="info">
        最后同步于 {task.updated}。源电脑在线。这个网页不能继续执行，也不能打开本机文件。
      </Callout>
      {task.tightened ? (
        <Callout tone="warn">这个对话已收紧。之后可用的工具变少了，规则细节在管理端。</Callout>
      ) : null}
      {agentStopped ? <Callout tone="danger">这个 Agent 已被管理员停用。</Callout> : null}
      <div className="bubbles">
        {task.messages.map((message, index) => (
          <div
            key={index}
            className={message.from === 'user' ? 'bubble bubble--user' : 'bubble bubble--agent'}
          >
            <div>{message.text}</div>
            {message.cite ? (
              <button
                type="button"
                className="cite"
                onClick={() => console.toast('原型没有原文。正式产品会打开这一页。')}
              >
                {message.cite.title} · {message.cite.place}
              </button>
            ) : null}
          </div>
        ))}
      </div>
      {task.approval ? (
        <section className="card" style={{ marginTop: 16 }}>
          <h2>需要你确认</h2>
          <dl className="kv">
            <dt>动作</dt>
            <dd>{task.approval.action}</dd>
            <dt>数据</dt>
            <dd>{task.approval.data}</dd>
            <dt>影响</dt>
            <dd>{task.approval.scope}</dd>
          </dl>
          {decision ? (
            <Callout tone={decision === 'rejected' ? 'danger' : 'info'}>
              {decision === 'rejected' ? '你已拒绝。' : '你已批准。'}
              {console.taskNotes[task.id] ? `修改说明：${console.taskNotes[task.id]}` : ''}
              执行会在你的 EvoWork 客户端继续，网页不会发送。
            </Callout>
          ) : (
            <>
              {sendBlocked ? (
                <Callout tone="warn">{blockReason}可以拒绝，不能批准。</Callout>
              ) : null}
              {editing ? (
                <label className="field">
                  修改说明
                  <textarea value={note} onChange={(event) => setNote(event.target.value)} />
                </label>
              ) : null}
              <div className="actions">
                <Button tone="danger" onClick={() => console.decideTask(task.id, 'rejected')}>
                  拒绝
                </Button>
                <Button disabled={sendBlocked} onClick={() => setEditing(true)}>
                  修改后批准
                </Button>
                <Button
                  tone="primary"
                  disabled={sendBlocked}
                  onClick={() => console.decideTask(task.id, 'approved')}
                >
                  批准
                </Button>
                {editing ? (
                  <Button
                    tone="primary"
                    disabled={sendBlocked}
                    onClick={() => console.decideTask(task.id, 'edited', note)}
                  >
                    确认修改并批准
                  </Button>
                ) : null}
              </div>
            </>
          )}
        </section>
      ) : null}
      <div className="composer">上传和继续输入都在客户端。网页只保留这次任务的状态。</div>
    </>
  );
}

function ConnectionsPage() {
  const console = useConsole();
  return (
    <>
      <PageHead
        title="我的连接"
        lede="这里只有你自己授权过的系统。服务账号、密钥和速率不在这个页面。"
      />
      <ul className="list">
        {CONNECTIONS.map((item) => {
          const on = console.granted[item.id] === true;
          return (
            <li key={item.id} className="card">
              <div className="row">
                <div>
                  <strong>{item.name}</strong>
                  <div className="tiny">{item.detail}</div>
                </div>
                <Badge tone={on ? 'ok' : 'neutral'}>{on ? '已授权' : '未授权'}</Badge>
              </div>
              <div className="actions" style={{ marginTop: 12 }}>
                {on ? (
                  <Button tone="danger" onClick={() => console.grantConnection(item.id, false)}>
                    撤销
                  </Button>
                ) : (
                  <Button tone="primary" onClick={() => console.grantConnection(item.id, true)}>
                    授权
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function MemoryPage() {
  const console = useConsole();
  const catalog = console.role === 'dept' ? DEPT_ADMIN_MEMORIES : MEMORIES;
  const rows = catalog.filter((item) => !console.hiddenMemories.includes(item.id));
  return (
    <>
      <PageHead
        title="我的记忆"
        lede={
          console.role === 'dept'
            ? '这是你自己的记忆，不是部门知识库。团队记忆不在这里。'
            : '管理员允许你查看和删除自己的条目。团队记忆不在这里。证件号、财务明细和健康信息不会被写成长期记忆。'
        }
      />
      {rows.length === 0 ? <p className="muted">你的记忆已经清空。</p> : null}
      <ul className="list">
        {rows.map((item) => (
          <li key={item.id} className="card">
            <div className="row">
              <div>
                <div>{item.text}</div>
                <div className="tiny">
                  {item.source} · {item.level}
                </div>
              </div>
              <Button tone="danger" onClick={() => console.deleteMemory(item.id)}>
                删除
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

function AccountPage() {
  const console = useConsole();
  const dept = console.role === 'dept';
  const used = dept ? DEPT_ADMIN_USED : PERSONAL_USED;
  const limit = dept ? DEPT_ADMIN_LIMIT : PERSONAL_LIMIT;
  const usage = dept ? DEPT_ADMIN_USAGE : PERSONAL_USAGE;
  const pct = percent(used, limit);
  return (
    <>
      <PageHead title="我的" lede="部门、角色和额度由身份源和管理员维护。这里不能改它们。" />
      <div className="stack">
        <section className="card">
          <h2>个人信息</h2>
          <dl className="kv">
            <dt>姓名</dt>
            <dd>{dept ? '何兰' : '林可'}</dd>
            <dt>邮箱</dt>
            <dd>{dept ? 'he.lan@hanlan.example' : 'lin.ke@hanlan.example'}</dd>
            <dt>部门</dt>
            <dd>财务共享中心</dd>
            <dt>空间</dt>
            <dd>东南亚总部</dd>
            <dt>角色</dt>
            <dd>{dept ? '部门管理员' : '成员'}</dd>
            <dt>登录</dt>
            <dd>Microsoft Entra ID</dd>
          </dl>
        </section>
        <section className="card">
          <h2>本期用量</h2>
          <p className="muted">
            {formatTokens(used)} / {formatTokens(limit)} token · {pct}% · 本期至 2026-11-01
          </p>
          <Meter used={used} limit={limit} />
          <p className="tiny">
            按分给你的额度计算，不含单价，也不能导出。用尽后停止，不自动换模型。
          </p>
          <UsageTable rows={usage} used={used} />
        </section>
        <section className="card">
          <h2>偏好</h2>
          <label className="field">
            回复语言
            <select
              value={console.language}
              onChange={(event) => console.setLanguage(event.target.value as 'zh-CN' | 'en')}
            >
              <option value="zh-CN">简体中文</option>
              <option value="en">English</option>
            </select>
          </label>
          <p className="tiny">
            当前回复语言：{console.language === 'en' ? 'English' : '简体中文'}
            。界面语言在正式产品里另有一套，这个原型保持中文。
          </p>
          <label className="check">
            <input
              type="checkbox"
              checked={console.notify}
              onChange={(event) => console.setNotify(event.target.checked)}
            />
            任务完成时通知我
          </label>
        </section>
        <section className="card">
          <h2>登录会话</h2>
          <ul className="list">
            {SESSIONS.filter((item) => !console.signedOut.includes(item.id)).map((item) => (
              <li key={item.id} className="row">
                <div>
                  <strong>{item.device}</strong>
                  <div className="tiny">
                    {item.place} · {item.when}
                  </div>
                </div>
                {item.current ? (
                  <Badge tone="ok">当前</Badge>
                ) : (
                  <Button onClick={() => console.signOutSession(item.id)}>退出</Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}

function UsageTable({ rows, used }: { rows: { agent: string; tokens: number }[]; used: number }) {
  return (
    <div className="table-wrap" style={{ marginTop: 12 }}>
      <table>
        <thead>
          <tr>
            <th>Agent</th>
            <th className="num">本期 token</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.agent}>
              <td>{row.agent}</td>
              <td className="num">{formatTokens(row.tokens)}</td>
            </tr>
          ))}
          <tr>
            <td>合计</td>
            <td className="num">{formatTokens(used)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
