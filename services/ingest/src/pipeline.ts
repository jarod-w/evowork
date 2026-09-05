/**
 * 解析管道的编排（08 §3.2）。
 *
 * ```
 * 拖入/选择 → ① 类型识别 → ② 闸门 → ③ 落盘 uploads/<时间戳-slug>/original.<ext>
 *          → ④ 解析器 → content.md · assets/ · meta.json
 *          → ⑤ 注入 turn/start（路径 + 摘要 + 关键页，**不塞全文**）
 *          → ⑥ 索引进资料库全文
 * ```
 *
 * ## 三条不能松的
 *
 * 1. **没有云端兜底**（K6 / Q3）。office 与 ocr 档缺失时给出"装扩展"或"以原始文件引用"
 *    两个出路，**不存在"那就传到云上解析"这条分支** —— 这个文件里也确实没有任何出网调用。
 * 2. **落盘在工作空间内**（`uploads/`），因此天然在沙箱允许范围内，agent 不需要额外授权。
 *    Ask 模式下这个写入由**服务层**完成（不是 agent），所以不违反只读语义 ——
 *    但 UI 要说明"上传的文件会保存到工作空间"（08 §3.5）。
 * 3. **解析进程不出网**。内置解析器是纯计算；外部解析器由 `ExternalParser` 注入，
 *    其实现必须在受限子进程里跑（网络关闭）—— 强制点在 M4 的沙箱，这里是接口约束。
 */

import { detectKind, extensionOf } from './detect.js';
import {
  checkArchive,
  checkFileSize,
  checkUploadCount,
  LIMITS,
  type GateRejection,
} from './gates.js';
import { buildInjection, buildPassThrough, type InjectionItem } from './inject.js';
import { parseDelimited, parseJson, parsePlainText, type ParseResult } from './parsers/builtin.js';
import { isDirectoryEntry, listZipEntries, readZipEntry } from './parsers/zip.js';
import { availabilityFor, type InputKind, type RuntimeProbe } from './runtime.js';

/** 落盘接口。注入以便测试，也让"写哪儿"这件事只有一处知道。 */
export interface UploadStore {
  /** 建目录并返回相对工作空间的路径（以 `/` 结尾） */
  createUploadDir(slug: string, at: Date): string;
  writeFile(uploadDir: string, relativePath: string, bytes: Uint8Array): void;
  writeText(uploadDir: string, relativePath: string, text: string): void;
}

/**
 * 需要 office / ocr 档的解析器。由宿主注入（它知道怎么起受限子进程）。
 *
 * 返回 `undefined` 表示"这一档没装" —— 而不是抛错，因为那不是异常，
 * 是一个要给用户两个出路的正常分支（03 §8）。
 */
export interface ExternalParser {
  parse(input: {
    readonly kind: InputKind;
    readonly absolutePath: string;
    readonly timeoutMs: number;
  }): Promise<ParseResult | undefined>;
}

export interface IngestOptions {
  readonly store: UploadStore;
  readonly probe: RuntimeProbe;
  readonly externalParser?: ExternalParser | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface IngestFile {
  readonly fileName: string;
  readonly bytes: Uint8Array;
}

export type IngestOutcome =
  | {
      readonly status: 'parsed';
      readonly fileName: string;
      readonly kind: InputKind;
      readonly uploadDir: string;
      readonly result: ParseResult;
      readonly injection: readonly InjectionItem[];
    }
  | {
      readonly status: 'passthrough';
      readonly fileName: string;
      readonly kind: 'code' | 'image';
      readonly uploadDir: string;
      readonly injection: readonly InjectionItem[];
    }
  | {
      readonly status: 'rejected';
      readonly fileName: string;
      readonly kind: InputKind;
      readonly rejection: GateRejection;
    }
  | {
      /** 运行时缺失。**两个出路**：装扩展，或以原始文件引用（03 §8） */
      readonly status: 'runtime-missing';
      readonly fileName: string;
      readonly kind: InputKind;
      readonly message: string;
      readonly fallback: 'refer-as-raw';
    };

const HEAD_BYTES = 512;

export function slugify(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, '');
  const slug = base
    .replace(/[\s/\\:*?"<>|]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'file';
}

export function timestampOf(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

export function createIngest(options: IngestOptions) {
  const now = options.now ?? (() => new Date());

  async function ingestOne(file: IngestFile, depth = 0): Promise<IngestOutcome[]> {
    const head = file.bytes.subarray(0, HEAD_BYTES);
    const isZipHead = head[0] === 0x50 && head[1] === 0x4b;
    const zipEntries = isZipHead ? safeListZipPaths(file.bytes) : undefined;
    const kind = detectKind({
      fileName: file.fileName,
      head,
      ...(zipEntries ? { zipEntries } : {}),
    });

    // ② 闸门：大小
    const sizeRejection = checkFileSize(file.bytes.byteLength, file.fileName);
    if (sizeRejection) {
      return [{ status: 'rejected', fileName: file.fileName, kind, rejection: sizeRejection }];
    }

    // 不解析这条路：直接落盘 + Mention / LocalImage
    if (kind === 'code' || kind === 'image') {
      const uploadDir = writeOriginal(file, kind);
      return [
        {
          status: 'passthrough',
          fileName: file.fileName,
          kind,
          uploadDir,
          injection: buildPassThrough(
            kind,
            file.fileName,
            `${uploadDir}original.${extensionOf(file.fileName)}`,
          ),
        },
      ];
    }

    if (kind === 'zip') return ingestArchive(file, depth);

    // ② 闸门：这一档运行时装了没
    const availability = availabilityFor(kind, options.probe);
    if (!availability.available) {
      return [
        {
          status: 'runtime-missing',
          fileName: file.fileName,
          kind,
          message: availability.message ?? '',
          fallback: 'refer-as-raw',
        },
      ];
    }

    const uploadDir = writeOriginal(file, kind);
    const result = await runParser(kind, file, uploadDir);
    if (!result) {
      return [
        {
          status: 'runtime-missing',
          fileName: file.fileName,
          kind,
          message: availability.message ?? '这种文件需要额外的本地组件才能解析。',
          fallback: 'refer-as-raw',
        },
      ];
    }

    // ④ 产出
    options.store.writeText(uploadDir, 'content.md', result.markdown);
    options.store.writeText(uploadDir, 'meta.json', JSON.stringify(result.meta, null, 2));

    return [
      {
        status: 'parsed',
        fileName: file.fileName,
        kind,
        uploadDir,
        result,
        injection: buildInjection({
          fileName: file.fileName,
          uploadDir,
          result,
          keyImages: result.assets.map((a) => `${uploadDir}${a}`),
        }),
      },
    ];
  }

  async function ingestArchive(file: IngestFile, depth: number): Promise<IngestOutcome[]> {
    const buffer = Buffer.from(file.bytes);
    let entries;
    try {
      entries = listZipEntries(buffer).filter((entry) => !isDirectoryEntry(entry));
    } catch (err) {
      return [
        {
          status: 'rejected',
          fileName: file.fileName,
          kind: 'zip',
          rejection: {
            code: 'ARCHIVE_PATH_TRAVERSAL',
            message: err instanceof Error ? err.message : '这个压缩包读不出来。',
          },
        },
      ];
    }

    // **先列后解**：炸弹检查在解压任何一个字节之前完成
    const rejection = checkArchive(entries, depth + 1);
    if (rejection) {
      return [{ status: 'rejected', fileName: file.fileName, kind: 'zip', rejection }];
    }

    const outcomes: IngestOutcome[] = [];
    for (const entry of entries) {
      const bytes = readZipEntry(buffer, entry);
      const name = entry.path.split('/').pop() ?? entry.path;
      outcomes.push(...(await ingestOne({ fileName: name, bytes }, depth + 1)));
    }
    return outcomes;
  }

  async function runParser(
    kind: InputKind,
    file: IngestFile,
    uploadDir: string,
  ): Promise<ParseResult | undefined> {
    switch (kind) {
      case 'txt':
      case 'unknown':
        return parsePlainText(file.bytes, 'txt');
      case 'md':
        return parsePlainText(file.bytes, 'md');
      case 'json':
        return parseJson(file.bytes);
      case 'csv':
        return parseDelimited(file.bytes, ',');
      case 'tsv':
        return parseDelimited(file.bytes, '\t');
      default:
        // office / ocr 档：交给受限子进程里的外部解析器（**不出网**）
        return options.externalParser?.parse({
          kind,
          absolutePath: `${uploadDir}original.${extensionOf(file.fileName)}`,
          timeoutMs: LIMITS.parseTimeoutMs,
        });
    }
  }

  function writeOriginal(file: IngestFile, _kind: InputKind): string {
    const uploadDir = options.store.createUploadDir(slugify(file.fileName), now());
    const extension = extensionOf(file.fileName) || 'bin';
    options.store.writeFile(uploadDir, `original.${extension}`, file.bytes);
    return uploadDir;
  }

  return {
    /** 单次上传。会先过"数量"闸门，再逐个处理。 */
    async ingest(files: readonly IngestFile[]): Promise<IngestOutcome[]> {
      const countRejection = checkUploadCount(files.length);
      if (countRejection) {
        return files.slice(LIMITS.maxFilesPerUpload).map((file) => ({
          status: 'rejected' as const,
          fileName: file.fileName,
          kind: 'unknown' as const,
          rejection: countRejection,
        }));
      }
      const outcomes: IngestOutcome[] = [];
      for (const file of files) outcomes.push(...(await ingestOne(file)));
      return outcomes;
    },
  };
}

/** 列条目时不抛错：判定类型阶段还不该因为坏包而失败，那是闸门那一步的事。 */
function safeListZipPaths(bytes: Uint8Array): readonly string[] | undefined {
  try {
    return listZipEntries(Buffer.from(bytes)).map((entry) => entry.path);
  } catch {
    return undefined;
  }
}
