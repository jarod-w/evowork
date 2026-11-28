/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 可选：企业版预约表单的提交地址（支持 Webhook 或后端 API）。留空时以本地预览回执模式运行。 */
  readonly VITE_LEAD_ENDPOINT?: string;
  /** 可选：覆写企业联系兜底邮箱。 */
  readonly VITE_CONTACT_EMAIL?: string;
  /** 可选：设为 "false" 可在发布已签名 macOS 安装包后关闭未签名 xattr 引导卡。 */
  readonly VITE_SHOW_MAC_UNSIGNED_GUIDE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
