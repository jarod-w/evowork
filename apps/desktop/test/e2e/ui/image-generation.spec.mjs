import { test } from './fixtures.mjs';
import { imageGenerationJourney } from './image-generation-journey.mjs';

test.use({ imageGeneration: 'fixture', imageInput: true, registerModels: true });
test('大图生成后查看图片：任务成功、预览可见、重载不重复生成', async ({
  page,
  electronApp,
}, testInfo) => {
  await imageGenerationJourney({ page, electronApp }, testInfo, 'doubao-seedream-5-0-flash-260915');
});
test('拒绝图片费用确认：零服务商请求且正常结束', async ({ page, electronApp }, testInfo) => {
  await imageGenerationJourney(
    { page, electronApp },
    testInfo,
    'doubao-seedream-5-0-flash-260915',
    false,
  );
});

test.describe('服务商错误', () => {
  test.use({ imageGeneration: 'unavailable' });
  test('服务商返回 404：明确记录型号不可用，不伪装取消或成功', async ({
    page,
    electronApp,
  }, testInfo) => {
    await imageGenerationJourney(
      { page, electronApp },
      testInfo,
      'doubao-seedream-5-0-flash-260915',
      true,
      'IMAGE_MODEL_UNAVAILABLE',
    );
  });
});
