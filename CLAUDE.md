# CLAUDE.md

当前状态与未做事项见 [`docs/STATUS.md`](docs/STATUS.md)。

## Conventions

### Commit messages

Git commit messages **must be written in English**, including subject and body.

Keep the existing prefix style: `doc:`, `feat:`, `fix:`, etc.

```
doc: tighten the demo-moment-1 narrative (closes Q-29)
```

The whole history is English. The Chinese subjects that predated this convention
were rewritten on 2026-08-29 (main) and 2026-08-30 (the M2 and desktop-shell
branches, on merge).

Documents themselves (everything under `docs/`) stay in Chinese.

### 每个任务的收尾条件

- `cargo fmt --all`
- `./scripts/ci.sh` 全段绿——**不是** `cargo test -p <crate>`。曾有连续四个任务只跑单 crate 测试，攒出三个 crate 的 fmt 漂移
- 改了 `Cargo.toml` 依赖必须一并提交 `Cargo.lock`
- 一个逻辑改动一次 commit

### 绝不 `git add -A`

`apps/ui/` 的 `.gitignore` 只在桌面外壳分支上被跟踪，在别的分支上 `apps/ui/node_modules`
是未忽略的未跟踪文件。一次 `git add -A` 曾把 3781 个文件、150 万行扫进提交，
最后靠 `filter-branch` 重写 13 个 commit 才清掉。

CI-10 现在会拦住这类误提交，但它是最后一道，不是第一道。

---

## 三条不可议价的工程约定

这三条是本项目反复付出代价换来的。它们**优先于**「让测试变绿」这个目标。

### 一、新增的检查必须被证明能失败

本项目已抓到**七处**「永远不会失败的检查」：

| 检查 | 为什么永远绿 |
|---|---|
| CI-3 治理旁路 | grep 只覆盖点分写法，漏掉混合写法 |
| `verify()` | 没有 checkpoint 时返回成功 |
| `eval/run.sh` | 从不读快照，且哈希只打印不比较 |
| CI-9 外壳隔离 | 只匹配 `@tauri-apps/api`，而 Tauri 2 的插件包名没有一个含 `api` |
| bundle 纯度 | `grep -c "tauri-apps" dist/` —— 压缩产物不保留 npm scope，恒为 0 |
| 前端类型检查 | `tsc --noEmit` 缺 `-p`/`-b`，实际编译 0 个文件 |
| CI-3（第二次） | `grep -v evo-exec-local` 无条件写在循环体内，把该 crate 从四条检查里全免 |

**要求**：新增或修改任何检查，必须构造一个具体的违规输入，实测它会红，再恢复确认复绿。
三段输出都要留证。**答不出「什么输入能让它红」的检查，等于没有这条检查。**

两个已经骗过我们的陷阱：

- 交互式 shell 的 `grep` 是 `.gitignore`-aware 的包装，与脚本里跑的 `grep` 行为不同。
  **一律调真实的 `./scripts/ci.sh`，不要在命令行手工重现脚本里的 grep。**
- 修完之后，拿修好的检查当靶子再打一轮。两条检查这样各又抓出三条绕法。

### 二、测试要断行为，不断中间状态

澄清死循环之所以漏掉：测试断了「`pending_question` 被清空」，没断「清空之后 `decide`
真的往前走」。于是「答了问题但运行卡死」通过了全部测试。

同一个坑的三个变体，都在本仓出现过：

1. **测试断中间字段**——如上。
2. **测试把 bug 当成期望行为编码进去**——daemon 里真有一条，修复时它会变红，
   那正是它该有的反应，不要把它改绿。
3. **测试切在缺陷的上游**——接通污点闸门时**没有任何现有测试变红**，因为仅有的
   三条污点断言都是把 `Tainted` 直接注入 `AdmitRequest`，测的是 bug 上面那一层，
   永远红不了。

**要求**：修 bug 时，先写一条在**未修**代码上会红的测试，把红的输出留证，再修。
「我加了测试且它绿」不算。

### 三、注释不要宣称代码做不到的事

M2 终审在一条分支上数出**十处**「注释断言了一件代码不做的事」。举两个：

- `runtime.rs` 的注释说「被拒绝的 effect 会被标成 `EffectState::Denied`」——
  这个机制不存在，于是 `resume()` 把它当成已批准直接执行（红线 1 破口）。
- `reduce.rs` 的注释说「外部返回一律 tainted」——而三个执行出口全部写死 `Clean`，
  污点闸门恒为 false。

它们的共同形状是：**结构先写对、注释先写足、测试断中间字段——三样互相印证，
唯独没有一样碰到真实输入边界。**

**要求**：写下「本层保证 X」之前，问一句代码在哪一行做了 X。做不到就改成
「本层**不**保证 X，见 <位置>」——过强的声明比没有声明更危险，它会让下一个人
不去检查。

---

## 结构优于纪律

能让错误**写不出来**的结构，优于要求人记住的纪律。本仓已有的例子：

- `tighten(decision, floor)` —— 「闸门只收紧不放宽」曾被写坏三次，抽出这个函数后
  「放宽」无法表达。
- `event_body!` 宏 —— 新增事件变体不写 `sample =` 就编译不过。
- `admit_with_preview` 改成关联函数（**待做**）—— 收 `&self` 却不用，
  「不许重新求值」目前只有注释挡着；去掉 `&self`，重新求值即成编译错误。

评审时如果发现「这里靠约定」，先想一想能不能改成「这里靠类型」。

---

## eval 钉住的哈希

`eval/cases/synthetic-01/case.yaml` 里的 `final_state_hash` 是判据 3 的锚点。

它**可以**变——`RunState` 形状一变，哈希必然跟着变。但每次变更必须：

1. 在一个**只含本次改动**的工作区上重新生成
2. 逐条核对新旧事件 kind 序列的差异**是本次有意引入的**
3. 按该文件里现有注释的格式，写清楚变了什么、为什么变、以及**哪些没变**

**绝不能不加说明就换掉这个值。** 现有的两段注释是范例。

## CI 检查编号跨分支唯一

设计文档 00 §4 的清单靠编号索引。并行分支各自新增检查时会撞号——
`m1-desktop-shell` 的 CI-9 与 M2 分支的构建产物检查就撞过，后者改成了 CI-10。

新增检查前，先看一眼其他未合并分支占用了哪些号。
