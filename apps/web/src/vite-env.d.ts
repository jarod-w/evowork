/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_IDENTITY_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
