# audit · dsh-ops 启动路径 execution handoff 审计（结案）

日期 2026-10-18。基线 `upstream v0.3.1`（`541b480`）。**本目录不是补丁。**

## 一句话结论

> 本机「dsh-ops 不可用」的病因是**版本**：`0.3.0`（npm `latest`）在两个独立条件下必挂，而 `v0.3.1` 从未发布到 npm。
> 修复来自上游 `#83` + `#86`，交付形式是 `v0.3.1`。我们的产出是**可复现的部署 + 可归因的观测**，
> **没有修改任何产品行为**。

## 当前部署状态（`evidence/deploy-receipt.json`）

| 项 | 值 |
|---|---|
| profile 声明 | `dsh-ops: file:C:/Users/david/AppData/Local/dsh-ops-src/0.3.1` |
| 来源 | GitHub 标签归档（`40E4AC36…8132`）+ release 运行时资产（worker `89B8E1E9…C8225`） |
| 安装副本 | `0.3.1`；`lib/` 下 50 个文件与 staging 逐个 sha256 一致，**零漂移** |
| 插桩构建是否在跑 | **否**（`auditBuildDeployed: false`）；无 `lib/trace.js` |

## 这个分支上有什么

分支 `audit/handoff-trace`（基于 `541b480`，5 个提交）**只含观测代码**：10 个文件、+833/−10，全部是
`lib/trace.js`（新模块）、各边界处的记录调用、以及 `test/trace.test.mjs`（14 项断言）。
没有改判定条件、错误处理、返回值或兜底 —— `catch` 里都是记录后原样重抛。
零回归的证据：全量套件的失败集与 pristine v0.3.1 逐字相同。

## 审计确立了什么（每条都能指向证据）

| # | 结论 | 证据 |
|---|---|---|
| 1 | `0.3.0` 的准备 spawn **既无 `env` 也无 `-ExecutionPolicy Bypass`** —— 两个独立失败类，`v0.3.1` 全修 | `dev-diary/2026-10-18-execution-handoff-audit.md` §4 |
| 2 | 故障的触发条件是**顺序**：`PSModulePath` 里 pwsh 7 的模块根排在 inbox 根之前才致死；**污染本身无害**；毒根不在注册表里，只由 pwsh 7 注入 | 同上 §3；`evidence/prep-env-probe2.json` |
| 3 | 「上游报告与我们的观测不一致」**主因是版本，不是理解**：四个报告无一错误，分成执行策略类与模块解析类，#94 系列另给出 MOTW 与出厂默认差异两条我们原先没有的事实 | `dev-diary/consistency-audit.md` |
| 4 | **K9 半成立**：准备步骤的前置条件真实（宿主 ACL `grantWrite` 要 `WRITE_OWNER`），但「Full-control 工作区两条都满足」→ 对本机是空操作；缺陷在**无条件执行并把空操作的失败当致命**，不在准备本身 | `dev-diary/2026-10-18-execution-handoff-audit.md` Phase 4 |
| 5 | **PTC 深层路径可用**：3 条 `worker{component:'ptc', runnerWrapped:true, enforcement:'partial', exitCode:0}`，argv 为 `[node, runner.js, --workspace … --temp … --mode … --write-sid … --temp-write-sid … --, dsh-ops-worker.exe]` —— 不变量 I4 首次被验证 | `dev-diary/ptc-live-test.md`、Phase 9 |
| 6 | 真宿主 B1 跑通（252–277 ms）且**不变量可断言**：`spawn.inheritsConsole:false` 与 `env.psModulePath.present:false` | `evidence/trace-summary.txt` |

## 没有做什么

- **没有产品补丁**。`#146` 的建议 B（把两条 `Get-Acl` 换成 `[System.IO.Directory]::GetAccessControl`）仍未实现：`v0.3.1` 已在 spawn 层切断继承，我们再也复现不出它的失败场景，它因此从"修病"降级为"防回归"。
- **没有碰 upstream**：无 PR、无 issue、无评论、无 push 到 `T-Auto/dsh-ops`。
- **`ops_bash` 未取证**：用户决定不使用 bash 子系统（D10），配置层永久关闭，属范围外。
- `#112`（可用性闸门）与 `#106`（预检顺序）是上游设计问题，未实现。

## 目录

| 路径 | 内容 |
|---|---|
| `dev-diary/` | 主线日记（决定 D1–D10、修订 R1–R10、Phase 0–10）、主张表 K1–K17、上游裁定、失效模式目录、blocker 清单、PTC 交接件 |
| `tools/deploy-official-0.3.1.ps1` | 从 GitHub 取官方 `v0.3.1`（标签归档 + release 运行时），摘要校验后组装并安装。**只用 Windows 原生工具**：PowerShell + .NET + 7-Zip |
| `tools/phase0-install.ps1` | 安装器：自解析 CLI、重定向捕获、瞬时错误重试、成功即不回滚。被上一个脚本调用 |
| `tools/summarize-trace.mjs` | 只读汇总 `handoff.jsonl` 并判不变量 I1–I5 |
| `tools/probes/` | 一次性探针：PSModulePath 矩阵、X1/X4、部署冒烟、钩子挂载诊断 |
| `evidence/` | 探针报告、套件结果、`trace-summary.txt`、部署 receipt |
| `submissions/` | **已冻结的旧草稿**，见其中的 `STATUS.md`：`I1` 仍有效，`I2` 作废 |

## 怎么复现

```powershell
# 1. 官方 v0.3.1（DSH 必须先停）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\deploy-official-0.3.1.ps1 -Plan
powershell -NoProfile -ExecutionPolicy Bypass -File tools\deploy-official-0.3.1.ps1 -Zero

# 2. 换回本分支的插桩构建取证（同一条安装路径，换源）
#    目前需手工把这棵树装进 profile；trace 默认关闭，
#    开启方式：$env:DSH_OPS_TRACE=1，或写 <DSH_HOME>\dsh-ops\trace.on（免重启）

# 3. 读记录
node tools\summarize-trace.mjs --since <pid>
```

## 有意没有进仓库的东西

| 排除 | 原因 |
|---|---|
| 原始 `handoff.jsonl`（52 KB） | 含绝对路径与临时能力 SID；仓库只需可复算的汇总（`evidence/trace-summary.txt`） |
| download 缓存（`*.tar.gz`、运行时 zip，2.7 MB） | 可由 URL + 摘要重建 |
| 备份与 session 导出 | 与结论无关，属本机私有状态 |
| `evidence/upstream/` 的 issue 原文 | 抓取时网络不可达；结论引用的原文段落已完整抄进 `dev-diary/consistency-audit.md` |

## 未结的两条工程项

- **K4** 安装/升级路径：`dsh plugin add` 需停机，而执行安装的工具由该宿主提供（引导悖论，现靠全局 `dsh` + `--dsh-cli` 缓解）。
- **K5** `npm run verify` 从未全绿：两个工作树缺 `node_modules` 与 Rust 构建，13 个套件在**基线**上同样失败。在此之前任何 PR 都不该声称 verified。
