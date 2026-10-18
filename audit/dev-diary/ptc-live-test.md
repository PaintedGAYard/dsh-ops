# PTC 实战测试 · 交接件

目的：`dsh-ops` 最深的一跳 —— `ops_batch` → `prepareWorkspace` → `sandbox.confine` → 宿主 ACL runner → 受限子进程 —— **从未被真实执行过**。这次只取证据，不修任何东西。

## 给用户的三步

1. **新建一个会话**（同一个 GUI、同一个 workspace）。新会话默认是 `ptc` preset（`agent-preset-registry.selectedDefault: ptc`）；若工具表里不是只有 `run_code`，在会话还空着时用预设选择器切到 `ptc`。
2. **把下面 `=== BRIEF START ===` 到 `=== BRIEF END ===` 之间的内容整段发给它。**
3. 把它回答里 `=== PTC-REPORT ===` 那一块**原样复制**给我。它可能很长，也可能只有几行 —— 两种都有用。

> 关键前提：**那个会话可能一条工具都用不上**（`run_code` 自己起不来时就是如此）。所以交接件要求它把证据**写在回答正文里**，不依赖任何工具、不依赖它写文件。我这边会用 `.dsh-probe/handoff/summarize-trace.mjs` 去读 trace。

---

=== BRIEF START ===

你被要求执行一次**只取证据的探针**。不要修任何东西，不要重试，不要绕过限制。

背景一句：`dsh-ops` 有一条执行路径从未被真实跑过（它要把一个 Rust worker 交给宿主沙箱的 ACL runner 再转到受限令牌子进程）。这次就是要看它在真实环境里到底走到哪一步、在哪一步断。

**绝对不要做**：修改任何文件、重启宿主、安装任何东西、更改配置、打开/关闭插件行。

## 第 0 步 · 环境确认

报告两件事：

- 你的工作目录（cwd）应该是 `E:\Users\David\Source\Playgrounds\etc`；
- 你当前能看到的工具名列表。在 PTC 模式下它应该只有 `run_code` 一个。

如果 cwd 不是上面那个路径，**仍然继续**，但要在报告里写明实际 cwd。

## 第 1–5 步 · 探针阶梯

每一步用**独立的一次 `run_code` 调用**，这样上一步失败不会把下一步也吞掉。PTC 的调用约定是：脚本里 `await tools.<工具名>(参数)`，然后 `return`。

**C1（控制组）** —— 先确认嵌套工具桥能不能到达宿主工具。注意 `pwsh` 的 `description` 是**必填**（第一次实测就是漏了它才报 `invalid arguments: missing required property "description"`）：

```js
return await tools.pwsh({ description: 'PTC bridge control probe', command: 'echo ptc-ok' })
```

**C2（靶子）** —— 走到 dsh-ops 的深层路径。注意：`action: 'plan'` 就足以触发 worker 启动与沙箱，即使它自己不产生写入：

```js
return await tools.ops_batch({
  action: 'plan',
  operations: [{ op: 'copy', path: '.dsh-probe/handoff/x1-report.json', to: '.dsh-probe/handoff/ptc-copy.json' }],
})
```

**C3** —— 如果 C2 返回里带 `id`，用它执行同一条计划（会产生一次真实复制，只会落在 `.dsh-probe/handoff/` 里）：

```js
return await tools.ops_batch({ action: 'resume', id: '<把 C2 的 id 填在这里>' })
```

**C4** —— 读回审计记录：

```js
return await tools.ops_result({ action: 'page', id: '<C2 或 C3 返回的 id>' })
```

每一步的规则都一样：

- 成功：把**返回值原样**留下（它是 JSON，不要改写、不要摘要）。
- 失败：把**错误原文逐字**留下（包括 `code`、`message`、任何堆栈）。**不要重试**。
- 该工具不存在：写明 `UNAVAILABLE: <工具的准确名字>` 或 `NO SUCH TOOL`。

## 第 6 步 · 报告（唯一必须做的事）

在你的回答**最后**放一个这样的块。这是给我复制用的，格式请照抄；没有的内容写 `n/a`，失败的内容写原文：

```
=== PTC-REPORT ===
PRESET: <你能判断的 preset 名，或 "unknown">
CWD: <实际 cwd>
TOOLS: <工具名列表，或 "only run_code"，或 "none">
C1 pwsh: <原样结果 / 错误原文 / UNAVAILABLE>
C2 plan: <原样结果 / 错误原文 / UNAVAILABLE>
C3 resume: <原样结果 / 错误原文 / "skipped: no id" / UNAVAILABLE>
C4 page: <原样结果 / 错误原文 / UNAVAILABLE>
NOTES: <其它异常，最多 10 行>
=== END ===
```

要求：错误原文照抄，不要润色成「失败了」；整块尽量控制在 60 行内。

## 如果完全没有工具

如果你连 `run_code` 都不可用：**不要尝试任何补救**，直接输出上面那个块，`TOOLS: none`，其余写 `n/a`，并在 `NOTES` 里写你看到的情况。这份报告本身就是结论。

=== BRIEF END ===

---

## 报告回来之后我做什么

1. 跑 `node .dsh-probe/handoff/summarize-trace.mjs --since <最新 pid>` 看 trace 里有没有 `worker{component:'ptc'}`。
2. 按 `handoff-failure-modes.md` §2.5 / `blockers.md` K3 的失败矩阵裁定，判定它落在哪一格。
3. 写进 `dev-diary/`，再谈 K1/K2/K4/K5 的取舍。

---

## 已执行一次（2026-10-18 18:32）· 结果与可复用要点

**结论：通过。** 顶层只有 `run_code`，嵌套桥 31 个工具（含 `ops_batch`/`ops_result`），`plan→resume→page` 全程成功；trace 出现 3 条
`worker{component:'ptc', runnerWrapped:true, mode:'workspace-write', enforcement:'partial', exitCode:0, dur 243–249 ms}`，
argv 正是 `[node, runner.js, --workspace … --temp … --mode … --write-sid … --temp-write-sid … --, dsh-ops-worker.exe]`。
副作用仅 `.dsh-probe/handoff/ptc-copy.json`，1338 B、与源逐字节一致。

复用时注意三点：

1. `pwsh` 需要 `description`（C1 已改）。
2. `enforcement:'partial'` 是**正常值**，不是退化：ACL 包只保证写限制；宿主还会附一行 `File sandbox enforcement is partial on this host.`。
3. 若想让 **B1 准备**在 PTC 路径上被观测到，必须在**重启后的宿主里先跑 PTC**（root 未缓存时才会真正 spawn 5.1）。

## 判据速查（我用的）

| 现象 | 结论 |
|---|---|
| `TOOLS: only run_code` 且 C2 成功、trace 有 `worker{component:'ptc', exitCode:0, runnerWrapped:true}` | 深层路径可用，I4 首次被验证 |
| C1、C2 都失败且错误相同 | 问题在 PTC 桥/运行时，不在 dsh-ops |
| C2 报「不是函数」类错误 | dsh-ops 的 PTC 发布门槛没过或 `dsh-ops-ptc` 未加载 |
| trace 出现 `worker{outcome:'settle-failed'}` | ACL runner / worker 没起来（`0xC0000142` 一类） |
| trace 出现 `runnerWrapped:false` | 沙箱没套上，比失败更严重 |
| trace 无任何新记录 | `run_code` 没到插件；证据只有 PTC-REPORT |
