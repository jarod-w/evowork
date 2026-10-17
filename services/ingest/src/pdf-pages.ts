import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveOfficeInterpreter } from './probe.js';
import { runIsolatedProcess } from './isolated-process.js';

/** Raster pages avoid the PDF plug-in, which cannot run inside the desktop's sandboxed frame. */
const SCRIPT = String.raw`
import json, sys
from pathlib import Path
import pypdfium2 as pdf
root=Path(sys.argv[1])
doc=pdf.PdfDocument(root/'preview.pdf')
total=len(doc)
if total < 1: raise ValueError('EMPTY_PDF')
used=0
rendered=0
for index in range(min(total,20)):
    page=doc[index]
    width,height=page.get_size()
    if not 0 < width < 100000 or not 0 < height < 100000: raise ValueError('PAGE_SIZE')
    scale=min(1.75,1600/width,2000/height)
    bitmap=page.render(scale=scale)
    image=bitmap.to_pil()
    target=root/f'page-{index+1}.png'
    image.save(target,format='PNG')
    size=target.stat().st_size
    if size > 6000000 or used+size > 16000000:
        target.unlink()
        break
    used+=size
    rendered+=1
    image.close()
    bitmap.close()
    page.close()
doc.close()
if rendered < 1: raise ValueError('PAGE_LIMIT')
(root/'pages.json').write_text(json.dumps({'total':total,'rendered':rendered}))
`;

export async function renderPdfPages(
  directory: string,
): Promise<{ pages: Buffer[]; total: number }> {
  const interpreter = resolveOfficeInterpreter();
  if (!interpreter) throw new Error('PDF_RENDERER_MISSING');
  await runIsolatedProcess({
    executable: interpreter,
    args: ['-c', SCRIPT, directory],
    readPaths: [dirname(dirname(interpreter))],
    writeDirectory: directory,
    timeoutMs: 30_000,
    maxResidentBytes: 512 * 1024 * 1024,
  });
  const manifest = join(directory, 'pages.json');
  if (lstatSync(manifest).size > 1024) throw new Error('PAGE_MANIFEST_LIMIT');
  const { total, rendered } = JSON.parse(readFileSync(manifest, 'utf8')) as {
    total: number;
    rendered: number;
  };
  if (
    !Number.isSafeInteger(total) ||
    !Number.isInteger(rendered) ||
    rendered < 1 ||
    rendered > 20 ||
    total < rendered
  )
    throw new Error('PAGE_COUNT');
  const pages: Buffer[] = [];
  let used = 0;
  for (let index = 1; index <= rendered; index++) {
    const path = join(directory, `page-${index}.png`),
      stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 6_000_000 ||
      (used += stat.size) > 16_000_000
    )
      throw new Error('PAGE_LIMIT');
    const bytes = readFileSync(path);
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      throw new Error('INVALID_PAGE');
    pages.push(bytes);
  }
  return { pages, total };
}
