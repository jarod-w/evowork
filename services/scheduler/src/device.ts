/**
 * 设备绑定与迁移（Q15 / 总纲 §6.9 最后一段）。
 *
 * ## 迁移时必须重置 misfire 基准
 *
 * 这是 Q15 里最容易漏、后果最直观的一条：把一个 automation 迁到新设备时，
 * 如果不把 misfire 基准重置为**迁移时刻**，新设备一上线就会按 `catchup_window`
 * 扫出一堆历史触发并补跑 —— 用户刚点完「迁移到本机」，就收到 8 条执行通知。
 *
 * ## 三条硬规则
 *
 * 1. 迁移是**排他**操作：用云端那份定义做乐观锁，避免两台设备同时认领。
 * 2. 工作空间路径在新设备上不存在时，**迁移必须失败**并要求用户重选目录，
 *    不得静默改路径 —— 静默改会让任务在错误的目录里跑起来。
 * 3. 非绑定设备**只读**：能看见、能编辑定义吗？不能触发。离线超 7 天提示迁移。
 */

export interface AutomationBinding {
  readonly automationId: string;
  readonly deviceId: string;
  readonly workspaces: readonly string[];
  readonly lastFireTime?: number | undefined;
  /** 乐观锁：云端那份定义的版本 */
  readonly revision: number;
}

export interface MigrationRequest {
  readonly binding: AutomationBinding;
  readonly targetDeviceId: string;
  /** 迁移时刻 —— 会成为新的 misfire 基准 */
  readonly at: number;
  /** 目标设备上这些工作空间在不在 */
  readonly workspaceExists: (path: string) => boolean;
  /** 云端当前的 revision；与 binding.revision 不等说明别人先动了 */
  readonly remoteRevision: number;
}

export type MigrationResult =
  | {
      readonly ok: true;
      readonly deviceId: string;
      /** **重置后的 misfire 基准** = 迁移时刻 */
      readonly lastFireTime: number;
      readonly revision: number;
    }
  | { readonly ok: false; readonly code: MigrationFailure; readonly message: string };

export type MigrationFailure = 'ALREADY_HERE' | 'CONFLICT' | 'WORKSPACE_MISSING';

export function migrate(request: MigrationRequest): MigrationResult {
  if (request.binding.deviceId === request.targetDeviceId) {
    return { ok: false, code: 'ALREADY_HERE', message: '这个自动化已经绑定在这台电脑上了。' };
  }
  if (request.binding.revision !== request.remoteRevision) {
    return {
      ok: false,
      code: 'CONFLICT',
      message: '另一台电脑刚刚也在认领这个自动化。刷新一下再试。',
    };
  }

  const missing = request.binding.workspaces.filter((path) => !request.workspaceExists(path));
  if (missing.length > 0) {
    // **不静默改路径**：在错误的目录里跑起来比不跑糟得多
    return {
      ok: false,
      code: 'WORKSPACE_MISSING',
      message:
        `这台电脑上找不到这些目录：${missing.join('、')}。` +
        '请为它重新选择工作空间之后再迁移 —— 我不会替你换一个目录。',
    };
  }

  return {
    ok: true,
    deviceId: request.targetDeviceId,
    // 见文件头：不重置的话新设备一上线就补一堆历史触发
    lastFireTime: request.at,
    revision: request.remoteRevision + 1,
  };
}

/** 离线超过这么久就提示迁移（Q15）。 */
export const OFFLINE_HINT_MS = 7 * 24 * 60 * 60 * 1000;

export function shouldSuggestMigration(input: {
  readonly boundDeviceLastSeen: number;
  readonly now: number;
  readonly isBoundDevice: boolean;
}): boolean {
  if (input.isBoundDevice) return false;
  return input.now - input.boundDeviceLastSeen > OFFLINE_HINT_MS;
}

/** 创建时固定的一行说明（07 §4.1）。 */
export function bindingNotice(deviceName: string): string {
  return `将在这台电脑（${deviceName}）上执行。其他电脑上可以看到它，但不会重复执行。`;
}

/** 关机/休眠的预期管理（07 §4.2）：**配置时**就要说，不能只在事后解释。 */
export const OFFLINE_EXPECTATION_NOTICE =
  '定时任务在这台电脑上运行。电脑关机或睡眠时不会执行，重新开机后按「错过补偿」的设置处理。';
