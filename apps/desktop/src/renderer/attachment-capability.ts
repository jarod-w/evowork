/**
 * 「这些附件当前模型收不收得下」—— 纯策略，不碰网络也不碰 React（同 `model-selection.ts`）。
 *
 * 03 §8：模型不支持图片时，**附件区就拒绝图片**并说明原因（D2「降级必须显式」）。
 * 以前没有这一层：图片照常发出去，网关按能力表整轮拒掉（`to-chat.ts` 的
 * 「当前模型不支持图片输入」），同一条消息里的其他附件一起白传。
 *
 * 判的是**引用**，不是附件类型：带插图的 docx / pptx 解析后也会带着最多几张
 * `localImage`（`services/ingest/src/inject.ts` 的 keyImages），它们同样会让整轮失败。
 *   · 只有图片的附件（截图、照片）→ 标成没添加，给「以原始文件引用」这条出路：
 *     模型看不见图，但拿到路径照样能把它放进 PPT、拷进产物目录。
 *   · 文档 → 去掉页图、照常发文字，并在附件区说一声图片没发出去。
 *
 * **只在确知不支持时才拦**：模型列表还没回来、或能力表里没有这一项，就交给网关判 ——
 * 猜"不支持"会把能读图的模型也拦下。
 *
 * 结果同时喂给 Composer 的显示和 `send()`：两边各判一遍，就会再出现
 * 「按钮是亮的、点了却什么都不发」那一类不一致。
 */
import type { ComposerAttachmentView, ModelOptionView } from '../shared/ipc.js';

/** 03 §8 原话。 */
export const IMAGE_INPUT_UNSUPPORTED = '当前模型不支持图片输入，可切换模型。';
/** 接在《文件名》后面读。 */
export const DOCUMENT_IMAGES_WITHHELD =
  '里的图片不会发给当前模型（它不支持图片输入），只发送解析出的文字。';

export interface GatedAttachment extends ComposerAttachmentView {
  /** 附件照常发送，但有一部分没发出去时的说明 */
  readonly notice?: string | undefined;
}

/** `undefined` = 不知道（列表没回来、能力表没有这一项），不拦。 */
export function modelImageInput(
  models: readonly ModelOptionView[],
  modelId: string | undefined,
): boolean | undefined {
  return models
    .find((model) => model.id === modelId)
    ?.capabilities.find((capability) => capability.id === 'image-input')?.available;
}

export function gateAttachmentsForModel(
  attachments: readonly ComposerAttachmentView[],
  imageInput: boolean | undefined,
): readonly GatedAttachment[] {
  if (imageInput !== false) return attachments;
  return attachments.map((attachment) => {
    if (attachment.state !== 'ready') return attachment;
    const images = attachment.references.filter((reference) => reference.type === 'localImage');
    if (images.length === 0) return attachment;
    const rest = attachment.references.filter((reference) => reference.type !== 'localImage');
    if (rest.length > 0) {
      return { ...attachment, references: rest, notice: DOCUMENT_IMAGES_WITHHELD };
    }
    const first = images[0] as (typeof images)[number];
    return {
      ...attachment,
      state: 'failed',
      error: IMAGE_INPUT_UNSUPPORTED,
      references: [],
      rawReference: { type: 'mention', name: attachment.name, path: first.path },
    };
  });
}
