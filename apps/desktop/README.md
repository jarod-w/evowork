# apps/desktop —— 桌面壳与三栏 UI（L4）

| 项       | 值                                                                                                                                                                                                                                                    |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 里程碑   | M2 前端 MVP（10 人周）                                                                                                                                                                                                                                |
| 设计     | [01 UI 设计系统](../../docs/design/01-ui-design-system.md) · [02 信息架构](../../docs/design/02-information-architecture.md) · [03 首页与输入区](../../docs/design/03-home-and-composer.md) · [04 任务工作台](../../docs/design/04-task-workspace.md) |
| 技术选型 | **Electron**（Q23）+ **React + TypeScript + Vite**（Q24），32 个组件全自建、token 驱动、不引 UI 库                                                                                                                                                    |

Q1=A 之后它同时是**本机服务的宿主**：`services/*` 的五个本机模块跑在 Electron 主进程里（09 §1
的决策：不单独拆进程 —— 五个服务的状态加起来就是一个 sqlite 加几个 watcher，拆进程要多付
IPC、崩溃恢复、双向同步三份复杂度，收益为零）。

**两条硬纪律**：

1. **只说 app-server JSON-RPC v2**（K2）。渲染层不直连协议，一律经 `services/kernel-adapter`
   的语义化 API —— 前端直连实验方法是破 K2 最常见的方式（Q27 单列 M2a 就是为了防这件事）。
2. **零字面量样式**（01 §9 验收项 1）。颜色与 px 一律走 token；`eslint` 里的
   `@evowork/no-style-literals` 会拦。第 33 个组件出现前先补进 01 §5。

---

## 目录导览

```
src/
  main/
    service-host.ts   本机服务宿主：先开库 → 起内核 → 对账（09 §1 / §4）
    bootstrap.ts      Electron 引导。**electron 是注入的**，见文件头注释
  preload/
    index.ts          渲染进程与主进程之间唯一的通道；暴露面被测试钉住
  renderer/
    app.tsx           外壳：首页 ↔ 任务页（只有两个页面，不需要 router）
    views/
      home.tsx            首页：Hero · 场景 · chips · Composer · 案例位（03）
      task-workspace.tsx  三栏工作台（04）
      sidebar.tsx         任务列表 · 六组筛选 · 行操作（04 §3）
    components/
      composer.tsx        首页与任务页**共用**的输入区（03 §4）
      menu.tsx            Menu / Popover / InlineSelect / ModelSelect
      item-renderers.tsx  19 类 ThreadItem（F13）
      approval-card.tsx   四类审批卡（10 §3）
      changes-view.tsx    结果区「变更」（04 §6.3）
      primitives.tsx      01 §5 的基础件
    styles/app.css    只允许 var(--token)，由 test/styles.test.ts 守着
```

## 这一层里"改错了不会立刻报错"的几处

它们都各自配了测试，改动前先看那条测试在断言什么：

| 位置                                | 约束                                        | 改错的表现                             |
| ----------------------------------- | ------------------------------------------- | -------------------------------------- |
| `bootstrap.ts` 的 `WINDOW_SECURITY` | 五项安全参数（R5）                          | 没有任何开发期症状，只在被注入那天出事 |
| `composer.tsx` 的 `detectTrigger`   | `/` 只在行首触发                            | `~/work/a.md` 里的斜杠弹出技能菜单     |
| `composer.tsx` 的 Ask 联动          | 切回 Craft 恢复**上一次**的权限，不是默认值 | 用户每次进出 Ask 都要重选权限          |
| `sidebar.tsx` 的 `onVisibleChange`  | 只报可见页（04 §3.4 第②步）                 | "筛出 800 条"变成 800 个 `thread/read` |
| `changes-view.tsx` 的 `REVERT_COPY` | 撤销动磁盘、回滚不动                        | 两句文案拼反 → 用户丢文件              |
| `app.tsx` 的 `mergeItem`            | 同 id 覆盖且**保持原位置**                  | 流式更新时消息跳到列表末尾             |

## 还没做的

- **Visualizer**（mermaid / evowork-chart / 沙箱 iframe）：按 §8 属 **M8**，不在 M2 范围。
- **`electron` 依赖与打包**：`bootstrap.ts` 只差一个十行的入口（`import { app, BrowserWindow }`），
  依赖与签名公证属 **M9**（且 P0-5 的证书是外部依赖）。
- 语音输入（03 §4.7）、`@` 候选的真实数据源接线、虚拟滚动。
