import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { delegatedCompletion } from './delegated-completion.mjs'

const CHANGESETS = {
  '2.3.0': [
    { file: 'api-errors', pkg: '@lumen/api', bump: 'minor', pr: 188, en: 'Return { code, message, details } for every API error', zh: '所有 API 错误统一返回 { code, message, details }' },
    { file: 'checkout-sdk-lazy', pkg: '@lumen/checkout', bump: 'patch', pr: 191, en: 'Load the payment SDK after the first interaction', zh: '支付 SDK 改为首次交互后再加载' },
    { file: 'session-ttl', pkg: '@lumen/api', bump: 'major', pr: 194, en: 'Breaking: sessions expire after 15 minutes of inactivity', zh: '破坏性变更：会话闲置 15 分钟后过期' },
  ],
  '2.3.1': [
    { file: 'grafana-alert', pkg: '@lumen/ingestion', bump: 'patch', pr: 197, en: 'Alert when metric writes lag by more than 2 minutes', zh: '指标写入延迟超过 2 分钟时告警' },
    { file: 'report-timezone', pkg: '@lumen/reporting', bump: 'patch', pr: 199, en: 'Show times on /reports in the viewer\'s time zone', zh: '/reports 按查看者所在时区显示时间' },
  ],
  '2.4.0': [
    { file: 'consumer-dedup', pkg: '@lumen/ingestion', bump: 'minor', pr: 215, en: 'Deduplicate events by event_id in the Kafka consumer', zh: 'Kafka 消费者按 event_id 去重' },
    { file: 'hero-image-size', pkg: '@lumen/checkout', bump: 'patch', pr: 212, en: 'Declare hero image dimensions to stop layout shift on checkout', zh: '为结账页首屏图片声明尺寸，消除布局偏移' },
    { file: 'report-preaggregate', pkg: '@lumen/reporting', bump: 'major', pr: 219, en: 'Breaking: reports are pre-aggregated every 5 minutes, and the hourly endpoint moves to /v2/reports', zh: '破坏性变更：报表改为每 5 分钟预聚合，小时报表接口迁移到 /v2/reports' },
    { file: 'test-fixtures', pkg: '@lumen/test-utils', bump: 'patch', pr: 221, en: 'internal: refactor the checkout test fixtures', zh: 'internal：重构结账测试夹具' },
  ],
}
const BY_PR = new Map(Object.values(CHANGESETS).flat().map(entry => [entry.pr, entry]))

const changesetFile = entry => `---\n"${entry.pkg}": ${entry.bump}\n---\n\n${entry.en} (#${entry.pr}).\n`
const changesetContext = release => CHANGESETS[release].map(entry => `.changeset/${entry.file}.md\n${changesetFile(entry)}`).join('\n')

const yamlText = text => /: | #|^[-?:,[\]{}#&*!|>'"%@`]/u.test(text) ? JSON.stringify(text) : text
const skill = (name, description, body, extra = '') => `---\nname: ${name}\ndescription: ${yamlText(description)}\n${extra}---\n\n${body.trim()}\n`

const CONTENT = {
  'zh-CN': {
    releaseRequest: /版本说明/u,
    correction: /按包分组/u,
    title: 'Lumen 2.4 版本说明',
    checklistQuery: '发布检查清单',
    skills: {
      releaseNotesFirst: skill('release-notes', '根据待发布的 changeset 编写 Lumen 的版本说明，中英双语。准备发版或被要求写版本说明时使用。', `
# 版本说明

## 步骤

1. 读取 \`.changeset/\` 下除 README.md 以外的每个文件。
2. 每个 changeset 写一条，按文件名顺序排列。
3. 先写英文版，再把同样的条目写成中文版。`),
      releaseNotes: skill('release-notes', '根据待发布的 changeset 编写 Lumen 的版本说明，中英双语。准备发版或被要求写版本说明时使用。', `
# 版本说明

## 步骤

1. 读取 \`.changeset/\` 下除 README.md 以外的每个文件。
2. 每个 changeset 写一条，按文件名顺序排列，保留摘要末尾的 PR 编号。
3. 先写英文版，再把同样的条目写成中文版。

## 检查

- 每个 changeset 在两种语言里各出现一次。`),
      releaseNotesDraft: skill('release-notes', '根据待发布的 changeset 编写 Lumen 的版本说明，中英双语，按包分组。准备发版或被要求写版本说明时使用。', `
# 版本说明

## 步骤

1. 读取 \`.changeset/\` 下除 README.md 以外的每个文件，记下包名、改动级别和摘要。
2. 略去摘要以 \`internal:\` 开头的改动。
3. 按包分组，每个包一个小标题，例如 \`### @lumen/checkout\`。含 major 改动的包排在最前，包内的 major 改动也排在最前，并以 **破坏性变更：** 开头。
4. 保留摘要末尾的 PR 编号。
5. 先写英文版，再写中文版；包名、路径和命令保持英文。

## 注意

- 不要按文件名顺序逐条罗列，同一个包的改动放在一起。

## 检查

- 每个对外的 changeset 在两种语言里各出现一次，并带有 PR 编号。
- 没有以 \`internal:\` 开头的改动。`),
      releaseNotesPersonal: skill('release-notes', '写版本说明（个人旧版）。', `
# 版本说明

逐条列出 changeset，写成中文。`),
      incidentReview: skill('incident-review', '按 Lumen 的格式写故障复盘：影响、原因、处理和后续。处理线上故障或被要求写复盘时使用。', `
# 故障复盘

## 步骤

1. 影响：受影响的功能、时长和范围。
2. 原因：直接原因和根本原因分开写。
3. 处理：临时措施和长期修复分开写。
4. 后续：每一项都有负责人和期限。`),
      incidentReviewAdopted: skill('incident-review', '按 Lumen 的格式写故障复盘：影响、时间线、原因、处理和后续。处理线上故障或被要求写复盘时使用。', `
# 故障复盘

## 步骤

1. 影响：受影响的功能、时长和范围。
2. 时间线：按 UTC+8 列出发现、响应和恢复的时间，从告警写到恢复。
3. 原因：直接原因和根本原因分开写。
4. 处理：临时措施和长期修复分开写。
5. 后续：每一项都有负责人和期限。

## 检查

- 时间线里的每个时间都带时区。`),
      checkoutPerf: skill('checkout-perf-check', '在提交性能相关的 PR 之前，测量结账页的 LCP 并与 p75 目标对比。', `
# 结账页性能检查

## 步骤

1. 用 \`pnpm build && pnpm start\` 启动生产构建。
2. 用 Lighthouse 的移动端预设测量 /checkout，记下 LCP。
3. 与 p75 LCP 2.5 秒的目标对比，把结果写进 PR 描述。`),
      prDescription: skill('pr-description', '写 PR 描述：摘要、测试方式和风险，标题用 Conventional Commits。开 PR 或被要求写 PR 描述时使用。', `
# PR 描述

## 步骤

1. 用一两句话说明改了什么、为什么改。
2. 列出测试方式：跑了哪些命令，手动验证了哪些路径。
3. 写清风险和回滚方式。
4. 标题用英文 Conventional Commits，例如 \`fix(checkout): declare hero image dimensions\`。`),
      sqlExplain: skill('sql-explain', '解读 Postgres 慢查询的 EXPLAIN ANALYZE 输出，指出瓶颈并给出索引建议。', `
# 慢查询解读

## 步骤

1. 在 postgres-test（端口 55432）上运行 \`EXPLAIN (ANALYZE, BUFFERS)\`。
2. 找出耗时最多的节点，以及估算行数与实际行数相差最大的地方。
3. 给出索引或改写建议，并说明预期收益。`),
    },
    cases: {
      grouping: { title: '按包分组', prompt: '根据下面的 changeset 写 Lumen 2.3.0 的版本说明。', context: changesetContext('2.3.0'), checks: [
        { text: '按包分组，每个包一个小标题', must: true },
        { text: '破坏性变更排在最前，并标明“破坏性变更”', must: true },
        { text: '每条保留 PR 编号', must: false },
      ] },
      bilingual: { title: '中英双语', prompt: '根据下面的 changeset 写 Lumen 2.3.1 的版本说明。', context: changesetContext('2.3.1'), checks: [
        { text: '有英文和中文两部分，条目一一对应', must: true },
        { text: '包名、路径和命令保持英文', must: false },
      ] },
      internal: { title: '略去内部改动', prompt: '根据下面的 changeset 写 Lumen 2.4 的版本说明。', context: changesetContext('2.4.0'), checks: [
        { text: '不包含以 internal: 开头的改动', must: true },
        { text: '按包分组，每个包一个小标题', must: true },
        { text: '有需要迁移的改动时，在末尾给出升级步骤', must: false },
      ] },
      timeline: { title: '复盘包含时间线', prompt: '为 10 月 3 日结账页 5 分钟不可用写一份复盘。', context: '14:05 告警；14:07 回滚配置；14:10 恢复。原因：一次配置变更关闭了支付回调。', checks: [
        { text: '包含影响、原因、处理、后续四部分', must: true },
        { text: '有按 UTC+8 的时间线，从告警写到恢复', must: true },
        { text: '后续事项有负责人和期限', must: false },
      ] },
      causes: { title: '原因分层', prompt: '为 9 月 12 日指标延迟写复盘的“原因”和“处理”两部分。', context: '营销活动带来 6 倍流量，ClickHouse 合并队列积压；临时扩容并对写入限流，长期改为队列摄取。', checks: [
        { text: '直接原因与根本原因分开写', must: true },
        { text: '处理部分区分临时措施和长期修复', must: true },
        { text: '不写个人责任', must: false },
      ] },
      lcp: { title: '测量改动前后的 LCP', prompt: '这个 PR 改了结账页首屏图片，测一下 LCP 有没有变化。', checks: [
        { text: '用生产构建测量', must: true },
        { text: '与 p75 LCP 2.5 秒的目标对比', must: true },
        { text: '把结果写进 PR 描述', must: false },
      ] },
      backfillWindow: { title: '补录一段时间窗口的事件', prompt: '把 2026-10-02 09:00 到 09:30（UTC+8）丢失的埋点事件补进 ClickHouse。', checks: [
        { text: '先暂停 ingest-consumer，再重置消费位点', must: true },
        { text: '位点按 UTC 时间重置', must: true },
        { text: '补录后核对条数', must: false },
      ] },
      backfillDuplicates: { title: '确认补录没有重复', prompt: '补录完成后，确认 ClickHouse 里没有重复的事件。', checks: [
        { text: '按 event_id 统计重复', must: true },
        { text: '说明消费者按 event_id 去重，重放是幂等的', must: false },
      ] },
    },
    reviews: {
      backfill: {
        title: '补录 9 月 12 日丢失的事件',
        steps: [
          { turn: 1, kind: 'user', text: '9 月 12 日 14:00 到 14:40 的埋点事件没有进 ClickHouse，帮我补录。' },
          { turn: 1, kind: 'tool', text: '架构决策：事件摄取改用队列；故障复盘：9 月 12 日指标延迟', tool: { name: 'mnemon_document_search', ok: true, input: 'query=事件摄取 补录' } },
          { turn: 1, kind: 'tool', text: 'Error: Assignments can only be reset if the group \'ingest\' is inactive', tool: { name: 'bash', ok: false, input: 'command=kafka-consumer-groups --reset-offsets --to-datetime 2026-09-12T06:00:00.000 --group ingest --all-topics --execute', error: 'Error: Assignments can only be reset if the group \'ingest\' is inactive' } },
          { turn: 1, kind: 'assistant', text: '消费组还在运行，需要先暂停 ingest-consumer，再重置位点。' },
          { turn: 1, kind: 'tool', text: 'deployment.apps/ingest-consumer scaled', tool: { name: 'bash', ok: true, input: 'command=kubectl scale deploy/ingest-consumer --replicas=0' } },
          { turn: 1, kind: 'tool', text: 'Offsets reset for 12 partitions', tool: { name: 'bash', ok: true, input: 'command=kafka-consumer-groups --reset-offsets --to-datetime 2026-09-12T06:00:00.000 --group ingest --all-topics --execute' } },
          { turn: 1, kind: 'tool', text: 'deployment.apps/ingest-consumer scaled', tool: { name: 'bash', ok: true, input: 'command=kubectl scale deploy/ingest-consumer --replicas=3' } },
          { turn: 1, kind: 'tool', text: '1284113', tool: { name: 'bash', ok: true, input: 'command=clickhouse-client -q "SELECT count() FROM events WHERE ts BETWEEN \'2026-09-12 06:00:00\' AND \'2026-09-12 06:40:00\'"' } },
          { turn: 2, kind: 'user', text: '数一下有没有重复的 event_id。' },
          { turn: 2, kind: 'tool', text: '0', tool: { name: 'bash', ok: true, input: 'command=clickhouse-client -q "SELECT count() - uniqExact(event_id) FROM events WHERE …"' } },
          { turn: 2, kind: 'assistant', text: '补录完成：共 1,284,113 条，没有重复的 event_id。消费者按 event_id 去重，重放是幂等的。' },
        ],
        summary: '这次补录摸索出一套可以照做的流程，第一次重置位点因消费组仍在运行而失败。',
        annotations: [
          { step: 3, signal: 'tool-failure', note: '消费组仍在运行，重置位点失败' },
          { step: 4, signal: 'approach-change', note: '改为先暂停消费者，再重置位点' },
          { step: 6, signal: 'procedure', note: '按 UTC 时间重置位点后恢复消费' },
          { step: 10, signal: 'procedure', note: '用 event_id 核对有没有重复' },
        ],
        suggestion: { skillName: 'event-backfill', action: 'create', summary: '新建技能：通过 Kafka 重放补录丢失的事件，并按 event_id 核对重复', rationale: '这次补录得出了一套可复用的步骤：暂停消费者、按 UTC 时间重置位点、恢复消费，再按 event_id 核对重复。第一次重置位点因为消费组仍在运行而失败。', confidence: 0.78, signals: ['procedure', 'tool-failure', 'approach-change'], steps: [3, 4, 5, 6, 7, 10] },
        cases: ['backfillWindow', 'backfillDuplicates'],
      },
      incident: {
        title: '9 月 12 日指标延迟的复盘',
        steps: [
          { turn: 1, kind: 'user', text: '按团队格式写一份 9 月 12 日指标延迟的复盘。' },
          { turn: 1, kind: 'skill', text: 'incident-review', skill: { name: 'incident-review', by: 'model' } },
          { turn: 1, kind: 'tool', text: '故障复盘：9 月 12 日指标延迟', tool: { name: 'mnemon_document_search', ok: true, input: 'query=9 月 12 日 指标延迟' } },
          { turn: 1, kind: 'assistant', text: '复盘初稿：影响约 40 分钟；原因是营销活动带来 6 倍流量，ClickHouse 合并队列积压；处理是扩容并限流；后续改为队列摄取。' },
          { turn: 2, kind: 'user', text: '加一段时间线，时间都用 UTC+8，从发现写到恢复。' },
          { turn: 2, kind: 'assistant', text: '已补上时间线：14:02 告警，14:10 扩容，14:25 限流，14:40 恢复（均为 UTC+8）。' },
          { turn: 3, kind: 'user', text: '以后写复盘都要有时间线。' },
          { turn: 3, kind: 'assistant', text: '好的，之后的复盘都会包含按 UTC+8 的时间线。' },
        ],
        summary: '用户补充了时间线的要求，并要求以后的复盘都包含时间线。',
        annotations: [
          { step: 2, signal: 'skill-gap', note: 'incident-review 没有时间线这一步' },
          { step: 5, signal: 'correction', note: '初稿缺少时间线' },
          { step: 7, signal: 'directive', note: '“以后写复盘都要有时间线”' },
        ],
        suggestion: { skillName: 'incident-review', action: 'update', summary: '在复盘中加入按 UTC+8 的时间线', rationale: '用户在第 2 轮补上了时间线，又要求以后都包含；incident-review 目前没有这一步。', confidence: 0.84, signals: ['correction', 'directive', 'skill-gap'], steps: [2, 5, 7] },
        cases: ['timeline'],
        draft: { notes: '用户要求复盘包含从告警到恢复的时间线，并统一用 UTC+8。草案在影响之后加入时间线一步，并在检查里要求每个时间都带时区。', changes: ['新增“时间线”一步，按 UTC+8 从告警写到恢复', '检查中要求时间带时区', '描述中加入时间线'] },
      },
      checkout: {
        title: '结账页 LCP 回归排查',
        steps: [
          { turn: 1, kind: 'user', text: '这个 PR 合进来之后结账页好像变慢了，测一下 LCP。' },
          { turn: 1, kind: 'skill', text: 'checkout-perf-check', skill: { name: 'checkout-perf-check', by: 'model' } },
          { turn: 1, kind: 'tool', text: 'Ready on http://localhost:3000', tool: { name: 'bash', ok: true, input: 'command=pnpm build && pnpm start' } },
          { turn: 1, kind: 'tool', text: 'LCP 2.9 s', tool: { name: 'bash', ok: true, input: 'command=lighthouse http://localhost:3000/checkout --preset=mobile' } },
          { turn: 1, kind: 'tool', text: 'LCP 2.4 s', tool: { name: 'bash', ok: true, input: 'command=lighthouse http://localhost:3000/checkout --preset=mobile' } },
          { turn: 1, kind: 'tool', text: 'LCP 2.6 s', tool: { name: 'bash', ok: true, input: 'command=lighthouse http://localhost:3000/checkout --preset=mobile' } },
          { turn: 1, kind: 'assistant', text: '三次测得的 LCP 分别是 2.9、2.4、2.6 秒，中位数 2.6 秒，略高于 2.5 秒的目标。' },
        ],
        summary: '单次 Lighthouse 结果波动较大，这次多测了几次再取中位数。',
        annotations: [
          { step: 5, signal: 'approach-change', note: '单次结果波动大，改为多测几次' },
          { step: 7, signal: 'success', note: '用中位数和目标对比' },
        ],
        suggestion: { skillName: 'checkout-perf-check', action: 'update', summary: 'Lighthouse 测三次，取中位数', rationale: '单次测量从 2.4 秒到 2.9 秒不等，取中位数更稳定。', confidence: 0.66, signals: ['approach-change', 'skill-gap'], steps: [4, 5, 6, 7] },
        cases: ['lcp'],
      },
    },
    runs: {
      timeline: { checks: [true, true, true], steps: ['读取上下文中的告警与恢复时间', '按影响、时间线、原因、处理、后续写复盘'], answer: '**影响**：结账页不可用 5 分钟。\n**时间线（UTC+8）**：14:05 告警；14:07 回滚配置；14:10 恢复。\n**原因**：一次配置变更关闭了支付回调。\n**处理**：回滚配置。\n**后续**：配置变更加上审核（负责人：平台组，10 月 20 日前）。', notes: ['四部分齐全', '时间线带 UTC+8', '后续有负责人和期限'] },
      causes: { checks: [true, true, false], steps: ['区分直接原因与根本原因', '区分临时措施与长期修复'], answer: '**原因**：直接原因是 ClickHouse 合并队列积压；根本原因是写入路径没有缓冲。\n**处理**：临时扩容并限流；长期改为经 Kafka 的队列摄取。值班同学没有及时扩容。', notes: ['直接原因与根本原因分开', '临时与长期分开', '写到了个人'] },
      lcp: { checks: [true, true, false], steps: ['pnpm build && pnpm start', 'lighthouse http://localhost:3000/checkout --preset=mobile', '与 2.5 秒的目标对比'], answer: 'LCP 2.3 秒，低于 p75 2.5 秒的目标。', notes: ['用生产构建测量', '与目标对比', '没有写进 PR 描述'] },
    },
    conversation: {
      first: notes => `我用 release-notes 技能，根据 4 个 changeset 写好了 2.4 的版本说明：\n\n${notes}\n\n发版前，按项目档案《发布检查清单》先确认 main 上的 CI 全部通过。`,
      second: notes => `已按包分组，破坏性变更放在最前，并略去了内部改动：\n\n${notes}`,
      idle: '可以让我写版本说明，我会先读取 .changeset 里的改动。',
    },
    review: {
      summary: '用户纠正了版本说明的格式，并要求以后沿用；release-notes 缺少分组、排序和过滤规则。',
      annotations: { skill: 'release-notes 只要求按文件名逐条罗列', correction: '要求按包分组、破坏性变更放在最前、略去内部改动', directive: '“以后都按这个格式”' },
      suggestion: { summary: '按包分组、破坏性变更放在最前，并略去内部改动', rationale: '用户在第 2 轮纠正了输出格式，并要求以后都按这个格式；release-notes 目前只要求按文件名逐条罗列，没有分组、排序和过滤的规则。' },
      nothing: '这段对话没有用到技能，也没有可复用的流程。',
    },
    draft: { notes: '用户要求按包分组、破坏性变更放在最前、略去内部改动，并说以后都按这个格式；当前技能只要求按文件名逐条罗列。草案把这三条写进步骤，并在检查里加上 PR 编号和 internal 两项。', changes: ['按包分组，每个包一个小标题', 'major 改动排在最前，并标注破坏性变更', '略去以 internal: 开头的改动', '检查中加入 PR 编号与 internal 两项'] },
    executor: {
      read: count => `读取 .changeset/ 下的 ${count} 个文件，记下包名、改动级别和摘要`,
      skip: files => `略去 internal 改动：${files}`,
      group: first => `按包分组，${first} 排在最前`,
      list: '按文件名顺序逐条写',
      languages: '先写英文版，再写中文版',
      generic: '按技能的步骤处理任务',
      genericAnswer: '（模拟输出：按技能步骤完成了任务。）',
    },
    judge: { pass: '满足', fail: '不满足', summary: (passed, total) => `${total} 项检查通过 ${passed} 项。` },
    catalog: {
      name: 'Lumen 团队技能',
      categories: [{ id: 'backend', label: '后端' }, { id: 'release', label: '发版' }, { id: 'testing', label: '测试' }],
      skills: [
        { name: 'api-error-format', category: 'backend', title: 'API 错误格式', description: '把 API 错误整理成 { code, message, details }，并对应到 HTTP 状态码。', body: '# API 错误格式\n\n1. 错误一律返回 `{ code, message, details }`。\n2. 校验错误用 400，权限错误用 403，找不到用 404。\n' },
        { name: 'changeset-entry', category: 'release', title: '写 changeset', description: '为一次改动写 changeset：包名、改动级别和一句带 PR 编号的英文摘要。', body: '# 写 changeset\n\n1. 运行 `pnpm changeset`，选择改动的包和级别。\n2. 摘要用一句英文，末尾写上 PR 编号。\n' },
        { name: 'postgres-test-db', category: 'testing', title: '测试数据库', description: '在 docker compose 中启动或重置 postgres-test（端口 55432）。', body: '# 测试数据库\n\n1. `docker compose up -d postgres-test`\n2. 需要干净数据时运行 `pnpm db:reset --env test`。\n' },
      ],
    },
  },
  en: {
    releaseRequest: /release notes/iu,
    correction: /group them by package/iu,
    title: 'Lumen 2.4 release notes',
    checklistQuery: 'release checklist',
    skills: {
      releaseNotesFirst: skill('release-notes', 'Writes Lumen\'s release notes from the pending changesets, in English and Chinese. Use when preparing a release or asked for release notes.', `
# Release notes

## Steps

1. Read every file under \`.changeset/\` except README.md.
2. Write one bullet per changeset, in file-name order.
3. Write the English notes first, then the same bullets in Chinese.`),
      releaseNotes: skill('release-notes', 'Writes Lumen\'s release notes from the pending changesets, in English and Chinese. Use when preparing a release or asked for release notes.', `
# Release notes

## Steps

1. Read every file under \`.changeset/\` except README.md.
2. Write one bullet per changeset, in file-name order, keeping the PR number at the end of its summary.
3. Write the English notes first, then the same bullets in Chinese.

## Verification

- Every changeset appears once in each language.`),
      releaseNotesDraft: skill('release-notes', 'Writes Lumen\'s release notes from the pending changesets, in English and Chinese, grouped by package. Use when preparing a release or asked for release notes.', `
# Release notes

## Steps

1. Read every file under \`.changeset/\` except README.md, noting each one's package, bump and summary.
2. Leave out changes whose summary starts with \`internal:\`.
3. Group the entries by package, one heading per package, such as \`### @lumen/checkout\`. Packages with a major change come first, the major change first within its package, starting with **Breaking:**.
4. Keep the PR number at the end of each summary.
5. Write the English notes first, then the Chinese ones; package names, paths and commands stay in English.

## Pitfalls

- Do not list changesets in file-name order; keep each package's changes together.

## Verification

- Every public changeset appears once in each language, with its PR number.
- No entry starts with \`internal:\`.`),
      releaseNotesPersonal: skill('release-notes', 'Writes release notes (an older personal copy).', `
# Release notes

List the changesets one by one.`),
      incidentReview: skill('incident-review', 'Writes an incident review in Lumen\'s format: impact, cause, response and follow-up. Use after a production incident or when asked for a review.', `
# Incident review

## Steps

1. Impact: the features affected, for how long and how widely.
2. Cause: the direct cause and the root cause, separately.
3. Response: the immediate mitigation and the lasting fix, separately.
4. Follow-up: every item has an owner and a due date.`),
      incidentReviewAdopted: skill('incident-review', 'Writes an incident review in Lumen\'s format: impact, timeline, cause, response and follow-up. Use after a production incident or when asked for a review.', `
# Incident review

## Steps

1. Impact: the features affected, for how long and how widely.
2. Timeline: when the incident was detected, handled and resolved, in UTC+8, from the first alert to recovery.
3. Cause: the direct cause and the root cause, separately.
4. Response: the immediate mitigation and the lasting fix, separately.
5. Follow-up: every item has an owner and a due date.

## Verification

- Every time in the timeline has a time zone.`),
      checkoutPerf: skill('checkout-perf-check', 'Measures checkout LCP and compares it with the p75 target before a performance pull request.', `
# Checkout performance check

## Steps

1. Start a production build with \`pnpm build && pnpm start\`.
2. Measure /checkout with Lighthouse's mobile preset and note the LCP.
3. Compare it with the p75 LCP target of 2.5 s and put the result in the PR description.`),
      prDescription: skill('pr-description', 'Writes a pull request description: summary, testing and risk, with a Conventional Commits title. Use when opening a PR or asked for its description.', `
# PR description

## Steps

1. Say what changed and why in one or two sentences.
2. List how it was tested: the commands run and the paths checked by hand.
3. State the risk and how to roll back.
4. Use a Conventional Commits title, such as \`fix(checkout): declare hero image dimensions\`.`),
      sqlExplain: skill('sql-explain', 'Reads a slow Postgres query\'s EXPLAIN ANALYZE output, finds the bottleneck and proposes an index.', `
# Slow query explained

## Steps

1. Run \`EXPLAIN (ANALYZE, BUFFERS)\` on postgres-test (port 55432).
2. Find the slowest node and where estimated and actual rows differ most.
3. Propose an index or a rewrite, with the expected gain.`),
    },
    cases: {
      grouping: { title: 'Group by package', prompt: 'Write the release notes for Lumen 2.3.0 from these changesets.', context: changesetContext('2.3.0'), checks: [
        { text: 'Groups entries under one heading per package', must: true },
        { text: 'Lists breaking changes first and marks them as breaking', must: true },
        { text: 'Keeps each entry\'s PR number', must: false },
      ] },
      bilingual: { title: 'English and Chinese', prompt: 'Write the release notes for Lumen 2.3.1 from these changesets.', context: changesetContext('2.3.1'), checks: [
        { text: 'Has an English and a Chinese section with the same entries', must: true },
        { text: 'Keeps package names, paths and commands in English', must: false },
      ] },
      internal: { title: 'Leave out internal changes', prompt: 'Write the release notes for Lumen 2.4 from these changesets.', context: changesetContext('2.4.0'), checks: [
        { text: 'Leaves out changes whose summary starts with internal:', must: true },
        { text: 'Groups entries under one heading per package', must: true },
        { text: 'Ends with upgrade steps when a change needs a migration', must: false },
      ] },
      timeline: { title: 'A review with a timeline', prompt: 'Write an incident review for the 5-minute checkout outage on October 3.', context: '14:05 alert; 14:07 configuration rolled back; 14:10 recovered. Cause: a configuration change turned off the payment callback.', checks: [
        { text: 'Has impact, cause, response and follow-up', must: true },
        { text: 'Has a timeline in UTC+8 from the alert to recovery', must: true },
        { text: 'Every follow-up item has an owner and a due date', must: false },
      ] },
      causes: { title: 'Causes in layers', prompt: 'Write the cause and response sections of the September 12 review of delayed metrics.', context: 'A marketing campaign brought 6x traffic and the ClickHouse merge queue backed up; capacity was added and writes throttled, and ingestion moved to a queue for good.', checks: [
        { text: 'Separates the direct cause from the root cause', must: true },
        { text: 'Separates the immediate mitigation from the lasting fix', must: true },
        { text: 'Blames no individual', must: false },
      ] },
      lcp: { title: 'LCP before and after a change', prompt: 'This PR changes the checkout hero image; check whether LCP changed.', checks: [
        { text: 'Measures a production build', must: true },
        { text: 'Compares with the p75 LCP target of 2.5 s', must: true },
        { text: 'Puts the result in the PR description', must: false },
      ] },
      backfillWindow: { title: 'Backfill a window of events', prompt: 'Backfill the tracking events lost between 09:00 and 09:30 (UTC+8) on 2026-10-02 into ClickHouse.', checks: [
        { text: 'Pauses ingest-consumer before resetting the offsets', must: true },
        { text: 'Resets the offsets by UTC time', must: true },
        { text: 'Checks the row count afterwards', must: false },
      ] },
      backfillDuplicates: { title: 'No duplicates after a backfill', prompt: 'After a backfill, make sure ClickHouse holds no duplicate events.', checks: [
        { text: 'Counts duplicates by event_id', must: true },
        { text: 'Explains that the consumer deduplicates by event_id, so a replay is idempotent', must: false },
      ] },
    },
    reviews: {
      backfill: {
        title: 'Backfill the events lost on September 12',
        steps: [
          { turn: 1, kind: 'user', text: 'Tracking events from 14:00 to 14:40 on September 12 never reached ClickHouse. Please backfill them.' },
          { turn: 1, kind: 'tool', text: 'Decision: queue event ingestion; Incident review: delayed metrics on September 12', tool: { name: 'mnemon_document_search', ok: true, input: 'query=event ingestion backfill' } },
          { turn: 1, kind: 'tool', text: 'Error: Assignments can only be reset if the group \'ingest\' is inactive', tool: { name: 'bash', ok: false, input: 'command=kafka-consumer-groups --reset-offsets --to-datetime 2026-09-12T06:00:00.000 --group ingest --all-topics --execute', error: 'Error: Assignments can only be reset if the group \'ingest\' is inactive' } },
          { turn: 1, kind: 'assistant', text: 'The consumer group is still running; ingest-consumer has to stop before the offsets can be reset.' },
          { turn: 1, kind: 'tool', text: 'deployment.apps/ingest-consumer scaled', tool: { name: 'bash', ok: true, input: 'command=kubectl scale deploy/ingest-consumer --replicas=0' } },
          { turn: 1, kind: 'tool', text: 'Offsets reset for 12 partitions', tool: { name: 'bash', ok: true, input: 'command=kafka-consumer-groups --reset-offsets --to-datetime 2026-09-12T06:00:00.000 --group ingest --all-topics --execute' } },
          { turn: 1, kind: 'tool', text: 'deployment.apps/ingest-consumer scaled', tool: { name: 'bash', ok: true, input: 'command=kubectl scale deploy/ingest-consumer --replicas=3' } },
          { turn: 1, kind: 'tool', text: '1284113', tool: { name: 'bash', ok: true, input: 'command=clickhouse-client -q "SELECT count() FROM events WHERE ts BETWEEN \'2026-09-12 06:00:00\' AND \'2026-09-12 06:40:00\'"' } },
          { turn: 2, kind: 'user', text: 'Count any duplicate event_id values.' },
          { turn: 2, kind: 'tool', text: '0', tool: { name: 'bash', ok: true, input: 'command=clickhouse-client -q "SELECT count() - uniqExact(event_id) FROM events WHERE …"' } },
          { turn: 2, kind: 'assistant', text: 'Backfill done: 1,284,113 events and no duplicate event_id. The consumer deduplicates by event_id, so the replay is idempotent.' },
        ],
        summary: 'The backfill settled into a procedure another agent could follow; the first offset reset failed because the consumer group was still running.',
        annotations: [
          { step: 3, signal: 'tool-failure', note: 'The reset failed while the consumer group was running' },
          { step: 4, signal: 'approach-change', note: 'Pause the consumer first, then reset the offsets' },
          { step: 6, signal: 'procedure', note: 'Reset the offsets by UTC time, then resume' },
          { step: 10, signal: 'procedure', note: 'Check for duplicates by event_id' },
        ],
        suggestion: { skillName: 'event-backfill', action: 'create', summary: 'New skill: backfill lost events by replaying Kafka, then check event_id for duplicates', rationale: 'The backfill produced reusable steps: pause the consumer, reset the offsets by UTC time, resume, and check duplicates by event_id. The first offset reset failed because the consumer group was still running.', confidence: 0.78, signals: ['procedure', 'tool-failure', 'approach-change'], steps: [3, 4, 5, 6, 7, 10] },
        cases: ['backfillWindow', 'backfillDuplicates'],
      },
      incident: {
        title: 'Review of the September 12 metrics delay',
        steps: [
          { turn: 1, kind: 'user', text: 'Write the review of the September 12 metrics delay in the team format.' },
          { turn: 1, kind: 'skill', text: 'incident-review', skill: { name: 'incident-review', by: 'model' } },
          { turn: 1, kind: 'tool', text: 'Incident review: delayed metrics on September 12', tool: { name: 'mnemon_document_search', ok: true, input: 'query=September 12 metrics delay' } },
          { turn: 1, kind: 'assistant', text: 'First draft: about 40 minutes of impact; a campaign brought 6x traffic and the ClickHouse merge queue backed up; capacity added and writes throttled; ingestion moves to a queue.' },
          { turn: 2, kind: 'user', text: 'Add a timeline, all times in UTC+8, from detection to recovery.' },
          { turn: 2, kind: 'assistant', text: 'Timeline added: 14:02 alert, 14:10 capacity added, 14:25 writes throttled, 14:40 recovered (UTC+8).' },
          { turn: 3, kind: 'user', text: 'Every review should have a timeline from now on.' },
          { turn: 3, kind: 'assistant', text: 'Understood: reviews will include a timeline in UTC+8.' },
        ],
        summary: 'The user added a timeline and asked for one in every review from now on.',
        annotations: [
          { step: 2, signal: 'skill-gap', note: 'incident-review has no timeline step' },
          { step: 5, signal: 'correction', note: 'The first draft had no timeline' },
          { step: 7, signal: 'directive', note: '"Every review should have a timeline from now on"' },
        ],
        suggestion: { skillName: 'incident-review', action: 'update', summary: 'Add a timeline in UTC+8 to every review', rationale: 'The user added a timeline in the second turn and asked for one in every review; incident-review has no such step.', confidence: 0.84, signals: ['correction', 'directive', 'skill-gap'], steps: [2, 5, 7] },
        cases: ['timeline'],
        draft: { notes: 'The user wants every review to carry a timeline from the alert to recovery, in UTC+8. The draft adds a timeline step after the impact and checks that every time has a time zone.', changes: ['New timeline step, in UTC+8, from the alert to recovery', 'Verification: every time has a time zone', 'The description names the timeline'] },
      },
      checkout: {
        title: 'Checkout LCP regression',
        steps: [
          { turn: 1, kind: 'user', text: 'Checkout feels slower since this PR merged. Measure the LCP.' },
          { turn: 1, kind: 'skill', text: 'checkout-perf-check', skill: { name: 'checkout-perf-check', by: 'model' } },
          { turn: 1, kind: 'tool', text: 'Ready on http://localhost:3000', tool: { name: 'bash', ok: true, input: 'command=pnpm build && pnpm start' } },
          { turn: 1, kind: 'tool', text: 'LCP 2.9 s', tool: { name: 'bash', ok: true, input: 'command=lighthouse http://localhost:3000/checkout --preset=mobile' } },
          { turn: 1, kind: 'tool', text: 'LCP 2.4 s', tool: { name: 'bash', ok: true, input: 'command=lighthouse http://localhost:3000/checkout --preset=mobile' } },
          { turn: 1, kind: 'tool', text: 'LCP 2.6 s', tool: { name: 'bash', ok: true, input: 'command=lighthouse http://localhost:3000/checkout --preset=mobile' } },
          { turn: 1, kind: 'assistant', text: 'Three runs measured LCP at 2.9, 2.4 and 2.6 s; the median, 2.6 s, is just over the 2.5 s target.' },
        ],
        summary: 'Single Lighthouse runs varied, so this run measured several times and took the median.',
        annotations: [
          { step: 5, signal: 'approach-change', note: 'Single runs varied; measure several times' },
          { step: 7, signal: 'success', note: 'Compare the median with the target' },
        ],
        suggestion: { skillName: 'checkout-perf-check', action: 'update', summary: 'Run Lighthouse three times and take the median', rationale: 'Single runs ranged from 2.4 s to 2.9 s; the median is steadier.', confidence: 0.66, signals: ['approach-change', 'skill-gap'], steps: [4, 5, 6, 7] },
        cases: ['lcp'],
      },
    },
    runs: {
      timeline: { checks: [true, true, true], steps: ['Read the alert and recovery times from the context', 'Write impact, timeline, cause, response and follow-up'], answer: '**Impact**: checkout unavailable for 5 minutes.\n**Timeline (UTC+8)**: 14:05 alert; 14:07 configuration rolled back; 14:10 recovered.\n**Cause**: a configuration change turned off the payment callback.\n**Response**: rolled the configuration back.\n**Follow-up**: review configuration changes (owner: platform team, by October 20).', notes: ['All four sections', 'Timeline in UTC+8', 'Owner and due date given'] },
      causes: { checks: [true, true, false], steps: ['Separate the direct cause from the root cause', 'Separate the mitigation from the lasting fix'], answer: '**Cause**: directly, the ClickHouse merge queue backed up; at the root, the write path had no buffer.\n**Response**: capacity added and writes throttled for now; ingestion goes through Kafka for good. The on-call engineer scaled up too late.', notes: ['Causes separated', 'Mitigation and fix separated', 'Names an individual'] },
      lcp: { checks: [true, true, false], steps: ['pnpm build && pnpm start', 'lighthouse http://localhost:3000/checkout --preset=mobile', 'Compare with the 2.5 s target'], answer: 'LCP is 2.3 s, under the p75 target of 2.5 s.', notes: ['Production build', 'Compared with the target', 'Not in the PR description'] },
    },
    conversation: {
      first: notes => `Using the release-notes skill, here are the 2.4 release notes from the 4 changesets:\n\n${notes}\n\nBefore publishing, confirm CI is green on main, as the Release checklist in Documents asks.`,
      second: notes => `Grouped by package, with the breaking change first and internal changes left out:\n\n${notes}`,
      idle: 'Ask me for release notes and I will read the pending changesets first.',
    },
    review: {
      summary: 'The user corrected the release notes\' format and asked to keep it; release-notes has no rules for grouping, order or filtering.',
      annotations: { skill: 'release-notes only lists changesets in file-name order', correction: 'Group by package, breaking changes first, no internal changes', directive: '"Do it this way from now on"' },
      suggestion: { summary: 'Group by package, put breaking changes first and leave out internal changes', rationale: 'The user corrected the output format in the second turn and asked for it from now on; release-notes only lists changesets in file-name order, with no rules for grouping, order or filtering.' },
      nothing: 'This conversation used no skill and produced no reusable procedure.',
    },
    draft: { notes: 'The user asked for entries grouped by package, breaking changes first and internal changes left out, from now on; the current skill lists changesets in file-name order. The draft puts the three rules in the steps and checks PR numbers and internal entries.', changes: ['Group by package, one heading each', 'Major changes first, marked as breaking', 'Leave out entries starting with internal:', 'Verification checks PR numbers and internal entries'] },
    executor: {
      read: count => `Read the ${count} files under .changeset/, noting each package, bump and summary`,
      skip: files => `Leave out the internal change: ${files}`,
      group: first => `Group by package, ${first} first`,
      list: 'Write one bullet per file, in file-name order',
      languages: 'Write the English notes, then the Chinese ones',
      generic: 'Follow the skill\'s steps for the task',
      genericAnswer: '(Simulated output: the task done as the skill describes.)',
    },
    judge: { pass: 'Met', fail: 'Not met', summary: (passed, total) => `${passed} of ${total} checks met.` },
    catalog: {
      name: 'Lumen team skills',
      categories: [{ id: 'backend', label: 'Backend' }, { id: 'release', label: 'Releases' }, { id: 'testing', label: 'Testing' }],
      skills: [
        { name: 'api-error-format', category: 'backend', title: 'API error format', description: 'Shapes API errors as { code, message, details } and maps them to HTTP status codes.', body: '# API error format\n\n1. Every error returns `{ code, message, details }`.\n2. Validation errors are 400, permission errors 403, missing resources 404.\n' },
        { name: 'changeset-entry', category: 'release', title: 'Write a changeset', description: 'Writes a changeset for a change: the package, the bump and a one-line English summary ending with the PR number.', body: '# Write a changeset\n\n1. Run `pnpm changeset` and choose the packages and the bump.\n2. Write one English sentence that ends with the PR number.\n' },
        { name: 'postgres-test-db', category: 'testing', title: 'Test database', description: 'Starts or resets the postgres-test database in docker compose, on port 55432.', body: '# Test database\n\n1. `docker compose up -d postgres-test`\n2. For clean data, run `pnpm db:reset --env test`.\n' },
      ],
    },
  },
}

export const DOCS_DEMO_SKILLS_LANGUAGES = Object.keys(CONTENT)

const day = 86_400_000
const iso = time => new Date(time).toISOString()
const value = result => result.value

function writeChangesets(workspace) {
  const directory = join(workspace, '.changeset')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'README.md'), '# Changesets\n\nRun `pnpm changeset` to add one.\n')
  for (const entry of CHANGESETS['2.4.0']) writeFileSync(join(directory, `${entry.file}.md`), changesetFile(entry))
}

function writeCatalog(directory, content, language) {
  for (const entry of content.catalog.skills) {
    mkdirSync(join(directory, 'skills', entry.name), { recursive: true })
    writeFileSync(join(directory, 'skills', entry.name, 'SKILL.md'), skill(entry.name, entry.description, entry.body))
  }
  const local = (_language, text) => ({ [language]: text })
  const catalog = {
    version: 1,
    id: 'lumen-team',
    name: local(language, content.catalog.name),
    categories: content.catalog.categories.map(category => ({ id: category.id, label: local(language, category.label) })),
    skills: content.catalog.skills.map(entry => ({
      name: entry.name, title: local(language, entry.title), description: local(language, entry.description), category: entry.category,
      author: 'Lumen platform team', license: 'MIT', version: '1.0.0', source: { type: 'path', path: `skills/${entry.name}` },
    })),
  }
  const path = join(directory, 'catalog.json')
  writeFileSync(path, JSON.stringify(catalog, null, 2) + '\n')
  return path
}

const proposed = entry => ({ title: entry.title, prompt: entry.context === undefined ? entry.prompt : `${entry.prompt}\n\n${entry.context}`, checks: entry.checks })

function caseResult(entry, run) {
  const checks = entry.checks.map((check, index) => ({ checkId: check.id, pass: run.checks[index], note: run.notes[index] }))
  const weight = check => check.must ? 2 : 1
  const total = entry.checks.reduce((sum, check) => sum + weight(check), 0)
  const passed = entry.checks.reduce((sum, check, index) => sum + (run.checks[index] ? weight(check) : 0), 0)
  return {
    caseId: entry.id, title: entry.title, verdict: entry.checks.every((check, index) => !check.must || run.checks[index]) ? 'pass' : 'fail',
    score: passed / total, checks, steps: run.steps, answer: run.answer, summary: '',
  }
}

export async function seedDocsDemoSkills({ runner, scope, workspace, catalogDir, language }) {
  const content = CONTENT[language]
  if (content === undefined) throw new Error('Unknown docs demo language: ' + language)
  writeChangesets(workspace)
  const skills = await runner.managementClient('source:skills', scope)
  const mutate = async (operation, input) => value(await skills.mutate(operation, input, { confirmed: true }))
  const read = async (operation, input = null) => value(await skills.read(operation, input))
  const field = (text, key) => { const raw = text.match(new RegExp(`^${key}: (.+)$`, 'mu'))[1]; return raw.startsWith('"') ? JSON.parse(raw) : raw }
  const create = (root, text) => mutate('skill-create', { root, name: field(text, 'name'), description: field(text, 'description'), content: text })

  await create('user-dsh', content.skills.releaseNotesPersonal)
  const release = await create('project-dsh', content.skills.releaseNotesFirst)
  await mutate('skill-save', { key: release.key, content: content.skills.releaseNotes, expectedHash: release.hash })
  await create('project-dsh', content.skills.incidentReview)
  await create('project-agents', content.skills.checkoutPerf)
  await create('user-dsh', content.skills.prDescription)
  const sql = await create('user-agents', content.skills.sqlExplain)
  await mutate('skill-invocation', { key: sql.key, modelInvocable: false, userInvocable: true, expectedHash: sql.hash })

  for (const key of ['grouping', 'bilingual']) await mutate('case-save', { skillName: 'release-notes', ...content.cases[key] })

  const now = Date.now()
  const record = async (key, at) => {
    const review = content.reviews[key]
    const steps = review.steps.map((step, index) => ({ ...step, index: index + 1, at: iso(at - (review.steps.length - index) * 40_000) }))
    const tools = steps.filter(step => step.kind === 'tool')
    const skillsUsed = [...new Set(steps.filter(step => step.kind === 'skill').map(step => step.skill.name))]
    return mutate('review-record', {
      review: { at: iso(at), sessionId: `docs-demo-${key}`, sessionTitle: review.title, trigger: 'automatic', durationMs: 18_400, outcome: 'suggested', summary: review.summary, turn: Math.max(...steps.map(step => step.turn)) },
      trajectory: {
        sessionId: `docs-demo-${key}`, sessionTitle: review.title, workspace: scope.workspaceId, startedAt: steps[0].at, endedAt: iso(at - 20_000),
        stats: {
          turns: Math.max(...steps.map(step => step.turn)), userCharacters: steps.filter(step => step.kind === 'user').reduce((sum, step) => sum + step.text.length, 0),
          toolCalls: tools.length, toolFailures: tools.filter(step => !step.tool.ok).length, uniqueTools: new Set(tools.map(step => step.tool.name)).size, skills: skillsUsed,
        },
        steps,
      },
      annotations: review.annotations,
      suggestions: [review.suggestion],
      cases: review.cases.map(name => ({ skillName: review.suggestion.skillName, ...proposed(content.cases[name]), steps: review.suggestion.steps.slice(-1) })),
    })
  }

  const incident = await record('incident', now - 3 * day)
  const draft = await mutate('draft-record', { suggestionId: incident.suggestionIds[0], skillName: 'incident-review', content: content.skills.incidentReviewAdopted, ...content.reviews.incident.draft, guidance: [] })
  await mutate('draft-adopt', { id: draft.id })
  await mutate('case-save', { skillName: 'incident-review', ...content.cases.causes })
  const checkout = await record('checkout', now - 2 * day)
  await mutate('suggestion-dismiss', { id: checkout.suggestionIds[0] })
  const backfill = await record('backfill', now - day)
  if (backfill.trajectoryId !== undefined) await mutate('trajectory-pin', { id: backfill.trajectoryId, pinned: true })

  const backtest = async (skillName, runs) => {
    const cases = await read('cases', { skill: skillName })
    const { target } = await read('target-content', { skillName, target: { kind: 'current' } })
    const run = await mutate('run-start', { skillName, target, caseIds: cases.map(entry => entry.id) })
    for (const entry of cases) await mutate('run-progress', { id: run.id, result: caseResult(entry, runs[Object.keys(content.cases).find(key => content.cases[key].title === entry.title)]) })
    await mutate('run-finish', { id: run.id, status: 'completed' })
  }
  await backtest('incident-review', content.runs)
  await backtest('checkout-perf-check', content.runs)

  await mutate('registry-add', { location: writeCatalog(catalogDir, content, language) })
}

const messageText = message => typeof message?.content === 'string' ? message.content : (message?.content ?? []).map(block => block.text ?? '').join('\n')

function systemText(request) {
  return (request.messages ?? []).filter(message => message.role === 'system').map(messageText).join('\n')
}

function parseChangesets(text) {
  return [...text.matchAll(/\.changeset\/([\w-]+)\.md\n---\n"(@lumen\/[\w-]+)": (major|minor|patch)\n---\n\n(.+?) \(#(\d+)\)\./gu)]
    .map(match => ({ file: match[1], pkg: match[2], bump: match[3], en: match[4], pr: Number(match[5]), zh: BY_PR.get(Number(match[5]))?.zh ?? match[4] }))
}

function releaseRules(skillText) {
  return {
    group: /按包分组|Group the entries by package/iu.test(skillText),
    breakingFirst: /major 改动的包排在最前|major change come first/iu.test(skillText),
    skipInternal: /略去摘要以 `internal:`|Leave out changes whose summary starts with `internal:`/iu.test(skillText),
    upgrade: /升级步骤|upgrade steps/iu.test(skillText),
  }
}

const bullet = (text, pr, field) => field === 'en' ? `- ${text} (#${pr}).` : `- ${text}（#${pr}）。`

function releaseNotes(changesets, rules) {
  const entries = rules.skipInternal ? changesets.filter(entry => !entry.en.startsWith('internal:')) : changesets
  const section = (heading, field) => {
    if (!rules.group) return `## ${heading}\n\n${entries.map(entry => bullet(entry[field], entry.pr, field)).join('\n')}`
    const packages = [...new Set(entries.map(entry => entry.pkg))]
    const breaking = pkg => entries.some(entry => entry.pkg === pkg && entry.bump === 'major')
    const ordered = rules.breakingFirst ? [...packages.filter(breaking), ...packages.filter(pkg => !breaking(pkg))] : packages
    const line = entry => {
      const text = entry[field]
      if (entry.bump !== 'major') return bullet(text, entry.pr, field)
      return field === 'en' ? bullet(`**Breaking:** ${text.replace(/^Breaking: /u, '')}`, entry.pr, field) : bullet(`**破坏性变更：**${text.replace(/^破坏性变更：/u, '')}`, entry.pr, field)
    }
    const inPackage = pkg => {
      const own = entries.filter(entry => entry.pkg === pkg)
      return rules.breakingFirst ? [...own.filter(entry => entry.bump === 'major'), ...own.filter(entry => entry.bump !== 'major')] : own
    }
    return `## ${heading}\n\n${ordered.map(pkg => `### ${pkg}\n${inPackage(pkg).map(line).join('\n')}`).join('\n\n')}`
  }
  const upgrade = rules.upgrade && entries.some(entry => entry.bump === 'major') ? '\n\n## Upgrade steps\n\n- Point clients at the new endpoints listed above.' : ''
  return `${section('English', 'en')}\n\n${section('中文', 'zh')}${upgrade}`
}

function judgeCheck(check, answer) {
  const bullets = answer.split('\n').filter(line => line.startsWith('- '))
  const chinese = answer.split('## 中文')[1] ?? ''
  if (/internal/iu.test(check)) return !/internal/iu.test(answer)
  if (/升级|upgrade/iu.test(check)) return /## Upgrade steps|升级步骤/iu.test(answer)
  if (/分组|heading per package/iu.test(check)) return /### @lumen\//u.test(answer)
  if (/破坏性|breaking/iu.test(check)) return /Breaking|破坏性/u.test(bullets[0] ?? '')
  if (/PR/u.test(check)) return bullets.length > 0 && bullets.every(line => /#\d+/u.test(line))
  if (/英文和中文|English and a Chinese/iu.test(check)) {
    const english = (answer.split('## 中文')[0] ?? '').split('\n').filter(line => line.startsWith('- ')).length
    return answer.includes('## English') && chinese !== '' && english === chinese.split('\n').filter(line => line.startsWith('- ')).length
  }
  if (/路径|paths/iu.test(check)) return /\/(?:v2\/)?reports|@lumen\//u.test(chinese)
  return undefined
}

export function skillsDemoModel(language, report) {
  const content = CONTENT[language]
  if (content === undefined) throw new Error('Unknown docs demo language: ' + language)
  return request => {
    const system = systemText(request)
    const messages = request.messages ?? []
    const task = messages.filter(message => message.role === 'user').map(messageText).join('\n')
    const complete = result => {
      const completion = delegatedCompletion(request)
      if (completion === undefined) throw new Error('a skill task reached the docs demo without its completion protocol')
      return { name: completion.name, args: completion.wrap(result) }
    }

    if (system.includes('You are Mnemon\'s skill evolution reviewer')) {
      const steps = [...task.matchAll(/^\[(\d+)\] turn (\d+) · (user|assistant|skill loaded: ([\w-]+)|tool [^\n]*)/gmu)].map(match => ({ index: Number(match[1]), line: match[0], skill: match[4] }))
      const user = [...task.matchAll(/^\[(\d+)\] turn \d+ · user:\n((?: {4}.*\n?)+)/gmu)].map(match => ({ index: Number(match[1]), text: match[2] }))
      const correction = user.find(step => content.correction.test(step.text))
      const loaded = steps.find(step => step.skill === 'release-notes')
      if (correction === undefined || loaded === undefined) {
        report({ event: 'skill-review', outcome: 'nothing' })
        return complete({ outcome: 'nothing', summary: content.review.nothing, annotations: [], suggestions: [], cases: [] })
      }
      const cited = [loaded.index, correction.index, ...steps.filter(step => step.index > correction.index && /assistant/u.test(step.line)).map(step => step.index).slice(0, 1)]
      report({ event: 'skill-review', outcome: 'suggest', steps: cited })
      return complete({
        outcome: 'suggest', summary: content.review.summary,
        annotations: [
          { step: loaded.index, signal: 'skill-gap', note: content.review.annotations.skill },
          { step: correction.index, signal: 'correction', note: content.review.annotations.correction },
          { step: correction.index, signal: 'directive', note: content.review.annotations.directive },
        ],
        suggestions: [{ skillName: 'release-notes', action: 'update', ...content.review.suggestion, confidence: 0.86, signals: ['correction', 'directive', 'skill-gap'], steps: cited }],
        cases: [{ skillName: 'release-notes', ...proposed(content.cases.internal), steps: [correction.index] }],
      })
    }

    if (system.includes('You are Mnemon\'s skill author')) {
      report({ event: 'skill-draft' })
      if (!/the skill "release-notes"/u.test(task)) throw new Error('the docs demo drafts only release-notes')
      return complete({ content: content.skills.releaseNotesDraft, notes: content.draft.notes, changes: content.draft.changes })
    }

    if (system.includes('You are running one eval case of a DSH skill in a simulation')) {
      const skillText = task.match(/<skill_content name="[^"]+">\n([\s\S]*?)\n<\/skill_content>/u)?.[1] ?? ''
      const changesets = parseChangesets(task)
      if (!/name: release-notes/u.test(skillText) || changesets.length === 0) return complete({ steps: [content.executor.generic], answer: content.executor.genericAnswer })
      const rules = releaseRules(skillText)
      const internal = changesets.filter(entry => entry.en.startsWith('internal:')).map(entry => `${entry.file}.md`)
      const breaking = changesets.find(entry => entry.bump === 'major')?.pkg
      const steps = [
        content.executor.read(changesets.length),
        ...(rules.skipInternal && internal.length > 0 ? [content.executor.skip(internal.join(', '))] : []),
        rules.group ? content.executor.group(rules.breakingFirst && breaking !== undefined ? breaking : changesets[0].pkg) : content.executor.list,
        content.executor.languages,
      ]
      report({ event: 'skill-execute', rules })
      return complete({ steps, answer: releaseNotes(changesets, rules) })
    }

    if (system.includes('You grade one eval case of a DSH skill')) {
      const checks = [...task.matchAll(/^(\d+)\. \[(must|should)\] (.+)$/gmu)].map(match => ({ index: Number(match[1]), must: match[2] === 'must', text: match[3] }))
      const answer = task.split('\nAnswer:\n')[1] ?? ''
      const graded = checks.map(check => {
        const pass = judgeCheck(check.text, answer) ?? check.must
        return { index: check.index, pass, note: pass ? content.judge.pass : content.judge.fail }
      })
      report({ event: 'skill-judge', passed: graded.filter(check => check.pass).length, total: graded.length })
      return complete({ checks: graded, summary: content.judge.summary(graded.filter(check => check.pass).length, graded.length) })
    }

    if (/Completion protocol: call `/u.test(system)) return undefined
    const lastReply = messages.findLastIndex(message => message.role === 'assistant' && (message.tool_calls ?? []).length === 0 && messageText(message).trim() !== '')
    const asked = messages.slice(lastReply + 1).filter(message => message.role === 'user').map(messageText).join('\n')
    if (asked.startsWith('Generate the session title') || /^Generate the session title/mu.test(asked)) return content.releaseRequest.test(asked) ? content.title : undefined
    const tools = new Set((request.tools ?? []).map(tool => tool.function?.name))
    const changesets = CHANGESETS['2.4.0']
    if (content.correction.test(asked)) {
      report({ event: 'release-notes', turn: 'correction' })
      return content.conversation.second(releaseNotes(changesets, { group: true, breakingFirst: true, skipInternal: true, upgrade: false }))
    }
    if (!content.releaseRequest.test(asked)) return undefined
    const calls = messages.slice(lastReply + 1).filter(message => message.role === 'assistant').flatMap(message => message.tool_calls ?? []).map(call => call.function.name)
    if (tools.has('skill') && !calls.includes('skill')) return { name: 'skill', args: { name: 'release-notes' } }
    if (tools.has('mnemon_document_search') && !calls.includes('mnemon_document_search')) return { name: 'mnemon_document_search', args: { query: content.checklistQuery, limit: 3 } }
    const read = calls.filter(name => name === 'read').length
    if (tools.has('read') && read < changesets.length) return { name: 'read', args: { file_path: `.changeset/${[...changesets].sort((a, b) => a.file.localeCompare(b.file))[read].file}.md` } }
    report({ event: 'release-notes', turn: 'first', reads: read })
    return content.conversation.first(releaseNotes([...changesets].sort((a, b) => a.file.localeCompare(b.file)), { group: false, breakingFirst: false, skipInternal: false, upgrade: false }))
  }
}
