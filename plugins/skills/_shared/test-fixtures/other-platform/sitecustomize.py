"""强制"不是 macOS"的环境（测试夹具，不随产品分发）。

放在 `PYTHONPATH` 上时，python 启动阶段的 `site` 会自动 import 这个模块，
它把 `sys.platform` 改成 `linux` —— 技能代码判平台只看这一个值。

## 为什么需要它

PDF 转换只在 macOS 上有隔离手段（seatbelt），其他平台必须**拒绝、不裸跑转换器**
（documents/render.py 的 `_convert_isolated`）。只用 `runIf(!onMac)` 的话，
这条拒绝路径在我们的开发机上永远没人验 —— 而它是 Windows / Linux 用户第一次导出 PDF 时走的。

改的时机足够早：`site` 在执行技能脚本之前就 import 了它，脚本读到的已经是改过的值。
"""

import sys

sys.platform = "linux"
