import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'smol-toml';
import { mergeComputerUseRequirements } from '@evowork/policy';

/** 同一读取器供设置准入与每次工具调用使用；企业只读状态优先于旧 allow。 */
export function createComputerUsePolicyReader(options: {
  requirementsPath: string;
  readManaged: () => Promise<unknown>;
  readOnly: () => boolean;
}) {
  return async () => {
    try {
      if (options.readOnly()) return mergeComputerUseRequirements(undefined);
      const managed = await options.readManaged();
      const local = existsSync(options.requirementsPath)
        ? parse(readFileSync(options.requirementsPath, 'utf8'))
        : {};
      if (options.readOnly()) return mergeComputerUseRequirements(undefined);
      return mergeComputerUseRequirements(managed, local);
    } catch {
      return mergeComputerUseRequirements(undefined);
    }
  };
}
