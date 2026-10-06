/** 内核有效 requirements 与本机 requirements 分层合并；allow 不代表用户已准入。 */
export interface ComputerUseRequirementsPolicy {
  enabled: boolean;
  persistentAllowed: boolean;
  appAccess: Record<string, 'allow' | 'deny'>;
  defaultAccess?: 'allow' | 'deny';
}
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('INVALID_POLICY');
  return value as Record<string, unknown>;
};
export function mergeComputerUseRequirements(...layers: unknown[]): ComputerUseRequirementsPolicy {
  const result: ComputerUseRequirementsPolicy = {
    enabled: true,
    persistentAllowed: true,
    appAccess: Object.create(null) as Record<string, 'allow' | 'deny'>,
  };
  const appLayers: { access?: 'allow' | 'deny'; ids: Record<string, 'allow' | 'deny'> }[] = [];
  try {
    for (const layer of layers) {
      if (layer === null) continue;
      const root = record(layer);
      const field = (obj: Record<string, unknown>, camel: string, snake: string) => {
        if (Object.hasOwn(obj, camel) && Object.hasOwn(obj, snake))
          throw new Error('AMBIGUOUS_POLICY');
        return obj[camel] ?? obj[snake];
      };
      const global = field(root, 'allowBrowserAndComputerUse', 'allow_browser_and_computer_use');
      if (global !== undefined && global !== null) {
        if (typeof global !== 'boolean') throw new Error('INVALID_POLICY');
        result.enabled &&= global;
      }
      const raw = field(root, 'computerUse', 'computer_use');
      if (raw === undefined || raw === null) continue;
      const cu = record(raw);
      if (
        Object.keys(cu).some(
          (key) =>
            ![
              'allowPersistentApproval',
              'allow_persistent_approval',
              'defaultAppAccess',
              'default_app_access',
              'allowLockedComputerUse',
              'allow_locked_computer_use',
              'macos',
              'windows',
            ].includes(key),
        )
      )
        throw new Error('UNKNOWN_COMPUTER_USE_POLICY');
      const persistent = field(cu, 'allowPersistentApproval', 'allow_persistent_approval');
      if (persistent !== undefined && persistent !== null) {
        if (typeof persistent !== 'boolean') throw new Error('INVALID_POLICY');
        result.persistentAllowed &&= persistent;
      }
      const apps: (typeof appLayers)[number] = {
        ids: Object.create(null) as Record<string, 'allow' | 'deny'>,
      };
      appLayers.push(apps);
      const access = field(cu, 'defaultAppAccess', 'default_app_access');
      if (access !== undefined && access !== null) {
        if (access !== 'allow' && access !== 'deny') throw new Error('INVALID_POLICY');
        apps.access = access;
        if (result.defaultAccess !== 'deny') result.defaultAccess = access;
      }
      if (cu.macos === undefined || cu.macos === null) continue;
      const macos = record(cu.macos);
      if (Object.keys(macos).some((key) => !['bundleIds', 'bundle_ids'].includes(key)))
        throw new Error('UNKNOWN_MACOS_POLICY');
      const ids = field(macos, 'bundleIds', 'bundle_ids');
      if (ids === undefined || ids === null) continue;
      for (const [id, decision] of Object.entries(record(ids))) {
        if (!id || (decision !== 'allow' && decision !== 'deny')) throw new Error('INVALID_POLICY');
        const key = id.toLowerCase();
        if (apps.ids[key] !== 'deny') apps.ids[key] = decision;
      }
    }
    for (const app of new Set(appLayers.flatMap((layer) => Object.keys(layer.ids)))) {
      const decisions = appLayers.map((layer) => layer.ids[app] ?? layer.access);
      result.appAccess[app] = decisions.includes('deny') ? 'deny' : 'allow';
    }
    return result;
  } catch {
    return { enabled: false, persistentAllowed: false, appAccess: {} };
  }
}

/** 单层应用 allow 覆盖本层默认 deny；仍不能覆盖其它层 deny。 */
export function computerUseEnterpriseAccess(
  policy: ComputerUseRequirementsPolicy,
  app: string,
): 'allow' | 'deny' | undefined {
  if (!policy.enabled) return 'deny';
  return policy.appAccess[app.toLowerCase()] ?? policy.defaultAccess;
}
