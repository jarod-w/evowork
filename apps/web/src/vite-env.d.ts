/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_IDENTITY_ORIGIN?: string;
  /** 分享托管服务的地址。生产里分享页与它同源，这个变量留空即可。 */
  readonly VITE_SHARE_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
