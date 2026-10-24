/** 打包预算：办公运行时完整随包，OCR 仍单独发行（08 §4 / R10）。 */
export const SIZE_BUDGET = Object.freeze({
  /** 主安装包压缩后下载体积，包含完整办公运行时。 */
  base: 400 * 1024 * 1024,
  /** 完整办公目录安装后体积，单独测量。 */
  office: 350 * 1024 * 1024,
  ocr: 80 * 1024 * 1024,
});

const ON_DEMAND_MARKERS = ['tesseract', 'tessdata'];

export function checkTierPlacement(basePackageFiles) {
  const offenders = basePackageFiles.filter((file) =>
    ON_DEMAND_MARKERS.some((marker) => file.includes(marker)),
  );
  return {
    ok: offenders.length === 0,
    offenders,
    message:
      offenders.length === 0
        ? '办公运行时可随包，OCR 组件保持独立。'
        : `这些 OCR 组件不该进基础包（08 §4 独立发行）：${offenders.join('、')}`,
  };
}

export function checkSizeBudget(tier, actualBytes) {
  const budget = SIZE_BUDGET[tier];
  const mb = (bytes) => `${Math.round(bytes / 1024 / 1024)}MB`;
  return {
    ok: actualBytes <= budget,
    tier,
    actualBytes,
    budget,
    message:
      actualBytes <= budget
        ? `${tier}: ${mb(actualBytes)} / ${mb(budget)}`
        : `${tier} 超出预算：${mb(actualBytes)} > ${mb(budget)}。请检查重复依赖、构建缓存及 OCR 是否误入基础包；办公运行时必须完整随包。`,
  };
}

/**
 * 签名计划。
 *
 * 三个平台各自需要的 secrets 不同，缺任何一个就**整体降级为未签名**并在文件名上标出来 ——
 * 半签名的产物比未签名的更危险：它看起来是正式包。
 */
export function planSigning(env, platform) {
  const required = {
    mac: ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID', 'CSC_LINK'],
    win: ['WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD'],
    linux: [],
  }[platform];

  const missing = required.filter((key) => !env[key]);
  if (missing.length === 0) {
    return { sign: true, notarize: platform === 'mac', suffix: '', missing: [] };
  }
  return {
    sign: false,
    notarize: false,
    // 标注必须进**文件名**，否则没人会注意到（U4 的替代方案原话是"产物标注未签名"）
    suffix: '-unsigned',
    missing,
    message: `缺少 ${missing.join('、')}，本次产出未签名包（U4）。另一台 Mac 经浏览器下载后会提示「已损坏」，先 xattr -cr 清隔离标记；正式分发需要 Developer ID 与公证。`,
  };
}

/** 产物文件名。未签名时后缀进名字。 */
export function artifactName(productName, version, platform, arch, extension, suffix = '') {
  return `${productName}-${version}-${platform}-${arch}${suffix}.${extension}`;
}

/**
 * hook 策略包的 vendor 步骤（见 `plugins/hooks/evowork-policy/bin/_runner.mjs`）。
 *
 * 打包时把 `@evowork/policy` **打成单文件**放进插件目录，运行器就不必回退到仓库路径
 * （打包后的应用里没有那个路径）。是 esbuild 的入口，不是拷贝的源 —— 见 `scripts/build.mjs`。
 */
export const HOOK_VENDOR = Object.freeze({
  from: 'services/policy/src/index.ts',
  to: 'plugins/hooks/evowork-policy/vendor/policy.mjs',
});
