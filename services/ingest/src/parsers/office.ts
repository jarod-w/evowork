/**
 * 办公扩展解析器（08 §3.3 的 Word / Excel / PPT / PDF 文本层）。
 *
 * 管道把 office / ocr 档交给 `ExternalParser`。这个文件是它的本机实现：
 * 找到办公扩展的解释器，跑旁边的 `office.py`，把 JSON 结果收成 `ParseResult`。
 *
 * ## 两条不能松的
 *
 * 1. **不出网。** 子进程不继承代理变量，并打开 `PYTHONNOUSERSITE`。
 *    真正的沙箱（seatbelt / landlock）仍是 M4 的强制点；这里先把网络相关的环境拿掉，
 *    这样即便 M4 还没接上，解析器也不会「碰巧」走一条 HTTP 代理。
 * 2. **打包后 Python 读不了 asar。** Electron 把主进程打进 `app.asar` 之后，
 *    Node 能 `readFile` 里面的 `office.py`，系统 Python 不能。所以一旦路径落在 asar 里，
 *    就把脚本物化到临时目录再交给解释器。漏了这一步的表现是：开发时解析成功，
 *    装好的 App 拖入 docx 永远「解析失败」。
 */

import { execFile as execFileCallback } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { MARKDOWN_ROW_LIMIT, type ParseResult } from './builtin.js';
import { resolveOfficeInterpreter } from '../probe.js';
import type { ExternalParser } from '../pipeline.js';
import type { InputKind } from '../runtime.js';

const execFile = promisify(execFileCallback);

const OFFICE_KINDS = new Set<InputKind>(['docx', 'xlsx', 'pptx', 'pdf', 'rtf']);

export interface OfficeParserOptions {
  readonly interpreter?: string | undefined;
  readonly scriptPath?: string | undefined;
  /** 覆盖 `execFile`，测试里用来注入假进程而不碰真 Python */
  readonly run?: typeof execFile | undefined;
}

export function resolveOfficeParserScript(fromUrl = import.meta.url): string | undefined {
  const here = dirname(fileURLToPath(fromUrl));
  const candidates = [join(here, 'office.py')];
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resources) candidates.push(join(resources, 'ingest', 'office.py'));
  return candidates.find((path) => existsSync(path));
}

/**
 * asar 里的脚本给系统 Python 读会 ENOENT。物化到临时目录；非 asar 路径原样返回。
 */
export function scriptForExec(scriptPath: string): string {
  if (!scriptPath.includes('.asar/') && !scriptPath.includes('.asar\\')) {
    return scriptPath;
  }
  const dest = join(tmpdir(), 'evowork-office-parser.py');
  writeFileSync(dest, readFileSync(scriptPath));
  return dest;
}

function parserEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
  ]) {
    delete env[key];
  }
  env.NO_PROXY = '*';
  env.no_proxy = '*';
  env.PYTHONNOUSERSITE = '1';
  return env;
}

function asParseResult(raw: unknown): ParseResult | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.markdown !== 'string') return undefined;
  const assets = Array.isArray(value.assets)
    ? value.assets.filter((item): item is string => typeof item === 'string')
    : [];
  if (value.markdown.trim() === '' && assets.length === 0) return undefined;
  const metaRaw = value.meta;
  if (metaRaw === null || typeof metaRaw !== 'object') return undefined;
  const meta = metaRaw as Record<string, unknown>;
  if (typeof meta.parser !== 'string' || typeof meta.parserVersion !== 'string') return undefined;
  if (typeof meta.chars !== 'number' || typeof meta.tables !== 'number') return undefined;
  if (typeof meta.confidence !== 'number') return undefined;
  return {
    markdown: value.markdown,
    meta: {
      parser: meta.parser,
      parserVersion: meta.parserVersion,
      chars: meta.chars,
      tables: meta.tables,
      confidence: meta.confidence,
      ...(typeof meta.pages === 'number' ? { pages: meta.pages } : {}),
      ...(meta.partial === true ? { partial: true } : {}),
      ...(typeof meta.note === 'string' ? { note: meta.note } : {}),
    },
    assets,
  };
}

export function createOfficeParser(options: OfficeParserOptions = {}): ExternalParser {
  const run = options.run ?? execFile;

  return {
    async parse(input): Promise<ParseResult | undefined> {
      if (!OFFICE_KINDS.has(input.kind)) return undefined;
      const interpreter = options.interpreter ?? resolveOfficeInterpreter();
      const scriptPath = options.scriptPath ?? resolveOfficeParserScript();
      if (!interpreter || !scriptPath) return undefined;
      if (!existsSync(input.absolutePath) || !isAbsolute(input.absolutePath)) return undefined;

      const workDir = mkdtempSync(join(tmpdir(), 'evowork-office-parse-'));
      const resultPath = join(workDir, 'result.json');
      try {
        await run(
          interpreter,
          [
            scriptForExec(scriptPath),
            '--kind',
            input.kind,
            '--input',
            input.absolutePath,
            '--out-dir',
            dirname(input.absolutePath),
            '--result',
            resultPath,
            '--row-limit',
            String(MARKDOWN_ROW_LIMIT),
          ],
          {
            timeout: input.timeoutMs,
            maxBuffer: 16 * 1024 * 1024,
            env: parserEnv(),
            windowsHide: true,
          },
        );
        if (!existsSync(resultPath)) return undefined;
        return asParseResult(JSON.parse(readFileSync(resultPath, 'utf8')));
      } catch {
        if (existsSync(resultPath)) {
          try {
            return asParseResult(JSON.parse(readFileSync(resultPath, 'utf8')));
          } catch {
            return undefined;
          }
        }
        return undefined;
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    },
  };
}
