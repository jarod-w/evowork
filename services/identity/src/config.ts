/**
 * identity 进程配置。**不是**桌面 `app.toml`，也不是内核 `config.toml`（11 §13.8）。
 */
export interface BootstrapConfig {
  readonly email?: string | undefined;
  readonly phone?: string | undefined;
  readonly password?: string | undefined;
  readonly tenantName: string;
}

export interface IdentityConfig {
  readonly bootstrap: BootstrapConfig;
  readonly masterKey: Buffer;
  readonly publicOrigin: string;
  readonly argon: import('./password.js').ArgonParams;
}

export function bootstrapFromEnv(env: NodeJS.ProcessEnv): BootstrapConfig {
  return {
    ...(env.EVOWORK_BOOTSTRAP_ADMIN_EMAIL
      ? { email: env.EVOWORK_BOOTSTRAP_ADMIN_EMAIL.trim() }
      : {}),
    ...(env.EVOWORK_BOOTSTRAP_ADMIN_PHONE
      ? { phone: env.EVOWORK_BOOTSTRAP_ADMIN_PHONE.trim() }
      : {}),
    ...(env.EVOWORK_BOOTSTRAP_ADMIN_PASSWORD
      ? { password: env.EVOWORK_BOOTSTRAP_ADMIN_PASSWORD }
      : {}),
    tenantName: env.EVOWORK_BOOTSTRAP_TENANT_NAME?.trim() || 'default',
  };
}
