import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createOfficeLayoutPreview, resolveOfficeConverter } from '../src/office-preview.js';

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'evowork-office-layout-'));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

it('缺少转换器明确说明正文预览，不假装已保留排版', async () => {
  expect(
    resolveOfficeConverter({ EVOWORK_OFFICE_CONVERTER: join(directory, 'missing') }),
  ).toBeUndefined();
  const path = join(directory, 'source.docx');
  writeFileSync(path, 'source');
  const result = await createOfficeLayoutPreview({ executable: join(directory, 'missing') })(path);
  expect(result.pdf).toBeUndefined();
  expect(result.note).toContain('不代表原文件排版');
});

it('版式转换使用独立副本、禁宏配置和隔离进程，返回 PDF 并清理临时目录', async () => {
  const source = join(directory, 'source.pptx'),
    executable = join(directory, 'soffice');
  writeFileSync(source, 'source bytes');
  writeFileSync(executable, 'converter');
  const fonts = join(directory, 'fonts');
  mkdirSync(fonts);
  writeFileSync(join(fonts, 'CJK.ttf'), 'font');
  symlinkSync(source, join(fonts, 'outside.ttf'));
  let temporary = '';
  const preview = createOfficeLayoutPreview({
    executable,
    fontDirectory: fonts,
    render: async () => ({ pages: [Buffer.from('page')], total: 1 }),
    run: async (input) => {
      temporary = input.writeDirectory;
      expect(input.args).toContain('--headless');
      expect(input.args).toContain('-env:OSL_SOCKET_PATH=' + temporary);
      expect(input.allowLocalIpc).toBe(true);
      expect(readFileSync(join(temporary, 'profile/user/fonts/CJK.ttf'), 'utf8')).toBe('font');
      expect(existsSync(join(temporary, 'profile/user/fonts/outside.ttf'))).toBe(false);
      expect(input.readPaths).not.toContain(source);
      expect(
        readFileSync(join(temporary, 'profile/user/registrymodifications.xcu'), 'utf8'),
      ).toContain('DisableMacrosExecution');
      expect(readFileSync(join(temporary, 'preview.pptx'), 'utf8')).toBe('source bytes');
      writeFileSync(join(temporary, 'preview.pdf'), '%PDF-1.7\ntest');
      return '';
    },
  });
  const result = await preview(source);
  expect(result.pdf?.subarray(0, 5).toString()).toBe('%PDF-');
  expect(result.note).toContain('离线转换');
  expect(result.pages).toEqual([Buffer.from('page')]);
  expect(existsSync(temporary)).toBe(false);
  expect(readFileSync(source, 'utf8')).toBe('source bytes');
});

it('转换失败或伪造输出时保留正文回退理由，并清理工作副本', async () => {
  const source = join(directory, 'source.xlsx'),
    executable = join(directory, 'soffice');
  writeFileSync(source, 'source');
  writeFileSync(executable, 'converter');
  let temporary = '';
  const result = await createOfficeLayoutPreview({
    executable,
    run: async (input) => {
      temporary = input.writeDirectory;
      writeFileSync(join(temporary, 'preview.pdf'), 'not PDF');
      return '';
    },
  })(source);
  expect(result.pdf).toBeUndefined();
  expect(result.note).toContain('仅为正文预览');
  expect(existsSync(temporary)).toBe(false);
});

it('PDF 转换成功但页面无法渲染时，回退正文而不交付空白 PDF 页面', async () => {
  const source = join(directory, 'source.docx'),
    executable = join(directory, 'converter');
  writeFileSync(source, 'source');
  writeFileSync(executable, 'converter');
  const preview = createOfficeLayoutPreview({
    executable,
    run: async (input) => {
      writeFileSync(join(input.writeDirectory, 'preview.pdf'), '%PDF-1.7\ntest');
      return '';
    },
    render: async () => {
      throw new Error('renderer unavailable');
    },
  });
  const result = await preview(source);
  expect(result.pdf).toBeUndefined();
  expect(result.pages).toBeUndefined();
  expect(result.note).toContain('仅为正文预览');
});
