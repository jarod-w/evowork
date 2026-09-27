/**
 * `/s/<share-id>` —— 给链接接收方看的一页（Q41 / 08 §7.4）。
 *
 * ## 这一页的四条硬规则
 *
 * 1. **办公文件不在浏览器里渲染**，只给元数据 + 下载。把 docx 当网页跑，
 *    和 Visualizer 同时给 `allow-scripts` + `allow-same-origin` 是同一类破口（验收口径第 21 条）。
 * 2. **不读账号会话、不带 `authorization`**（第 25 条）。这个目录里不 import `../api.js`，
 *    有测试扫着。
 * 3. **失效页不多说**：过期 / 撤销 / 没有这个链接，都只给一句话，
 *    文件名以外的元数据一个不给。
 * 4. **密码只挡住拿文件**，不因此开通办公文件预览。
 *
 * 页面不依赖账号应用的组件层：它是独立 bundle，样式自带一份最小的。
 */
import { useEffect, useState } from 'react';

import {
  fallbackName,
  fetchBytes,
  fetchShare,
  fileNameFromHash,
  formatBytes,
  formatRemaining,
  shareIdFromPath,
  typeLabel,
  unlock,
  type ShareView,
} from './api.js';

type Phase =
  | { kind: 'loading' }
  | { kind: 'bad-link' }
  | { kind: 'offline' }
  | { kind: 'ready'; view: ShareView };

export interface SharePageProps {
  readonly pathname?: string;
  readonly hash?: string;
}

export function SharePage(props: SharePageProps = {}) {
  const pathname = props.pathname ?? window.location.pathname;
  const hash = props.hash ?? window.location.hash;
  const id = shareIdFromPath(pathname);
  const name = fileNameFromHash(hash);

  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [grant, setGrant] = useState<string | undefined>();
  const [password, setPassword] = useState('');
  const [pwError, setPwError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<string | undefined>();
  const [downloadError, setDownloadError] = useState<string | undefined>();

  useEffect(() => {
    if (!id) {
      setPhase({ kind: 'bad-link' });
      return;
    }
    void fetchShare(id).then((view) => {
      setPhase(view ? { kind: 'ready', view } : { kind: 'offline' });
    });
  }, [id]);

  const meta = phase.kind === 'ready' ? phase.view.meta : undefined;
  /** 失效状态单独取出来：在 JSX 三元里收窄不了联合，索引就会变成 `string | undefined`。 */
  const invalid: InvalidState | undefined =
    phase.kind === 'ready' && phase.view.state !== 'active' ? phase.view.state : undefined;
  const unlocked = meta !== undefined && (!meta.hasPassword || grant !== undefined);

  // 预览只对安全名单里的类型发生，且要等解锁之后
  useEffect(() => {
    if (!id || !meta?.previewable || !unlocked || preview !== undefined) return;
    void fetchBytes(id, grant).then((blob) => {
      if (blob) setPreview(URL.createObjectURL(blob));
    });
  }, [id, meta, unlocked, grant, preview]);

  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );

  async function onUnlock() {
    if (!id) return;
    setBusy(true);
    setPwError(undefined);
    const got = await unlock(id, password);
    setBusy(false);
    if (!got) {
      // 不区分"密码错"与"链接已失效"：区分开就能拿来枚举
      setPwError('密码不对，或者这个链接已经失效了。');
      return;
    }
    setGrant(got);
  }

  async function onDownload() {
    if (!id || !meta) return;
    setBusy(true);
    setDownloadError(undefined);
    const blob = await fetchBytes(id, grant);
    setBusy(false);
    if (!blob) {
      setDownloadError('没能取到这个文件，可能刚刚失效了。');
      return;
    }
    /*
     * 用 object URL + `download` 而不是直接把链接指过去。
     *
     * 服务器**不知道文件名**（只收到 digest），所以它写不出 `Content-Disposition`；
     * 名字只在这个浏览器里（来自链接片段）。这样保存下来的文件有正确的名字，
     * 而名字一次也没有发给服务器。
     */
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name ?? fallbackName(id, meta.contentType);
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="sh-page">
      <header className="sh-top">
        <span className="sh-brand">
          <svg className="sh-logo" viewBox="0 0 32 32" aria-hidden="true">
            <rect x="1" y="1" width="30" height="30" rx="9" fill="var(--accent)" />
            <path
              d="M10 11h12M10 16h8M10 21h12"
              stroke="var(--text-inverse)"
              strokeWidth="2"
              strokeLinecap="round"
              fill="none"
            />
          </svg>
          EvoWork
        </span>
      </header>

      <main className="sh-main">
        {phase.kind === 'loading' ? <p className="sh-muted">正在打开…</p> : null}

        {phase.kind === 'bad-link' ? (
          <Invalid title="这个链接不对" body="地址里没有分享编号。请检查链接是否被截断了。" />
        ) : null}

        {phase.kind === 'offline' ? (
          <Invalid title="打不开这个链接" body="连不上分享服务，稍后再试。" />
        ) : null}

        {invalid ? (
          <Invalid title={INVALID_TITLE[invalid]} body={INVALID_BODY[invalid]} name={name} />
        ) : null}

        {phase.kind === 'ready' && meta ? (
          <section className="sh-card">
            <div className="sh-head">
              <span className="sh-name">{name ?? '（文件名未随链接传来）'}</span>
              <span className="sh-meta">
                <span className="sh-badge">{typeLabel(meta.contentType)}</span>
                <span>{formatBytes(meta.sizeBytes)}</span>
                <span>·</span>
                <span>{formatRemaining(meta.expiresAt)}</span>
              </span>
            </div>

            {meta.hasPassword && !unlocked ? (
              <form
                className="sh-lock"
                onSubmit={(e) => {
                  e.preventDefault();
                  void onUnlock();
                }}
              >
                <label className="sh-label" htmlFor="sh-pw">
                  这个分享设了访问密码
                </label>
                <div className="sh-row">
                  <input
                    id="sh-pw"
                    className="sh-input"
                    type="password"
                    autoComplete="off"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <button className="sh-btn" type="submit" disabled={busy || password === ''}>
                    {busy ? '校验中…' : '解锁'}
                  </button>
                </div>
                {pwError ? <p className="sh-error">{pwError}</p> : null}
                <p className="sh-muted">密码不会离开你的浏览器，发出去的是它的哈希。</p>
              </form>
            ) : null}

            {unlocked ? (
              <>
                {meta.previewable ? (
                  <Preview contentType={meta.contentType} url={preview} />
                ) : (
                  <p className="sh-muted">
                    办公文件不在浏览器里打开 —— 它们会被当成网页跑，那是一类安全问题。
                    下载后用你本机的软件打开。
                  </p>
                )}

                <div className="sh-actions">
                  <button
                    className="sh-btn sh-primary"
                    type="button"
                    disabled={busy}
                    onClick={() => void onDownload()}
                  >
                    {busy ? '准备中…' : '下载'}
                  </button>
                  <a className="sh-btn" href={`evowork://share/${meta.id}`}>
                    在 EvoWork 中打开
                  </a>
                </div>
                {downloadError ? <p className="sh-error">{downloadError}</p> : null}
                <p className="sh-muted">
                  「在 EvoWork 中打开」只在这台电脑装了 EvoWork、并且本机有这份产物时才有用；
                  没有的话它会如实告诉你，不会把文件同步过来。
                </p>
              </>
            ) : null}
          </section>
        ) : null}

        <p className="sh-foot">
          这个链接有有效期，到期后云端副本会被自动删除。分享者随时可以撤销它。
        </p>
      </main>
    </div>
  );
}

type InvalidState = Exclude<ShareView['state'], 'active'>;

const INVALID_TITLE: Record<InvalidState, string> = {
  expired: '这个链接已经过期',
  revoked: '这个分享已经被撤销',
  missing: '找不到这个分享',
};

const INVALID_BODY: Record<InvalidState, string> = {
  expired: '云端副本已经自动删除了。需要的话，请让分享者重新发一份。',
  revoked: '分享者撤销了它，云端副本已经删除。',
  missing: '链接可能打错了，或者它早就失效了。',
};

/** 失效页：**文件名以外的元数据一个不给**（08 §7.4）。 */
function Invalid(props: {
  readonly title: string;
  readonly body: string;
  readonly name?: string | undefined;
}) {
  return (
    <section className="sh-card sh-invalid">
      <h1 className="sh-title">{props.title}</h1>
      {props.name ? <p className="sh-name-dim">{props.name}</p> : null}
      <p className="sh-muted">{props.body}</p>
    </section>
  );
}

/**
 * 预览。
 *
 * PDF 走**沙箱 iframe 且不给 `allow-same-origin`**（08 §7.4）——
 * 给了就等于让一份不可信文件拿到这一页的源，能读这一页的一切。
 * 图片用 `<img>`，它本来就不执行脚本。
 */
function Preview(props: { readonly contentType: string; readonly url: string | undefined }) {
  if (!props.url) return <p className="sh-muted">正在取文件…</p>;
  if (props.contentType === 'application/pdf') {
    return <iframe className="sh-preview" src={props.url} sandbox="" title="预览" />;
  }
  return <img className="sh-preview" src={props.url} alt="预览" />;
}
