"""强制"没装办公扩展"的环境（测试夹具，不随产品分发）。

放在 `PYTHONPATH` 上时，python 启动阶段的 `site` 会自动 import 这个模块，
它把办公扩展的那几个模块**变得和真的没装一模一样**：探测说没有、真去 import 也失败。

## 为什么需要它

`ensure_office_runtime` 的第一步是"当前解释器里缺不缺这些模块"，不缺就直接返回。
而开发机的用户级 site-packages 里往往早就有 python-docx / openpyxl / matplotlib
（被别的项目装进去的）—— 于是"没装办公扩展"那条路径在这些机器上根本走不到，
测试渲染成功、退出码 0。

## 为什么也挡 `jsonschema`

它和文档库一样**只随办公扩展安装**（`services/runtime-installer/src/manifest.ts`）。
2026-10-03 之前这里刻意**不**挡它，理由是「它属于基础包」—— 那是错的，后果有两个：
测试要求跑测试的那个 `python3` 恰好装着 jsonschema（这台机器没有就红）；
而产品里同样的情形会给用户一句「请重新安装解析组件」，指向一个没坏的东西。
现在「没装扩展」就是扩展提供的**所有**模块都不在，与用户机器上的真实情形一致，
也不再看本机 python 的脸色。

## 为什么不用 PYTHONNOUSERSITE=1

它只挡用户级 site-packages，挡不住系统级（发行版的 `python3-docx` 之类），
而且会连带挡掉与扩展无关的包 —— 挡的范围要精确到模块名。

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

#: 办公扩展提供的模块（08 §4 + 内容校验用的 jsonschema）。**只挡这些**。
BLOCKED = frozenset({"docx", "openpyxl", "pptx", "matplotlib", "jsonschema"})


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
