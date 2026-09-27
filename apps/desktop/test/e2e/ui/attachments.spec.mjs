/**
 * **一次选多个文件：点「添加本地文件」→ 多选 → 看附件条 → 发送。**
 *
 * 这条旅程守的三件事，此前都**不报错**地坏着（2026-09-27）：
 *
 * ① 「单次最多 20 个」在桌面上从没生效 —— 宿主一个一个地调管道，数量闸门每次只看到 1 个；
 *    而闸门自己超限时，前 20 个既不处理也不返回，等于凭空消失。
 * ② 失败的**原因**哪儿都没画。界面上只有一个「解析失败」，分不出文件坏了还是一次选多了；
 *    被拒掉的文件还挂着一个「以原始文件引用」，点了什么都不会发生（原文件根本没保存）。
 * ③ xlsx 解析出的 csv 被当成图片发给模型。
 *
 * 系统文件框 Playwright 点不到，由 `ui-entry.mjs` 按 `__evoworkE2E.pickedFiles` 作答；
 * 被测的是**选完之后**的那一段：宿主 → 解析管道 → 附件条 → 发送 → 模型请求。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, makeOfficeFixtures, test } from './fixtures.mjs';

test('选 23 个：前 20 个就绪、后 3 个说清原因；发出去的请求里图一张不少、csv 不当图', async ({
  page,
  electronApp,
}, testInfo) => {
  const dir = testInfo.outputPath('picked');
  const office = makeOfficeFixtures(dir);
  // 五个真文件在前，再补 18 个纯文本凑到 23：被拒的应当正好是最后 3 个纯文本
  const notes = Array.from({ length: 18 }, (_, i) => {
    const path = join(dir, `笔记${String(i + 1).padStart(2, '0')}.txt`);
    writeFileSync(path, `第 ${i + 1} 份笔记`, 'utf8');
    return path;
  });
  const picked = [...office.map((fixture) => fixture.path), ...notes];
  await electronApp.evaluate((_electron, files) => {
    globalThis.__evoworkE2E.pickedFiles = files;
  }, picked);

  // ① 用户真正点的那两下
  await page.getByRole('button', { name: '添加内容' }).click();
  await page.getByRole('menuitem', { name: /添加本地文件/ }).click();

  const chips = page.locator('.ew-attachment');
  await expect(chips).toHaveCount(23, { timeout: 60_000 });
  await expect(page.locator('.ew-attachment[data-state="ready"]')).toHaveCount(20);
  const failed = page.locator('.ew-attachment[data-state="failed"]');
  await expect(failed).toHaveCount(3);
  await expect(failed.locator('.ew-attachment-name')).toHaveText([
    '笔记16.txt',
    '笔记17.txt',
    '笔记18.txt',
  ]);

  // ② 原因画出来了，而且只说一次；没有点了没反应的按钮
  const alert = page.getByRole('alert').filter({ hasText: '前 20 个照常处理' });
  await expect(alert).toHaveCount(1);
  await expect(alert).toContainText('《笔记16.txt》《笔记17.txt》《笔记18.txt》');
  await expect(alert).toContainText('另起一批');
  await expect(page.getByRole('button', { name: '以原始文件引用' })).toHaveCount(0);

  // 用户照着提示把那 3 个移掉
  for (const name of ['笔记16.txt', '笔记17.txt', '笔记18.txt']) {
    await page.getByRole('button', { name: `移除附件：${name}` }).click();
  }
  await expect(chips).toHaveCount(20);
  await expect(page.getByRole('alert').filter({ hasText: '前 20 个照常处理' })).toHaveCount(0);

  // ③ 发送，然后看网关收到了什么
  const marker = `MULTI-ATTACH-${Date.now()}`;
  await page.getByLabel('需求输入').fill(`把这些文件汇总一下 ${marker}`);
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle', {
    timeout: 60_000,
  });

  const findRequest = () =>
    electronApp.evaluate(
      (_electron, needle) =>
        globalThis.__evoworkE2E.gateway.requestBodies.find((body) => body.includes(needle)) ?? null,
      marker,
    );
  await expect.poll(findRequest, { message: '网关没收到这一回合的请求' }).not.toBeNull();
  const request = await findRequest();
  const body = JSON.parse(request);
  const userContent = body.input
    .filter((item) => item.role === 'user')
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []));
  const text = userContent
    .filter((part) => part.type === 'input_text')
    .map((part) => part.text)
    .join('\n');

  // 20 个就绪的每一个都进了这一回合；被移掉的 3 个没有
  // 单独的图片走「不解析」那条路（08 §3.3），只有一个 localImage、没有文字 —— 它在下面按图数
  for (const path of picked.slice(0, 20).filter((p) => !p.endsWith('.png'))) {
    const name = path.split('/').at(-1);
    expect(text, `${name} 没进这一回合`).toContain(name);
  }
  for (const name of ['笔记16.txt', '笔记17.txt', '笔记18.txt']) {
    expect(text).not.toContain(name);
  }

  /*
   * 图：docx 两张 + pptx 两张 + png 本身一张 = 5。
   * xlsx 解析出的 csv 以前也被当成 localImage，那时这里是 6。
   */
  const expectedImages = office.reduce((sum, fixture) => sum + fixture.embeddedImages, 0) + 1;
  const images = userContent.filter((part) => part.type === 'input_image');
  expect(images).toHaveLength(expectedImages);
  for (const image of images) {
    expect(image.image_url, '发给模型的"图"不是图').toMatch(/^data:image\//);
  }
});

/*
 * 拖拽那条路走的是另一个 IPC（`ingestAttachments`，带字节而不是路径），只在宿主里汇合。
 * 系统级拖放 Playwright 造不出来，但 Chromium 收得下一个带真 `File` 的合成 `drop` 事件 ——
 * 从 `onDrop` 往后的每一段（读字节 → IPC → 宿主 → 管道 → 附件条）都是真的。
 */
test('把带图的 docx 与 pptx 拖进输入框：两个都就绪，图也抽出来了', async ({
  page,
  electronApp,
}, testInfo) => {
  const office = makeOfficeFixtures(testInfo.outputPath('dropped'));
  const dropped = office
    .filter((fixture) => fixture.embeddedImages > 0)
    .map((fixture) => ({
      name: fixture.file,
      base64: readFileSync(fixture.path).toString('base64'),
    }));

  await page.locator('.ew-composer-shell').evaluate((shell, files) => {
    const transfer = new DataTransfer();
    for (const file of files) {
      const bytes = Uint8Array.from(atob(file.base64), (char) => char.charCodeAt(0));
      transfer.items.add(new File([bytes], file.name));
    }
    for (const type of ['dragenter', 'dragover', 'drop']) {
      shell.dispatchEvent(
        new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }),
      );
    }
  }, dropped);

  const ready = page.locator('.ew-attachment[data-state="ready"] .ew-attachment-name');
  await expect(ready).toHaveText(
    dropped.map((file) => file.name),
    { timeout: 60_000 },
  );
  await expect(page.locator('.ew-attachment[data-state="failed"]')).toHaveCount(0);

  const marker = `DROP-ATTACH-${Date.now()}`;
  await page.getByLabel('需求输入').fill(`看看这两份 ${marker}`);
  await page.getByRole('button', { name: '发送' }).click();
  const findRequest = () =>
    electronApp.evaluate(
      (_electron, needle) =>
        globalThis.__evoworkE2E.gateway.requestBodies.find((body) => body.includes(needle)) ?? null,
      marker,
    );
  await expect.poll(findRequest, { message: '网关没收到这一回合的请求' }).not.toBeNull();
  const images = JSON.parse(await findRequest())
    .input.filter((item) => item.role === 'user')
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .filter((part) => part.type === 'input_image');
  // docx 两张 + pptx 两张：拖进来的字节同样要经过抽图那一步
  expect(images).toHaveLength(office.reduce((sum, fixture) => sum + fixture.embeddedImages, 0));
});
