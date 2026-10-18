// One-off: reorder the audit diary so the Phase sections read 0,1,2,3,…,8.
// Pure line surgery, verifies the heading order before writing.
import fs from 'node:fs'

const file = 'E:\\Users\\David\\Source\\Playgrounds\\etc\\dev-diary\\2026-10-18-execution-handoff-audit.md'
const lines = fs.readFileSync(file, 'utf8').split('\n')
const at = heading => {
  const i = lines.findIndex(line => line === heading)
  if (i < 0) throw new Error(`heading not found: ${heading}`)
  return i
}

const a = at('## Phase 5 记录：logging 补齐 + 部署（重启后）')
const b = at('## Phase 3 记录：全量裁定')
const c = at('## 下一步')

const before = lines.slice(0, a - 2)
const mid = lines.slice(a - 2, b - 2)      // Phase 5..8, with its leading separator
const phases34 = lines.slice(b - 2, c - 2) // Phase 3..4, with its leading separator
const tail = lines.slice(c - 2)

const reordered = [...before, ...phases34, ...mid, ...tail]
const order = reordered.filter(line => /^## /.test(line))
const expected = [
  '## 目标（冻结，不再改）', '## 范围', '## 决定日志', '## 认知修订日志', '## 本轮新增的关键观测',
  '## 开放问题', '## 现行状态（干净基线）', '## Phase 0 执行记录', '## Phase 1 记录',
  '## Phase 2 记录：handoff trace', '## Phase 3 记录：全量裁定', '## Phase 4 记录：K9 —— 准备步骤是不是宿主必需',
  '## Phase 5 记录：logging 补齐 + 部署（重启后）', '## Phase 6 记录：真宿主第一组记录，与一个意外',
  '## Phase 7 记录：B1 在真宿主上成立（并撤回 Phase 6 的推断）', '## Phase 8 记录：机器冷启动 + ASLR 之后，以及 X2/X3 收口',
  '## 下一步',
]
if (JSON.stringify(order) !== JSON.stringify(expected)) {
  console.error('ABORT — unexpected order:')
  console.error(order.join('\n'))
  process.exit(1)
}
fs.writeFileSync(file, reordered.join('\n'))
console.log(`reordered OK, ${order.length} level-2 headings`)
