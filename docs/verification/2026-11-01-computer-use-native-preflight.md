# 微信、TextEdit、WPS/Office 原生 AX/TCC 验收前置

日期：2026-11-01（Asia/Taipei）。版本保持 0.0.8，未发布或替换原安装。

**结论：原生 AX/TCC 验收仍然阻塞，实际 AX 读写动作完成数为 0。**
本轮没有使用假 Helper，也没有放宽生产签名或调用方校验；完成的是实际机器上的签名/TCC 前置探测与未授权读取拒绝测试。

## 本机实测

| 项目 | 实际结果 | 意义 |
| --- | --- | --- |
| 本机代码签名身份 | `security find-identity -v -p codesigning` 返回 **0** | 尚不能生成同 Team ID 的正式签名宿主与 Helper |
| 待测桌面宿主 | `com.evowork.desktop`，没有可用 Team ID，未通过 Apple 信任链条件 | 不能通过 Helper 的父进程身份验证 |
| 原生 Helper | 当前开发产物没有正式 Team ID；SHA256 与上一轮冻结的原生二进制一致 | 未修改或绕过 `trustedCaller()` |
| Helper 辅助功能 TCC | `accessibility=false` | 尚不能读取/操作原生 AX |
| Helper 屏幕录制 TCC | `screenRecording=true` | 只说明本次只读预检返回已授权，不证明截图或撤权恢复通过 |
| 微信 4.2.0 | 静态签名链/严格验证通过；生产函数对运行进程判定 ordinary | 未读取聊天、未发送消息 |
| TextEdit 1.21 | 已安装，静态签名链/严格验证通过 | 未激活、未读取/修改文档 |
| WPS 12.1.29182 | 静态签名链/严格验证通过；生产函数对运行进程判定 ordinary | 未读取/修改办公文件 |
| Microsoft Word/Excel/PowerPoint | 标准系统安装目录未发现 | 本轮不能验证 Microsoft Office 的真实控件 |
| 非受信宿主请求三种 App 的 `get_app_state` | 三次均返回 `POLICY_DENIED` | 真实原生进程在读取 AX 前拒绝；不能把拒绝测试算作应用交互通过 |
| 发布标记 | `releaseVerified=false` | 保持关闭 |

原始证据：[前置报告](assets/2026-11-01-computer-use-native-preflight/preflight.json)、[控制台结果](assets/2026-11-01-computer-use-native-preflight/preflight.log.txt)、[生产进程身份探针](assets/2026-11-01-computer-use-native-preflight/running-app-identities.json)。报告不包含聊天、文档、AX 正文或截图。

新增 `scripts/verify-computer-use-preflight.mjs`，对环境阻塞与安全断言失败使用不同退出码；即使前置全部就绪也只返回 ready，始终保留 `nativeAcceptanceCompleted=false`。审查覆盖缺证书、ad-hoc、不同团队、错误宿主 ID、异常/缺失拒绝证据、health 字段与版本错误、目标 App 签名错配、缺 TCC 和截断/拼接帧，共 6 项确定性测试通过。前置探针首轮把 codesign requirement 文本当成文件名而误判目标签名，改用 `=anchor apple generic` 的内联语法后，三个真实目标静态签名验证通过；不把该探针错误记成应用缺陷。

完整 `pnpm run check` 退出 0，**3489 通过、2 项既有跳过**，216 个测试文件通过、1 既有跳过；格式、lint、类型、K1/K2 与许可检查均通过，见[完整日志](assets/2026-11-01-computer-use-native-preflight/check.log.txt)。使用已有办公运行时与 Vitest 并发 2，未增加超时或新增跳过。

## 恢复验收的步骤

1. 证书申请完成后，将 **Developer ID Application 证书及匹配私钥**导入这台 Mac 的钥匙串；不在聊天中发送证书密码。重新核对可用身份。
2. 使用同一 Team ID 对待测 EvoWork 桌面包与其 Helper 正式签名，核对 Helper 的 signing identifier 为 `com.evowork.desktop.computer-use`。签名使用现有打包链路；签名完成并不等于公证或原生验收通过。
3. 在正式签名包的实际权限主体上，由用户通过系统设置完成辅助功能授权；签名变化后重新检查录屏权限。当前开发产物的录屏状态不能移作正式签名包的授权凭据。
4. 用待测产物路径复跑前置探针，前置就绪后继续下表；仍保留发布闸门，不能手工改为通过来启动测试。

```sh
node scripts/verify-computer-use-preflight.mjs \
  --host-app='/绝对路径/EvoWork.app' \
  --helper-app='/绝对路径/EvoWork Computer Use.app' \
  --output='dist/cu-native-validation/preflight.json'
```

## 前置就绪后必须实际执行的矩阵

| 对象 | 用例及效果断言 | 当前状态 |
| --- | --- | --- |
| TextEdit | 独立临时文档：AX 读取 → 文本框聚焦 → 编辑 → 重读；过期/窗口变化后旧 state_id 拒绝；不覆盖原有文件 | 阻塞，未执行 |
| WPS/Office | 专用临时文字/表格/演示文稿：识别可编辑控件、聚焦/编辑/重读；保存/覆盖/分享逐次确认，拒绝后文件不变 | 阻塞，未执行；Microsoft Office 还需安装待测版本 |
| 微信 | 专用验收会话与接收人：读取、核对已有草稿、聚焦；敏感发送拒绝后零发送，明确确认后仅一次并重读 | 阻塞，未执行；真实发送前需指定专用验收接收人与消息内容 |
| TCC 拒绝/授权 | 首次不授权应失败关闭；授权后可读；分别测 AX-only 与截图 | 阻塞，未执行 |
| TCC 撤销/恢复/升级 | 运行中撤销辅助功能和录屏，工具注销、在途动作停；重新授权/重启恢复；升级后重验 | 阻塞，未执行；系统授权/撤权需要用户在设置中完成 |
| 中断与状态 | Esc/停止控制/物理输入/锁屏/焦点及窗口变化；P95 < 500ms、无悬挂按键/鼠标 | 阻塞，未执行 |
| 九类原生动作与剪贴板 | 元素/坐标点击、set_value、secondary action、按键、纯文本粘贴、type_text、选区、滚动、拖拽；异常/崩溃后剪贴板不覆盖用户新内容 | 阻塞，未执行 |

本轮结果只增加对真实环境的证据，不关闭设计 12 的 CU-R1–R4、R7、R8 或 R11/R12。上一轮真实模型和 Chrome 的通过结论保持原有边界，不能替代此矩阵。
