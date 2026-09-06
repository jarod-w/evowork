"""强制"没装办公扩展"的环境（测试夹具，不随产品分发）。

放在 `PYTHONPATH` 上时，python 启动阶段的 `site` 会自动 import 这个模块，
它把办公扩展的那几个模块**变得和真的没装一模一样**：探测说没有、真去 import 也失败。

## 为什么需要它

`ensure_office_runtime` 的第一步是"当前解释器里缺不缺这些模块"，不缺就直接返回。
而开发机的用户级 site-packages 里往往早就有 python-docx / openpyxl / matplotlib
（被别的项目装进去的）—— 于是"没装办公扩展"那条路径在这些机器上根本走不到，
测试渲染成功、退出码 0。

## 为什么不用 PYTHONNOUSERSITE=1

它一刀切掉整个用户级 site-packages，**连 `jsonschema` 一起挡掉**了 ——
于是脚本走进"校验库缺失"的分支，退出码同样是 3，但文案完全不同。
两种缺失是两件事（一个要装办公扩展，一个是 EvoWork 自己的解析组件坏了），
测试要能区分它们，挡的范围就必须精确到模块名。

## 为什么要动两个地方

"没装"在 python 里有两种可观察形式，技能代码两种都会用到：

  · `importlib.util.find_spec("docx")` 返回 `None`  —— `ensure_office_runtime` 的探测；
  · `import docx` 抛 `ModuleNotFoundError`          —— 真正去用它的时候。

只做后者的话，`find_spec` 会**把异常原样抛出去**（它不吞 finder 的异常），
表现是一条 traceback + 退出码 1，而不是我们要的可操作提示 + 退出码 3。
所以两处都要：`find_spec` 被替换成短路版本（先返回 None，根本走不到 meta_path），
meta_path 上的 finder 则只会被真正的 import 触发。
"""

import importlib.util
import sys
from importlib.abc import MetaPathFinder

#: 办公扩展提供的模块（08 §4）。**只挡这些**。
BLOCKED = frozenset({"docx", "openpyxl", "pptx", "matplotlib"})


def _is_blocked(fullname: str) -> bool:
    return fullname.split(".", 1)[0] in BLOCKED


class _BlockOfficeModules(MetaPathFinder):
    """真正的 `import docx` 走到这里 —— 抛得和没装时一样。"""

    def find_spec(self, fullname, path=None, target=None):
        if _is_blocked(fullname):
            raise ModuleNotFoundError(f"No module named {fullname!r}", name=fullname)
        return None  # 其余模块交给后面的 finder


_real_find_spec = importlib.util.find_spec


def _find_spec(name, package=None):
    """探测路径：被挡的模块直接说"没有"，不要走到会抛异常的 finder 上。"""
    if _is_blocked(name):
        return None
    return _real_find_spec(name, package)


importlib.util.find_spec = _find_spec
sys.meta_path.insert(0, _BlockOfficeModules())
