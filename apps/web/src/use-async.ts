/**
 * 「载入中 / 出错 / 有数据」三态的加载钩子。
 *
 * 写成一个钩子而不是每处 `useEffect + setState`，是因为散着写的时候
 * **失败会被静默吞掉**：管理端原先六个请求里有四个 `if (out.ok) setX(...)`，
 * 失败那一支什么也不做，于是表格就是空的 —— 而"空"和"没加载出来"
 * 在界面上长得一模一样，管理员分不出是没人，还是服务挂了。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { ApiResult } from './api.js';
import type { AsyncState } from './components.js';

export function useAsync<T>(
  load: () => Promise<ApiResult<T>>,
  deps: readonly unknown[] = [],
): { state: AsyncState<T>; reload: () => void; set: (data: T) => void } {
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading' });
  const alive = useRef(true);
  // 依赖数组按值展开给 useCallback；load 本身每次渲染都是新函数，不能进依赖
  const ref = useRef(load);
  ref.current = load;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = useCallback(() => {
    setState({ status: 'loading' });
    void ref.current().then((out) => {
      if (!alive.current) return;
      setState(
        out.ok
          ? { status: 'ready', data: out.data }
          : { status: 'error', message: out.error.message },
      );
    });
    // deps 由调用方给（`useAsync(load, [blocked])`），刻意不做静态依赖校验
  }, deps);

  useEffect(run, [run]);

  const set = useCallback((data: T) => setState({ status: 'ready', data }), []);
  return { state, reload: run, set };
}

/**
 * 「这个动作正在提交吗」。
 *
 * 每个会写数据的按钮都要用它：不禁用的话点三次就是三次签发，
 * 而签发策略包是不可重复的动作。
 */
export function useAction(): {
  busy: boolean;
  error: string | undefined;
  run: (fn: () => Promise<ApiResult<unknown>>, onOk?: () => void) => Promise<boolean>;
  clearError: () => void;
} {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const run = useCallback(async (fn: () => Promise<ApiResult<unknown>>, onOk?: () => void) => {
    setBusy(true);
    setError(undefined);
    const out = await fn();
    setBusy(false);
    if (!out.ok) {
      setError(out.error.message);
      return false;
    }
    onOk?.();
    return true;
  }, []);

  return { busy, error, run, clearError: () => setError(undefined) };
}
