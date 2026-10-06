/**
 * 附件在当前模型下收不收得下（`renderer/attachment-capability.ts`，03 §8）。
 *
 * 盯三件事：读不了图时**一张图都不许发出去**（发出去网关会整轮拒掉，别的附件一起白传）；
 * 文档的文字不能跟着图片一起丢；不知道模型能不能读图时不许猜"不能"。
 */
import { describe, expect, it } from 'vitest';

import {
  DOCUMENT_IMAGES_WITHHELD,
  gateAttachmentsForModel,
  IMAGE_INPUT_UNSUPPORTED,
  modelImageInput,
} from '../src/renderer/attachment-capability.js';
import type { ComposerAttachmentView, ModelOptionView } from '../src/shared/ipc.js';

const SCREENSHOT: ComposerAttachmentView = {
  id: 'img',
  name: '截图.png',
  kind: 'image',
  sizeLabel: '已保存到项目',
  state: 'ready',
  references: [{ type: 'localImage', name: '截图.png', path: '/w/uploads/a/截图.png' }],
};

/** 带插图的 Word：解析后是「摘要文字 + 页图 + 指向目录的 mention」（ingest 的 buildInjection） */
const REPORT: ComposerAttachmentView = {
  id: 'doc',
  name: '年报.docx',
  kind: 'document',
  sizeLabel: '已保存到项目',
  state: 'ready',
  references: [
    { type: 'text', text: '已上传《年报.docx》，解析后的正文在 /w/uploads/b/content.md' },
    { type: 'localImage', name: '年报.docx', path: '/w/uploads/b/assets/image1.png' },
    { type: 'mention', name: '年报.docx', path: '/w/uploads/b/' },
  ],
};

const BROKEN: ComposerAttachmentView = {
  id: 'bad',
  name: '坏.zip',
  kind: 'archive',
  sizeLabel: '',
  state: 'failed',
  error: '这个压缩包读不出来。',
  references: [],
};

function outgoing(attachments: readonly ComposerAttachmentView[]) {
  return attachments.flatMap((attachment) => attachment.references);
}

describe('当前模型读不了图（imageInput = false）', () => {
  const gated = gateAttachmentsForModel([SCREENSHOT, REPORT, BROKEN], false);

  it('发出去的引用里一张图都没有 —— 有一张，网关就会把整轮拒掉', () => {
    expect(outgoing(gated).some((reference) => reference.type === 'localImage')).toBe(false);
  });

  it('截图在附件区被拒，说的是 03 §8 那句话，并给「以原始文件引用」这条出路', () => {
    const screenshot = gated.find((attachment) => attachment.id === 'img');
    expect(screenshot?.state).toBe('failed');
    expect(screenshot?.error).toBe(IMAGE_INPUT_UNSUPPORTED);
    expect(IMAGE_INPUT_UNSUPPORTED).toContain('可切换模型');
    // 模型看不见图，但拿到路径还能把它放进 PPT —— 原始引用是同一个文件的 mention
    expect(screenshot?.rawReference).toEqual({
      type: 'mention',
      name: '截图.png',
      path: '/w/uploads/a/截图.png',
    });
  });

  it('文档的文字与目录引用照常发，只留下插图，并说一声', () => {
    const report = gated.find((attachment) => attachment.id === 'doc');
    expect(report?.state).toBe('ready');
    expect(report?.references.map((reference) => reference.type)).toEqual(['text', 'mention']);
    expect(report?.notice).toBe(DOCUMENT_IMAGES_WITHHELD);
  });

  it('本来就失败的附件原样保留（它的原因不该被换成读图的那句）', () => {
    expect(gated.find((attachment) => attachment.id === 'bad')).toEqual(BROKEN);
  });

  it('改用原始文件引用之后不会再被拦（那里已经没有图片了）', () => {
    const referred: ComposerAttachmentView = {
      ...SCREENSHOT,
      references: [{ type: 'mention', name: '截图.png', path: '/w/uploads/a/截图.png' }],
    };
    expect(gateAttachmentsForModel([referred], false)).toEqual([referred]);
  });
});

describe('能读图，或者不知道能不能读图', () => {
  it('能读图：原样发，图片都在', () => {
    const attachments = [SCREENSHOT, REPORT];
    expect(gateAttachmentsForModel(attachments, true)).toBe(attachments);
  });

  it('不知道（列表还没回来、能力表没有这一项）：不拦，交给网关判 —— 猜"不能"会拦下能读图的模型', () => {
    const attachments = [SCREENSHOT];
    expect(gateAttachmentsForModel(attachments, undefined)).toBe(attachments);
  });
});

describe('从模型目录里读能力位', () => {
  const models: readonly ModelOptionView[] = [
    {
      id: 'evowork/text-only',
      label: 'x/text-only',
      provider: 'x',
      capabilities: [{ id: 'image-input', label: '读图', available: false }],
      notices: [],
      credentialSource: 'byok',
      verified: true,
    },
    {
      id: 'evowork/no-claim',
      label: 'x/no-claim',
      provider: 'x',
      capabilities: [],
      notices: [],
      credentialSource: 'byok',
      verified: false,
    },
  ];

  it('明确标了不支持才是 false', () => {
    expect(modelImageInput(models, 'evowork/text-only')).toBe(false);
  });

  it('能力表里没有这一项、模型不在目录里、还没选模型：都是"不知道"', () => {
    expect(modelImageInput(models, 'evowork/no-claim')).toBeUndefined();
    expect(modelImageInput(models, 'evowork/gone')).toBeUndefined();
    expect(modelImageInput(models, undefined)).toBeUndefined();
    expect(modelImageInput([], 'evowork/text-only')).toBeUndefined();
  });
});

it('独立 AI 编辑引用不依赖对话模型看图能力', () => {
  const image: ComposerAttachmentView = {
    ...SCREENSHOT,
    references: [
      { type: 'localImage', name: '截图.png', path: '/w/uploads/a/截图.png', purpose: 'imageEdit' },
    ],
  };
  expect(gateAttachmentsForModel([image], false)).toEqual([image]);
});
