/**
 * `evowork://` 深链（02 §8）。
 *
 * 三个场景要它：分享链接回跳（Q10）、系统通知点击、CLI 唤起 GUI（Q13）。
 * 即使 Q1=A 是纯本地应用，这三条都跨进程。
 *
 * ## 02 §8 的三条规则，每条都落在这个文件里
 *
 * 1. **不携带任何文件内容**，只带 ID 与场景 / 提示词。
 *    解析结果的类型里因此没有能装内容的字段 —— 想加就得先改这个联合，
 *    而改它会被 `test/deeplink.test.ts` 看见。
 * 2. **`prompt` 只写进 Composer，不自动发送**。所以 `home` 那一支给的是
 *    `prefill`，名字本身就在说它做什么 —— 叫 `prompt` 的话，
 *    某天有人会顺手把它接到发送上，而那意味着一条外部链接能直接触发执行。
 * 3. **未知 ID 要给明确错误**，不是空白页。所以解析与**解析成功但找不到东西**
 *    是两种结果，不是一种。
 *
 * 这个文件不 import electron：协议注册与 argv 捕获在 `bootstrap.ts`，
 * 这里只做"一条 URL 该跳到哪"。那是唯一值得单独测的部分。
 */

export const DEEPLINK_SCHEME = 'evowork';

/** 一条能跳的目标。**没有能装文件内容的字段**（02 §8 规则 1）。 */
export type DeeplinkTarget =
  | { readonly kind: 'task'; readonly threadId: string }
  | { readonly kind: 'automation'; readonly automationId: string }
  | { readonly kind: 'library'; readonly nodeId: string }
  | { readonly kind: 'share'; readonly shareId: string }
  | {
      readonly kind: 'home';
      readonly scenario?: string | undefined;
      /**
       * 写进 Composer 的文本。
       *
       * **叫 `prefill` 不叫 `prompt`**：02 §8 规则 2 说它只写入不发送，
       * 而名字是这条规则最便宜的守卫 —— 一个叫 `prompt` 的字段迟早会被接到发送上。
       */
      readonly prefill?: string | undefined;
    };

export type DeeplinkParse =
  | { readonly ok: true; readonly target: DeeplinkTarget }
  | { readonly ok: false; readonly reason: string };

/** id 只允许这套字符：它会被拿去查库、拼路由。 */
const ID = /^[A-Za-z0-9_-]{1,128}$/;

/** 提示词长度上限。外部链接不该能往 Composer 里灌一整本书。 */
const MAX_PREFILL = 4000;

/**
 * 解析一条 `evowork://` URL。
 *
 * 认不出来时回**具体**原因而不是 `undefined`：这条链接多半是用户从别处点进来的，
 * 而"什么都没发生"是最难排查的那种失败。
 */
export function parseDeeplink(raw: string): DeeplinkParse {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: '这不是一条能识别的链接。' };
  }
  if (url.protocol !== `${DEEPLINK_SCHEME}:`) {
    return { ok: false, reason: `只认 ${DEEPLINK_SCHEME}:// 开头的链接。` };
  }

  /*
   * `evowork://task/abc` 里 host 是 `task`、pathname 是 `/abc`。
   * 但某些系统会把它交成 `evowork:///task/abc`（host 空），所以两种都收下 ——
   * 只按 host 取的话，从通知中心点进来的那条在 Linux 上会解不出来。
   */
  const segments = [url.hostname, ...url.pathname.split('/')]
    .map((part) => decodeURIComponent(part.trim()))
    .filter((part) => part !== '');
  const [kind, id] = segments;

  switch (kind) {
    case 'task':
      return id && ID.test(id)
        ? { ok: true, target: { kind: 'task', threadId: id } }
        : { ok: false, reason: '这条链接里没有任务编号。' };
    case 'automation':
      return id && ID.test(id)
        ? { ok: true, target: { kind: 'automation', automationId: id } }
        : { ok: false, reason: '这条链接里没有自动化编号。' };
    case 'library':
      return id && ID.test(id)
        ? { ok: true, target: { kind: 'library', nodeId: id } }
        : { ok: false, reason: '这条链接里没有资料编号。' };
    case 'share':
      return id && ID.test(id)
        ? { ok: true, target: { kind: 'share', shareId: id } }
        : { ok: false, reason: '这条链接里没有分享编号。' };
    case 'home': {
      const scenario = url.searchParams.get('scenario')?.trim();
      const prefill = url.searchParams.get('prompt')?.slice(0, MAX_PREFILL);
      return {
        ok: true,
        target: {
          kind: 'home',
          ...(scenario && ID.test(scenario) ? { scenario } : {}),
          ...(prefill ? { prefill } : {}),
        },
      };
    }
    default:
      return { ok: false, reason: `不认识 ${DEEPLINK_SCHEME}://${kind ?? ''} 这种链接。` };
  }
}

/**
 * 从进程参数里挑出深链。
 *
 * Windows / Linux 上系统是把 URL 当命令行参数递过来的（macOS 走 `open-url` 事件）。
 * argv 里还混着 electron 自己的开关与入口路径，所以只认 scheme 前缀。
 */
export function deeplinkFromArgv(argv: readonly string[]): string | undefined {
  return argv.find((arg) => arg.startsWith(`${DEEPLINK_SCHEME}://`));
}

export type DeeplinkResolution =
  | { readonly ok: true; readonly target: DeeplinkTarget }
  | { readonly ok: false; readonly reason: string };

export interface DeeplinkLookup {
  readonly hasTask: (threadId: string) => boolean;
  readonly hasAutomation: (automationId: string) => boolean;
  readonly hasArtifact: (nodeId: string) => boolean;
  readonly hasShare: (shareId: string) => boolean;
}

/**
 * 解析 + 查本机有没有这个东西。
 *
 * **找不到时说清是"不在这台电脑上"**（02 §8 规则 3）。这是 Q1=A 的必然结果：
 * 任务与产物只在创建它的那台机器上，而用户拿到的链接可能来自另一台。
 * 含糊成"打不开"会让人以为是程序坏了，然后去重装。
 */
export function resolveDeeplink(raw: string, lookup: DeeplinkLookup): DeeplinkResolution {
  const parsed = parseDeeplink(raw);
  if (!parsed.ok) return parsed;
  const target = parsed.target;

  switch (target.kind) {
    case 'task':
      return lookup.hasTask(target.threadId)
        ? { ok: true, target }
        : { ok: false, reason: '该任务不在本机，可能创建于其他设备。' };
    case 'automation':
      return lookup.hasAutomation(target.automationId)
        ? { ok: true, target }
        : { ok: false, reason: '该自动化不在本机，可能创建于其他设备。' };
    case 'library':
      return lookup.hasArtifact(target.nodeId)
        ? { ok: true, target }
        : { ok: false, reason: '该文件不在这台电脑上。分享链接里的文件不会自动同步过来。' };
    case 'share':
      return lookup.hasShare(target.shareId)
        ? { ok: true, target }
        : {
            ok: false,
            // 分享页上那个「在 EvoWork 中打开」多半是**接收方**点的，而他本机当然没有
            reason: '这份产物不在这台电脑上 —— 它是别人分享给你的，请用网页上的「下载」。',
          };
    case 'home':
      return { ok: true, target };
  }
}
