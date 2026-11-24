/**
 * 技能 · 连接器 · 专家目录的本机 I/O（05）。
 *
 * 判定全在 `@evowork/catalog`。这里只做读盘、拷目录、写 `connectors.json`、
 * 改内核 `config.toml` 的 mcp_servers 段。
 *
 * **不执行**被审计目录里的脚本（05 §3.3）。审计喂的是文件名与文本。
 * 本层只落配置；调用方负责通过 app-server 的 `config/mcpServer/reload` 应用变更。
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  lstatSync,
  symlinkSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import {
  auditSkillFiles,
  BROWSER_CONNECTOR_ID,
  ensureOfficialBrowser,
  listApps,
  listExperts,
  listSkills,
  mergeConnectors,
  parseConnectorStore,
  parseFrontmatter,
  skillAllowsImplicit,
  patchSkillInvocation,
  patchMcpServersToml,
  removeConnector,
  renderAgentToml,
  riskLabel,
  serializeConnectorStore,
  setConnectorToolPolicy,
  slugExpert,
  slugConnectorName,
  SOURCE_MARKER_FILE,
  sourceLabel,
  trustConnector,
  upsertConnector,
  withOfficialLaunch,
  type CatalogIo,
  type ConnectorRecord,
  type ConnectorStore,
  type ExpertRecord,
  type OfficialLaunch,
  type SkillRecord,
  type StoredConnector,
} from '@evowork/catalog';

import {
  replaceSkillDirectories,
  removeSkillDirectories,
  skillDestinations,
  skillContentHash,
  SKILL_PROVENANCE,
  preserveSkillInvocation,
} from './skill-storage.js';

import type {
  CatalogAppView,
  CatalogDataView,
  CatalogExpertView,
  CatalogItemView,
  CatalogMutationResult,
  ConnectorView,
} from '../shared/ipc.js';

export interface CatalogPorts {
  readonly pluginsDir: string;
  readonly userRoot: string;
  readonly kernelHome: string;
  readonly nodeCommand: string;
  /**
   * 跑随包 JS 时额外要的环境变量。打包后 `nodeCommand` 是 Electron 自己，
   * 要带 `ELECTRON_RUN_AS_NODE=1` 才是 node（用户机器上没有 node）。
   */
  readonly nodeEnv?: Readonly<Record<string, string>> | undefined;
  readonly io: CatalogIo;
  readonly exists: (path: string) => boolean;
  readonly mkdirp: (path: string) => void;
  readonly copyDir: (src: string, dest: string) => void;
  readonly linkDir: (target: string, path: string) => void;
  readonly removePath: (path: string) => void;
  readonly renamePath: (from: string, to: string) => void;
  readonly writeText: (path: string, content: string) => void;
  readonly writeBytes: (path: string, content: Uint8Array) => void;
  readonly mkdtemp: (prefix: string) => string;
  readonly gitClone: (
    url: string,
    dest: string,
  ) => Promise<
    | { readonly ok: true; readonly revision?: string }
    | { readonly ok: false; readonly error: string }
  >;
}

export interface InstallSkillInput {
  readonly kind: 'file' | 'directory' | 'git';
  readonly path?: string | undefined;
  readonly url?: string | undefined;
  readonly acknowledge?: boolean | undefined;
  readonly confirmName?: string | undefined;
  readonly reviewToken?: string | undefined;
}

export interface AddConnectorInput {
  readonly name: string;
  readonly transport: 'stdio' | 'sse' | 'http';
  readonly command?: string | undefined;
  readonly args?: string | undefined;
  readonly url?: string | undefined;
}

export interface SetConnectorToolPolicyInput {
  readonly id: string;
  readonly tool: string;
  readonly policy: 'default' | 'approve' | 'allow';
}

export interface CreateExpertInput {
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly sampleTasks: string;
  readonly instructions?: string | undefined;
}

const NO_PORTS = '这个版本还没有技能目录。';

export function emptyCatalog(): CatalogDataView {
  return { skills: [], connectors: [], experts: [], apps: [] };
}

export function readCatalog(ports: CatalogPorts): CatalogDataView {
  const skills = listSkills(skillRoots(ports), ports.io);
  const connectors = mergeConnectors(readStore(ports), officialBrowser(ports));
  const experts = readExperts(ports);
  const apps = listApps(skills, connectors);
  return {
    skills: skills.map((skill) => ({
      ...toSkillView(skill),
      allowImplicitInvocation: skillAllowsImplicit(
        ports.io.readText(join(skill.path, 'agents', 'openai.yaml')),
      ),
      invocationEditable: skill.source !== 'official' && !skill.hubRevoked,
      ...(skill.hubRevoked ? { enabled: false, invocationEditable: false } : {}),
    })),
    connectors: connectors.map(toConnectorView),
    experts,
    apps: apps.map(toAppView),
  };
}

/** 内核发现范围可能大于本应用的安装目录；同名技能必须按文件路径分别管理。 */
export function mergeDiscoveredSkills(
  ports: CatalogPorts,
  installed: readonly CatalogItemView[],
  discovered: readonly {
    readonly name: string;
    readonly description: string;
    readonly path: string;
    readonly scope: NonNullable<CatalogItemView['scope']>;
    readonly enabled: boolean;
    readonly pluginId?: string | null;
    readonly interface?: { readonly displayName?: string; readonly defaultPrompt?: string };
  }[],
): readonly CatalogItemView[] {
  const byPath = new Map(discovered.map((skill) => [canonicalSkillPath(skill.path), skill]));
  const matched = new Set<string>();
  const rows = installed.map((skill) => {
    if (!skill.skillPath) return skill;
    const direct = byPath.get(canonicalSkillPath(skill.skillPath));
    // 全局安装保存于用户目录，内核读取其镜像；不使用名称匹配外部同名技能。
    const mirror = byPath.get(
      canonicalSkillPath(
        join(ports.kernelHome, 'skills', basename(dirname(skill.skillPath)), 'SKILL.md'),
      ),
    );
    const native = direct ?? (skill.source !== 'official' ? mirror : undefined);
    if (!native) return skill;
    matched.add(canonicalSkillPath(native.path));
    return {
      ...skill,
      description: native.description,
      enabled: native.enabled,
      scope: native.scope,
      skillPath: native.path,
    };
  });
  for (const [path, skill] of byPath) {
    if (matched.has(path)) continue;
    const audit = auditSkillFiles(ports.io.listFiles(dirname(skill.path), 3));
    const official =
      path ===
      canonicalSkillPath(
        join(ports.pluginsDir, 'skills', basename(dirname(skill.path)), 'SKILL.md'),
      );
    rows.push({
      id: skill.name,
      name: skill.interface?.displayName || skill.name,
      description: skill.description,
      category: '未分类',
      source: official ? 'official' : 'local',
      sourceLabel: official
        ? '官方内置'
        : skill.pluginId
          ? '套件技能'
          : { user: '用户共享', repo: '项目技能', system: '系统技能', admin: '管理员技能' }[
              skill.scope
            ],
      installed: true,
      featured: false,
      riskLevel: audit.level,
      riskLabel: riskLabel(audit.level),
      findings: audit.findings.map((finding) => finding.detail),
      ...(audit.worstCase !== undefined ? { worstCase: audit.worstCase } : {}),
      ...(skill.interface?.defaultPrompt ? { defaultPrompt: skill.interface.defaultPrompt } : {}),
      enabled: skill.enabled,
      scope: skill.scope,
      skillPath: skill.path,
      allowImplicitInvocation: skillAllowsImplicit(
        ports.io.readText(join(dirname(skill.path), 'agents', 'openai.yaml')),
      ),
      invocationEditable: false,
      ...(official
        ? {}
        : { uninstallDisabledReason: '此技能由外部目录或套件管理，可在这里停用。' }),
    });
  }
  return rows;
}

export function canonicalSkillPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

interface SkillSnapshot {
  readonly key: string;
  readonly token: string;
  readonly directory: string;
  readonly sourceKind: 'local' | 'git';
  readonly origin: Readonly<Record<string, string>>;
  readonly hash: string;
  readonly id: string;
  readonly cleanup: ReturnType<typeof setTimeout>;
}

const reviews = new WeakMap<CatalogPorts, Map<string, SkillSnapshot>>();

export function disposeSkillReviews(ports: CatalogPorts): void {
  for (const snapshot of reviews.get(ports)?.values() ?? []) forgetSnapshot(ports, snapshot);
}

function forgetSnapshot(ports: CatalogPorts, snapshot: SkillSnapshot): void {
  reviews.get(ports)?.delete(snapshot.key);
  clearTimeout(snapshot.cleanup);
  try {
    ports.removePath(snapshot.directory);
  } catch {
    /* Outside skill roots. */
  }
}

export async function installSkill(
  ports: CatalogPorts,
  input: InstallSkillInput,
): Promise<CatalogMutationResult> {
  const key = JSON.stringify([input.kind, input.path, input.url]);
  const pending = reviews.get(ports)?.get(key);
  if (input.acknowledge && pending && (!input.reviewToken || pending.token === input.reviewToken))
    return installSnapshot(ports, input, pending);
  if (input.reviewToken) return mutation(ports, false, '安装确认已过期，请重新选择技能并审查。');
  const prepared = await resolveInstallSource(ports, input);
  if (!prepared.ok) return mutation(ports, false, prepared.refused);
  try {
    const snapshot = prepareSnapshot(ports, input, prepared, key);
    return installSnapshot(ports, { ...input, acknowledge: false }, snapshot);
  } catch (error) {
    return mutation(
      ports,
      false,
      `没能准备技能：${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    if (prepared.temporary) {
      try {
        ports.removePath(prepared.temporary);
      } catch {
        /* Outside skill roots. */
      }
    }
  }
}

export function installProjectSkill(
  ports: CatalogPorts,
  input: InstallSkillInput,
  projectRoot: string,
): CatalogMutationResult {
  if (input.kind !== 'directory' || !input.path)
    return mutation(ports, false, '项目技能需要完整目录。');
  const key = JSON.stringify([projectRoot, input.path]);
  const destinations = [join(projectRoot, '.agents', 'skills')];
  const pending = reviews.get(ports)?.get(key);
  if (input.acknowledge && pending) return installSnapshot(ports, input, pending, destinations);
  try {
    const snapshot = prepareSnapshot(ports, input, { src: input.path, sourceKind: 'local' }, key);
    return installSnapshot(ports, { ...input, acknowledge: false }, snapshot, destinations);
  } catch (error) {
    return mutation(
      ports,
      false,
      `没能准备技能：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function prepareSnapshot(
  ports: CatalogPorts,
  input: InstallSkillInput,
  prepared: { src: string; sourceKind: 'local' | 'git'; origin?: Readonly<Record<string, string>> },
  key: string,
): SkillSnapshot {
  const directory = ports.mkdtemp('ew-skill-review-');
  try {
    const file = input.kind === 'file' ? prepared.src : findSkillFile(ports, prepared.src);
    const markdown = file ? ports.io.readText(file) : undefined;
    if (markdown === undefined) throw new Error('这个技能文件读不到，目录必须包含 SKILL.md。');
    const frontmatter = parseFrontmatter(markdown);
    if (!frontmatter.description || (input.kind === 'file' && !frontmatter.name))
      throw new Error('SKILL.md 需要有效的 YAML 元数据与 description；单文件还需要 name。');
    const id = frontmatter.name || basename(prepared.src);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id))
      throw new Error('技能名须为 1–64 位字母、数字、连字符或下划线，不能包含路径。');
    if (Buffer.byteLength(markdown, 'utf8') > 1024 * 1024)
      throw new Error('技能文件不能超过 1 MB。');
    if (input.kind === 'file') ports.mkdirp(directory);
    else ports.copyDir(prepared.src, directory);
    for (const entry of ports.io.readDir(directory)) {
      if (!entry.isDirectory && entry.name.toLowerCase() === 'skill.md')
        ports.removePath(join(directory, entry.name));
    }
    ports.removePath(join(directory, SOURCE_MARKER_FILE));
    ports.removePath(join(directory, SKILL_PROVENANCE));
    ports.writeText(join(directory, 'SKILL.md'), markdown.replace(/^\uFEFF/, ''));
    ports.writeText(join(directory, SOURCE_MARKER_FILE), `${prepared.sourceKind}\n`);
    const map = reviews.get(ports) ?? new Map<string, SkillSnapshot>();
    const previous = map.get(key);
    if (previous) forgetSnapshot(ports, previous);
    while (map.size >= 8) forgetSnapshot(ports, map.values().next().value!);
    const snapshot: SkillSnapshot = {
      key,
      directory,
      id,
      token: randomUUID(),
      sourceKind: prepared.sourceKind,
      origin: prepared.origin ?? { path: prepared.src },
      hash: skillContentHash(directory),
      cleanup: setTimeout(() => forgetSnapshot(ports, snapshot), 10 * 60_000),
    };
    snapshot.cleanup.unref();
    map.set(key, snapshot);
    reviews.set(ports, map);
    return snapshot;
  } catch (error) {
    ports.removePath(directory);
    throw error;
  }
}

function installSnapshot(
  ports: CatalogPorts,
  input: InstallSkillInput,
  snapshot: SkillSnapshot,
  projectRoots?: readonly string[],
): CatalogMutationResult {
  const official = listSkills({ official: skillRoots(ports).official, user: '/nope' }, ports.io);
  if (official.some((skill) => skill.id === snapshot.id)) {
    forgetSnapshot(ports, snapshot);
    return mutation(ports, false, '这是随包技能，已经在目录里了，不必再装一份。');
  }
  const managed = listSkills(skillRoots(ports), ports.io).find((skill) => skill.id === snapshot.id);
  if (!projectRoots && (managed?.source === 'hub' || managed?.source === 'private')) {
    forgetSnapshot(ports, snapshot);
    return mutation(ports, false, '同名技能由内容源管理，请先卸载它再安装本地版本。');
  }
  const audit = auditSkillFiles(ports.io.listFiles(snapshot.directory, 32));
  if (audit.level !== 'p0' && !input.acknowledge)
    return {
      ok: false,
      needsConfirm: true,
      audit: {
        skillId: snapshot.id,
        reviewToken: snapshot.token,
        level: audit.level,
        findings: audit.findings.map((finding) => finding.detail),
        ...(audit.worstCase ? { worstCase: audit.worstCase } : {}),
      },
      catalog: readCatalog(ports),
    };
  if (audit.level === 'p2' && input.confirmName !== snapshot.id)
    return mutation(ports, false, `要安装高风险技能，请输入技能名「${snapshot.id}」确认。`);
  try {
    if (skillContentHash(snapshot.directory) !== snapshot.hash)
      throw new Error('已审计内容发生变化，请重新审查。');
    const destinations =
      projectRoots?.map((root) => join(root, snapshot.id)) ?? skillDestinations(ports, snapshot.id);
    replaceSkillDirectories(ports, destinations, (next) => {
      ports.copyDir(snapshot.directory, next);
      const invocation = preserveSkillInvocation(ports, destinations[0]!, next);
      ports.writeText(
        join(next, SKILL_PROVENANCE),
        JSON.stringify({
          schemaVersion: 1,
          source: snapshot.sourceKind,
          ...snapshot.origin,
          ...(invocation !== undefined ? { allowImplicitInvocation: invocation } : {}),
          contentHash: skillContentHash(next),
          installedAt: new Date().toISOString(),
        }),
      );
    });
    return { ...mutation(ports, true), installedSkillPath: join(destinations[0]!, 'SKILL.md') };
  } catch (error) {
    return mutation(
      ports,
      false,
      `没能装上：${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    forgetSnapshot(ports, snapshot);
  }
}

export function uninstallSkill(ports: CatalogPorts, id: string): CatalogMutationResult {
  const skill = listSkills(skillRoots(ports), ports.io).find((entry) => entry.id === id);
  if (!skill) return mutation(ports, false, '没有这个技能。');
  if (skill.source === 'official') return mutation(ports, false, '官方内置技能不能卸载。');
  try {
    removeSkillDirectories(ports, skillDestinations(ports, basename(skill.path)));
  } catch (error) {
    return mutation(
      ports,
      false,
      `没能卸载：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return mutation(ports, true);
}

export function setSkillInvocation(
  ports: CatalogPorts,
  path: string,
  enabled: boolean,
): CatalogMutationResult {
  const skill = listSkills(skillRoots(ports), ports.io).find(
    (entry) =>
      entry.source !== 'official' &&
      !entry.hubRevoked &&
      [
        join(entry.path, 'SKILL.md'),
        join(ports.kernelHome, 'skills', basename(entry.path), 'SKILL.md'),
      ].some((candidate) => canonicalSkillPath(candidate) === canonicalSkillPath(path)),
  );
  if (!skill) return mutation(ports, false, '只能修改本应用管理的已安装技能。');
  try {
    replaceSkillDirectories(ports, skillDestinations(ports, basename(skill.path)), (next) => {
      ports.copyDir(skill.path, next);
      const policyPath = join(next, 'agents', 'openai.yaml');
      const policy = patchSkillInvocation(ports.io.readText(policyPath), enabled);
      ports.mkdirp(dirname(policyPath));
      ports.writeText(policyPath, policy);
      const previous = ports.io.readText(join(next, SKILL_PROVENANCE));
      ports.writeText(
        join(next, SKILL_PROVENANCE),
        JSON.stringify({
          ...(previous ? JSON.parse(previous) : {}),
          allowImplicitInvocation: enabled,
          contentHash: skillContentHash(next),
        }),
      );
    });
    return mutation(ports, true);
  } catch (error) {
    return mutation(
      ports,
      false,
      `没能修改调用方式：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function addConnector(ports: CatalogPorts, input: AddConnectorInput): CatalogMutationResult {
  const name = input.name.trim();
  if (name === '') return mutation(ports, false, '名称不能为空。');
  if (input.transport === 'stdio' && (input.command === undefined || input.command.trim() === '')) {
    return mutation(ports, false, 'stdio 连接器需要一条命令。');
  }
  if (input.transport !== 'stdio' && (input.url === undefined || input.url.trim() === '')) {
    return mutation(ports, false, 'SSE / HTTP 连接器需要 URL。');
  }
  let store = readStore(ports);
  let id = slugConnectorName(name);
  if (id === BROWSER_CONNECTOR_ID || store.connectors.some((c) => c.id === id)) {
    id = uniqueId(id, new Set(store.connectors.map((c) => c.id)));
  }
  const next: StoredConnector = {
    id,
    name,
    kind: 'custom',
    transport: input.transport,
    trusted: false,
    toolPolicy: {},
    ...(input.transport === 'stdio'
      ? {
          command: input.command?.trim(),
          ...(input.args !== undefined && input.args.trim() !== ''
            ? {
                args: input.args
                  .trim()
                  .split(/\s+/)
                  .filter((a) => a !== ''),
              }
            : {}),
        }
      : { url: input.url?.trim() }),
  };
  store = upsertConnector(store, next);
  writeStore(ports, store);
  return mutation(ports, true);
}

export function trustConnectorAction(ports: CatalogPorts, id: string): CatalogMutationResult {
  let store = ensureOfficialBrowser(readStore(ports), officialBrowser(ports));
  if (id !== BROWSER_CONNECTOR_ID && !store.connectors.some((c) => c.id === id)) {
    return mutation(ports, false, '没有这个连接器。');
  }
  store = trustConnector(store, id);
  const trusted = store.connectors.find((c) => c.id === id);
  if (trusted === undefined || !trusted.trusted) {
    return mutation(ports, false, '没有这个连接器。');
  }
  writeStore(ports, store);
  writeMcpConfig(ports, store);
  return mutation(ports, true);
}

export function removeConnectorAction(ports: CatalogPorts, id: string): CatalogMutationResult {
  let store = ensureOfficialBrowser(readStore(ports), officialBrowser(ports));
  if (id !== BROWSER_CONNECTOR_ID && !store.connectors.some((c) => c.id === id)) {
    return mutation(ports, false, '没有这个连接器。');
  }
  store = removeConnector(store, id);
  writeStore(ports, store);
  writeMcpConfig(ports, store);
  return mutation(ports, true);
}

export function setConnectorToolPolicyAction(
  ports: CatalogPorts,
  input: SetConnectorToolPolicyInput,
): CatalogMutationResult {
  const tool = input.tool.trim();
  if (tool === '') return mutation(ports, false, '工具名不能为空。');
  let store = ensureOfficialBrowser(readStore(ports), officialBrowser(ports));
  const connector = store.connectors.find((c) => c.id === input.id);
  if (!connector) return mutation(ports, false, '没有这个连接器。');
  if (!connector.trusted) return mutation(ports, false, '请先信任并启用这个连接器。');
  store = setConnectorToolPolicy(
    store,
    input.id,
    tool,
    input.policy === 'default' ? undefined : input.policy,
  );
  writeStore(ports, store);
  writeMcpConfig(ports, store);
  return mutation(ports, true);
}

export function createExpert(ports: CatalogPorts, input: CreateExpertInput): CatalogMutationResult {
  const name = input.name.trim();
  if (name === '') return mutation(ports, false, '名称不能为空。');
  const id = slugExpert(name);
  const dir = expertRoots(ports).user;
  const dest = join(dir, `${id}.toml`);
  if (ports.exists(dest)) return mutation(ports, false, '已经有同名专家了。');
  const sampleTasks = input.sampleTasks
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
  const text = renderAgentToml({
    name,
    description: input.description.trim(),
    category: input.category.trim() || '未分类',
    sampleTasks,
    ...(input.instructions !== undefined && input.instructions.trim() !== ''
      ? { instructions: input.instructions.trim() }
      : {}),
  });
  try {
    ports.mkdirp(dir);
    ports.writeText(dest, text);
  } catch (err: unknown) {
    return mutation(ports, false, `没能创建：${err instanceof Error ? err.message : String(err)}`);
  }
  return mutation(ports, true);
}

export function readExperts(ports: CatalogPorts): readonly CatalogExpertView[] {
  return listExperts(expertRoots(ports), ports.io).map(toExpertView);
}

export function removeExpert(ports: CatalogPorts, id: string): CatalogMutationResult {
  const experts = listExperts(expertRoots(ports), ports.io);
  const expert = experts.find((e) => e.id === id);
  if (expert === undefined) return mutation(ports, false, '没有这个专家。');
  if (expert.source === 'official') return mutation(ports, false, '官方专家不能删。');
  try {
    ports.removePath(expert.path);
  } catch (err: unknown) {
    return mutation(ports, false, `没能删除：${err instanceof Error ? err.message : String(err)}`);
  }
  return mutation(ports, true);
}

export function missingPortsResult(): CatalogMutationResult {
  return { ok: false, refused: NO_PORTS, catalog: emptyCatalog() };
}

export function createFsCatalogPorts(input: {
  readonly pluginsDir: string;
  readonly userRoot: string;
  readonly kernelHome: string;
  readonly nodeCommand?: string | undefined;
  readonly nodeEnv?: Readonly<Record<string, string>> | undefined;
  readonly gitClone?: CatalogPorts['gitClone'] | undefined;
}): CatalogPorts {
  const io = createFsCatalogIo();
  return {
    pluginsDir: input.pluginsDir,
    userRoot: input.userRoot,
    kernelHome: input.kernelHome,
    nodeCommand: input.nodeCommand ?? 'node',
    ...(input.nodeEnv !== undefined ? { nodeEnv: input.nodeEnv } : {}),
    io,
    exists: (path) => {
      try {
        lstatSync(path);
        return true;
      } catch {
        return false;
      }
    },
    linkDir: (target, path) =>
      symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir'),
    mkdirp: (path) => {
      mkdirSync(path, { recursive: true });
    },
    copyDir: (src, dest) => {
      // 选中的根目录可以是别名；暂存本身必须是独立目录。
      cpSync(realpathSync(src), dest, { recursive: true, dereference: true });
      const git = join(dest, '.git');
      if (existsSync(git)) rmSync(git, { recursive: true, force: true });
    },
    removePath: (path) => {
      rmSync(path, { recursive: true, force: true });
    },
    renamePath: (from, to) => renameSync(from, to),
    writeText: (path, content) => {
      writeFileSync(path, content, 'utf8');
    },
    writeBytes: (path, content) => {
      writeFileSync(path, content);
    },
    mkdtemp: (prefix) =>
      join(tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(16).slice(2)}`),
    gitClone: input.gitClone ?? defaultGitClone,
  };
}

export function createFsCatalogIo(): CatalogIo {
  return {
    readDir(path) {
      return readdirSync(path, { withFileTypes: true }).map((e) => ({
        name: e.name,
        isDirectory: e.isDirectory(),
      }));
    },
    readText(path) {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return undefined;
      }
    },
    listFiles(dir, maxDepth = 3) {
      return walkFiles(dir, '', maxDepth);
    },
  };
}

function walkFiles(
  root: string,
  rel: string,
  depth: number,
): readonly { readonly relativePath: string; readonly text?: string | undefined }[] {
  if (depth < 0) return [];
  const here = rel === '' ? root : join(root, rel);
  let names: string[] = [];
  try {
    names = readdirSync(here);
  } catch {
    return [];
  }
  const out: { relativePath: string; text?: string | undefined }[] = [];
  for (const name of names) {
    if (name === 'node_modules' || name === '.git' || name === SKILL_PROVENANCE) continue;
    const childRel = rel === '' ? name : join(rel, name);
    const full = join(root, childRel);
    let dir = false;
    try {
      dir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (dir) {
      out.push(...walkFiles(root, childRel, depth - 1));
      continue;
    }
    const text = isText(name) ? readFileSync(full, 'utf8') : undefined;
    out.push({ relativePath: childRel, ...(text !== undefined ? { text } : {}) });
  }
  return out;
}

function isText(name: string): boolean {
  return /\.(md|json|py|mjs|cjs|js|ts|toml|txt|yml|yaml|sh|ps1|bat|html|css|csv)$/i.test(name);
}

function defaultGitClone(
  url: string,
  dest: string,
): Promise<
  { readonly ok: true; readonly revision?: string } | { readonly ok: false; readonly error: string }
> {
  return new Promise((resolve) => {
    const child = spawn('git', ['clone', '--depth', '1', '--', url, dest], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      resolve({ ok: false, error: err.message });
    });
    child.on('close', (code) => {
      if (code === 0) {
        const revision = spawn('git', ['-C', dest, 'rev-parse', 'HEAD'], {
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        let commit = '';
        revision.stdout.on('data', (chunk: Buffer) => {
          commit += chunk.toString();
        });
        revision.on('error', () => resolve({ ok: true }));
        revision.on('close', () =>
          resolve({
            ok: true,
            ...(/^[a-f0-9]{40,64}$/.test(commit.trim()) ? { revision: commit.trim() } : {}),
          }),
        );
      } else resolve({ ok: false, error: stderr.trim() || `git clone 退出码 ${String(code)}` });
    });
  });
}

function skillRoots(ports: CatalogPorts) {
  return {
    official: join(ports.pluginsDir, 'skills'),
    user: join(ports.userRoot, 'skills'),
  };
}

function expertRoots(ports: CatalogPorts) {
  return {
    official: join(ports.pluginsDir, 'agents'),
    user: join(ports.userRoot, 'agents'),
  };
}

export function officialBrowser(ports: CatalogPorts): OfficialLaunch {
  return {
    command: ports.nodeCommand,
    args: [join(ports.pluginsDir, 'connectors', 'browser', 'server.mjs')],
    ...(ports.nodeEnv !== undefined ? { env: ports.nodeEnv } : {}),
  };
}

/**
 * 启动时对一次官方连接器的启动方式（应用升级、或 2026-10-02 之前写进去的 `command = "node"`）。
 * 只有已信任、且 `config.toml` 里那份与现在不一样时才写盘；返回是否写过（写过要让内核重读）。
 */
export function refreshOfficialConnectors(ports: CatalogPorts): boolean {
  const raw = readStore(ports);
  const browser = raw.connectors.find((c) => c.id === BROWSER_CONNECTOR_ID);
  if (browser === undefined) return false;
  const fresh = withOfficialLaunch(raw, officialBrowser(ports));
  const next = fresh.connectors.find((c) => c.id === BROWSER_CONNECTOR_ID);
  if (JSON.stringify(next) === JSON.stringify(browser)) return false;
  writeStore(ports, fresh);
  if (browser.trusted) {
    writeMcpConfig(ports, fresh);
    return true;
  }
  return false;
}

function storePath(ports: CatalogPorts): string {
  return join(ports.userRoot, 'connectors.json');
}

function readStore(ports: CatalogPorts): ConnectorStore {
  return parseConnectorStore(ports.io.readText(storePath(ports)));
}

function writeStore(ports: CatalogPorts, store: ConnectorStore): void {
  ports.mkdirp(ports.userRoot);
  ports.writeText(storePath(ports), serializeConnectorStore(store));
}

function writeMcpConfig(ports: CatalogPorts, store: ConnectorStore): void {
  const configPath = join(ports.kernelHome, 'config.toml');
  const current = ports.io.readText(configPath) ?? '';
  const trusted = store.connectors.filter((c) => c.trusted);
  const next = patchMcpServersToml(current, trusted);
  ports.mkdirp(ports.kernelHome);
  ports.writeText(configPath, next);
}

function mutation(ports: CatalogPorts, ok: boolean, refused?: string): CatalogMutationResult {
  return {
    ok,
    ...(refused !== undefined ? { refused } : {}),
    catalog: readCatalog(ports),
  };
}

async function resolveInstallSource(
  ports: CatalogPorts,
  input: InstallSkillInput,
): Promise<
  | {
      readonly ok: true;
      readonly src: string;
      readonly sourceKind: 'local' | 'git';
      readonly temporary?: string;
      readonly origin?: Readonly<Record<string, string>>;
    }
  | { readonly ok: false; readonly refused: string }
> {
  if (input.kind === 'directory' || input.kind === 'file') {
    const path = input.path?.trim();
    if (path === undefined || path === '')
      return { ok: false, refused: '没有选择技能文件或目录。' };
    if (!ports.exists(path)) return { ok: false, refused: '这个技能文件或目录不存在。' };
    if (input.kind === 'file' && !/\.md$/i.test(path))
      return { ok: false, refused: '请选择 Markdown 技能文件。' };
    return { ok: true, src: path, sourceKind: 'local' };
  }
  const url = input.url?.trim() ?? '';
  if (url === '' || url.includes('\n') || url.startsWith('-')) {
    return { ok: false, refused: '仓库地址不对。' };
  }
  const dest = ports.mkdtemp('ew-skill-git-');
  let keepForInstall = false;
  try {
    const cloned = await ports.gitClone(url, dest);
    if (!cloned.ok) return { ok: false, refused: `没能克隆：${cloned.error}` };
    const src = findSkillDir(ports, dest);
    if (src === undefined) return { ok: false, refused: '仓库里没有 SKILL.md。' };
    keepForInstall = true;
    return {
      ok: true,
      src,
      sourceKind: 'git',
      temporary: dest,
      origin: {
        url,
        subdirectory: src === dest ? '.' : basename(src),
        ...(cloned.revision ? { commit: cloned.revision } : {}),
      },
    };
  } catch (error) {
    return {
      ok: false,
      refused: `没能克隆：${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    if (!keepForInstall) {
      try {
        ports.removePath(dest);
      } catch {
        /* 与安装后的克隆清理采用同一口径。 */
      }
    }
  }
}

function findSkillDir(ports: CatalogPorts, dest: string): string | undefined {
  if (findSkillFile(ports, dest)) return dest;
  let entries: readonly { name: string; isDirectory: boolean }[] = [];
  try {
    entries = ports.io.readDir(dest);
  } catch {
    return undefined;
  }
  const dirs = entries.filter((e) => e.isDirectory && e.name !== '.git');
  const hits = dirs.filter((e) => findSkillFile(ports, join(dest, e.name)) !== undefined);
  if (hits.length === 1 && hits[0] !== undefined) return join(dest, hits[0].name);
  return undefined;
}

function findSkillFile(ports: CatalogPorts, dir: string): string | undefined {
  const canonical = join(dir, 'SKILL.md');
  if (ports.io.readText(canonical) !== undefined) return canonical;
  try {
    const name = ports.io
      .readDir(dir)
      .find((entry) => !entry.isDirectory && entry.name.toLowerCase() === 'skill.md')?.name;
    return name ? join(dir, name) : undefined;
  } catch {
    return undefined;
  }
}

function uniqueId(base: string, taken: Set<string>): string {
  let n = 2;
  let id = `${base}-${String(n)}`;
  while (taken.has(id) || id === BROWSER_CONNECTOR_ID) {
    n += 1;
    id = `${base}-${String(n)}`;
  }
  return id;
}

function toSkillView(s: SkillRecord): CatalogItemView {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    category: s.interface.category,
    source: s.source,
    sourceLabel: sourceLabel(s.source),
    installed: s.installed,
    featured: s.featured,
    skillPath: join(s.path, 'SKILL.md'),
    riskLevel: s.audit.level,
    riskLabel: riskLabel(s.audit.level),
    findings: s.audit.findings.map((f) => f.detail),
    ...(s.audit.worstCase !== undefined ? { worstCase: s.audit.worstCase } : {}),
    ...(s.interface.defaultPrompt !== undefined
      ? { defaultPrompt: s.interface.defaultPrompt }
      : {}),
  };
}

function toConnectorView(c: ConnectorRecord): ConnectorView {
  return {
    id: c.id,
    name: c.name,
    kind: c.kind,
    transport: c.transport,
    trusted: c.trusted,
    status: c.status,
    category: c.category,
    toolPolicy: c.toolPolicy,
    ...(c.command !== undefined ? { command: c.command } : {}),
    ...(c.args !== undefined ? { args: c.args } : {}),
    ...(c.url !== undefined ? { url: c.url } : {}),
    ...(c.envKeys !== undefined ? { envKeys: c.envKeys } : {}),
    ...(c.toolCount !== undefined ? { toolCount: c.toolCount } : {}),
    ...(c.failureSummary !== undefined ? { failureSummary: c.failureSummary } : {}),
    ...(c.disabledReason !== undefined ? { disabledReason: c.disabledReason } : {}),
  };
}

function toExpertView(e: ExpertRecord): CatalogExpertView {
  return {
    id: e.id,
    name: e.name,
    description: e.description,
    source: e.source,
    category: e.interface.category,
    sampleTasks: e.interface.sampleTasks,
    ...(e.instructions !== undefined ? { instructions: e.instructions } : {}),
  };
}

function toAppView(a: {
  readonly id: string;
  readonly kind: 'skill' | 'connector';
  readonly displayName: string;
  readonly description: string;
  readonly category: string;
  readonly defaultPrompt?: string | undefined;
}): CatalogAppView {
  return {
    id: a.id,
    kind: a.kind,
    displayName: a.displayName,
    description: a.description,
    category: a.category,
    ...(a.defaultPrompt !== undefined ? { defaultPrompt: a.defaultPrompt } : {}),
  };
}
