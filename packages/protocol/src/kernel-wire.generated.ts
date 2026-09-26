// 由 `node scripts/kernel-contract.mjs --write` 从内核源码生成，**不要手改**。
//
// 它的作用不是被谁 import，而是让 `tsc` 证明：我们手写的协议类型
// 接受内核**真实发出**的那些形状。改内核签出后重新生成即可。
//
// 内核签出：d583e73c4d12

import type {
  PatchChangeKind,
  ThreadItem,
  ThreadStatus,
  TurnStatus,
} from './types.js';

/** 从一个内部标签联合里取出它的判别式取值。我们没用联合时它是 `never`。 */
type Discriminant<T> = T extends { readonly type: infer K } ? K : never;

/** 内核 `ThreadStatus`：内部标签联合，判别键 `type`。 */
export const THREAD_STATUS_VARIANTS: Discriminant<ThreadStatus>[] = ['notLoaded', 'idle', 'systemError', 'active'];

/** 内核 `TurnStatus`：外部标签的单元枚举，线上是裸字符串。 */
export const TURN_STATUS_VARIANTS: TurnStatus[] = ['completed', 'interrupted', 'failed', 'inProgress'];

/** 内核 `PatchChangeKind`：内部标签联合，判别键 `type`。 */
export const PATCH_CHANGE_KIND_VARIANTS: Discriminant<PatchChangeKind>[] = ['add', 'delete', 'update'];

/** 内核 `ThreadItem`：内部标签联合，判别键 `type`。 */
export const THREAD_ITEM_VARIANTS: Discriminant<ThreadItem>[] = ['userMessage', 'hookPrompt', 'agentMessage', 'functionCallOutput', 'plan', 'reasoning', 'commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall', 'subAgentActivity', 'webSearch', 'imageView', 'sleep', 'imageGeneration', 'enteredReviewMode', 'exitedReviewMode', 'contextCompaction'];
