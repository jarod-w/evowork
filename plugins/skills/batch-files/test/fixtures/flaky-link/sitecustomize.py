"""测试夹具：在第 N 次 `os.link` 上制造故障（不随产品逻辑生效，只在放上 PYTHONPATH 时起作用）。

放在 `PYTHONPATH` 上时，python 启动阶段的 `site` 会自动 import 这个模块。
用环境变量按调用序号（从 1 数）点名，两种故障：

  · ``EVOWORK_TEST_LINK_FAIL=2,3``  第 2、3 次 link 抛 PermissionError（EACCES）——
    「执行到一半出错」与「撤回时又出错」；
  · ``EVOWORK_TEST_LINK_RACE=1``    第 1 次 link 之前，「别的程序」先在目标位置写下 ``intruder`` ——
    检查与动手之间目标被抢占。

## 为什么在 link 上动手

batch-files 每一次落盘（移动、写出 PDF、写出合并表、撤回一次移动）最后都是一次 `os.link`，
那正是「不覆盖」靠的原语。故障放在这里，测的就是真实的执行与撤回路径，
而不是在产品代码里留一个只给测试用的开关。
"""

import errno
import os


def _indices(name):
    return {int(item) for item in os.environ.get(name, "").split(",") if item.strip()}


_FAIL = _indices("EVOWORK_TEST_LINK_FAIL")
_RACE = _indices("EVOWORK_TEST_LINK_RACE")
_real_link = os.link
_calls = 0


def _link(src, dst, *args, **kwargs):
    global _calls
    _calls += 1
    if _calls in _FAIL:
        raise PermissionError(errno.EACCES, "injected by test fixture")
    if _calls in _RACE:
        with open(dst, "x", encoding="utf-8") as handle:
            handle.write("intruder")
    return _real_link(src, dst, *args, **kwargs)


if _FAIL or _RACE:
    os.link = _link
    # 让被测代码走与平时相同的分支（它按这张表决定传不传 follow_symlinks）
    if _real_link in os.supports_follow_symlinks:
        os.supports_follow_symlinks.add(_link)
