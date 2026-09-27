/**
 * 分享链接的二维码（08 §7.1 第 ③ 步）。
 *
 * ## 为什么引依赖而不是自己写
 *
 * QR 编码里有 Reed-Solomon 纠错、八种掩码的惩罚分评估、BCH 格式信息 ——
 * 手写一遍能跑，但**没法验证它是对的**：一个掩码选错、一位格式信息错，
 * 生成的图案照样"看起来像二维码"，只是扫不出来。而我们没有扫码器来验收。
 * `qrcode-generator` 是 MIT、零传递依赖、用了十年的实现。
 *
 * ## 为什么画 SVG 不画 canvas
 *
 * canvas 要按设备像素比重画，且截图/复制出来是位图。SVG 在任何缩放下都清晰，
 * 也不需要 ref 与副作用 —— 这一页本来就只是把一个字符串画成方块。
 */
import qrcode from 'qrcode-generator';

/**
 * 纠错级别 M（约 15%）。
 *
 * 不用 L：二维码会被截图、被投影、被手机在会议室里斜着扫，
 * 而分享链接带 `#文件名` 片段之后通常有 60–100 字符，L 的容错在这些场景下不够。
 * 也不用 H：那会把模块数推高一档，在对话框那么大的地方每个模块就只剩一两个像素。
 */
const ERROR_CORRECTION = 'M';

/** `0` = 让库按内容长度自己挑最小版本。定死版本会在链接变长时直接抛错。 */
const AUTO_VERSION = 0;

export interface QrCodeProps {
  readonly value: string;
  /** 整体边长（CSS px）。模块数由内容决定，所以这里给的是外框，不是每格大小。 */
  readonly size: number;
  readonly title: string;
}

export function QrCode(props: QrCodeProps) {
  const qr = qrcode(AUTO_VERSION, ERROR_CORRECTION);
  qr.addData(props.value);
  qr.make();

  const count = qr.getModuleCount();
  /*
   * 静区 4 个模块（规范要求）。少给的话，深色背景或紧贴的边框会让扫码器
   * 找不到定位图案 —— 这是二维码"有时扫得出有时扫不出"最常见的原因。
   */
  const quiet = 4;
  const total = count + quiet * 2;

  const paths: string[] = [];
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (!qr.isDark(row, col)) continue;
      paths.push(`M${col + quiet} ${row + quiet}h1v1h-1z`);
    }
  }

  return (
    <svg
      className="ew-qr"
      width={props.size}
      height={props.size}
      viewBox={`0 0 ${total} ${total}`}
      role="img"
      aria-label={props.title}
      shapeRendering="crispEdges"
    >
      {/* 白底是规范的一部分，不是装饰：模块必须画在浅色上才有对比度 */}
      <rect width={total} height={total} fill="#ffffff" />
      <path d={paths.join('')} fill="#000000" />
    </svg>
  );
}
