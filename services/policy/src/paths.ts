/**
 * 路径三级策略（10 §2.3，清单 §14 的落点）。
 *
 * ```
 * ┌ 硬拦截 ── 系统目录 · 密钥与凭据 · EvoWork 自身配置
 * │           **任何 profile 都不行，含 evowork-full**
 * ├ 需逐次审批 ── 桌面 / 下载 / 文档 / 图片，以及工作空间之外的任何路径
 * └ 工作空间内 ── 按 profile 放行
 * ```
 *
 * ## 为什么硬拦截对「完全访问」也生效
 *
 * 10 §2.3 的原话，值得原样抄过来：用户点"完全访问"是为了让 agent 装个依赖、
 * 改个工作空间外的项目文件，**不是为了让它读走 SSH 私钥**。
 * 把这条做成不可绕过，比在审批卡上写警告有效得多 ——
 * 警告会被点掉，不可绕过不会。
 *
 * 这条同时也是提示注入的最后一道防线：注入能骗过模型、能骗过用户点"允许"，
 * 但骗不过一个不看谁在请求的路径判定。
 */

export type PathVerdict = 'hard-block' | 'needs-approval' | 'allow';

export interface PathDecision {
  readonly verdict: PathVerdict;
  /** 命中的规则名。审计要记它，用户看到的话也从它推出来 */
  readonly rule: string;
  /** 给用户/模型看的一句话。硬拦截时**必须**有 */
  readonly reason?: string;
}

/**
 * 硬拦截清单。
 *
 * 用前缀匹配而不是 glob：glob 的边界条件（`**` 跨不跨层、大小写）在三个平台上不一致，
 * 而这份清单错一次的代价是私钥被读走。前缀匹配的语义在哪儿都一样。
 */
export interface BlockRule {
  readonly name: string;
  /** 归一化后的路径前缀（POSIX 风格，`~` 已展开） */
  readonly prefixes: readonly string[];
  readonly reason: string;
}

export const HARD_BLOCK_RULES: readonly BlockRule[] = Object.freeze([
  {
    name: 'system-dirs',
    prefixes: [
      '/System/',
      '/Library/LaunchDaemons/',
      '/private/etc/',
      '/etc/',
      '/usr/bin/',
      '/usr/sbin/',
      '/sbin/',
      '/bin/',
      '/boot/',
      '/proc/',
      '/sys/',
      'C:/Windows/',
      'C:/Program Files/',
    ],
    reason: '这是系统目录，改动它可能让系统无法启动',
  },
  {
    name: 'credentials',
    prefixes: [
      '~/.ssh/',
      '~/.aws/',
      '~/.gnupg/',
      '~/.kube/',
      '~/.docker/config.json',
      '~/.netrc',
      '~/.npmrc',
      '~/.pypirc',
      '~/Library/Keychains/',
      '~/AppData/Roaming/Microsoft/Credentials/',
      // 浏览器 profile 里有 cookie 与保存的密码
      '~/Library/Application Support/Google/Chrome/',
      '~/Library/Application Support/Firefox/',
      '~/.config/google-chrome/',
      '~/.mozilla/',
    ],
    reason: '这里存着密钥、凭据或浏览器登录态',
  },
  {
    name: 'evowork-self',
    prefixes: ['~/.evowork/config.toml', '~/.evowork/requirements.toml', '~/.evowork/kernel/'],
    reason: '这是 EvoWork 自己的配置，改它会绕过你设的安全策略',
  },
]);

/** 需逐次审批的个人目录（清单 §14 的"个人文件操作有严格策略"）。 */
export const PERSONAL_DIR_PREFIXES: readonly string[] = Object.freeze([
  '~/Desktop/',
  '~/Downloads/',
  '~/Documents/',
  '~/Pictures/',
  '~/Movies/',
  '~/Music/',
  '~/桌面/',
  '~/下载/',
  '~/文档/',
]);

export interface PathContext {
  /** 当前 thread 的 cwd（绝对路径） */
  readonly workspaceRoot: string;
  /** `runtimeWorkspaceRoots`：额外被视为工作空间内的目录 */
  readonly extraRoots?: readonly string[];
  /** 用户主目录，用来把 `~` 展开 */
  readonly home: string;
}

/**
 * 归一化：统一分隔符、去掉 `.`、解析 `..`、把 home 折成 `~`。
 *
 * **`..` 必须在匹配前解析掉** —— 否则 `~/work/../.ssh/id_rsa` 会被判成工作空间内。
 * 这是这个文件里最容易写错、也最致命的一处。
 */
export function normalizePath(input: string, home: string): string {
  let path = input.replace(/\\/g, '/');
  if (path.startsWith('~/')) path = `${home}/${path.slice(2)}`;

  const isAbsolute = path.startsWith('/') || /^[a-zA-Z]:/.test(path);
  const parts: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop();
      else if (!isAbsolute) parts.push('..');
      continue;
    }
    parts.push(segment);
  }
  let resolved = (isAbsolute && !/^[a-zA-Z]:/.test(path) ? '/' : '') + parts.join('/');
  if (path.endsWith('/') && !resolved.endsWith('/')) resolved += '/';

  const normalizedHome = home.replace(/\\/g, '/').replace(/\/$/, '');
  if (resolved === normalizedHome) return '~';
  if (resolved.startsWith(`${normalizedHome}/`)) {
    return `~/${resolved.slice(normalizedHome.length + 1)}`;
  }
  return resolved;
}

function underPrefix(path: string, prefix: string): boolean {
  // 目录前缀（以 / 结尾）匹配它自己与其下所有内容；文件前缀要求精确相等
  if (prefix.endsWith('/')) {
    return path === prefix.slice(0, -1) || path.startsWith(prefix);
  }
  return path === prefix;
}

export function classifyPath(rawPath: string, context: PathContext): PathDecision {
  const path = normalizePath(rawPath, context.home);

  // ① 硬拦截优先。**先于工作空间判定** —— 否则把工作空间设在 ~/.ssh 就能绕过
  for (const rule of HARD_BLOCK_RULES) {
    if (rule.prefixes.some((prefix) => underPrefix(path, prefix))) {
      return {
        verdict: 'hard-block',
        rule: rule.name,
        reason: `已阻止访问 ${rawPath}：${rule.reason}。这个限制对「完全访问」同样生效。`,
      };
    }
  }

  // ② 工作空间内：按 profile 放行
  const roots = [context.workspaceRoot, ...(context.extraRoots ?? [])].map((root) =>
    normalizePath(root, context.home),
  );
  for (const root of roots) {
    if (path === root || path.startsWith(`${root}/`)) {
      return { verdict: 'allow', rule: 'workspace' };
    }
  }

  // ③ 个人目录与工作空间之外：逐次审批
  const personal = PERSONAL_DIR_PREFIXES.some((prefix) => underPrefix(path, prefix));
  return {
    verdict: 'needs-approval',
    rule: personal ? 'personal-dir' : 'outside-workspace',
    reason: personal
      ? `${rawPath} 在你的个人目录里，每次访问都会问你一次`
      : `${rawPath} 在这个任务的工作空间之外`,
  };
}
