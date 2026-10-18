# 主张表（claims register） · v4

用途：把仓库里**写着**的断言逐条对照观测。状态只有三种：`verified` / `contradicted` / `unverified`。
不是提交清单，也不是目标 —— 它服务于两件事：让我们自己的模型保持最新；将来提 issue 时是原始素材。

更新规则：状态变化必须同时写进 `2026-10-18-execution-handoff-audit.md` 的修订日志。

**基线**：upstream `v0.3.1`（commit `541b4801910afbbd4394e4d8690bf26d41f2c745`），profile 已按此归零。
v1 是基于 `0.3.0` 安装副本写的；v2 全部重新在 v0.3.1 原文上核对。
**v3（Phase 1 收尾）**：新增 K13/K14；K1/K4 由 `contradicted` 改判 `verified`（机理逐字吻合，只是缺「顺序 + 控制台句柄」两个条件）；K3 的「唯一一处」改判为「语义不同，不该合并」。证据列全部换成 Phase 1 的实测矩阵（`dev-diary/2026-10-18-execution-handoff-audit.md` §2–§3）。
**v4（Phase 3 裁定后）**：新增 K15/K16；K6 改判 `verified（与本主题无关）`；K9 补入外部佐证。上游四条报告的裁定见 `dev-diary/consistency-audit.md`。

| ID | 出处 | 断言 | 状态 | 证据 |
|---|---|---|---|---|
| K1 | `lib/workspace-preparation.js` 的 `preparationEnvironment()` 文档（v0.3.1 仍在） | 5.1「按顺序先命中 .NET Core 副本，因其扩展类型数据与 inbox 副本冲突而加载失败」 | **verified（机械吻合，补一个条件）** | 失败文本逐字吻合：`The member AuditToString is already present` → `Get-Acl` CommandNotFound。**补充条件**：只在本插件的 spawn 形状下成立 —— 任一 stdio 重定向/无控制台时 5.1 照收继承值；附着控制台时它整体改写变量、污染被清除（与 `windowsHide` 无关，用 `windowsHide:false` 对照仍失败）。且**只有 Core 根排在 inbox 之前**才致死。见日记 Phase 1 §2–§3 |
| K2 | 同上 | 「只删 `PSModulePath`；PATH、SystemRoot、DSH_HOME 是子进程自己的输入」 | **contradicted（部分）** | `DSH_HOME` 在父进程里算好后以 `-BackupDir` 传入，子进程并不需要该变量；PATH/SystemRoot 确实需要 |
| K3 | `PROVENANCE.md`「Two spawn paths, one credential policy」 | 两条 spawn 路径，一套凭证策略 | **contradicted（已部分修复）** | v0.3.1 新增 `lib/env.js` 的 **allow-list** `childEnv()`，`binary.js:400`（`probeBinary`）与 `tools.js:475`（FastCtx）已采用；`workspace-preparation.js:117` 用 `preparationEnvironment()`（语义不同：保留 PATH/HOME 给解释器，**不该**与 `childEnv` 合并）。工具启动路径上已无未清洗点，剩下 `rust.js:177`（cargo，开发工具）与 `profile-install.js:92`（安装器）。文档措辞未同步 |
| K4 | `test/permissions.test.mjs` 注释 | 与 K1 同因的表述 | **verified** | 同 K1（机理成立） |
| K5 | `PROVENANCE.md`「verified by mutation」 | spawn 已被断言覆盖 | **contradicted（范围，已收窄）** | v0.3.1 **确实**有跑真脚本的行为测试（`:145` Restricted 策略、`:155` DACL 只改根、`:181` AI 继承）；但 `runPreparation(root,{executable,args,timeoutMs})` **没有 env 覆盖入口**，敌意 `PSModulePath` 无法注入 → 「脚本依赖模块自动加载」这一类仍未被钉住 |
| K6 | `#43` / `#74` | 10 s → 120 s 是常量时间化与超时修复 | **verified（与本主题无关）** | `v0.3.0` 的 `setTimeout(..., 10000)` 硬编码与 `v0.3.1` 的 `PREPARATION_TIMEOUT_MS = 120_000` 均在源码确认；我们的失败是脚本秒退，与超时无关。`#112` 把超时路径当第三个「全局闸门」实例，成立 |
| K7 | `PROVENANCE.md:112` | `0xC0000142` 属 DSH 宿主 ACL runner、插件不修 | **unverified** | #41/#92 把它报在插件侧；可能是两个不同的 `0xC0000142`（ACL runner vs MSYS fork） |
| K8 | `#112` | 无从在首次命令前得知前置结果 | **verified（有补充）** | 成立；但 `ready` 路径无副作用（不写 receipt、不动 DACL）→ 预检近乎免费，#112 未提 |
| K9 | `bin/prepare-workspace.ps1` 注释 | 「需要 `WRITE_OWNER` 才能设沙箱完整性标签」，故必须在宿主启动执行体前准备 | **verified（前提）· contradicted（必要性）** | 前提真实且属宿主：`@deepseek-ai/dsh-sandbox-windows-acl/lib/types/acl.d.ts:80-95` 的 `grantWrite()` 要求「目录归调用者所有 **且** 授予 `WRITE_OWNER`（标签在 SACL 里；owner 隐式只有 `READ_CONTROL`/`WRITE_DAC`）——**Full-control 工作区两条都满足**」。本机 `E:\…\etc`：owner 是自己 + 继承 `FullControl` → 两条都满足 → 脚本走 `ready`、不写 ACL → **准备对本机是空操作**。缺陷不在准备步骤，在 `tools/execute` 上无条件执行它并把空操作的失败当致命（K15/#112） |
| K10 | `lib/workspace-preparation.js` 的 `prepared` | 每个工作区根只准备一次 | **verified** | 模块级 `Set`，成功才写、永不过期、失败不写；`test/permissions.test.mjs:177-178` 断言 warm 路径不新增 receipt |
| K11 | v0.3.1 各 spawn 点 | `preparationEnvironment()` 是唯一未用 `childEnv()` 的 spawn | **verified** | spawn 点：`binary.js:401`（`:400` 已用 childEnv）、`handshake.js:134`（接收已清洗 env）、`tools.js:475`（用 childEnv）、`shells.js:1266` 与 `worker.js:71/128`（经宿主 subprocess 服务清洗）、`profile-install.js:92-93`（安装器，`stdio: inherit`）、`rust.js:47/177`（开发工具）；**只有 `workspace-preparation.js:117` 用 `preparationEnvironment()`** |
| K12 | `lib/profile-install.js` CLI 解析 | 「`--dsh-cli` → 桌面 CLI → `@deepseek-ai/dsh` 三个锚点 → 否则裸 `dsh.cmd` 交给 `cmd /c`」 | **contradicted** | npx 启动的宿主上唯一 launcher 在 npx 缓存、宿主停机后不可用；裸名回退又假设 PATH 可见。实测 `'"dsh.cmd"' is not recognized`。**引导悖论**：安装必须在宿主停机时做，而执行安装的工具由该宿主提供。缓解：全局安装 + 显式 `--dsh-cli` |
| K13 | `v0.3.0` vs `v0.3.1` 的准备 spawn | 0.3.0 起不来的原因 | **verified** | `git show v0.3.0:lib/workspace-preparation.js`：`spawn(..., { windowsHide:true, stdio:['ignore','pipe','pipe'] })` —— **无 `env` 选项**（必然继承毒）+ **无 `-ExecutionPolicy Bypass`**（#66 才加）。两个互相独立的失败类，v0.3.1 全修；而 v0.3.1 **从未发布到 npm**（`npm latest`=0.3.0）。这是「上游报告 ≠ 我们观测」的最强解释候选 |
| K14 | `bin/prepare-workspace.ps1` 对模块搜索路径的隐式依赖 | 环境变量只要污染就致命 | **contradicted（顺序敏感）** | 顺序决定成败、污染本身无害：`PS7;INBOX` 死，`INBOX;PF51;PS7` 活。毒源唯一 = `…\PowerShell\7\Modules`，**注册表里没有**（Machine 只有 inbox 两条、User 空），只由 pwsh 7 自己注入 → 触发条件 = **宿主由 pwsh 7 启动**。另：`PSModulePath=""` ≠ 删除（空串让 `Import-Module` 直接 FileNotFound） |
| K15 | `lib/workspace-preparation.js:139-145` | 准备是 `tools/execute` 上的闸门 | **verified** | 钩子覆盖 `run_code`/`pwsh`/`bash`/`*_persistent`，`await prepareWorkspace(...)` 在 `next()` 之前；一次失败即全量不可用，无降级。四个上游报告的共同可观测形状 |
| K16 | `lib/workspace-preparation.js:53` 文案 | 「既然已传 Bypass，再被拒就只能来自组策略」 | **contradicted** | `RemoteSigned` + 包内 `.ps1` 的 **Mark-of-the-Web** 同样拒绝未签名脚本，而 `MachinePolicy`/`UserPolicy` 可以都是 `Undefined`。Charlestam218 在 #94 给出对照实验（同脚本 ± `-ExecutionPolicy Bypass`） |
| K17 | `lib/ptc/worker.js`：`sandbox.confine` → `subprocess.spawn` | `workspace-write` 下的 `ops_batch` 必经宿主 ACL runner | **verified（10-18 18:32 首次）** | 3 条 `worker{component:'ptc', runnerWrapped:true, mode:'workspace-write', enforcement:'partial', exitCode:0}`，argv = `[node, runner.js, --workspace …, --temp …, --mode …, --write-sid …, --temp-write-sid …, --, dsh-ops-worker.exe]`。不变量 I4 由此首次被验证。注：`partial` 是 ACL 包自述的**部分保证**（只限写），不是退化 |
