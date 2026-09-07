/**
 * 办公扩展要下载哪些东西（08 §4 的"按需下载"清单）。
 *
 * ## 为什么是一份钉死版本 + 哈希的清单，而不是"装最新的"
 *
 * 这里下载的是**可执行的二进制**和会被 python 直接 import 的代码。没有哈希的下载
 * 等于把用户机器上跑什么交给网络中间人。所以每一项都带 `sha256`，
 * 校验不过就整包失败 —— 不存在"校验失败但先用着"这条分支。
 *
 * 版本钉死还有第二个理由：**可复现**。用户 A 今天装、用户 B 下月装，如果拿到不同版本的
 * matplotlib，"图表生成失败"这类报告就没法复现。企业离线包（§3 的 `EVOWORK_OFFICE_BUNDLE`）
 * 也是照这份清单打的 —— 两条路径装出来的环境必须是同一个。
 *
 * ## 这些值是怎么来的
 *
 * **不是抄的文档，是 2026-09-06 实际取回来的**：
 *
 *   · python 的 6 个哈希来自 `SHA256SUMS`（release 20260901），其中
 *     `aarch64-apple-darwin` 一项与 GitHub API 的 `digest` 字段交叉核对过；
 *   · 字体哈希是把文件下载到本机后 `shasum -a 256` 算的；
 *   · 六个 python 包的版本号是在一个真装出来的环境里用 `importlib.metadata` 读的，
 *     并且用它跑通了 docx / xlsx / pptx / 图表四种产物的生成与回读。
 *
 * 更新清单用 `node scripts/refresh-office-manifest.mjs`，它会重新拉 `SHA256SUMS` 并核对。
 */

/** 一个可下载、可校验的文件。**三个字段缺一不可**：没有 size 就画不出进度条。 */
export interface RemoteAsset {
  readonly url: string;
  readonly sha256: string;
  readonly bytes: number;
}

/**
 * python 发行版：astral-sh/python-build-standalone 的 `install_only` 构建。
 *
 * ## 为什么是它，而不是 `uv venv` 或系统 python
 *
 * 这是本轮修的两个"客户设备上装不起来"里的第二个。`uv venv` 建出来的目录**不可搬运**：
 * 它的 `bin/python` 是一个指向 `~/.local/share/uv/python/...` 的符号链接
 * （2026-09-06 在本机实测确认），客户机器上没有 uv、也没有那个解释器，拷过去就是死链。
 * 系统 python 更不能用：版本不可控，而且往系统环境里装包正是 08 §4 要避免的事
 * （卸载 = 删一个目录，这条约定不能破）。
 *
 * `install_only` 构建解压出来是一个**自包含且位置无关**的 `python/` 目录，
 * 里面自带 pip —— 这正是"能打包发给客户"和"能离线装"同时成立的前提。
 */
export const PYTHON_VERSION = '3.12.14';
export const PYTHON_RELEASE = '20260901';

/** node 的 `${process.arch}-${process.platform}` → python-build-standalone 的 target triple。 */
export const TRIPLE_BY_PLATFORM: Readonly<Record<string, string>> = Object.freeze({
  'arm64-darwin': 'aarch64-apple-darwin',
  'x64-darwin': 'x86_64-apple-darwin',
  'x64-win32': 'x86_64-pc-windows-msvc',
  'arm64-win32': 'aarch64-pc-windows-msvc',
  'x64-linux': 'x86_64-unknown-linux-gnu',
  'arm64-linux': 'aarch64-unknown-linux-gnu',
});

const PYTHON_BASE = `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_RELEASE}`;

function pythonAsset(triple: string, sha256: string, bytes: number): RemoteAsset {
  // `+` 在 URL 里必须转义成 %2B，否则 GitHub 返回 404 —— 而 404 的表现是
  // "下载失败"，看起来像网络问题，实际是拼错了地址
  const name = `cpython-${PYTHON_VERSION}%2B${PYTHON_RELEASE}-${triple}-install_only.tar.gz`;
  return { url: `${PYTHON_BASE}/${name}`, sha256, bytes };
}

export const PYTHON_ASSETS: Readonly<Record<string, RemoteAsset>> = Object.freeze({
  'aarch64-apple-darwin': pythonAsset(
    'aarch64-apple-darwin',
    '3ee3ee547cedfeb7c2b16b2b7156039f7b470bb8f857e226fd3d2eb11db83c76',
    25_135_464,
  ),
  'x86_64-apple-darwin': pythonAsset(
    'x86_64-apple-darwin',
    '2e31b23f3f1319f707d0e620b48847a0046577541d357276821f9f1b5492e0ba',
    24_826_296,
  ),
  'x86_64-pc-windows-msvc': pythonAsset(
    'x86_64-pc-windows-msvc',
    'e90c1b6419da3bd812dd73bb3de40287a21abf153438147639ec5e20375ea93f',
    46_184_075,
  ),
  'aarch64-pc-windows-msvc': pythonAsset(
    'aarch64-pc-windows-msvc',
    '4e852236277eb8f7105cbe0f5adf45592f521af238bc0f700c351856e2c2e41a',
    42_877_617,
  ),
  'x86_64-unknown-linux-gnu': pythonAsset(
    'x86_64-unknown-linux-gnu',
    '936c246dfdbbfa7cb22dd01814a21f582a892689fae96b06071a5e433baffa22',
    111_368_545,
  ),
  'aarch64-unknown-linux-gnu': pythonAsset(
    'aarch64-unknown-linux-gnu',
    'b61b856c3e1a4fc65b8f6e6b0495ef975dd0924f90c59f3ea61b38a079173b84',
    83_541_077,
  ),
});

/**
 * 要装的六个包，**全部钉死版本**。
 *
 * 这就是 `RUNTIME_TIERS.office.probeModules` 那五个模块的来源，加上技能校验用的
 * `jsonschema`。顺序无所谓（pip 自己解依赖），但**不能漏 jsonschema**：
 * 四个技能都用它校验内容 JSON，缺了它技能会以"缺模块"退出，
 * 而探针只查五个模块、会说"装好了" —— 两边不一致正是 08 §4 点名要避免的情形。
 */
export const REQUIREMENTS: readonly string[] = Object.freeze([
  'python-docx==1.2.0',
  'openpyxl==3.1.5',
  'python-pptx==1.0.2',
  'matplotlib==3.11.1',
  'pdfplumber==0.11.10',
  'jsonschema==4.26.0',
]);

/**
 * 中文字体。**它是扩展的一部分，不是"希望系统里刚好有"**。
 *
 * `plugins/skills/charts` 会在画图前探测中文字体，探不到就停下来报错而不是画一张方框图。
 * 在 macOS / Windows 上系统字体让这一步侥幸能过，但裸 Linux 或精简 Windows 镜像上过不了 ——
 * 而在此之前那句提示写的是"请安装办公扩展（它带中文字体）"，**扩展里其实一个字体都没有**。
 * 这一项是让那句话变成真的。
 *
 * ## 为什么钉在一个 commit 上而不是 `main`
 *
 * `raw.githubusercontent.com/google/fonts/main/...` 是移动靶：Google 更新字体那天
 * 哈希就对不上，所有用户的安装同时开始失败。钉 commit 之后这个文件永远是同一份。
 *
 * ## 为什么下载的是可变字体，装完却是静态实例
 *
 * matplotlib 把这个可变字体的 `Noto Sans SC` 家族登记成了 **weight 100**
 * （实测：`findfont: Failed to find font weight normal, now using 100`），
 * 于是按家族名查找会拿到一个明显偏细的字重 —— 图表标题看起来像没吃饭。
 * 安装时用 fontTools（matplotlib 自带的依赖，不额外下载）切一份 `wght=400` 的静态实例，
 * 登记就干净了，也没有那条警告。代价是约 9 秒，换来的是"字重是确定的"。
 */
export const FONT_ASSET: RemoteAsset = Object.freeze({
  url:
    'https://raw.githubusercontent.com/google/fonts/' +
    '2894aab31764f10f29c421bdfd2340d3b382d384/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf',
  sha256: 'a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da',
  bytes: 17_772_300,
});

/** 装完之后留在 `fonts/` 里的那份（静态实例）。`charts` 按这个家族名查找。 */
export const FONT_FAMILY = 'Noto Sans SC';
export const FONT_FILE_NAME = 'NotoSansSC-Regular.ttf';
export const FONT_WEIGHT_AXIS = 'wght=400';
/** K5：随产品分发的第三方字体要进 `THIRD_PARTY_NOTICES`。 */
export const FONT_LICENSE = 'SIL Open Font License 1.1';

/** 下载总量（用于进度条与"要下多少"的文案）。**按 triple 算，不是一个常数**。 */
export function totalDownloadBytes(triple: string): number {
  return (PYTHON_ASSETS[triple]?.bytes ?? 0) + FONT_ASSET.bytes;
}
