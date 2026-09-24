import { useRef, useState } from 'react';

import type { FilePreviewView } from '../../shared/ipc.js';
import { EmptyState } from './primitives.js';
import { renderMarkdown } from './item-renderers.js';

const LOCAL_PREVIEW_CSP =
  "default-src 'none'; img-src data: blob:; media-src data: blob:; font-src data:; style-src 'unsafe-inline';";

export function sandboxedHtml(content: string): string {
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${LOCAL_PREVIEW_CSP}">${content}`;
}

const SOURCE_TOKEN =
  /(\/\/[^\n]*|#[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:const|let|var|function|class|interface|type|import|export|from|return|if|else|for|while|async|await|def|fn|struct|impl|pub|use|package|func|SELECT|FROM|WHERE|JOIN|CREATE)\b|\b\d+(?:\.\d+)?\b)/g;

function highlightedSource(content: string) {
  return content.split(SOURCE_TOKEN).map((part, index) => {
    if (!part) return null;
    if (index % 2 === 0) return part;
    const kind =
      part.startsWith('//') || part.startsWith('#')
        ? 'comment'
        : part.startsWith('"') || part.startsWith("'")
          ? 'string'
          : /^\d/.test(part)
            ? 'number'
            : 'keyword';
    return (
      <span key={index} data-token={kind}>
        {part}
      </span>
    );
  });
}

export function FilePreview({
  preview,
  onAnnotate,
}: {
  readonly preview: FilePreviewView | null;
  readonly onAnnotate?:
    | ((annotation: {
        readonly fileName: string;
        readonly quote?: string;
        readonly comment: string;
      }) => void)
    | undefined;
}) {
  const contentRef = useRef<HTMLElement | null>(null);
  const [quote, setQuote] = useState('');
  const [comment, setComment] = useState('');
  const [annotating, setAnnotating] = useState(false);
  if (!preview) return <EmptyState title="选择一个文件" hint="文件内容会在这里预览。" />;
  if (preview.kind === 'unsupported') {
    return <EmptyState title={preview.name} hint={preview.message ?? '暂不支持内嵌预览。'} />;
  }
  const captureSelection = (): void => {
    const selection = window.getSelection();
    const root = contentRef.current;
    if (!selection || selection.isCollapsed || !root) return;
    const anchor = selection.anchorNode;
    const focus = selection.focusNode;
    if (!anchor || !focus || !root.contains(anchor) || !root.contains(focus)) return;
    setQuote(selection.toString().trim().slice(0, 500));
  };
  return (
    <section className="ew-file-preview-text" aria-label={`文件预览：${preview.name}`}>
      <div className="ew-file-preview-toolbar">
        <strong>{preview.name}</strong>
        {onAnnotate ? (
          <button
            type="button"
            className="ew-pill-button"
            onClick={() => setAnnotating((value) => !value)}
          >
            添加批注
          </button>
        ) : null}
      </div>
      {preview.message ? <p>{preview.message}</p> : null}
      {preview.truncated ? <p>文件较大，只显示前 1 MB。</p> : null}
      {preview.kind === 'image' ? (
        <img className="ew-file-preview-image" src={preview.content} alt={preview.name} />
      ) : preview.kind === 'html' ? (
        <iframe
          className="ew-file-preview-frame"
          title={`网页预览：${preview.name}`}
          sandbox=""
          referrerPolicy="no-referrer"
          srcDoc={sandboxedHtml(preview.content ?? '')}
        />
      ) : preview.kind === 'pdf' ? (
        <iframe
          className="ew-file-preview-frame"
          title={preview.name}
          sandbox=""
          referrerPolicy="no-referrer"
          src={preview.content}
        />
      ) : preview.kind === 'markdown' ? (
        <article
          ref={(node) => {
            contentRef.current = node;
          }}
          className="ew-markdown ew-file-preview-markdown"
          onMouseUp={captureSelection}
          dangerouslySetInnerHTML={renderMarkdown(preview.content ?? '')}
        />
      ) : (
        <pre
          ref={(node) => {
            contentRef.current = node;
          }}
          data-language={preview.language}
          onMouseUp={captureSelection}
        >
          {preview.kind === 'source' ? highlightedSource(preview.content ?? '') : preview.content}
        </pre>
      )}
      {annotating ? (
        <div className="ew-file-annotation">
          {quote ? <blockquote>{quote}</blockquote> : <p>未选中文字时，批注将关联整个文件。</p>}
          <textarea
            aria-label="批注内容"
            value={comment}
            placeholder="说明希望如何修改…"
            onChange={(event) => setComment(event.target.value)}
          />
          <button
            type="button"
            className="ew-pill-button"
            disabled={!comment.trim()}
            onClick={() => {
              if (!comment.trim()) return;
              onAnnotate?.({
                fileName: preview.name,
                ...(quote ? { quote } : {}),
                comment: comment.trim(),
              });
              setComment('');
              setQuote('');
              setAnnotating(false);
            }}
          >
            加入修改请求
          </button>
        </div>
      ) : null}
    </section>
  );
}
