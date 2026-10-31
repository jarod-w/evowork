import { useConsole } from '../console';
import {
  AGENTS,
  APPROVAL_RULES,
  AUDIT_SEED,
  CHANGES,
  DATA_FLOW,
  DEPT_USAGE,
  DEVICES,
  DLP_RULES,
  HEALTH,
  MEMBERS,
  PATH,
  SPACES,
  issuedPolicy,
  TOOL_GRANTS,
  canApprove,
  canEditOrg,
  canEditPolicy,
  canEditRouting,
  formatTokens,
  matches,
  percent,
  usableModels,
} from '../model';
import { CatalogPanel, ProvidersPanel } from './model-config';
import { PolicyDraftPage, PolicyPage } from './policy';
import { Badge, Button, Callout, PageHead, Table, Tabs, downloadText, toneFor } from '../ui';

export function AdminPages({ pathname }: { pathname: string }) {
  if (pathname === PATH.org) return <OrgPage />;
  if (pathname.startsWith(PATH.models)) return <ModelsPage pathname={pathname} />;
  if (pathname === PATH.knowledge) return <DataPage tab="knowledge" />;
  if (pathname === PATH.memoryAdmin) return <DataPage tab="memory" />;
  if (pathname === PATH.data) return <DataPage tab="policy" />;
  if (pathname === PATH.tools) return <AgentsPage tab="tools" />;
  if (pathname === PATH.approvals) return <AgentsPage tab="rules" />;
  if (pathname === PATH.agents) return <AgentsPage tab="catalog" />;
  if (pathname === PATH.policyNew) return <PolicyDraftPage />;
  if (pathname === PATH.policy) return <PolicyPage />;
  if (pathname === PATH.audit) return <AuditPage />;
  if (pathname === PATH.ops) return <OpsPage />;
  return <OverviewPage />;
}

function OverviewPage() {
  const console = useConsole();
  const space = SPACES.find((item) => item.id === console.spaceId)?.name ?? '';
  const depts = DEPT_USAGE[console.spaceId];
  const used = depts.reduce((sum, row) => sum + row.used, 0);
  const limit = depts.reduce((sum, row) => sum + row.limit, 0);
  const pending = CHANGES.filter((item) => console.changes[item.id] === 'pending');
  const finance = console.role === 'finance';
  const auditor = console.role === 'auditor';
  const pack = issuedPolicy(console.packs);
  const behind = DEVICES.filter((device) => device.version !== pack.version);

  return (
    <>
      <PageHead title="概览" lede={`${space}。这是按身份拼出来的首页，具体规则写在各自的组里。`} />
      <div className="grid-stats">
        <article className="stat">
          <div className="stat__label">本月额度</div>
          <div className="stat__value">{percent(used, limit)}%</div>
          <div className="stat__hint">
            {formatTokens(used)} / {formatTokens(limit)}
          </div>
        </article>
        <article className="stat">
          <div className="stat__label">待审批</div>
          <div className="stat__value">{finance ? '—' : pending.length}</div>
          <div className="stat__hint">{finance ? '财务不处理发布和白名单' : '高影响变更'}</div>
        </article>
        <article className="stat">
          <div className="stat__label">策略</div>
          <div className="stat__value">v{pack.version}</div>
          <div className="stat__hint">
            {console.policyDraft
              ? '有草稿未签发'
              : console.nudged
                ? `已催办 ${behind.length} 台旧设备`
                : `${behind.length} 台设备仍不是 v${pack.version}`}
          </div>
        </article>
        <article className="stat">
          <div className="stat__label">外发</div>
          <div className="stat__value">{console.egressStopped ? '已停止' : '允许'}</div>
          <div className="stat__hint">模型调用不受这颗开关影响</div>
        </article>
      </div>
      {!finance ? (
        <section className="card" style={{ marginTop: 16 }}>
          <h2>待办</h2>
          {pending.length === 0 ? <p className="muted">没有待审批的变更。</p> : null}
          <ul className="list">
            {pending.map((change) => (
              <li key={change.id} className="row">
                <div>
                  <strong>{change.title}</strong>
                  <div className="tiny">
                    {change.kind} · {change.by} 提交 · 等待 {change.wait}
                  </div>
                </div>
                {canApprove(console.role, change.id) ? (
                  <Button tone="primary" onClick={() => console.approveChange(change.id)}>
                    批准
                  </Button>
                ) : auditor ? (
                  <span className="tiny">审计员不能审批</span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <section className="card" style={{ marginTop: 16 }}>
          <h2>部门额度</h2>
          <UsageTable />
          <div className="actions" style={{ marginTop: 12 }}>
            <Button tone="primary" onClick={() => console.navigate(PATH.usage)}>
              打开用量
            </Button>
          </div>
        </section>
      )}
      <section className="card" style={{ marginTop: 16 }}>
        <h2>策略下发</h2>
        <p className="tiny">
          当前是 v{pack.version}，{pack.createdBy} 创建，{pack.signedBy}{' '}
          签发。正式环境把策略编译进客户端；这里只展示有没有跟上。
        </p>
        {console.policyDraft ? (
          <Callout tone="warn">有一份草稿还没签发。设备仍使用 v{pack.version}。</Callout>
        ) : null}
        <Table head={['设备', '版本', '状态']}>
          {DEVICES.map((device) => {
            const applied = device.version === pack.version;
            return (
              <tr key={device.name}>
                <td>{device.name}</td>
                <td>v{device.version}</td>
                <td>
                  <Badge tone={applied ? 'ok' : 'warn'}>{applied ? '已应用' : '未应用'}</Badge>
                </td>
              </tr>
            );
          })}
        </Table>
        {console.role === 'finance' ? null : (
          <div className="actions" style={{ marginTop: 12 }}>
            <Button onClick={() => console.navigate(PATH.policy)}>打开策略</Button>
          </div>
        )}
        {canEditPolicy(console.role) ? (
          <div className="actions" style={{ marginTop: 12 }}>
            <Button disabled={console.nudged} onClick={console.nudgeDevices}>
              {console.nudged ? '已记录催办' : '催办未应用的设备'}
            </Button>
          </div>
        ) : null}
      </section>
    </>
  );
}

function OrgPage() {
  const console = useConsole();
  const editable = canEditOrg(console.role);
  const rows = MEMBERS.filter(
    (member) =>
      member.space === console.spaceId &&
      matches(console.query, member.name, member.email, member.dept, member.role),
  );
  return (
    <>
      <PageHead
        title="组织"
        lede="人、组和空间来自身份源。发布人和审批人不是同一个人，审计员不能改配置。"
      />
      {!editable ? <Callout>安全管理员可以查看成员，不能改角色和邀请。</Callout> : null}
      <div className="grid-stats">
        <article className="stat">
          <div className="stat__label">单点登录</div>
          <div className="stat__value">Entra ID</div>
          <div className="stat__hint">已强制 SSO，保留 1 个应急管理员</div>
        </article>
        <article className="stat">
          <div className="stat__label">目录同步</div>
          <div className="stat__value">2 分钟前</div>
          <div className="stat__hint">SCIM。停用后会话立即失效</div>
        </article>
        <article className="stat">
          <div className="stat__label">管理端会话</div>
          <div className="stat__value">8 小时</div>
          <div className="stat__hint">强制 MFA，空闲 30 分钟退出</div>
        </article>
      </div>
      <section className="card" style={{ marginTop: 16 }}>
        <div className="row">
          <h2>成员</h2>
          <Button
            tone="primary"
            disabled={!editable}
            onClick={() => console.toast('原型不发送邀请。正式环境只按邮箱邀请。')}
          >
            邀请成员
          </Button>
        </div>
        <Table head={['姓名', '邮箱', '部门', '角色', '状态']}>
          {rows.map((member) => (
            <tr key={member.email}>
              <td>{member.name}</td>
              <td>{member.email}</td>
              <td>{member.dept}</td>
              <td>{member.role}</td>
              <td>
                <Badge tone="ok">{member.status}</Badge>
              </td>
            </tr>
          ))}
        </Table>
        {rows.length === 0 ? <p className="tiny">这个空间里没有符合的成员。</p> : null}
      </section>
      <section className="card">
        <h2>服务账号</h2>
        <Table head={['名称', '范围', '到期', '最近使用']}>
          <tr>
            <td>svc-kb-sync</td>
            <td>SharePoint 财务库，只读</td>
            <td>2026-12-31</td>
            <td>今天</td>
          </tr>
        </Table>
        <p className="tiny">密钥不在界面上显示。轮换之后只出现一次。</p>
        <Button disabled={!editable} onClick={() => console.toast('原型不生成密钥。')}>
          轮换
        </Button>
      </section>
    </>
  );
}

function ModelsPage({ pathname }: { pathname: string }) {
  const console = useConsole();
  const routing = canEditRouting(console.role);
  const tab =
    pathname === PATH.providers
      ? 'providers'
      : pathname === PATH.catalog
        ? 'catalog'
        : pathname === PATH.usage
          ? 'usage'
          : 'routing';
  return (
    <>
      <PageHead
        title="模型与成本"
        lede="先配置提供商和模型，再用别名决定成员实际走到哪一个。成员看不到厂商和单价。"
      />
      {console.role === 'finance' ? null : (
        <Tabs
          items={[
            { href: PATH.providers, label: '提供商' },
            { href: PATH.catalog, label: '模型' },
            { href: PATH.models, label: '路由' },
            { href: PATH.usage, label: '用量' },
          ]}
        />
      )}
      {tab === 'providers' ? <ProvidersPanel editable={routing} /> : null}
      {tab === 'catalog' ? <CatalogPanel editable={routing} /> : null}
      {tab === 'routing' ? <RoutingPanel editable={routing} /> : null}
      {tab === 'usage' ? <UsagePanel /> : null}
    </>
  );
}

function RoutingPanel({ editable }: { editable: boolean }) {
  const console = useConsole();
  const choices = usableModels(console.models, console.providers);
  const broken = (['reasoning', 'fast'] as const).filter(
    (key) => !choices.some((model) => model.id === console.aliases[key]),
  );
  return (
    <div className="stack">
      {!editable ? (
        <Callout>路由由平台管理员维护。你可以查看处理位置和是否用于训练。</Callout>
      ) : null}
      {broken.length > 0 ? (
        <Callout tone="warn">
          有别名指向了已停用或未评估的模型。在可以映射之前，对应任务会报错，不会改走更松的模型。
        </Callout>
      ) : null}
      <section className="card">
        <h2>别名</h2>
        <AliasSelect
          label="高推理"
          value={console.aliases.reasoning}
          disabled={!editable}
          onChange={(modelId) => console.setAlias('reasoning', modelId)}
        />
        <AliasSelect
          label="快速"
          value={console.aliases.fast}
          disabled={!editable}
          onChange={(modelId) => console.setAlias('fast', modelId)}
        />
        <p className="tiny">换模型只改映射。列表里只有已启用、已评估、且提供商可用的模型。</p>
      </section>
      <section className="card">
        <h2>当前可路由的模型</h2>
        <Table head={['模型', '提供商', '处理位置', '留存', '训练']}>
          {choices.map((model) => {
            const provider = console.providers.find((item) => item.id === model.providerId);
            return (
              <tr key={model.id}>
                <td>{model.name}</td>
                <td>{provider?.name}</td>
                <td>{model.place}</td>
                <td>{model.keep}</td>
                <td>{model.train}</td>
              </tr>
            );
          })}
        </Table>
        {choices.length === 0 ? (
          <p className="tiny">还没有可以路由的模型。先在「提供商」和「模型」里启用并评估。</p>
        ) : null}
      </section>
      <section className="card">
        <h2>请求日志</h2>
        <p>默认只记元数据：token、时延、错误码。不能在这里改成记录正文。</p>
      </section>
    </div>
  );
}

function AliasSelect({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onChange: (modelId: string) => void;
}) {
  const console = useConsole();
  const choices = usableModels(console.models, console.providers);
  const known = choices.some((model) => model.id === value);
  const current = console.models.find((model) => model.id === value);
  return (
    <label className="field">
      {label}
      <select disabled={disabled} value={value} onChange={(event) => onChange(event.target.value)}>
        {known ? null : <option value={value}>{current?.name ?? value}（当前不可用）</option>}
        {choices.map((model) => (
          <option key={model.id} value={model.id}>
            {model.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function UsagePanel() {
  const console = useConsole();
  const finance = console.role === 'finance' || console.role === 'platform';
  return (
    <div className="stack">
      <Callout>用量明细不能导出。审计日志可以导出，两类数据分开。</Callout>
      <UsageTable />
      <section className="card">
        <h2>提醒线</h2>
        <label className="field">
          达到额度的百分之几时提醒
          <input
            type="number"
            min={50}
            max={100}
            disabled={!finance}
            value={console.warnPercent}
            onChange={(event) => console.setWarnPercent(Number(event.target.value))}
          />
        </label>
        <p className="tiny">提醒只带数字。超限动作是拒绝，不降级到别的模型。那条规则在路由页。</p>
      </section>
    </div>
  );
}

function UsageTable() {
  const console = useConsole();
  const rows = DEPT_USAGE[console.spaceId].filter((row) => matches(console.query, row.dept));
  return (
    <Table head={['部门', '已用 token', '上限', '比例']}>
      {rows.map((row) => {
        const pct = percent(row.used, row.limit);
        return (
          <tr key={row.dept}>
            <td>{row.dept}</td>
            <td className="num">{formatTokens(row.used)}</td>
            <td className="num">{formatTokens(row.limit)}</td>
            <td>
              <Badge tone={pct >= console.warnPercent ? 'warn' : 'ok'}>{pct}%</Badge>
            </td>
          </tr>
        );
      })}
    </Table>
  );
}

function DataPage({ tab }: { tab: 'policy' | 'knowledge' | 'memory' }) {
  const console = useConsole();
  const editable = canEditPolicy(console.role);
  const allow = ['bedrock.ap-southeast-1.amazonaws.com', 'graph.microsoft.com', '*.sharepoint.com'];
  if (console.changes.egress === 'approved') allow.push('api.slack.com');
  return (
    <>
      <PageHead
        title="数据"
        lede="分级是这一组的根。知识库、记忆、导出和模型路由引用同一套级别。"
      />
      <Tabs
        items={[
          { href: PATH.data, label: '分级与出口' },
          { href: PATH.knowledge, label: '知识库' },
          { href: PATH.memoryAdmin, label: '记忆' },
        ]}
      />
      {tab === 'policy' ? (
        <div className="stack">
          <section className="card">
            <h2>级别</h2>
            <p>公开、内部、机密、高度机密。机密及以上不能走未评估模型。高度机密不写入长期记忆。</p>
          </section>
          <section className="card">
            <h2>敏感信息规则</h2>
            <Table head={['规则', '命中动作', '来源']}>
              {DLP_RULES.map((rule) => (
                <tr key={rule.name}>
                  <td>{rule.name}</td>
                  <td>{rule.action}</td>
                  <td>{rule.source}</td>
                </tr>
              ))}
            </Table>
          </section>
          <section className="card">
            <h2>出口白名单</h2>
            <p className="tiny">默认拒绝。下面是已经允许的目的地。</p>
            <ul>
              {allow.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            {console.changes.egress === 'pending' ? (
              <Callout tone="warn">
                api.slack.com 还在等另一名平台管理员批准，现在不能访问。
              </Callout>
            ) : null}
          </section>
          <section className="card">
            <h2>留存与驻留</h2>
            <dl className="kv">
              <dt>对话</dt>
              <dd>180 天</dd>
              <dt>记忆</dt>
              <dd>365 天</dd>
              <dt>审计在线</dt>
              <dd>180 天</dd>
              <dt>存储</dt>
              <dd>客户 VPC，ap-southeast-1，客户 KMS</dd>
              <dt>法律保留</dt>
              <dd>当前 0 个冻结对象</dd>
            </dl>
            <Button
              onClick={() => downloadText('数据流说明.txt', DATA_FLOW, 'text/plain;charset=utf-8')}
            >
              导出数据流说明
            </Button>
          </section>
        </div>
      ) : null}
      {tab === 'knowledge' ? (
        <div className="stack">
          <Callout>
            员工电脑上的个人资料库不在管理端。各部门的数据源由该部门的部门管理员配置，这里能看到全部部门。
          </Callout>
          <Table head={['数据源', '部门', '状态', '时间', '分级', '说明']}>
            {console.sources
              .filter((source) => matches(console.query, source.name, source.note, source.dept))
              .map((source) => (
                <tr key={source.id}>
                  <td>{source.name}</td>
                  <td>{source.dept}</td>
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
                </tr>
              ))}
          </Table>
          <Button disabled={!editable} onClick={() => console.retryFailedSources()}>
            重试失败文档
          </Button>
        </div>
      ) : null}
      {tab === 'memory' ? (
        <div className="stack">
          <section className="card">
            <h2>范围</h2>
            <dl className="kv">
              <dt>会话级</dt>
              <dd>开。默认只有这一层。</dd>
              <dt>用户级</dt>
              <dd>东南亚总部已开，保留 180 天。日本子公司仍关。</dd>
              <dt>团队级</dt>
              <dd>关。写入需要另外审批。</dd>
            </dl>
          </section>
          <section className="card">
            <h2>成员自助</h2>
            <label className="check">
              <input
                type="checkbox"
                disabled={!editable}
                checked={console.selfService}
                onChange={(event) => console.setSelfService(event.target.checked)}
              />
              允许成员查看和删除自己的记忆
            </label>
            <p className="tiny">关掉之后，切换到林可，侧栏里不再有「我的记忆」。</p>
          </section>
        </div>
      ) : null}
    </>
  );
}

function AgentsPage({ tab }: { tab: 'catalog' | 'tools' | 'rules' }) {
  const console = useConsole();
  const editable = canEditPolicy(console.role);
  const rows = AGENTS.filter(
    (agent) => agent.space === console.spaceId && matches(console.query, agent.name, agent.owner),
  );
  return (
    <>
      <PageHead
        title="Agent"
        lede="构建者在这里起草和提交发布。成员网页只出现已经发布给他的 Agent。新建时默认没有工具。"
      />
      <Tabs
        items={[
          { href: PATH.agents, label: '目录与发布' },
          { href: PATH.tools, label: '工具与连接器' },
          { href: PATH.approvals, label: '审批规则' },
        ]}
      />
      {tab === 'catalog' ? (
        <div className="stack">
          <Table head={['名称', '负责人', '风险', '版本', '状态', '使用人数', '']}>
            {rows.map((agent) => {
              const stopped = console.stoppedAgents.includes(agent.id);
              const pending = agent.gate === 'publish' && console.changes.publish !== 'approved';
              const status = stopped ? '已停止' : pending ? '待审批' : '生产';
              return (
                <tr key={agent.id}>
                  <td>{agent.name}</td>
                  <td>{agent.owner}</td>
                  <td>
                    <Badge tone={toneFor(agent.risk)}>{agent.risk}</Badge>
                  </td>
                  <td>{agent.version}</td>
                  <td>
                    <Badge tone={toneFor(status)}>{status}</Badge>
                  </td>
                  <td className="num">{pending ? 0 : agent.people}</td>
                  <td>
                    {editable && !stopped && !pending ? (
                      <Button
                        className="btn--small"
                        tone="danger"
                        onClick={() => console.stopAgent(agent.id)}
                      >
                        停止
                      </Button>
                    ) : null}
                    {pending && canApprove(console.role, 'publish') ? (
                      <Button
                        className="btn--small"
                        tone="primary"
                        onClick={() => console.approveChange('publish')}
                      >
                        批准发布
                      </Button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </Table>
          {rows.length === 0 ? <p className="tiny">这个空间还没有 Agent。</p> : null}
          {console.changes.publish === 'pending' ? (
            <p className="tiny">合同条款审阅还没发布，林可的工作台看不到它。</p>
          ) : (
            <p className="tiny">合同条款审阅已发布。切到林可就能在工作台看到。</p>
          )}
        </div>
      ) : null}
      {tab === 'tools' ? (
        <div className="stack">
          <Callout>
            未授权的工具对 Agent 不可见。连接器使用成员自己的授权，不使用共享管理员账号。
          </Callout>
          <Table head={['Agent', '工具', '读写', '风险', '授权']}>
            {TOOL_GRANTS.map((grant) => {
              const on = !console.revokedTools.includes(grant.id);
              return (
                <tr key={grant.id}>
                  <td>{grant.agent}</td>
                  <td>{grant.tool}</td>
                  <td>{grant.mode}</td>
                  <td>
                    <Badge tone={toneFor(grant.risk)}>{grant.risk}</Badge>
                  </td>
                  <td>
                    <Button
                      className="btn--small"
                      disabled={!editable}
                      onClick={() => console.toggleTool(grant.id)}
                    >
                      {on ? '已授权 · 收回' : '已收回 · 恢复'}
                    </Button>
                  </td>
                </tr>
              );
            })}
          </Table>
          <section className="card">
            <h2>凭证</h2>
            <p>
              Outlook、SharePoint
              的服务配置只引用保险库条目，不展示密钥。成员授权记录在「我的连接」。
            </p>
          </section>
        </div>
      ) : null}
      {tab === 'rules' ? (
        <Table head={['工具', '条件', '审批人', '超时']}>
          {APPROVAL_RULES.map((rule) => (
            <tr key={`${rule.tool}-${rule.when}`}>
              <td>{rule.tool}</td>
              <td>{rule.when}</td>
              <td>{rule.who}</td>
              <td>{rule.timeout}</td>
            </tr>
          ))}
        </Table>
      ) : null}
    </>
  );
}

function AuditPage() {
  const console = useConsole();
  const rows = [...console.auditExtra, ...AUDIT_SEED].filter((row) =>
    matches(console.query, row.actor, row.action, row.target, row.trace, row.result),
  );
  return (
    <>
      <PageHead
        title="审计"
        lede="只读。谁改了配置、谁批准了动作，都在这里。审计员没有其他编辑入口。"
      >
        <Button
          tone="primary"
          onClick={() => {
            const header = '时间,操作者,动作,对象,结果,trace\n';
            const body = rows
              .map((row) =>
                [row.time, row.actor, row.action, row.target, row.result, row.trace].join(','),
              )
              .join('\n');
            downloadText('audit.csv', header + body, 'text/csv;charset=utf-8');
          }}
        >
          导出
        </Button>
      </PageHead>
      <div className="grid-stats">
        <article className="stat">
          <div className="stat__label">完整性</div>
          <div className="stat__value">哈希链</div>
          <div className="stat__hint">今日尚未发现断链</div>
        </article>
        <article className="stat">
          <div className="stat__label">SIEM</div>
          <div className="stat__value">已连接</div>
          <div className="stat__hint">近实时推送元数据</div>
        </article>
        <article className="stat">
          <div className="stat__label">正文</div>
          <div className="stat__value">不记录</div>
          <div className="stat__hint">默认，且不能改成记录内容</div>
        </article>
      </div>
      {console.query ? <p className="tiny">正在筛选「{console.query}」</p> : null}
      <div style={{ marginTop: 16 }}>
        <Table head={['时间', '操作者', '动作', '对象', '结果', 'trace']}>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>{row.time}</td>
              <td>{row.actor}</td>
              <td>{row.action}</td>
              <td>{row.target}</td>
              <td>{row.result}</td>
              <td>{row.trace}</td>
            </tr>
          ))}
        </Table>
        {rows.length === 0 ? <p className="tiny">没有符合的记录。</p> : null}
      </div>
    </>
  );
}

function OpsPage() {
  const console = useConsole();
  return (
    <>
      <PageHead
        title="运行"
        lede="看这套部署是否健康、能否升级、诊断包里有没有正文。镜像和网络拓扑不在日常页面里。"
      />
      <div className="stack">
        <Table head={['组件', '状态', '说明']}>
          {HEALTH.map((item) => (
            <tr key={item.name}>
              <td>{item.name}</td>
              <td>
                <Badge tone={toneFor(item.state)}>{item.state}</Badge>
              </td>
              <td>{item.detail}</td>
            </tr>
          ))}
        </Table>
        <section className="card">
          <h2>备份与升级</h2>
          <dl className="kv">
            <dt>最近备份</dt>
            <dd>今天 02:10，成功</dd>
            <dt>当前版本</dt>
            <dd>2026.10.31 原型</dd>
            <dt>升级</dt>
            <dd>没有待安装版本。失败会回滚。</dd>
          </dl>
        </section>
        <section className="card">
          <h2>诊断与厂商进入</h2>
          <p className="muted">诊断包自动去掉提示词、正文和密钥。下载前可以先看这份预览。</p>
          <pre className="composer">{`{\n  "version": "2026.10.31-prototype",\n  "prompts": "已排除",\n  "gateway": "正常"\n}`}</pre>
          <div className="actions">
            <Button
              onClick={() =>
                downloadText(
                  'diagnostic.json',
                  '{\n  "version": "2026.10.31-prototype",\n  "prompts": "removed",\n  "gateway": "ok"\n}\n',
                  'application/json',
                )
              }
            >
              下载诊断包
            </Button>
            <Button disabled onClick={() => undefined}>
              厂商进入：关闭
            </Button>
          </div>
          <p className="tiny">默认没有厂商访问。打开需要管理员批准、限时，并写入审计。</p>
        </section>
        <p className="tiny">
          当前空间：{SPACES.find((item) => item.id === console.spaceId)?.name}
          。单个空间的额度用尽不会放宽别的空间。
        </p>
      </div>
    </>
  );
}
