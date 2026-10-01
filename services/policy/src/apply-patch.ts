/**
 * apply_patch 的**删除**与**整篇覆盖**（2026-10-01，外部验收 D1-2 真模型复测后用户决定，10 §2.4）。
 *
 * 内核补丁 P6 让 shell 的 `>` 覆盖已有文件要审批，但真模型改文件最常走的是 apply_patch ——
 * 原生 `apply_patch` 工具，或 `exec_command` 里的 `apply_patch <<'PATCH' … PATCH`（内核截下来按补丁应用）。
 * 工作空间内的 apply_patch 不问，于是 deepseek-flash 四轮里三轮用它改掉了文件；其中一轮是
 * `printf >` 被 P6 拦下、**用户拒绝之后**，换成 Delete File + Add File 把文件删了重建。
 *
 * hook 只能放行或拒绝、发不起询问（`permissionDecision: ask` 不被支持），所以这里**拒绝并指路**：
 * 删除改用 `rm`（execpolicy 的 prompt 规则会弹审批），整篇覆盖改用 shell 重定向（P6 会弹审批）。
 * 拒绝本身是确定的：文件不会被这条路改掉。模型照着指路走，用户就看到审批卡；不照着走，什么也没发生。
 *
 * 「整篇覆盖」与 P6 的口径一致：原内容一行不留。局部修改（带上下文、只动其中几行）照旧不问 ——
 * 「请求批准」的定义是工作空间内编辑不问（10 §2.4 的表），这里不改它。
 */

/** apply_patch 里对一个文件的一个动作。 */
export interface PatchFileOp {
  readonly kind: 'add' | 'delete' | 'update';
  readonly path: string;
  /** update：被删掉的非空行数（`-` 行） */
  readonly removed: number;
  /** update：保留下来的非空上下文行数（` ` 行） */
  readonly kept: number;
}

const FILE_HEADER = /^\*\*\* (Add|Delete|Update) File: (.+)$/;

/**
 * 认出 apply_patch 并拆成逐文件动作；不是 apply_patch 返回 `undefined`。
 *
 * shell 命令要同时含 `apply_patch`（或 `applypatch`）与 `*** Begin Patch` 才算 —— 内核只截这种调用，
 * 一条只是把补丁文本 `cat` 出来的命令不会改任何文件。
 */
export function parseApplyPatch(
  toolName: string,
  command: string | undefined,
): readonly PatchFileOp[] | undefined {
  if (command === undefined || !command.includes('*** Begin Patch')) return undefined;
  if (toolName !== 'apply_patch' && !/\bapply_?patch\b/.test(command)) return undefined;

  const ops: PatchFileOp[] = [];
  let current: { kind: PatchFileOp['kind']; path: string; removed: number; kept: number } | null =
    null;
  const flush = () => {
    if (current) ops.push({ ...current });
    current = null;
  };
  let inside = false;
  for (const line of command.split(/\r?\n/)) {
    if (line.trim() === '*** Begin Patch') {
      inside = true;
      continue;
    }
    if (!inside) continue;
    if (line.trim() === '*** End Patch') {
      flush();
      inside = false;
      continue;
    }
    const header = FILE_HEADER.exec(line);
    if (header) {
      flush();
      const kind = header[1] === 'Add' ? 'add' : header[1] === 'Delete' ? 'delete' : 'update';
      current = { kind, path: (header[2] ?? '').trim(), removed: 0, kept: 0 };
      continue;
    }
    if (current?.kind !== 'update') continue;
    if (line.startsWith('-') && line.slice(1).trim() !== '') current.removed += 1;
    else if (line.startsWith(' ') && line.slice(1).trim() !== '') current.kept += 1;
  }
  flush();
  return ops;
}

/** 这次 update 会不会把原文件一行不留地换掉。原文件没有非空行时不算（没东西可丢）。 */
export function replacesWholeFile(op: PatchFileOp, original: string): boolean {
  if (op.kind !== 'update') return false;
  const lines = original.split(/\r?\n/).filter((line) => line.trim() !== '').length;
  return lines > 0 && op.kept === 0 && op.removed >= lines;
}

/** 给模型看的拒绝理由：说清为什么、该怎么做，以及用户拒绝时不要再做。 */
export function deletePatchReason(path: string): string {
  return (
    `POLICY：不要用 apply_patch 删除文件（${path}）。删除请用 rm 命令 —— 它会先征求用户同意；` +
    '用户拒绝的话，就不要删，也不要换别的办法删。'
  );
}

export function overwritePatchReason(path: string): string {
  return (
    `POLICY：这次 apply_patch 会把已有文件 ${path} 的内容整个换掉，等于覆盖。` +
    `覆盖已有文件请用 shell 重定向（如 printf '…' > ${path}）—— 它会先征求用户同意；` +
    '只改其中几处请用带上下文的局部修改。用户拒绝覆盖的话，就不要再改这个文件。'
  );
}
