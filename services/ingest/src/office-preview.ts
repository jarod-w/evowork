/** Optional local layout renderer. No downloads, account environment or source-directory writes. */
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runIsolatedProcess, type IsolatedProcessOptions } from './isolated-process.js';
import { officeFontsPath } from './runtime.js';
import { renderPdfPages } from './pdf-pages.js';

export function resolveOfficeConverter(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const candidates = env.EVOWORK_OFFICE_CONVERTER
    ? [env.EVOWORK_OFFICE_CONVERTER]
    : [
        '/Applications/LibreOffice.app/Contents/MacOS/soffice',
        '/Applications/LibreOfficeDev.app/Contents/MacOS/soffice',
        ...(env.PATH ?? '')
          .split(process.platform === 'win32' ? ';' : ':')
          .filter(Boolean)
          .map((root) => join(root, 'soffice')),
      ];
  return candidates.find((path) => {
    try {
      return lstatSync(path).isFile() || lstatSync(path).isSymbolicLink();
    } catch {
      return false;
    }
  });
}

export function createOfficeLayoutPreview(
  options: {
    executable?: string | undefined;
    fontDirectory?: string | undefined;
    run?: ((input: IsolatedProcessOptions) => Promise<string>) | undefined;
    render?: ((directory: string) => Promise<{ pages: Buffer[]; total: number }>) | undefined;
  } = {},
) {
  return async (
    path: string,
  ): Promise<{ pdf?: Buffer; pages?: Buffer[]; pageCount?: number; note: string }> => {
    const converter = options.executable ?? resolveOfficeConverter();
    if (!converter)
      return { note: '未找到本机 LibreOffice 版式转换器；以下仅为正文预览，不代表原文件排版。' };
    if (!['.docx', '.xlsx', '.pptx', '.rtf'].includes(extname(path).toLowerCase()))
      return { note: '此格式没有版式预览。' };
    const directory = mkdtempSync(join(tmpdir(), 'evowork-office-preview-'));
    try {
      if (!lstatSync(path).isFile() || lstatSync(path).size > 50 * 1024 * 1024)
        throw new Error('INPUT_LIMIT');
      const input = join(directory, 'preview' + extname(path).toLowerCase()),
        profile = join(directory, 'profile');
      copyFileSync(path, input);
      mkdirSync(join(profile, 'user'), { recursive: true });
      // The installed office extension ships a CJK fallback font. LibreOffice's isolated
      // profile cannot see user font registrations, so give it a bounded private copy.
      const fonts = options.fontDirectory ?? officeFontsPath(homedir());
      if (existsSync(fonts)) {
        const target = join(profile, 'user', 'fonts');
        mkdirSync(target);
        let fontBytes = 0;
        for (const name of readdirSync(fonts).slice(0, 32)) {
          const source = join(fonts, name),
            stat = lstatSync(source);
          if (
            !/\.(ttf|otf|ttc)$/i.test(name) ||
            !stat.isFile() ||
            fontBytes + stat.size > 64 * 1024 * 1024
          )
            continue;
          copyFileSync(source, join(target, name));
          fontBytes += stat.size;
        }
      }
      writeFileSync(
        join(profile, 'user', 'registrymodifications.xcu'),
        '<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop><prop oor:name="DisableActiveContent" oor:op="fuse"><value>true</value></prop><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item></oor:items>',
      );
      const executable = realpathSync(converter),
        app = executable.indexOf('.app/Contents/');
      await (options.run ?? runIsolatedProcess)({
        executable,
        args: [
          '-env:UserInstallation=' + pathToFileURL(profile).href,
          '--headless',
          '--nologo',
          '--nodefault',
          '--norestore',
          '--nolockcheck',
          '--convert-to',
          'pdf',
          '--outdir',
          directory,
          input,
        ],
        readPaths: [
          app >= 0 ? executable.slice(0, app + 4) : dirname(executable),
          ...['/dev/random', '/dev/urandom'].filter(existsSync),
        ],
        writeDirectory: directory,
        timeoutMs: 45_000,
        maxResidentBytes: 1024 * 1024 * 1024,
      });
      const output = join(directory, 'preview.pdf');
      if (
        !existsSync(output) ||
        !lstatSync(output).isFile() ||
        lstatSync(output).isSymbolicLink() ||
        lstatSync(output).size > 25_000_000
      )
        throw new Error('OUTPUT_LIMIT');
      const pdf = readFileSync(output);
      if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('INVALID_PDF');
      const rendered = await (options.render ?? renderPdfPages)(directory);
      return {
        pdf,
        pages: rendered.pages,
        pageCount: rendered.total,
        note:
          '本机离线转换的 PDF 版式预览；字体替换和打印设置可能与原 Office 应用存在差异。' +
          (rendered.pages.length < rendered.total
            ? `仅显示前 ${rendered.pages.length} 页，共 ${rendered.total} 页。`
            : ''),
      };
    } catch {
      return { note: '本机版式转换不可用或未成功；以下仅为正文预览，不代表原文件排版。' };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
}
