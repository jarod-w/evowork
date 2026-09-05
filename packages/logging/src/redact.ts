/**
 * 把"不能记的东西"转成"能记的东西"。
 *
 * 这个文件的存在是为了让**正确做法比错误做法更省事**。如果只有一条禁令（"不许记正文"），
 * 开发在排查线上问题时一定会想办法绕过它；给出 `pathFields()` / `errorFields()` / `digest()`
 * 三个现成出口后，绕过的动机就小得多 —— 它们提供的同一性判断（同一个文件？同一条 prompt？
 * 同一个错误？）恰好是排查真正需要的，而正文本身通常并不需要。
 */
import { createHash } from 'node:crypto';
import { basename, extname, relative, resolve, sep } from 'node:path';

/** 摘要长度：16 个 hex（64 bit）。足够做同一性判断，短到不像密钥。 */
const DIGEST_LEN = 16;

/**
 * 内容摘要。**不是**为了隐藏后还能还原 —— sha256 对短文本可暴力枚举，所以摘要不等于脱敏，
 * 它的用途只有一个：判断两条记录说的是不是同一件事。
 */
export function digest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, DIGEST_LEN);
}

export type PathKind =
  /** 工作空间内（当前 thread 的 cwd 或 runtimeWorkspaceRoots）—— 按 profile 放行 */
  | 'workspace'
  /** 上传目录：工作空间内的 uploads/，由服务层写入（08 §3.5） */
  | 'upload'
  /** EvoWork 自己的目录（~/.evowork） */
  | 'evowork'
  /** 工作空间之外 —— 需逐次审批（10 §2.3 第二级） */
  | 'outside'
  /** 硬拦截清单：系统目录、密钥与凭据、EvoWork 配置（10 §2.3 第一级，对 danger-full-access 也生效） */
  | 'blocked';

/** 10 §2.3 的硬拦截清单。对 `evowork-full` 同样生效 —— 这是刻意的、不可绕过的。 */
const BLOCKED_PATTERNS: readonly RegExp[] = [
  // 系统目录
  /^\/System(\/|$)/,
  /^\/usr\/(bin|sbin|lib)(\/|$)/,
  /^\/bin(\/|$)/,
  /^\/sbin(\/|$)/,
  /^[A-Za-z]:[\\/]Windows(\\|\/|$)/i,
  // 密钥与凭据
  /(^|[\\/])\.ssh([\\/]|$)/,
  /(^|[\\/])\.aws([\\/]|$)/,
  /(^|[\\/])\.gnupg([\\/]|$)/,
  /(^|[\\/])Library[\\/]Keychains([\\/]|$)/,
  /(^|[\\/])\.config[\\/](gcloud|kube)([\\/]|$)/,
  // 浏览器 profile（cookie 与登录态）
  /(^|[\\/])Library[\\/]Application Support[\\/](Google[\\/]Chrome|Firefox)([\\/]|$)/,
  /(^|[\\/])\.mozilla([\\/]|$)/,
  /(^|[\\/])AppData[\\/](Local|Roaming)[\\/](Google[\\/]Chrome|Mozilla)([\\/]|$)/i,
  // EvoWork 自身配置（改了它等于改策略）
  /(^|[\\/])\.evowork[\\/](config\.toml|requirements\.toml)$/,
];

/**
 * 用 `type` 而不是 `interface` 是有原因的：TypeScript 只给**类型别名**隐式索引签名，
 * 接口没有。而这些结构的用途就是直接交给 `logger.info(event, fields)`（`Fields` 是
 * `Record<string, FieldValue>`），写成 interface 会在调用点报 TS2345，
 * 逼人加一层 `{...spread}` 或 `as never` —— 后者正是我们最不想在日志调用点看到的东西。
 */
export type PathClassification = {
  readonly pathKind: PathKind;
  readonly pathDigest: string;
  /** 扩展名（不含点，小写）。它不含客户信息，且是产物类型识别的依据（08 §2.3） */
  readonly extension: string | undefined;
};

/**
 * 把一个绝对路径转成可记录的三个字段。
 *
 * **为什么不记文件名**：文件名经常就是业务信息本身（`鹏程公司-2026Q2-逾期清单.xlsx`）。
 * 这一条是前一代实现用真实场景换来的教训：字段名（`path`）无害，值有害。
 *
 * @param absPath 绝对路径
 * @param opts.workspaceRoots 工作空间根（thread.cwd + runtimeWorkspaceRoots）
 * @param opts.evoworkHome `~/.evowork`
 */
export function pathFields(
  absPath: string,
  opts: { workspaceRoots?: readonly string[]; evoworkHome?: string } = {},
): PathClassification {
  const normalized = absPath.replaceAll('\\', '/');
  const ext = extname(basename(normalized)).replace(/^\./, '').toLowerCase();

  const classify = (): PathKind => {
    for (const re of BLOCKED_PATTERNS) {
      if (re.test(absPath) || re.test(normalized)) return 'blocked';
    }
    if (opts.evoworkHome && isInside(opts.evoworkHome, absPath)) return 'evowork';
    for (const root of opts.workspaceRoots ?? []) {
      if (!isInside(root, absPath)) continue;
      const rel = relative(resolve(root), resolve(absPath)).replaceAll('\\', '/');
      return rel === 'uploads' || rel.startsWith('uploads/') ? 'upload' : 'workspace';
    }
    return 'outside';
  };

  return {
    pathKind: classify(),
    pathDigest: digest(normalized),
    // token 形状要求以字母开头：`7z` 这类扩展名过不了校验，宁可不记也不记成畸形值
    extension: ext && /^[A-Za-z][A-Za-z0-9]{0,15}$/.test(ext) ? ext : undefined,
  };
}

/** 目录包含判断（不做 realpath —— 那会为了日志去碰磁盘）。 */
function isInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith('..'));
}

/**
 * 声明"我的 message 里不含请求正文"的错误。
 *
 * 只有这一类错误的 message 允许被摘要之外的方式使用（目前也仅限于 `errorCode`）。
 * 其余错误（尤其是第三方 SDK 抛出的）一律只留 class + digest —— 因为各家模型的错误消息
 * 经常把整个请求 echo 回来，而**异常堆栈不得携带请求体**是 Q14 明写的三条路径之一。
 */
export class BodyFreeError extends Error {
  readonly bodyFree = true as const;
  constructor(
    override readonly message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'BodyFreeError';
  }
}

/** 同 `PathClassification`：用 type 别名以获得隐式索引签名，便于直接进 `logger.*`。 */
export type ErrorFields = {
  readonly errorClass: string;
  readonly errorCode?: string;
  readonly messageDigest: string;
  readonly messageLength: number;
};

/**
 * 从任意 throw 出来的东西提取可记录字段。
 *
 * 注意**不记 stack**：堆栈里的帧名本身无害，但第三方库经常把请求片段拼进 message，
 * 而 message 是 stack 的第一行。要定位代码位置用 `errorClass` + 我们自己的 `errorCode`，
 * 那两样足够指到具体分支。
 */
export function errorFields(err: unknown): ErrorFields {
  if (err instanceof BodyFreeError) {
    return {
      errorClass: err.name,
      ...(err.code ? { errorCode: err.code } : {}),
      messageDigest: digest(err.message),
      messageLength: err.message.length,
    };
  }
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    const codeStr = typeof code === 'string' && /^[A-Z0-9_.-]{1,64}$/.test(code) ? code : undefined;
    return {
      errorClass: sanitizeToken(err.name) ?? 'Error',
      ...(codeStr ? { errorCode: codeStr } : {}),
      messageDigest: digest(err.message),
      messageLength: err.message.length,
    };
  }
  const text = typeof err === 'string' ? err : safeStringify(err);
  return {
    errorClass: 'NonError',
    messageDigest: digest(text),
    messageLength: text.length,
  };
}

function sanitizeToken(value: string): string | undefined {
  return /^[A-Za-z][A-Za-z0-9_./:-]{0,63}$/.test(value) ? value : undefined;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}
