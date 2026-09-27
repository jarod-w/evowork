/**
 * 分享授权模态（08 §7.1 的四步，Q10 的六条硬规则）。
 *
 * ## 这个模态存在的理由是"让用户想清楚"
 *
 * 分享是本机内容离开设备的**唯一常规出网路径**（除模型调用）。所以流程刻意做得重：
 *
 * 1. **每次都出**，不记住选择 —— 这里**没有**「以后不再询问」的勾选框。
 *    做一个出来，这条通道就会在用户第二次点分享之后变成默认开启（规则 1）。
 * 2. **一次一个**，不做批量 —— `plan` 的入参是一个 `artifactId`，不是数组（规则 2）。
 * 3. **确认框不预勾**（§7.1）。"没勾"是默认状态而不是用户失误，所以文案不责备。
 * 4. **进度可取消，且取消真的中止请求** —— 只把进度条停掉、请求跑完，是最容易写出来的假取消。
 *
 * ## 三段式
 *
 * 授权 → 上传中 → 完成。三段用同一个 `Dialog` 壳，但**标题与按钮都不同** ——
 * 合成一个"状态藏在里面"的框会让"还没传"与"已经传上去了"看起来一样。
 */
import { useEffect, useId, useRef, useState } from 'react';

import type { SharePlanView, ShareTtlId } from '../../shared/ipc.js';
import { QrCode } from './qr.js';
import { Banner, Dialog, PillButton } from './primitives.js';

/**
 * 分享任务时的额外警告（08 §7.2 规则 5）。
 *
 * **这句话在 `@evowork/artifacts` 的 `THREAD_SHARE_WARNING` 里也有一份。**
 * 这边不 import 那个包：渲染层在浏览器里跑，而那个 barrel 会拖进 node 内置模块
 * （`apps/desktop/test/styles.test.ts` 有一条守着）。
 *
 * 两份不许分叉 —— `share-journey.test.tsx` 直接比对它们相等。
 */
export const THREAD_SHARE_WARNING =
  '任务里可能包含工作空间路径、文件内容片段与业务信息。上传前请先预览将要分享的内容。';

export type SharePhase =
  | { readonly kind: 'authorize'; readonly plan: SharePlanView }
  /**
   * 分享**任务**（08 §7.2 规则 5）：同一个模态，但多两样东西 ——
   * 一句额外警告，和**将要上传内容的预览**。`markdown` 就是要传的那个字符串，
   * 不是它的另一份渲染。
   */
  | { readonly kind: 'authorize-thread'; readonly plan: SharePlanView; readonly markdown: string }
  | { readonly kind: 'uploading'; readonly plan: SharePlanView }
  | { readonly kind: 'done'; readonly url: string; readonly expiresAt: number }
  | { readonly kind: 'failed'; readonly plan: SharePlanView; readonly refused: string };

export interface ShareDialogProps {
  readonly phase: SharePhase;
  readonly onConfirm: (input: {
    readonly ttl: ShareTtlId;
    readonly accessCode: string | undefined;
    readonly confirmed: boolean;
    /** 分享任务时才有意义：用户确实看过将要上传的内容 */
    readonly previewed: boolean;
  }) => void;
  readonly onCancel: () => void;
  readonly onCopy: (url: string) => void;
}

/** 二维码边长。对话框宽 420，留出内边距之后 160 是"手机举起来就能扫"的下限。 */
const QR_SIZE = 160;

function sizeLabel(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function ShareDialog(props: ShareDialogProps) {
  const [ttl, setTtl] = useState<ShareTtlId>('24h');
  const [accessCode, setAccessCode] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [previewed, setPreviewed] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // 用 htmlFor/id 而不是把 input 包进 label：那个 label 里还有一段说明文字，
  // 包起来会让无障碍名变成"标签 + 整段说明"
  const codeId = useId();

  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );

  if (props.phase.kind === 'uploading') {
    return (
      <Dialog
        title="正在上传"
        confirmLabel="取消上传"
        cancelLabel="在后台继续"
        onConfirm={props.onCancel}
        onCancel={props.onCancel}
      >
        <div className="ew-share-body">
          <p className="ew-share-file">{props.phase.plan.fileName}</p>
          {/*
            这里**不画进度条**。上传是一次 fetch，拿不到分块进度：
            `uploader` 的 `onProgress` 只在开头和结尾各响一次。
            画一条 0→100 一跳的条比不画更糟 —— 它会让人以为中间那段是真的在走。
          */}
          <p className="ew-share-status" role="status">
            正在上传…
          </p>
          <p className="ew-field-hint">取消会中止请求，云端不会留下这个文件。</p>
        </div>
      </Dialog>
    );
  }

  if (props.phase.kind === 'done') {
    const done = props.phase;
    return (
      <Dialog
        title="链接已生成"
        confirmLabel="完成"
        onConfirm={props.onCancel}
        onCancel={props.onCancel}
      >
        <div className="ew-share-body">
          <Banner tone="accent">
            任何拿到这条链接的人都能访问它。{new Date(done.expiresAt).toLocaleString('zh-CN')}失效。
          </Banner>
          <div className="ew-share-link">
            <code className="ew-share-url">{done.url}</code>
            <PillButton
              onClick={() => {
                props.onCopy(done.url);
                setCopied(true);
                copyTimer.current = setTimeout(() => setCopied(false), 2000);
              }}
            >
              {copied ? '已复制' : '复制链接'}
            </PillButton>
          </div>

          {/*
            二维码（08 §7.1 第 ③ 步）。它编的就是上面那条链接，**包括 `#` 之后的文件名** ——
            手机扫出来的和复制出去的必须是同一条，否则扫码拿到的文件会没有名字。
          */}
          <div className="ew-share-qr">
            <QrCode value={done.url} size={QR_SIZE} title="分享链接的二维码" />
            <p className="ew-field-hint">用手机扫它，或者复制上面那条链接。</p>
          </div>
          <p className="ew-field-hint">
            链接里 <code>#</code> 之后那一段是文件名，只给接收方的浏览器看 ——
            我们的服务器不知道这个文件叫什么。
          </p>
          <p className="ew-field-hint">随时可以在「资料库 → 我分享的」里撤销它。</p>
        </div>
      </Dialog>
    );
  }

  const plan = props.phase.plan;
  const failed = props.phase.kind === 'failed' ? props.phase.refused : undefined;
  const thread = props.phase.kind === 'authorize-thread' ? props.phase : undefined;
  // 分享任务要两个都勾上：确认可以对外分享，**以及**确实看过将要上传的内容
  const ready = confirmed && (!thread || previewed);

  return (
    <Dialog
      title={thread ? '分享这个任务' : '分享这份产物'}
      confirmLabel={failed ? '重试' : '生成链接'}
      confirmDisabled={!ready}
      closable
      onConfirm={() =>
        props.onConfirm({
          ttl,
          accessCode: accessCode.trim() || undefined,
          confirmed,
          previewed,
        })
      }
      onCancel={props.onCancel}
    >
      <div className="ew-share-body">
        {failed ? <Banner tone="danger">{failed}</Banner> : null}

        {/*
          规则 5 的额外警告。用户对"分享一个任务"的直觉是"分享一段对话"，
          想不到里面还有工作空间路径、命令输出片段与业务数据。
        */}
        {thread ? <Banner tone="warning">{THREAD_SHARE_WARNING}</Banner> : null}

        {/* 三句话缺一不可：上传什么 · 上传到哪+谁能看 · 多久失效。原样显示，不重新组织 */}
        <ul className="ew-share-summary">
          {plan.summary.map((line) => (
            <li key={line}>{renderEmphasis(line)}</li>
          ))}
        </ul>

        <p className="ew-share-file">
          {plan.fileName}
          <span className="ew-field-hint">
            {' '}
            · {plan.artifactTypeLabel} · {sizeLabel(plan.sizeBytes)}
          </span>
        </p>

        <fieldset className="ew-field">
          <legend>链接有效期</legend>
          <div className="ew-share-ttl">
            {plan.ttlOptions.map((option) => (
              <PillButton
                key={option.id}
                variant={option.id === ttl ? 'accent' : undefined}
                onClick={() => setTtl(option.id)}
              >
                {option.label}
              </PillButton>
            ))}
          </div>
        </fieldset>

        <div className="ew-field">
          <label className="ew-share-label" htmlFor={codeId}>
            访问密码（可选）
          </label>
          <input
            id={codeId}
            type="password"
            autoComplete="off"
            value={accessCode}
            onChange={(event) => setAccessCode(event.target.value)}
          />
          <p className="ew-field-hint">
            它只挡住下载。<strong>办公文件在浏览器里始终不预览</strong>，设不设都一样。
          </p>
        </div>

        {thread ? (
          <div className="ew-field">
            <span className="ew-share-label">将要上传的内容（全文）</span>
            {/*
              预览的是**要传的那个字符串本身**，不是它的另一份渲染 ——
              两处各自生成的话，某天一处改了另一处没改，预览就开始撒谎。
            */}
            <pre className="ew-share-preview">{thread.markdown}</pre>
            <p className="ew-field-hint">
              这就是对方会拿到的全部内容。里面如果有不该外传的东西，请先取消并改任务。
            </p>
          </div>
        ) : null}

        {thread ? (
          <label className="ew-checkbox">
            <input
              type="checkbox"
              checked={previewed}
              onChange={(event) => setPreviewed(event.target.checked)}
            />
            <span>我已经看过上面这些内容</span>
          </label>
        ) : null}

        {/* 不预勾（§7.1）。"没勾"是默认状态，不是用户失误 —— 文案不责备 */}
        <label className="ew-checkbox">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          <span>我确认这份文件可以对外分享</span>
        </label>
      </div>
    </Dialog>
  );
}

/** `authorizationSummary` 里用 `**…**` 标了重点，这里把它画成粗体而不是显示星号。 */
function renderEmphasis(line: string) {
  const parts = line.split(/\*\*(.+?)\*\*/g);
  return parts.map((part, index) =>
    index % 2 === 1 ? <strong key={`${part}-${index}`}>{part}</strong> : part,
  );
}
