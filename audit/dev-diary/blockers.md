# Blocker 清单 · 「在我的环境下解决 dsh-ops 启动痛点」

日期 2026-10-18。判据与 D-决定一致；每条都指向本会话里能复核的证据，不是印象。

**根本目的**：这台机器上 `dsh-ops` 不再因为启动路径让工具不可用；出问题时失败要能指名是哪一跳。

**"解决"的判据**

| # | 判据 | 现状 |
|---|---|---|
| S1 | profile 里**启用**的每条工具路径，冷启动后都能用 | 文件/准备 ✅（有记录）；PTC ✅（`runnerWrapped:true`）；bash **范围外**（D10：用户不用，配置层永久关闭） |
| S2 | 失败能定位到跳（trace 有记录） | 7 条边界已插桩；现场覆盖 5 条（bash 范围外、FastCtx 本组合不用、安装边界未验） |
| S3 | **部署的就是被测的**（无手工漂移） | ✅ 官方 v0.3.1 已归零部署（`%LOCALAPPDATA%\dsh-ops-src\0.3.1`，摘要在案） |
| S4 | 安装/升级不需要引导悖论 | ❌ |
| S5 | `npm run verify` 绿 | ❌ |

---

## 部署层

### K1 · 部署不可复现 —— ✅ **已关闭（10-18 19:54）**

| 事实 | 值 |
|---|---|
| profile 声明（现在） | `dsh-ops: file:C:/Users/david/AppData/Local/dsh-ops-src/0.3.1` |
| 这棵树的来源 | GitHub 标签归档 + release 运行时资产，摘要已校验（tarball `40E4AC36…8132`、worker `89B8E1E9…C8225`） |
| 安装方式 | `dsh-ops uninstall` → `dsh plugin add file:<staging>`（真归零，不是原地换 spec） |
| 官方性 | 安装副本 50 个 `lib/` 文件与 staging 逐个 sha256 一致；无 `lib/trace.js`、无 `traceHandoff` |
| 版本 / 运行时 | 安装副本 0.3.1；runtime receipt 0.3.1 `win32-x64`；worker 摘要与 release 资产一致 |

**之前的失效形态**（历史，留档）：profile 声明 `dsh-ops-base`（23 个 `lib/` 文件、无 `trace.js`），实际安装副本 24 个、9 个被手工覆盖 —— 一次 `pnpm install` 就会把运行中的构建换回基线。

**仍存在的一个细节（不是 blocker）**：`node_modules/dsh-ops` 是 pnpm 从 store 硬链接出来的**实体副本**（`linkType` 为空），不是指向 staging 的链接。它是**快照**：改 staging 不会自动生效，重跑一次 `deploy-official-0.3.1.ps1` 才同步。

**代价（诚实记录）**：归零后跑的是**官方构建**，没有 trace 代码。`handoff-failure-modes.md` 的现场观测能力只存在于插桩构建上；要再取证，把 `audit/handoff-trace` 那棵树按同一条安装路径部署回去。

**为什么是最高优先**：S1 里已经成立的部分，也建立在一次手工复制上。这不是"待优化"，是"随时会没"。

**可执行的解法（已就绪）**：`deploy-official-0.3.1.ps1`。它不做任何"手工复制"，而是从 GitHub 取两件**已发布**的东西 —— 标签归档 + release 原生运行时资产 —— 校验摘要、拼成一棵与发布完全一致的树（`%LOCALAPPDATA%\dsh-ops-src\0.3.1`），再交给 `phase0-install.ps1` 安装。

```powershell
# 只看会做什么，不动任何东西
powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy-official-0.3.1.ps1 -Plan
# 真跑（DSH 必须先停）
powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy-official-0.3.1.ps1 -Zero
```

| 开关 | 作用 |
|---|---|
| `-Zero` | 先 `uninstall` 再 `install`：真正的归零，而不是原地换 spec |
| `-NukeNodeModules` | 把 `node_modules` **改名**挪到一边（不是删除），安装未生效时自动改回来 |
| `-FromCache` | 完全离线，只用 `.dsh-probe\dl` 里已有的两件 |
| `-ReStage` | 重建 staging 树（默认已通过校验就跳过下载） |
| `-StageOnly` | 只取回、组装、校验 staging，**不碰 profile**：风险的一半可以单独先验 |

**工具链只用 Windows 原生的**：PowerShell 5.1 + .NET（`ZipFile` / `Get-FileHash` / `Invoke-WebRequest`）+ **7-Zip**（原生 PE，无 MSYS 层；负责唯一一件 .NET 4.x 干不了的事 —— 读 `.tar.gz`）。`System32\tar.exe` 是 bsdtar（libarchive 移植品），在这台机器上**无法创建 `docs/` 下五个中文名文档**、静默丢 5 个文件并返回一个看起来正常的树 —— 脚本里已完全不使用它。7-Zip 缺失时报错并给出 `winget install --id 7zip.7zip -e`。

**它门禁的是「官方性」**：`package.json` 必须是 0.3.1、**标签树必须正好 461 个文件**（含 `docs/` 下 5 个非 ASCII 名）、`lib/env.js` 必须在、**`lib/trace.js` 必须不在**、`lib/` 里不得出现 `traceHandoff`/`traceEvent(`、worker 的 sha256 必须等于 release 资产的 `89B8E1E9…C8225`。任一不满足就拒绝安装 —— 这正是 K1 的失效形态（把插桩树当成官方树）。

### K4 · 安装/升级路径

- `dsh plugin add` 在宿主运行时因插件目录被占用失败（`os error 32`，见日记 F8；持有者可以是 VS Code、资源管理器等任意进程）。
- 停机安装又没有可用 CLI —— 执行安装的工具由那个宿主提供（K12 引导悖论）；现靠"全局安装 `E:\NodeJS\dsh.cmd` + 显式 `--dsh-cli`"缓解。
- 现行唯一路径：`file:` 依赖 + 手工复制 + 提权。不可交付给用户自己复跑。

---

## 运行时层

### K2 · `ops_bash` —— ✅ **结案：范围外（D10，用户决定）**

- 用户明确**不使用** bash 子系统；`dsh-ops-shell` 在配置层保持 `disabled: true` 即可，**不改任何代码、不做结案测试**。
- 因此它不是缺口，而是**既定形态**：S1 的「启用路径」判据里不含 bash。
- 连带结论（对 D9/Q2 有用）：私有插件**不需要携带任何 bash payload**（`@dsh-ops/bash-win32-x64`、`vendor/bash`、`provision-shells --bash` 全都不必管），接管面因此更小。
- 若哪天要重新启用，取证方式仍然现成：把 `audit/handoff-trace` 部署回去，打开该行，看 `bash` 记录的 `runnerWrapped` / `exitCode` / `stderr`。

### K3 · PTC 零实战 —— ✅ **已关闭（10-18 18:32）**

- `ops_batch` → `lib/ptc/worker.js` → `prepareWorkspace` → `sandbox.confine` → ACL runner → 受限子进程。这是唯一每次执行都过 ACL runner 的路径。
- **10-18 18:32 首次实战通过**：3 条 `worker{component:'ptc', runnerWrapped:true, mode:'workspace-write', enforcement:'partial', exitCode:0}`，argv 是 `[node, runner.js, --workspace … --temp … --mode … --write-sid … --temp-write-sid … --, dsh-ops-worker.exe]`；`plan→resume→page` 全程 `status` 从 `planned` 走到 `completed`，副本逐字节一致（1338 B）。
- **不变量 I4 首次被验证**；A1–A6 全过。详见日记 Phase 9。
- 仍未取到：`0xC0000142`（K7）**没有出现**，所以对它的归因没有进展；B1 在 PTC 路径上的首次执行也未观测（root 当时已缓存，记为 Q8）。

---

## 工程层

### K5 · `npm run verify` 从未绿

- 两个工作树都没有 `node_modules`、没有 Rust 构建；13 个套件**在基线上**同样失败（`yaml` 缺失、native worker 未构建）。
- 目前只能用「失败集与基线逐字相同」表达零回归，比全绿弱一档。
- 只影响「能否向upstream宣称 verified / 提 PR」，不影响本机可用性。

---

## 约束与已接受风险

| ID | 内容 | 处置 |
|---|---|---|
| R1 | F10/F11：准备子进程继承 91 个环境名；代理变量只按名字过滤，值不检查（本机两个代理无 userinfo） | 记录在案，不改 |
| R2 | Q7：首台宿主（pid `34492`）为何无 `preparation` 记录 | 未解释，不影响现状 |
| R3 | 上游 0.3.2 在飞；`v0.3.1` tag（10-16 06:14）早于修 #91 的 #140（11:07） | 任何提交都要等 |
| R4 | D9/Q2：私有补丁形态与接管程度未决 | 冻结，等用户拍板 |

---

## 建议次序

**所有会阻塞「本机可用」的条目都已关闭。** 剩下的只有两条与「提交/长期维护」有关的工程项，以及一个还没拍板的形态决策。

| 次序 | 事项 | 理由 |
|---|---|---|
| 1 | **D9 / Q2：私有补丁形态** | 基线干净了、PTC 验过了、bash 范围外了 —— 这是唯一还没动过的决策 |
| 2 | K4（安装路径）· K5（verify 绿） | 只在决定「提交上游 / 长期维护自有版本」时才成为问题 |
| ✅ | ~~K1（部署可复现）~~ | 官方 v0.3.1 归零部署，50 个 `lib/` 文件逐个摘要一致 |
| ✅ | ~~K2（bash）~~ | D10：用户不用，配置层关闭，范围外 |
| ✅ | ~~K3（PTC 实战）~~ | `runnerWrapped:true` 现场记录 |
