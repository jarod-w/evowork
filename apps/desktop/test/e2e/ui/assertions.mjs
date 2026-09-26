/**
 * 几条**任何页面都该成立**的几何/样式判据。
 *
 * 抽出来是因为它们要用在每个视图上（资料库、自动化、设置…），而复制一份扫描逻辑
 * 的下场是两边慢慢漂开 —— 到时候"这个视图为什么不报"就没人答得上来。
 *
 * 这里只**返回事实**，不写 `expect`：断言留在 spec 里，失败信息才能说清是哪个视图。
 */

/** 页面横向溢出了多少像素（0 或 1 都算正常，亚像素取整） */
export function horizontalOverflow(page) {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

/**
 * 被**无声硬裁**的文字：内容超出容器、`overflow: hidden` 挡住，却既没有省略号
 * 也没有 `title`。用户看到的是半个词，而且不知道自己看到的是半个。
 *
 * 返回 `examined` 是为了自证：扫不到候选时这条判据什么都没在守，
 * 而那种情况应该让 spec 红，不该让它无声地绿。
 */
export function silentlyClippedText(page) {
  return page.evaluate(() => {
    const bad = [];
    let examined = 0;
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      if (cs.overflowX !== 'hidden' && cs.overflow !== 'hidden') continue;
      // 只看直接装着文字的元素：容器溢出是布局问题，由 horizontalOverflow 管
      const text = [...el.childNodes]
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent?.trim() ?? '')
        .join('');
      if (text.length === 0) continue;
      examined += 1;
      if (el.scrollWidth <= el.clientWidth + 1) continue;
      if (cs.textOverflow === 'ellipsis') continue;
      if ((el.getAttribute('title') ?? '').length > 0) continue;
      bad.push(`${el.className || el.tagName}: ${JSON.stringify(text.slice(0, 24))}`);
    }
    return { examined, bad };
  });
}

/** 改原生窗口大小。Electron 里 `setViewportSize` 不管用 */
export function resizeWindow(electronApp, width, height) {
  return electronApp.evaluate(
    ({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height);
    },
    { width, height },
  );
}
