/**
 * 打包计划与体积预算（M9 / R10）。
 *
 * ## R10 是这份文件存在的理由
 *
 * R10：安装包含内核二进制 + Python/Node 运行时（+100–300MB）、三平台签名公证、自动更新。
 * 缓解手段有三条，其中两条落在这里：
 *
 *   · **解析运行时按需下载而非全量随包**（08 §4）—— 所以基础包里**不该出现**
 *     python-docx / openpyxl / matplotlib 这些东西。这条靠 `checkTierPlacement` 守着：
 *     它们混进基础包不会报错，只会让安装包悄悄胖 200MB。
 *   · **体积预算**：超了要红，而不是等用户下载时才发现。
 *
 * 第三条（升级走差量包）在 electron-builder 的 publish 配置里。
 *
 * ## 签名：没有证书就产出「未签名」的包，而不是假装签了
 *
 * P0-5 的证书是外部依赖（U4）。CI 里签名步骤存在但在无 secrets 时跳过，
 * **产物标注「未签名」** —— 这是 work-priority §10 给 U4 的替代方案，
 * 而"标注"必须是产物文件名的一部分，否则没人会注意到。
 */

/** 各档的体积预算（字节）。数值来自 08 §4 与 R10。 */
export const SIZE_BUDGET = Object.freeze({
  /** 基础包：Electron + 内核二进制 + 我们的代码。**不含任何 Python 库** */
  base: 220 * 1024 * 1024,
  /** 办公扩展（按需下载） */
  office: 140 * 1024 * 1024,
  /** OCR 扩展（按需下载） */
  ocr: 80 * 1024 * 1024,
});

/** 只允许出现在按需下载档里的东西。混进基础包 = 安装包悄悄胖一倍。 */
const ON_DEMAND_MARKERS = [
  'python-docx',
  'openpyxl',
  'python-pptx',
  'pdfplumber',
  'matplotlib',
  'tesseract',
  'site-packages',
];

export function checkTierPlacement(basePackageFiles) {
  const offenders = basePackageFiles.filter((file) =>
    ON_DEMAND_MARKERS.some((marker) => file.includes(marker)),
  );
  return {
    ok: offenders.length === 0,
    offenders,
    message:
      offenders.length === 0
        ? '基础包里没有按需下载的运行时。'
        : `这些东西不该进基础包（08 §4 决定按需下载）：${offenders.join('、')}`,
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
        : `${tier} 超出预算：${mb(actualBytes)} > ${mb(budget)}。R10 的缓解手段是按需下载与差量升级，先看是不是有东西混进了基础包。`,
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
    message: `缺少 ${missing.join('、')}，本次产出未签名包（U4）。安装时系统会拦截，仅供内部验证。`,
  };
}

/** 产物文件名。未签名时后缀进名字。 */
export function artifactName(productName, version, platform, arch, extension, suffix = '') {
  return `${productName}-${version}-${platform}-${arch}${suffix}.${extension}`;
}

/**
 * hook 策略包的 vendor 步骤（见 `plugins/hooks/evowork-policy/bin/_runner.mjs`）。
 *
 * 打包时把 `@evowork/policy` 的构建产物放到插件目录里，运行器就不必回退到仓库路径。
 */
export const HOOK_VENDOR = Object.freeze({
  from: 'services/policy/dist/index.js',
  to: 'plugins/hooks/evowork-policy/vendor/policy.mjs',
});
