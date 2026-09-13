import type { FilePreviewView } from '../../shared/ipc.js';
import { EmptyState } from './primitives.js';

const LOCAL_PREVIEW_CSP =
  "default-src 'none'; img-src data: blob:; media-src data: blob:; font-src data:; style-src 'unsafe-inline';";

export function sandboxedHtml(content: string): string {
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${LOCAL_PREVIEW_CSP}">${content}`;
}

export function FilePreview({ preview }: { readonly preview: FilePreviewView | null }) {
  if (!preview) return <EmptyState title="选择一个文件" hint="文件内容会在这里预览。" />;
  if (preview.kind === 'unsupported') {
    return <EmptyState title={preview.name} hint={preview.message ?? '暂不支持内嵌预览。'} />;
  }
  if (preview.kind === 'image') {
    return <img className="ew-file-preview-image" src={preview.content} alt={preview.name} />;
  }
  if (preview.kind === 'html') {
    return (
      <iframe
        className="ew-file-preview-frame"
        title={`网页预览：${preview.name}`}
        sandbox=""
        referrerPolicy="no-referrer"
        srcDoc={sandboxedHtml(preview.content ?? '')}
      />
    );
  }
  if (preview.kind === 'pdf') {
    return (
      <iframe
        className="ew-file-preview-frame"
        title={preview.name}
        sandbox=""
        referrerPolicy="no-referrer"
        src={preview.content}
      />
    );
  }
  return (
    <section className="ew-file-preview-text" aria-label={`文件预览：${preview.name}`}>
      {preview.truncated ? <p>文件较大，只显示前 1 MB。</p> : null}
      <pre>{preview.content}</pre>
    </section>
  );
}
