/**
 * 闸门（08 §3.4）。
 *
 * 六条规则里有两条是**安全硬规则**，不是体验取舍：
 *
 *   · **ZIP 路径穿越**（条目名里有 `../` 或绝对路径）→ 拒绝**整包**，不是跳过那一条。
 *     跳过单条的做法看起来更友好，但一个精心构造的包可以靠"部分成功"探出目录结构。
 *   · **压缩炸弹**：解压后总量 / 文件数 / 深度三个上限，任一超限即拒绝整包。
 *     只看压缩前大小挡不住 —— 一个 42KB 的 zip 能解出 4.5PB。
 *
 * 其余四条是资源与体验：单文件 200MB、单次 20 个、单文件 120s、加密文件要密码。
 */

export const LIMITS = Object.freeze({
  /** 单文件 200MB。超了建议"把文件放进工作空间，直接让 agent 读" */
  maxFileBytes: 200 * 1024 * 1024,
  /** 单次上传 20 个 */
  maxFilesPerUpload: 20,
  /** 单文件解析超时 120s。超时保留已产出部分 + 标注不完整 */
  parseTimeoutMs: 120_000,
  /** ZIP 解压后总量 500MB */
  maxArchiveBytes: 500 * 1024 * 1024,
  /** ZIP 内文件数 200 */
  maxArchiveEntries: 200,
  /** ZIP 递归深度 2（包里的包还能再解一层，再深就停） */
  maxArchiveDepth: 2,
});

export type GateCode =
  | 'FILE_TOO_LARGE'
  | 'TOO_MANY_FILES'
  | 'ARCHIVE_TOO_LARGE'
  | 'ARCHIVE_TOO_MANY_ENTRIES'
  | 'ARCHIVE_TOO_DEEP'
  | 'ARCHIVE_PATH_TRAVERSAL'
  | 'ENCRYPTED'
  | 'PARSE_TIMEOUT'
  | 'DISK_FULL';

export interface GateRejection {
  readonly code: GateCode;
  /** 给用户看的话。**每一条都要给出路**，不是只说"不行"（01 §4.3 的同一条纪律） */
  readonly message: string;
}

export function checkFileSize(bytes: number, fileName: string): GateRejection | undefined {
  if (bytes <= LIMITS.maxFileBytes) return undefined;
  const mb = Math.round(bytes / 1024 / 1024);
  return {
    code: 'FILE_TOO_LARGE',
    message:
      `《${fileName}》有 ${mb}MB，超过 200MB 的解析上限。` +
      `把它放进工作空间，然后直接让我读那个路径 —— 大文件这样处理更快，也不占解析缓存。`,
  };
}

export function checkUploadCount(count: number): GateRejection | undefined {
  if (count <= LIMITS.maxFilesPerUpload) return undefined;
  return {
    code: 'TOO_MANY_FILES',
    message: `一次最多处理 ${LIMITS.maxFilesPerUpload} 个文件，这次选了 ${count} 个。分两批，或者把它们放进一个文件夹让我直接读。`,
  };
}

export interface ArchiveEntry {
  readonly path: string;
  readonly uncompressedBytes: number;
  readonly encrypted?: boolean;
}

/**
 * 压缩包的四条检查。**任一不过就拒绝整包**。
 *
 * 顺序是刻意的：先查路径穿越（安全），再查规模（资源）。这样一个既穿越又超大的包
 * 报的是穿越 —— 那是更该让用户知道的那一条。
 */
export function checkArchive(
  entries: readonly ArchiveEntry[],
  depth: number,
): GateRejection | undefined {
  for (const entry of entries) {
    if (isPathTraversal(entry.path)) {
      return {
        code: 'ARCHIVE_PATH_TRAVERSAL',
        message:
          '这个压缩包里有指向压缩包之外的路径，已整包拒绝。' +
          '这通常意味着它不是一个正常打包出来的文件 —— 如果确认可信，请先手动解压再拖进来。',
      };
    }
    if (entry.encrypted) {
      return {
        code: 'ENCRYPTED',
        message: '这个压缩包是加密的。请先解压，或者告诉我密码（只在本次解析中使用，不保存）。',
      };
    }
  }

  if (depth > LIMITS.maxArchiveDepth) {
    return {
      code: 'ARCHIVE_TOO_DEEP',
      message: `压缩包套了太多层（超过 ${LIMITS.maxArchiveDepth} 层），已停止解包。请手动解压后再拖进来。`,
    };
  }
  if (entries.length > LIMITS.maxArchiveEntries) {
    return {
      code: 'ARCHIVE_TOO_MANY_ENTRIES',
      message: `这个压缩包里有 ${entries.length} 个文件，超过 ${LIMITS.maxArchiveEntries} 个的上限。请解压后挑需要的几个给我。`,
    };
  }
  const total = entries.reduce((sum, entry) => sum + entry.uncompressedBytes, 0);
  if (total > LIMITS.maxArchiveBytes) {
    return {
      code: 'ARCHIVE_TOO_LARGE',
      message:
        `这个压缩包解开后有 ${Math.round(total / 1024 / 1024)}MB，超过 500MB 的上限，已停止解包。` +
        '请解压后把需要的文件给我。',
    };
  }
  return undefined;
}

/**
 * 路径穿越判定。
 *
 * 三种形态都要认：`../`、绝对路径、以及 Windows 的盘符与反斜杠。
 * 只查 `..` 的实现会放过 `/etc/passwd` 这种绝对路径条目。
 */
export function isPathTraversal(entryPath: string): boolean {
  const normalized = entryPath.replace(/\\/g, '/');
  if (normalized.startsWith('/')) return true;
  if (/^[a-zA-Z]:/.test(normalized)) return true;
  return normalized.split('/').includes('..');
}

/** 磁盘空间预检（08 §8）：解析与生成前都要做，不足时**给出所需空间**而不是只说"空间不足"。 */
export function checkDiskSpace(
  requiredBytes: number,
  availableBytes: number,
): GateRejection | undefined {
  if (availableBytes >= requiredBytes) return undefined;
  const need = Math.ceil((requiredBytes - availableBytes) / 1024 / 1024);
  return {
    code: 'DISK_FULL',
    message: `磁盘空间不够，还差约 ${need}MB。清理一下再试 —— 「资料库 → 清理」可以删掉解析缓存。`,
  };
}
