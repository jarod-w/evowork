/**
 * 官方最佳实践案例池（03 §5）。
 *
 * **真源是随包分发的 `config/showcase/*.toml`**，这里是兜底默认值 ——
 * 与 `BUILTIN_SCENARIOS` 对 `config/scenarios/*.toml` 的关系完全一样。
 *
 * 三条来自 03 §5 的约束，改之前先看它们：
 *   · **不联网**。案例随包 + 私有源下发，不为了 4 张卡新增一条出网路径（K6）。
 *   · **点击只写入 Composer，不自动发送**。案例是提示词的起点，不是一键执行。
 *   · 封面图会显著增大安装体积（R10），所以这一批**全部是纯文字卡** ——
 *     `CaseCard` 无封面时降级为 `--bg-sunken` 底 + 大号图标，那是设计的一部分而非兜底。
 */
import type { CaseView } from '../shared/ipc.js';

export const BUILTIN_CASES: readonly CaseView[] = [
  {
    id: 'weekly-report',
    scenarioId: 'office',
    title: '把这周的记录整理成周报',
    prompt: '把 data/ 目录下这周的记录整理成一份周报 docx：先列关键结论，再给数据支撑。',
  },
  {
    id: 'sales-dashboard',
    scenarioId: 'office',
    title: '销售数据做成带图表的表格',
    prompt: '读这份销售明细，按区域和月份做透视，并生成一张趋势图，输出成 xlsx。',
  },
  {
    id: 'deck-from-doc',
    scenarioId: 'office',
    title: '一份文档改成汇报幻灯片',
    prompt: '把这份文档改写成 12 页以内的汇报幻灯片，每页一个结论 + 支撑要点。',
  },
  {
    id: 'contract-diff',
    scenarioId: 'office',
    title: '两版合同的差异清单',
    prompt: '比较这两版合同，列出实质性差异（金额、期限、责任），忽略措辞改动。',
  },
  {
    id: 'repo-tour',
    scenarioId: 'code',
    title: '快速读懂一个陌生项目',
    prompt: '梳理这个项目的结构、关键路径与启动方式，给我一份能照着跑起来的说明。',
  },
  {
    id: 'add-tests',
    scenarioId: 'code',
    title: '给核心模块补测试',
    prompt: '为这个模块补单元测试，断言写"后果"而不是实现细节。',
  },
  {
    id: 'moodboard',
    scenarioId: 'design',
    title: '围绕一个主题出几版方案',
    prompt: '围绕这个主题给我三版风格不同的方案，各自说清适用场合。',
  },
  {
    id: 'chart-restyle',
    scenarioId: 'design',
    title: '把一张图表重做成品牌风格',
    prompt: '把这张图表按我们的品牌配色重做，并说明为什么这样改更易读。',
  },
];
