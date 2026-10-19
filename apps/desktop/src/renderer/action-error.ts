/**
 * 经 IPC 回来的拒绝被 Electron 包成这个样子，**内层还可能再套一层我们自己的错误类**：
 *   `Error invoking remote method 'evowork:interrupt': JsonRpcCallError: turn/interrupt 失败 (code -32600)`
 */
const IPC_WRAPPER = /^Error invoking remote method '[^']*':\s*/;

/** 一眼就知道不是写给用户看的东西。命中任何一条就改用兜底文案。 */
const INTERNAL_MARKERS: readonly RegExp[] = [
  /Error invoking remote method/,
  /\w+Error:/, // JsonRpcCallError / TransportClosedError / TypeError…
  /\bcode -?\d{3,}\b/, // 裸 JSON-RPC 错误码
  /\n\s*at\s/, // 堆栈
];

/**
 * 动作失败时**给用户看的那句话**。
 *
 * `error.message` 不能原样显示。2026-09-27 的用户截图里，点「停止」失败之后弹出来的是
 * `Error invoking remote method 'evowork:interrupt': JsonRpcCallError: turn/interrupt 失败 (code -32600)`
 * —— 它同时泄漏了内部通道名、内部错误类和裸错误码，而对用户没有任何可操作信息。
 * 此前的实现是「有 message 就显示 message」，于是调用方精心写的兜底文案几乎永远轮不到。
 *
 * 规则：先剥掉 Electron 的包装；剩下的部分还带内部痕迹的话，就用**调用方为这个动作写的
 * 兜底文案** —— 那是为这次失败写的人话，比任何通用改写都准。
 *
 * **不碰回合失败卡**：那条路（`turn-failed` 的 summary）是 03 §8 的明确决定 ——
 * 把内核给的原因原样显示，因为 `connection refused` 与 `401` 对用户是不同的两件事。
 * 两者的区别是：那边显示的是**内核写的原因**，这边泄漏的是**传输层的包装**。
 */
export function actionErrorText(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message.trim() : '';
  if (raw === '') return fallback;
  const unwrapped = raw.replace(IPC_WRAPPER, '').trim();
  if (unwrapped === '') return fallback;
  if (INTERNAL_MARKERS.some((re) => re.test(unwrapped))) return fallback;
  return unwrapped;
}
