# 上游报告 vs 我们的观测 · 全量裁定

日期 2026-10-18。基线 upstream `v0.3.1`（`541b480`）。本文只做裁定，**不提交、不评论、不开 issue**。

被裁定对象：`#146`、`#94`（正文 + 4 条评论）、`#112`、`#106`。
裁定依据：各报告原文（GitHub API 直取，存于 `.dsh-probe/upstream/`）、`v0.3.0`/`v0.3.1`/`main` 源码逐版本比对、本机 5.1 实测矩阵（`2026-10-18-execution-handoff-audit.md` §2–§3）。

---

## 1. 判类

这份审计要分离两个经常被混在一起的轴：

- **版本轴**：报告针对的是 npm `0.3.0`、`main`、还是 `v0.3.1` tag？三者内容不同，而**只有 `0.3.0` 能被普通用户装上**。
- **理解轴**：报告对机理的描述，与实测是否一致？

于是五个判类：

| 判类 | 含义 |
|---|---|
| **A 成立·已修** | 报告的现象与机理都对，且在当前基线（v0.3.1）上已被修掉 |
| **B 成立·未修** | 现象与机理都对，v0.3.1 上仍然成立 |
| **C 归因错·现象真** | 现象真实，但报告给的成因不是实测成因（通常是另一条同签名路径） |
| **D 版本错配** | 报告成立，但只对已无人能安装的版本成立，或引用的源码状态不属于任何发布版本 |
| **E 未能验证** | 本机无法构造报告的前提条件；记为限制，不记为缺陷 |

**「归因错」不等于「报告错」。** 同一个用户可见签名至少有三条成因（见 §5），报告抓住其中一条并把修复指向它，对**他自己那台机器**是对的。

---

## 2. 时间轴（判定版本错配的前提）

| 时刻（UTC） | 事件 |
|---|---|
| 10-14 04:17 | `v0.3.0` GitHub tag |
| 10-14 04:30 | `0.3.0` 发布到 npm —— **至今仍是 `latest`** |
| 10-15 10:01 | #74 合并（准备步骤 O(1) 化） |
| 10-15 12:41 | **#83 合并** —— spawn 不再继承宿主 env，删掉 `PSModulePath` |
| 10-15 13:16 | **#86 合并** —— `-ExecutionPolicy Bypass` + `classifyPreparationFailure()` |
| 10-15 21:08 | `3059f5c` —— 抽 `lib/env.js` 的 allow-list `childEnv()`（`#112` 引用的行号出自这里） |
| 10-16 06:14 | **`v0.3.1` tag** |
| 10-16 11:07 | #140 合并（#91 整树回写，**晚于** v0.3.1 tag） |

结论一句话：**`0.3.0` 里既没有 #83 也没有 #86**；`v0.3.1` 里两个都有，但**从未发 npm**；`v0.3.1` 之后 main 还修了 #140 之类，所以发 0.3.1 也不是终局（见 `devil233-ui` 的评论）。

---

## 3. 逐条裁定

### #146 · fengxias · 10-16 13:27 · **open，0 评论**

**报告主张**：`workspace-preparation.js:34` 起 5.1 时没传 `env` → 完整继承宿主环境 → pwsh 7 把自己的 `$PSHOME\Modules` 写进 `PSModulePath` 最前 → 5.1 命令发现命中 `CompatiblePSEditions = @("Core")` 的 Security 清单 → `Get-Acl` 挂 → `$ErrorActionPreference='Stop'` 让子进程非 0 → `prepareWorkspace()` reject → 该模式下所有 shell 操作全废。修法 A 传干净 `PSModulePath`，B 改用 `[IO.Directory]::GetAccessControl()`。环境：`0.3.0`，宿主由 **PowerShell 7.6.6** 启动。

**裁定：A 成立·已修**（机理与我们实测**一致**），附两处需精确化的细节：

| #146 的说法 | 实测 |
|---|---|
| 毒源是 `node_modules/@dsh-ops/pwsh-win32-x64/bin/Modules` | 这是我们证据包里同样验证过的一行，是**其中一个**毒源；本机的毒源是系统 `c:\program files\powershell\7\Modules`。差别只取决于宿主跑的是**捆绑的 pwsh 7** 还是**系统的 pwsh 7**（`pwsh-sandbox` 行指向哪个，见 `session-pwsh.js` 的 overlay） |
| 拒绝原因是 `CompatiblePSEditions=@("Core")` | 本机实测的拒绝原因是**扩展类型数据冲突**：`The member AuditToString is already present`。两者都能给出 `CouldNotAutoloadMatchingModule` 这个 FQID，属于同一条「pwsh 7 的 Security 模块在 5.1 里装不进去」下的两个子机制 |

**它被 `#83` 修掉了，而且它是在 `v0.3.1` tag 之后开的**（13:27 vs 06:14）—— 报告者装的是 npm 上的 0.3.0，所以对他那台机器**必然**再现，但对 `v0.3.1` 已不成立。这不是「报告错」，是**报告到达时修复已经存在却没人告诉他**（该 issue 至今 0 评论）。

它提的修法 B（`[IO.Directory]::GetAccessControl`）**没有被采纳**，是本案唯一仍然成立的诉求 —— 见 §4 的 `W1`。

### #94 · Zci514 · 10-15 15:15 · **open，4 评论**

**报告主张**：这是**发版**请求，不是 bug 报告。缺陷由 #66/#82 跟踪并已关闭；本文只要求把已合并的 `-ExecutionPolicy Bypass` 发出去。判据很硬：对 `0.3.0` tarball 字符串检索 `"-ExecutionPolicy"` → `false`。

**裁定：A 成立·已修**（版本层面）。它自己的环境是 `workspace-write` + **执行策略为 `Restricted`**，后来改成 `RemoteSigned` 就不再复现 —— 这条**归因链本身是对的**，只是与本机不同：

| | #94 / Kibyuu / raphael-y7 | 本机 |
|---|---|---|
| 成因 | 执行策略拦脚本（`UnauthorizedAccess`） | 模块自动加载失败（`CouldNotAutoloadMatchingModule`） |
| 现场错误行 | `… cannot be loaded because running scripts is disabled on this system` | `… The 'Get-Acl' command was found in the module … but the module could not be loaded` |
| 在 `0.3.0` 上 | 必现 | 必现（只要宿主由 pwsh 7 启动） |
| 在 `v0.3.1` 上 | 修（#86） | 修（#83） |

**三条评论各自给了一条我们原先没有的事实：**

- **Kibyuu** —— 触发面比「策略是 Restricted 的机器」更宽：**出厂默认**机器必然中招，因为两个引擎的内建默认不同（pwsh 7 = `RemoteSigned`，5.1 = `Restricted`）。同一台机器、同一时刻实测两个引擎的 effective 策略不同。**这一条解释了「我这边的报告为什么对不上」的第一层**：报告者用的是哪个引擎决定了它撞上哪一类。
- **Charlestam218** —— 第三条策略形态：无组策略，`CurrentUser = RemoteSigned`，但**包内 `.ps1` 带 Mark-of-the-Web**，`RemoteSigned` 同样拒绝未签名脚本；加 `-ExecutionPolicy Bypass` 即 `ready`。据此指出 #86 的文案把「策略类失败」等同于「只能来自组策略」是错的。**这条是它自己发现的、我们没发现的**。同一条评论还独立确认了模块类成因（「子进程继承了指向 Electron 自带 PowerShell 7 模块目录的 `PSModulePath`」）—— **DSH Desktop 是第四条毒源**。
- **raphael-y7** —— 失败面：`ops_bash`、宿主 `pwsh` 一起挂，`ops_grep/ops_glob/ops_inspect_local_file/ops_replace` 正常（=`#112` 的分裂），并且**桌面端用户连自救都做不到**（改策略需要一个能跑的 shell）。
- **devil233-ui**（10-18 07:16）—— 与本主题无关但**决定上游方向**：只发 0.3.1 不足以修 #91 的整树回写循环，因为 `v0.3.1` tag（06:14）早于修它的 #140（11:07）；建议从当前 main 切 0.3.2 或 backport。**这是我们「不与仓库方向冲突」判断的直接依据。**

### #112 · Sijie20 · 10-16 05:15 · **open，0 评论**

**报告主张**：准备步骤是 `tools/execute` 上的**全局可用性闸门**，失败即「所有会起进程的工具不可用」，且**无法在第一次工具调用之前得知前置结果**；给出四条可选修法（预检暴露 / 能力探测取代 prepare-all / 显式降级模式 / 文档），并明确说「降级不是显然正确的，我宁愿把权衡摆出来」。

**裁定：B 成立·未修**，且**引用行号不属于任何发布版本**（判类 D 的一个注解，不是缺陷）：它引的 `workspace-preparation.js:125`（`ctx.on('tools/execute')`）与 `:128`（`await prepareWorkspace`）出现在 `3059f5c`（10-15 21:08）那一版；`v0.3.0` 里是 `:47/:50`，`v0.3.1` 里是 `:139/:142`。它自己也声明「cited paths were read from the published repository, not from a local checkout」—— **静态阅读 main 的报告，行号会随 main 漂移**，这是上游维护成本的一部分。

它引用的 `bin/prepare-workspace.ps1:17/20-26/27-28` 在 `v0.3.0` 与 `v0.3.1` 上**行号与内容都对得上**（`$needed = TakeOwnership`、effective deny 拒绝、`allow` 足够则 `ready` 退出），所以它对脚本的读法是对的。

我们的补充（记录在 §6 第 3 条）：它把「预检近乎免费」当成一个待评估的建议，而 `ready` 路径的**无副作用性**是可以直接从代码判定的（不写 receipt、不动 DACL、`prepared` 不写）—— 这让选项 1 的成本从「要设计」降到「要调用」。

### #106 · **裁不了，标 E**

**报告主张**：owner 预检排在 effective 权限计算之前，于是「不归我所有但已实际持有 `WRITE_OWNER`」的根会被误拒。

**裁定：E 未能验证**。我们**能**复现「非本人所有的根被拒」（`E:\`，`S-1-5-32-544`，`Workspace is not owned by the current user`，exit 1，见 `submissions/04-EVIDENCE.md` §5），但**构造不出**报告要求的那个组合（外来 owner **且** 已实际持有 `WRITE_OWNER`）—— 把所有权改到别的 principal 需要 `SeRestorePrivilege`。九目录扫描只找到「我是 owner 且无 WRITE_OWNER」「别人是 owner 且无 WRITE_OWNER」「我是 owner 且有 WRITE_OWNER」，即**反方向的**不对称。

这一条与 `K9` 是同一个问题的两侧：如果宿主沙箱在**没有**准备步骤时也能工作（本机在启用 PTC 行之前一直是这个状态），那么「owner 预检该不该排在前面」就退化成「准备步骤该不该存在」。留给 Phase 4。

---

## 4. 汇总

| 报告 | 判类 | 在 v0.3.1 上还成立吗 | 我们能否复现 |
|---|---|---|---|
| #146 模块类成因 | A | **不**（#83 切断继承） | 能，逐字（§2 A 组） |
| #146 修法 B（脚本去模块依赖） | B | **是**（脚本仍用 `Get-Acl`） | 能（`PS7;INBOX` 即死） |
| #94 执行策略类成因 | A | **不**（#86 加 `Bypass`） | 本机策略 `RemoteSigned`，构造不出；Kibyuu/raphael-y7 给了出厂默认的构造法 |
| Charlestam218 的 MOTW 分支 | B | **是**：`classifyPreparationFailure()` 的文案仍把策略类失败等同于组策略 | 未试（需要给脚本打 zone identifier） |
| Charlestam218 的 Electron 毒源 | A | 不 | 未试（本机宿主是 CLI，非 Desktop） |
| #112 可用性闸门 | B | **是** | 能（0.3.0 现场就是它） |
| #112 预检近乎免费 | A（作为事实） | 是 | 能（`ready` 路径无副作用，K8） |
| #106 顺序问题 | E | 未知 | 构造不出 |

**一句话结论**：四个报告里没有一个是「错的」。它们分成两组 —— **撞上策略的**（#94 系列）与**撞上模块解析的**（#146）—— 两组在 `0.3.0` 上都必现、在 `v0.3.1` 上都已修、而 `v0.3.1` 不在 npm 上。所谓「报告与我们的观测不一致」，**主因是版本，不是理解**。

---

## 5. 同签名、多成因：一张诊断表

这是本次审计最有复用价值的产出。四条成因都能给出「准备失败 → workspace-write 下所有命令类工具不可用」，区分它们只需要三个读数：

| 成因 | 现场错误行 | 判别读数 | 出现条件 |
|---|---|---|---|
| 执行策略 | `running scripts is disabled` / `not digitally signed` / `UnauthorizedAccess` | `Get-ExecutionPolicy -List`；`Get-Item -Stream Zone.Identifier` | 5.1 effective = `Restricted`（出厂默认）或 `RemoteSigned` + MOTW |
| 模块自动加载 | `CouldNotAutoloadMatchingModule` / `The term 'Get-Acl' is not recognized` | 子进程里的 `PSModulePath`：`coreRootIndex` 是否小于 `inboxRootIndex` | 宿主由任一 pwsh 7 启动（系统 / 捆绑 payload / Desktop 的 Electron 副本） |
| 所有者/权限前提 | `Workspace is not owned by the current user` / `Explicit effective denial of WRITE_OWNER` | 根目录 owner SID 与 effective `WRITE_OWNER` | 工作区在别的主体的目录下 |
| 超时 | `the preparation executor timed out after …` | 准备耗时 vs `PREPARATION_TIMEOUT_MS` | 超大或极慢的文件系统（0.3.0 是 10 s 硬编码） |

**关键洞察**：前两条都表现为 `workspace-write` 的**全量不可用**，与后两条不可区分 —— 因为准备步骤在 `tools/execute` 上、在 `next()` 之前。这就是 #112 说的闸门形状，也是为什么四个报告看起来像同一件事。

我们自己的 trace（`lib/trace.js`）正是为这张表服务的：`preparation` 记录里同时带 `spawn.inheritsConsole`、`env.psModulePath.{present,coreRootIndex,inboxRootIndex}`、`outcome` 与 `failure` 文本 —— 一次失败就能落到上面四行中的一行，不必再靠猜。

---

## 6. 对我们自己的观测的修正

审计同时反向校了我们自己的三条判断：

1. **「上游报告与我们的观测不一致」——主因判明为版本差，不是理解差。** #146 的机理与我们逐字一致；#94 系列的机理对，只是成因不同。
2. **我们曾经判 `K1`（类型数据冲突机理）为 `contradicted`，判重了。** 实测的拒绝文本正是「扩展类型数据冲突」，上游注释是对的；错的只是「无条件继承」这一层（正确说法是「在本插件的 spawn 形状下必然继承」）。已在 register v3 改判 `verified`。
3. **`#112` 的选项 1（预检）比它自己估计的更便宜**：`ready` 路径不写 receipt、不动 DACL（K8/K10 都已 verified），所以「先跑一次、按结果分类、决定要不要放行」不需要 check-only 模式。这条对上游有价值，但**不进本次范围**（D1：不提交）。

---

## 7. 对「接下来做什么」的含义（不提交，只落判断）

- **上游当前该做的事不是我们的事**：`devil233-ui` 已经指出 `v0.3.1` tag 早于 #140，正确动作是切 0.3.2 或者 backport —— 这条与我们的范围**不冲突**，因为我们不提任何发版诉求。
- 仍然成立、且**只有我们这一侧**会去做的：`W1`（脚本去模块依赖）。它是 `#146` 的修法 B，至今没人做。
- `#112` / `#106` 属于上游的**设计**问题（闸门形状、预检、能力探测）。我们若做私有插件，会绕开它们而不是修它们（Q2 的 a/b 在 Phase 4 决定）。

---

## 8. 证据清单

| 用途 | 位置 |
|---|---|
| #146 / #94(+4 评论) / #112 / #106 原文 | `.dsh-probe/upstream/issue-*.json`（GitHub API 直取，无 token） |
| 行号逐版本比对 | `dsh-ops-base` 的 `git show <ref>:lib/workspace-preparation.js`；`3059f5c` 是 `#112` 引用的那一版 |
| 5.1 矩阵（A/B/C/E + 顺序） | `.dsh-probe/handoff/prep-env-probe{,2}.json`，日记 §2–§3 |
| 我们的 0.3.0 现场 | `.dsh-probe/handoff/err-t-host-shaped-hidden-pipes.txt` 等；`submissions/04-EVIDENCE.md` §1–§4 |
| #106 的部分复现 | `submissions/04-EVIDENCE.md` §5 |
