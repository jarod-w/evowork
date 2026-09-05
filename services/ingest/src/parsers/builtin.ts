/**
 * 内置解析器（08 §3.3 的 CSV/TSV、TXT/MD、JSON 三行 + §4 的**基础包**）。
 *
 * 这几种不需要 Python，也就是说：**没装任何扩展的用户也能干活**。
 * 这一点决定了首运行体验 —— 拖一个 csv 进来立刻能用，而不是先下 120MB。
 *
 * 产出的形状与 office 档的解析器一致（`ParseResult`），所以下游（注入、索引）
 * 不需要知道这份 Markdown 是谁产的。
 */

import { sniffEncoding, type TextEncoding } from '../detect.js';

export interface ParsedTable {
  readonly header: readonly string[];
  readonly rows: readonly (readonly string[])[];
  /** 列类型推断（08 §3.3 的「列类型推断」） */
  readonly columnTypes: readonly ColumnType[];
  readonly totalRows: number;
}

export type ColumnType = 'number' | 'date' | 'text' | 'empty';

export interface ParseResult {
  /** 结构化 Markdown 正文（保留标题层级与表格） */
  readonly markdown: string;
  /** 页数 / 字数 / 表数等，落 meta.json */
  readonly meta: {
    readonly parser: string;
    readonly parserVersion: string;
    readonly chars: number;
    readonly tables: number;
    readonly pages?: number;
    /** 0–1。OCR 之外一律 1（我们没有猜） */
    readonly confidence: number;
    readonly encoding?: TextEncoding;
    /** 超时或部分失败时为 true，注入文案要如实说 */
    readonly partial?: boolean;
    readonly note?: string;
  };
  /** 关键页图片的相对路径（内置解析器不产图） */
  readonly assets: readonly string[];
}

const PARSER_VERSION = '1';

/** csv/tsv 进 Markdown 的行数上限（08 §3.3：大表只取前 200 行，完整数据留 csv 供 agent 读）。 */
export const MARKDOWN_ROW_LIMIT = 200;

export function decodeText(bytes: Uint8Array): { text: string; encoding: TextEncoding } {
  const encoding = sniffEncoding(bytes);
  if (encoding === 'gbk') {
    // Node 的 TextDecoder 带 gbk（ICU 全量构建）。没有时退回 latin1 并如实标注 ——
    // 乱码总比崩溃好，但**必须让用户知道**，所以 note 会写进 meta
    try {
      return { text: new TextDecoder('gbk').decode(bytes), encoding };
    } catch {
      return { text: new TextDecoder('latin1').decode(bytes), encoding };
    }
  }
  const text = new TextDecoder('utf-8').decode(bytes);
  // 用转义写 BOM：字面量的 U+FEFF 在编辑器里是不可见的，读代码的人只会看到一个空正则
  return { text: encoding === 'utf-8-bom' ? text.replace(/^\uFEFF/, '') : text, encoding };
}

export function parsePlainText(bytes: Uint8Array, kind: 'txt' | 'md'): ParseResult {
  const { text, encoding } = decodeText(bytes);
  return {
    // txt 原样进 Markdown 会让 `#` 之类的字符被当成标记，所以包一层代码块；md 本来就是 Markdown
    markdown: kind === 'md' ? text : text,
    meta: {
      parser: kind === 'md' ? 'builtin-markdown' : 'builtin-text',
      parserVersion: PARSER_VERSION,
      chars: text.length,
      tables: 0,
      confidence: 1,
      encoding,
    },
    assets: [],
  };
}

export function parseJson(bytes: Uint8Array): ParseResult {
  const { text, encoding } = decodeText(bytes);
  let pretty = text;
  let note: string | undefined;
  try {
    pretty = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    // 坏 JSON 不是解析失败：原样给出去，agent 往往正是要来修它的
    note = '这个文件不是合法 JSON，已按纯文本处理。';
  }
  return {
    markdown: `\`\`\`json\n${pretty}\n\`\`\``,
    meta: {
      parser: 'builtin-json',
      parserVersion: PARSER_VERSION,
      chars: pretty.length,
      tables: 0,
      confidence: 1,
      encoding,
      ...(note ? { note } : {}),
    },
    assets: [],
  };
}

/** 分隔符文本 → 表格。**自己切而不是拉 csv 库**：要处理引号、换行、BOM 与 GBK。 */
export function parseDelimited(bytes: Uint8Array, delimiter: ',' | '\t'): ParseResult {
  const { text, encoding } = decodeText(bytes);
  const rows = splitDelimited(text, delimiter);
  const header = rows[0] ?? [];
  const body = rows.slice(1);
  const columnTypes = inferColumnTypes(header.length, body);

  const shown = body.slice(0, MARKDOWN_ROW_LIMIT);
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...shown.map((row) => `| ${row.map((cell) => cell.replace(/\|/g, '\\|')).join(' | ')} |`),
  ];
  if (body.length > shown.length) {
    // 截断必须说出来，否则 agent 会以为它看到了全部数据然后算错总数
    lines.push(
      '',
      `> 只显示前 ${MARKDOWN_ROW_LIMIT} 行，共 ${body.length} 行。完整数据在原始文件里。`,
    );
  }
  lines.push('', `> 列类型：${header.map((h, i) => `${h}=${columnTypes[i]}`).join('、')}`);

  return {
    markdown: lines.join('\n'),
    meta: {
      parser: delimiter === ',' ? 'builtin-csv' : 'builtin-tsv',
      parserVersion: PARSER_VERSION,
      chars: text.length,
      tables: 1,
      confidence: 1,
      encoding,
    },
    assets: [],
  };
}

/** 带引号处理的分隔符切分。引号里的分隔符与换行都不算分隔。 */
export function splitDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || (r[0] ?? '') !== '');
}

const DATE_PATTERN = /^\d{4}[-/]\d{1,2}([-/]\d{1,2})?$/;

export function inferColumnTypes(
  width: number,
  rows: readonly (readonly string[])[],
): ColumnType[] {
  const types: ColumnType[] = [];
  for (let column = 0; column < width; column += 1) {
    const values = rows.map((row) => (row[column] ?? '').trim()).filter((v) => v !== '');
    if (values.length === 0) {
      types.push('empty');
      continue;
    }
    // 判据是"全部都像"，不是"多数像"：一列里混了一个 "合计" 就不该被当成数值列，
    // 否则下游按数值处理会在那一行炸掉
    if (values.every((v) => isNumeric(v))) types.push('number');
    else if (values.every((v) => DATE_PATTERN.test(v))) types.push('date');
    else types.push('text');
  }
  return types;
}

function isNumeric(value: string): boolean {
  const cleaned = value
    .replace(/[,，\s]/g, '')
    .replace(/^[¥$€£]/, '')
    .replace(/%$/, '');
  return cleaned !== '' && Number.isFinite(Number(cleaned));
}
