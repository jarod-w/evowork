/** Flash / Pro 各一次付费生成；Chat 调度为可控夹具，网关/内核/MCP/窗口均真实。 */
import { test } from './fixtures.mjs';
import { imageGenerationJourney } from './image-generation-journey.mjs';

test.use({ realModel: false, imageGeneration: 'real', imageInput: true, registerModels: true });
test.describe.configure({ retries: 0, timeout: 420_000 });
for (const [label, model] of [
  ['Flash', 'doubao-seedream-5-0-flash-260915'],
  ['Pro', 'doubao-seedream-5-0-pro-260628'],
]) {
  test(`真实 Seedream ${label}：天空图片生成、查看与回合收尾`, async ({
    page,
    electronApp,
  }, testInfo) => {
    await imageGenerationJourney({ page, electronApp }, testInfo, model);
  });
}
