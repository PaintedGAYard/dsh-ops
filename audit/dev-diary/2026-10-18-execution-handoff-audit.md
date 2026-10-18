# 2026-10-18 · dsh-ops 启动路径 execution handoff 审计

## 目标（冻结，不再改）

> 尽可能解决 dsh-ops 各种工具启动路径上 execution handoff 导致的问题。

允许迭代：过程中可能发现新问题，也可能发现过去的理解是错的。目标不变，**问题描述可变**。

## 范围

**在**：preparation 引导脚本及其 spawn / 宿主 shell 执行面 / PTC 的全局钩子 / spawn 的环境与凭证策略 / 启动失败的可诊断性。

**不在**：file worker 内部、bash IPC 与私有 MSYS（#41/#92 在跟）、`ops_batch` 语义、性能（#87）、安装锁（#175）。

划这条线的理由不是防扩，而是：范围内的东西会让我自己的环境不可用，范围外的不影响日常。

---

## 决定日志

| ID | 决定 | 理由 |
|---|---|---|
| D1 | fork 是试验田；**不动原 repo**；提交只在内容冻结后进行 | 允许充分实验而不必先满足上游流程 |
| D2 | 分解放在冻结之后；手段不限 cherry-pick，可以手动编辑提交分支，用 issue 正文 / commit 信息记录理由 | 迭代可能推翻 framework，过早定粒度是给不存在的未来上枷锁；无人关心过程 |
| D3 | 私有 patch 的**最终形态 = 独立的 DSH 插件**（可以多个），放工作区其它文件夹、各自新 repo | 避免长期维护 fork；与上游解耦 |
| D4 | **不预设** issue 数量与形态（撤销最初的「一份 issue」） | 事实会变，形态应随之变 |
| D5 | 「值不值得报」的判据只决定**报 repo 还是私有 patch**，不用于防扩 | 自己的痛必须先解决，贡献放在最后 |
| D6 | 基线 = **通过 GitHub 安装 dsh-ops 0.3.1 发布版**（runtime 资产的 stage 方式待研究），并把 dsh 状态 commit（`~/.dsh` 有 git 追踪） | 需要一个可复算的起点 |
| D7 | 「已解决」判据：①原始失败条件被写成**可复跑用例** ②`npm run verify` 全绿且无新增 skip ③**实际部署的就是这个 build** | ①是防头痛医头的唯一硬约束 |
| D8 | 关注点隔离在**最终树**上（不在历史上）；决定留痕、过程不留痕 | 冻结时要能按文件/模块切分，而不是按 commit 重放 |
| D9 | 私有 patch 的形态**由最终方案的侵入性决定**：若存在无法分解到独立插件的侵入式改动 → ①酌情提交上游 ②实在无法提交则**不 archive fork**，持续维护自有版本；若不存在 → 走独立插件，fork 可弃 | 解决自身痛点是优先级最高的；贡献是副产品 |
| D10 | **`ops_bash` / `dsh-ops-shell` 不由本机使用**：永久关闭在配置层（`disabled: true`），**不修改代码、不做结案测试** | 用户明确不使用该子系统；它的问题不影响本机可用性。关闭是配置事实，不是待办 —— 因此 S1 的「bash 路径」是**范围外**，不是缺口。附带好处：私有插件不需要携带任何 bash payload，接管面因此更小 |

---

## 认知修订日志

| ID | 曾经的判断 | 现在的判断 | 什么推翻了它 |
|---|---|---|---|
| R1 | 「`prepare-workspace.ps1` 的 ACL 逻辑是元凶」 | 不是。本机它打印 `ready`、一条 ACL 都不写 | 按插件原样参数直接跑脚本，回 `ready` exit 0；备份目录从未建立 |
| R2 | 「`PSModulePath` 是唯一根因」（#146 / #83） | 只是一半。还必须有**分离启动** | 2×4 矩阵：附着启动下四种变量都正常；分离启动下只有「变量为空」正常 |
| R3 | 「隔离实验证明该机理不成立」（莫琳第 7 轮结论） | **错误，已撤回** | 三次隔离实验全用附着启动 —— 重现器与被测物共享同一混淆变量 |
| R4 | 「文件工具不受影响」 | 已证，且是故障读起来像权限问题的原因 | 故障期间 `ops_*` 四个工具全部正常（`enforcement: policy`，不进沙箱） |
| R5 | 「clone 是分叉的 fork，含 fork-only 提交与 fork-only 的 `lib/paths.js`」 | **错误**。`git rev-list --left-right --count upstream/main...origin/main` = `86 / 0`：fork **没有任何自有提交**，只是落后 86 个提交的镜像；`lib/paths.js` 属于上游 main（v0.3.1 之后） | 直接比对两条主线的领先/落后计数 |
| R6 | 「`lib/profile-install.js` 里那段『This fork will run…』注释是 fork 独有的」 | **错误**，它是上游自己的文字（v0.3.1 就带着） | 在 `dsh-ops-base`（v0.3.1 工作树）里读到同一段 |
| R7 | 「分离启动的两个充分条件：隐藏窗口 或 任一 stdio 重定向」（本文件旧观测 1） | **半个错误**。窗口标志**无关**：`windowsHide:false` + stdio 重定向仍然失败；唯一变量是**子进程有没有继承父进程的控制台句柄** | Phase 1 §2 的 E 组对照 |
| R8 | 「W1 在 v0.3.1 上不变且更强；W2 收窄为唯一一处、应让 `preparationEnvironment` 复用 `childEnv`」 | **两条都改判**。W1 降级为加固诉求（v0.3.1 已切断继承，现场不再死）；W2 判**不动**（两个 env 辅助函数语义不同，合并是错的） | Phase 1 §5；`lib/env.js` 是给不可信二进制的白名单，准备器需要 PATH/HOME |
| R9 | 「上游报告与我们的观测不一致」（本任务最初的困惑） | **不一致的主因是版本，不是理解**。#146 的机理与我们逐字一致；#94 系列的机理也对，只是撞的是执行策略而不是模块解析 | Phase 3 全量裁定（`consistency-audit.md`）：四个报告无一是错的，两组成因在 `0.3.0` 上都必现、在 `v0.3.1` 上都已修，而 `v0.3.1` 不在 npm 上 |
| R10 | 「把准备脚本改名后 `pwsh` 仍成功，说明钩子没拦」（Phase 6 的核心推断） | **探针无效，结论撤回**。`prepareWorkspace` 按 root 缓存成功结果：第一次准备之后，改脚本不会让任何后续调用失败。这个探针不能区分「钩子没挂」与「钩子挂了但已缓存」。真宿主第二次重启后 `hook-mounted` + `preparation(resolved)` 双双出现，钩子确实是挂着的 | `106787d` 加的 `dispatch.durationMs` 才让「这次真起了 5.1」与「已缓存跳过」可区分（实测 277 ms vs ~0 ms） |

**方法学教训（留在最显眼处）**：重现一个 *spawn 上下文* bug 时，**重现器自身的启动形状就是变量之一**。这次害人的不是代码，是测法。

---

## 本轮新增的关键观测

1. 分离启动的唯一条件：**子进程未继承父进程控制台句柄**（`windowsHide` 无关，见 R7）。
2. 失败态里只有 `Get-Acl` / `Set-Acl` 不可解析；`Get-Item`/`Join-Path`/`Set-Content`/`Where-Object`/`Add-Type`/`Write-Output`/`Get-Date` 全部正常 → **暴露面只有两行**。
3. 5.1 在附着启动时会把继承来的 `PSModulePath` 改写（实测 5→3 条，甚至清空）；分离启动时**原样照收**。
4. `prepared` 只在成功时写、永不过期 → 失败永久化、成功不复验（K10）。
5. **K9（新增，未验）**：本机全程在 `workspace-write` 下跑受限命令，而准备钩子直到 PTC 行启用才第一次出现 —— 说明宿主沙箱在没有准备步骤时工作正常，准备步骤可能对本机冗余。
6. 污染是**顺序敏感**的（K14）：`PS7;INBOX` 死、`INBOX;PF51;PS7` 活。毒源 `…\PowerShell\7\Modules` 不在注册表里，只由 pwsh 7 注入。
7. 0.3.0 的准备 spawn **既无 `env` 也无 `-ExecutionPolicy Bypass`**（K13）——两个独立失败类，v0.3.1 全修且 v0.3.1 **没发 npm**。

---

## 开放问题

| ID | 问题 | 会改变什么 |
|---|---|---|
| Q1 | K9 是否成立：准备步骤是否只是 dsh-ops 自用 | 若成立，私有插件可能完全不需要接管沙箱 |
| Q2 | 私有插件能接管到什么程度：**(a)** 自己拥有执行面（关掉 shell/ptc 行、自建受限工具）vs **(b)** 只改宿主环境（启动时清 `PSModulePath`） | G2 的实验该往哪边取证 |
| Q3 | 5.1 为何在分离启动时跳过 `PSModulePath` 重写（引擎内因） | 不影响修法，但决定回归测试怎么写 |
| Q4 | K7：`PROVENANCE` 里的 ACL runner `0xC0000142` 与 #41/#92 报的 MSYS fork `0xC0000142` 是否同一件事 | 决定这条要不要碰 |
| Q5 | 部署 0.3.1 后，模块自动加载故障只能靠合成探针验证；是否需要保留第二 profile 装 0.3.0 作对照 | 证据链能否复现 |
| Q6 | 5.1 对 `PSModulePath` 的「补全」规则无从归纳：`INBOX`→`PF51;INBOX`、`PF51;INBOX`→`USER51;PF51;INBOX`、`PS7USER;…;INBOX`→逐字。补的条目随输入而变 | 只影响「为什幺」，不影响「顺序决定成败」这条操作结论；不值得为它加实验 |

---

## 现行状态（干净基线）

**基线指纹（可复算）**

| 项 | 值 |
|---|---|
| profile 依赖 | `file:E:/Users/David/Source/Playgrounds/etc/dsh-ops-base` |
| 源码 | upstream tag `v0.3.1`，commit `541b4801910afbbd4394e4d8690bf26d41f2c745` |
| 原生运行时 | `native-win32-x64-runtime-v0.3.1.zip` → worktree `runtime/win32-x64/`；worker sha256 `89b8e1e9…8225`；receipt `version=0.3.1` |
| 已装包 | `node_modules/dsh-ops` 报 `0.3.1`；**hoisted 实体拷贝**（非链接）→ Phase 2 换 audit 分支需再装一次 |
| 探针残留 | 无（`temporary probe` 全文检索 0 命中） |
| `~/.dsh` commit | `111a9c2`（package.json / pnpm-lock.yaml / cordis.yml / cordis.patch.yml） |
| 工作树 | `dsh-ops-base`（detached、只读）；`dsh-ops-audit`（`audit/handoff-trace`） |
| 未提交噪音 | `.gitignore`（`package.json.lock`，非本次改动）+ session/storage 缓存 |

- 历史证据（**归属 0.3.0**）：`submissions/04-EVIDENCE.md`、`.dsh-probe/handoff/`、`.dsh-probe/backup-0.3.0-*`。
- 提交草稿：`submissions/`（未提交，形态未冻结）。

---

## Phase 0 执行记录

| 步 | 状态 | 事实 |
|---|---|---|
| 0.1 fetch tags | ✅ | `upstream` 的 tag 已取到（`v0.3.1` 存在；原先 clone 里一个 tag 都没有） |
| 0.2 worktrees | ✅ | `dsh-ops-base` detached @ `541b480`（v0.3.1）；`dsh-ops-audit` 分支 `audit/handoff-trace` @ 同一 commit |
| 0.3 runtime stage | ✅ | `native-win32-x64-runtime-v0.3.1.zip`（1,087,937 B）解到 `base\runtime\win32-x64\`；`native-runtime.mjs check --staged` 通过；worker sha256 `89b8e1e9…8225`，receipt `version=0.3.1` |
| 0.4 install | ⛔ 阻塞 | `pnpm add file:…` 报 `os error 32`（目录被占用），两次尝试均在**回滚后**收场（`package.json` 仍是 `^0.3.0`）。查证：插件目录下 **198 个文件全部可独占打开**、无残留半成品目录 → 占用者是**目录句柄或 cwd**，不是文件。与 #175 同源：**插件目录不能在 dsh 运行时替换** |
| 0.4 处置 | ✅ 备好 | `phase0-install.ps1`（工作区根）：检测存活进程 → 备份 manifest/lock → 安装 → 校验已装包版本 + runtime receipt + 探针残留 → 失败自动回滚 |
| 0.4 失败#2 | 📌 记录 | 用户停机后实跑：`'"dsh.cmd"' is not recognized`。根因见 **K12** —— `profile-install.js` 找不到 `@deepseek-ai/dsh` 时按名调 `dsh.cmd`，而 npx 启动的宿主只有缓存内的 launcher |
| 0.4 失败#3 | 📌 记录 | 自检抓出脚本自身 bug：`& $cli --version \| Select-Object -First 1` 会丢 `$LASTEXITCODE`（实测 piped 为空、unpiped 为 0），于是「解析到 CLI 却判为不可用」 |
| 0.4 修复#2 | 📌 记录 | 诊断力不足：`profile-install.js` 用 `stdio: 'inherit'` 调 `cmd /c pnpm`，pnpm 的错误块只进终端、进不了 `& node … 2>&1`。改为 `Start-Process` + 重定向句柄（孙进程继承），错误全文落盘 |
| 0.4 失败#4 | 📌 记录 | 真正的占用者是 **VS Code**，不是 dsh。教训写进 F8：占用者可以是编辑器/资源管理器，不限于宿主 |
| 0.4 失败#5 | 📌 记录 | 脚本自身第二个 bug：校验用 `$spec`（反斜杠）与 pnpm 写出的（正斜杠）裸比 → **安装成功却被判失败并回滚**，留下「manifest 0.3.0 / 字节 0.3.1」的不一致 |
| 0.4 修复#3 | ✅ | 校验改为规范化比较（分隔符 + 大小写）；**校验失败不再回滚**（安装成功就必须保持与字节一致）；EBUSY 提示补上编辑器 |
| 0.4 install | ✅ | `Packages: +1 -1`，263 ms，`install exit=0`；`.modules.yaml` 早已认定 `file:` 安装，故**无需换目录**，dsh 全程未停 |
| 0.5 verify | ✅ | `status` 报 `file:` 依赖且 `enabled: true`；已装包 `0.3.1`；receipt `0.3.1`；`temporary probe` 0 命中；`pwsh` 与 `ops_*` 均可用 |
| 0.6 commit | ✅ | `~/.dsh` → `111a9c2`（4 个文件）；`.gitignore` 与 session/storage 噪音未提交 |
| 0.7 指纹 | ✅ | 见「现行状态」指纹表 |

**Phase 0 期间的额外发现（与目标同源）**

- **F7 · 归零路径本身也有 handoff 依赖**：把环境归零到某个版本，依赖「一个在宿主停机后仍然存在的 dsh CLI」。npx 启动的宿主不满足这一点。这不是运行期 bug，而是**维护期**的同类问题。
- **F8 · 进程占用与探测盲区**：占用插件目录的可以是**任何**打开它的进程（VS Code、资源管理器），不限于宿主；而本会话沙箱的进程枚举只能看到 34 个进程、看不到 `node`/`dsh`，因此「宿主是否已停止」只有用户真实终端可靠。我们写给自己跑的脚本不能依赖它（提权后枚举才正常）。

**环境事实（供复算）**：全局安装后 `dsh` 为 `E:\NodeJS\dsh.cmd`，宿主代码在 `E:\NodeJS\node_modules\@deepseek-ai\dsh`（0.2.0-rc.2）；`file:` spec 安装会被 pnpm 以「不同来源」警告后替换；`dsh plugin add` 在宿主运行时无法删除插件目录（`os error 32`）；`curl.exe` 的 schannel 在本沙箱下 `SEC_E_NO_CREDENTIALS`（下载必须走 gh / Node 的 TLS 栈）。

---

## Phase 1 记录

### 1. 机械 diff（`v0.3.0` → `v0.3.1`，`lib`/`bin`/`test`）

55 个文件、+5195/−304。与本主题相关的四处：`lib/workspace-preparation.js` +112、`lib/env.js` **新增**、`lib/tools.js` 78 行、`test/permissions.test.mjs` +283。其余大头是 Linux/macOS 移植与新工具测试，与 handoff 无关（`lib/shells.js` +234 里的 `shellEnvOverrides` 是唯一沾到子进程 env 的新增，见 §5）。

### 2. 决定性测量：准备 handoff 在本机到底坏在哪

用真实 5.1（`System32\WindowsPowerShell\v1.0\powershell.exe`）+ 真实探针脚本，唯一变量是**子进程继承什么 env**。探针只回答一件事：这条解释器能不能自动加载 `Get-Acl`。

`windowsHide:true`、`stdio:'ignore'`（等价于插件的 `['ignore','pipe','pipe']`：都不是父进程控制台句柄）：

| 组 | 注入的 `PSModulePath` | 5.1 自报的值 | `Get-Acl` |
|---|---|---|---|
| **A** = 0.3.0 行为 | 宿主原样（含 `…\PowerShell\7\Modules`） | **5 条，逐字保留** | **✗ CommandNotFound** |
| **B** = v0.3.1 行为 | 删除（`preparationEnvironment()`） | 重建 3 条，**无 PS7** | ✓ |
| C | 强设为「机器两条」 | 补成 3 条 | ✓ |
| E = A 但 `windowsHide:false` | 同 A | 同 A | ✗ |

> E 与 A 完全相同 → **窗口标志不是变量，stdio 是否附着控制台才是**。（上一轮只把「分离启动」当整体，这里把它拆开了。）

A 组的失败是逐字复现的：

```
IMPORT: RuntimeException: ... Error in TypeData "System.Security.AccessControl.ObjectSecurity":
        The member AuditToString is already present.
GET-ACL: CommandNotFoundException: The term 'Get-Acl' is not recognized ...
```

**所以上游 K1 的机理描述是对的**，我们上一轮判它「contradicted」判重了 —— 错的只是「无条件继承」这一层，正确说法是「在本插件的 spawn 形状下必然继承」。

### 3. 决定性测量：毒是「存在」还是「排在前」

| 注入值 | 5.1 自报 | `Get-Acl` |
|---|---|---|
| 删除 | `USER51;PF51;INBOX` | ✓ |
| 仅 `INBOX` | `PF51;INBOX` | ✓ |
| `INBOX;PF51;PS7` | 逐字 | ✓ |
| **`PS7;INBOX`** | `PS7;PF51;INBOX` | **✗** |
| `PS7USER;USER51;PF51;INBOX` | 逐字 | ✓（PS7USER 里没有 Security 模块） |
| `""`（空串） | 视为未设 | ✓ `Get-Acl`，但 `Import-Module` 抛 FileNotFound |
| `PF51;INBOX;PS7;`（尾分号） | 逐字 | ✓ |

**结论：顺序决定成败，污染本身无害。** 唯一的毒源是 `…\PowerShell\7\Modules` 这个**机器根**，它在注册表里**不存在**（Machine 值只有 inbox 两条，User 值为空）—— 它只由 **pwsh 7 自己启动时注入**。于是触发条件可以写死一句：

> **只要宿主是由 pwsh 7 启动的，0.3.0 的准备脚本就必然起不来。**

另两条副产品：`PSModulePath=""` **不等于**删除（空串会让 `Import-Module` 直接找不到模块），所以任何「置空而不删」的修法都有坑；「删除后 5.1 用 `$PSHOME\Modules` + 机器 + 用户值重建」这句上游注释也不够准 —— 重建出的首条 `…\Documents\WindowsPowerShell\Modules` 是**按目录约定合成**的，不来自注册表。

### 4. 0.3.0 与 v0.3.1 的差别正好落在两个失败类上

`git show v0.3.0:lib/workspace-preparation.js`：

```js
spawn(executable, ['-NoProfile', '-NonInteractive', '-File', script, ...], { windowsHide: true, stdio: ['ignore','pipe','pipe'] })
```

0.3.0 **没有 `env` 选项**（= A 组，必然继承毒），也**没有 `-ExecutionPolicy Bypass`**（v0.3.1 的 #66 才加）。也就是说 0.3.0 有两个互相独立的失败类，v0.3.1 把两个都修了，而 **v0.3.1 从未发布到 npm**（`npm latest` = 0.3.0，0.3.1 只有 GitHub release）。这是「上游报告与我们的观测不一致」目前最强的解释候选（Phase 3 全量裁定）。

本机 ExecutionPolicy：LocalMachine `RemoteSigned`，其余 `Undefined` —— 策略类在本机不成立，现场的失败就是模块类。

### 5. W1 / W2 在 v0.3.1 上的准确形态

| 项 | 0.3.0 | v0.3.1 实测 | 准确形态 |
|---|---|---|---|
| **W1** 引导脚本零模块依赖 | 依赖 `Get-Acl`/`Set-Acl`，且无条件继承毒 → **现场死** | 仍依赖 `Get-Acl`，但继承被切断 → **不再死** | **降级为加固诉求**：脚本仍假设 5.1 的自动加载可用；把两条 `Get-Acl` 换成 `[System.IO.Directory]::GetAccessControl` 可让脚本对模块解析免疫。这不是 bug 报告，是「别再让一个 ACL 脚本依赖模块搜索路径」的健壮性论点 |
| **W2** 凭证/环境策略 | 「四条路径两条未清洗」 | `childEnv()`（allow-list）覆盖 `probeBinary` 与 FastCtx；`preparationEnvironment()` 覆盖准备 | **工具启动路径上已无未清洗点**。剩下的 `process.env` 继承只有 `rust.js:177`（`cargo`，开发工具）与 `profile-install.js:92-93`（安装器，`stdio:inherit`），都不在工具启动路径上。W2 作为**安全**议题基本关闭；作为**一致性**议题只剩「`preparationEnvironment` 没复用 `childEnv`」这一处，而它俩语义不同（前者保留 PATH/HOME 给解释器，后者是给不可信二进制的白名单），**不该合并** |

W2 修法因此从「抽公共模块」改判为：**不动**。上一轮「P2 diff 会变小」的推论作废 —— 没有需要修的 P2。

### 6. 对 P1（测试设计）的影响

`runPreparation(root, {executable, args, timeoutMs})` 没有 `env` 覆盖入口，敌意 `PSModulePath` 注不进去 → 「脚本依赖模块自动加载」这一类始终没被钉住。若将来提 P1，最小形状是：给 `runPreparation` 加 `env` 覆盖（与 `executable`/`args` 同级），再加一条**顺序敏感**的红测试（`PS7;INBOX` 死、`INBOX;PS7` 活）—— 后者比「删变量」更能表达真实约束。

### 7. 残余与沙箱假象

- 真 `runPreparation()` 在**我的沙箱内**跑不了：Node 的管道句柄要开命名管道，受限令牌下 `spawn EPERM`。这不是产品证据，是沙箱边界；插件的真实 spawn 在宿主进程里，不受此限。真正的 D 组验证 = 重启宿主后在真实会话里跑一次 `ops_bash`（v0.3.1 已装好，等用户方便时重启即可）。
- 上述 A/C/E 与顺序实验的产物都在 `.dsh-probe/handoff/prep-env-probe*.json`，可重跑。

---

## Phase 2 记录：handoff trace

分支 `audit/handoff-trace`，commit `97eca7e`（`lib/trace.js` 新增，四处插桩 62 行，`test/trace.test.mjs` 10 项）。**只存在于 fork，不进上游。**

### 8. 为什么是一个独立模块而不是一串 `console.error`

一个 handoff 的失败在现场是**不可归因**的：工具只会说「拒绝访问」或「找不到命令」，不会说哪一跳丢了什么。要归因，就得让每一跳自己留下「我交出去了什么、拿回了什么」。四个约束决定了形状：

| 约束 | 做法 |
|---|---|
| 不能改变任何行为 | 默认关闭；`traceEvent()` 在关闭时**不碰文件系统**（不是「写个空文件」）；全部 `try/catch` 吞掉，永不抛 |
| 不能是凭据仓库 | 环境按**名字**记录；匹配 `KEY\|PASSWORD\|SECRET\|TOKEN\|CREDENTIAL\|AUTH` 的值一律不写。`SSH_AUTH_SOCK` 也在内 —— 理由与 `lib/env.js` 拒收它一致 |
| 不能无限增长 | 单文件 4 MiB 上限，到顶轮转为 `handoff.1.jsonl`（一代，不滚雪球） |
| 必须能回答「顺序」 | `PSModulePath` 记**下标**：`coreRootIndex` 与 `inboxRootIndex`。前者在前 = 必死，在后 = 无害（§3）。记布尔值等于把答案丢掉 |

开启方式两种：`DSH_OPS_TRACE=1`（管一条命令）或 `<DSH_HOME>/dsh-ops/trace.on` 标记文件（管下一次重启）；环境变量优先，显式 `0` 能压过标记。落盘在 `<DSH_HOME>/dsh-ops/trace/handoff.jsonl`。

### 9. 四处插桩

| hop | 位置 | 记录什么 | 为什么是这里 |
|---|---|---|---|
| **B1 准备** | `lib/workspace-preparation.js` `runPreparation` | `root`、解释器 argv、**实际交给 5.1 的 env**、`spawnShape`（`inheritsConsole`）、耗时、失败文本 | 解释器是插件唯一「故意不是宿主那个」的子进程，它继承的 env 块**就是**这个 handoff 的全部 |
| **B4 bash** | `lib/shells.js` `bashToolDefinition.execute` | `file`/`source`、`workdir`、`argv`、`shellEnvOverrides` 之后的 env、exit/signal/超时 | 插件 → 宿主 subprocess 服务 → 受限子进程，三次转手只剩一个 argv |
| **B5 FastCtx** | `lib/tools.js` `#connect` | runtime 文件、`serve --enable-shell` argv、`childEnv()` 之后的 env、钉住的 `FASTCTX_BASH`、是否 shared lease | `FASTCTX_BASH` 决定 Rust worker 有没有 shell 工具；这一条能直接判定「工具为什么不存在」 |
| **B6 PTC worker** | `lib/ptc/worker.js` `invoke` | **最终 argv**（worker 本身 or ACL runner 包好的）、cwd、mode、`enforcement`、exit/signal | `0xC0000142` 这类「runner 自己起不来」只能靠「argv 是否被包过 + exit code」区分（K7） |

`lib/file/worker.js` 故意**不**插桩：它走 `enforcement: 'policy'`、不经 ACL runner，没有独立的 handoff；插进去只会用每次读文件把日志刷满。

### 10. 验证

| 项 | 结果 |
|---|---|
| `node test/run.mjs trace` | **10/10 全绿** |
| 全量套件 vs 干净基线 | 失败集**逐字相同**（都是 `13 failed / 12 skipped`，原因两样：工作树没有 `node_modules`（`yaml` 缺失）与没有 Rust worker 构建），差异只有新增的这一套 |
| 提交 | `97eca7e`，`git status` 干净 |

**未能验证的一跳**：真 `runPreparation()` 在我的沙箱里必然 `spawn EPERM`（Node 的管道 stdio 要开命名管道，受限令牌开不了）。这不是产品行为，是沙箱边界；**真正的 B1 现场验证只能在重启宿主后做**。届时 trace 会直接回答三件事：准备子进程拿到的 env 里 `PSModulePath.present` 是否为 `false`、`inheritsConsole` 是否为 `false`、以及失败时是哪一跳的哪种失败。

（顺带记一个沙箱假象：本会话里 `git commit` 必须加 `-c commit.gpgsign=false` —— MSYS 的 gpg 建不了自己的命名对象，`NtCreateDirectoryObject(...) 0xC0000022`。和 §7 的 `EPERM`、K7 的 `0xC0000142` 是同一族「受限令牌 + MSYS/命名对象」现象，**不要**当成产品 bug。）

---

## Phase 3 记录：全量裁定

裁定正文独立成篇：**[`consistency-audit.md`](consistency-audit.md)**（判类、时间轴、逐条裁定、同签名多成因诊断表、对我们自己观测的反向修正）。

摘要：

- 四个报告**没有一个是错的**，分成两组成因：撞**执行策略**的（#94 + 三条评论）与撞**模块解析**的（#146）。两组在 `0.3.0` 上都必现、在 `v0.3.1` 上都已修，而 **`v0.3.1` 不在 npm 上**（`latest` 仍是 0.3.0）。所以「不一致」的主因是**版本**，不是理解（R9）。
- #146 的机理与我们逐字一致，两点需精确化：毒源随宿主跑的是哪个 pwsh 7 而变（系统 / 插件捆绑 payload / Desktop 的 Electron 副本），拒绝原因可以是 `CompatiblePSEditions` 也可以是**扩展类型数据冲突**（本机实测是后者）。
- #112 成立未修（全局闸门 + 无法预知前置结果）；它引的行号属于 `3059f5c`（main），不属于任何发布版本 —— 静态阅读 main 的报告行号会漂。
- #106 **构造不出**其前提（外来 owner **且** 已持有 `WRITE_OWNER`），标 E，与 K9 合并到 Phase 4。
- 新得三件我们原先没有的事实：**出厂默认下 pwsh 7 = RemoteSigned 而 5.1 = Restricted**（Kibyuu）；**`RemoteSigned` + MOTW 是第三条策略形态，`classifyPreparationFailure` 的文案把它漏了**（Charlestam218，K16 contradicted）；**`v0.3.1` tag 早于 #140，只发 0.3.1 不足以修 #91**（devil233-ui）—— 这条是「不与仓库方向冲突」判断的直接依据。

---

## Phase 4 记录：K9 —— 准备步骤是不是宿主必需

**问题**：`bin/prepare-workspace.ps1` 的注释说「需要 `WRITE_OWNER` 才能设沙箱完整性标签，故必须在宿主启动执行体前准备」。这个前提是真的吗，还是插件自己的假设？

**答案：前提是真的，但它属于宿主的沙箱，而不是属于命令；而且它对本机是空操作。**

决定性证据在宿主自己的包里 —— `@deepseek-ai/dsh-sandbox-windows-acl/lib/types/acl.d.ts:80-95`，`grantWrite()` 的文档：

> Each grant … apply the Low mandatory label — one merge. …
> **The directory must be owned by the caller AND grant WRITE_OWNER (the label lives in the SACL; owner-implicit rights cover only READ_CONTROL and WRITE_DAC) — a Full-control workspace satisfies both.**

三件事同时被这一句钉住：

1. **前置条件真实**：`grantWrite()` 用一次 `SetNamedSecurityInfoW` 同时改 DACL 与 SACL（低完整性标签），设标签要 `WRITE_OWNER`；owner 隐式只有 `READ_CONTROL`/`WRITE_DAC`。所以「根目录不给你 `WRITE_OWNER` 就设不了标签」不是插件的臆测。
2. **它只对受限模式成立**：`workspace-write` 才有 `writableDirs` 与标签；`danger-full-access` 连 `prepareWorkspace` 都在 `:25` 短路。所以准备是**沙箱**的前提，不是**执行**的前提（这与 Charlestam218 的方法论提醒一致）。
3. **「Full-control 的工作区两条都满足」** —— 也就是说，绝大多数真实工作区（自己目录下的项目）根本不需要这一步。

本机指纹（可复算）：

```
root  E:\Users\David\Source\Playgrounds\etc
owner WAFFLE-FRAME\david
ace   WAFFLE-FRAME\david  FullControl  inherited
ace   Everyone           DeleteSubdirectoriesAndFiles  explicit
```

owner 是自己、且有继承来的 `FullControl` → **两条都满足** → 脚本走到 `ready` 分支、一条 ACL 都不写（R1 的现场就是这个）。至此三件事同时得到解释：`ready` 路径为什么无副作用（K8/K10）、为什么本机在启用 PTC 行之前从不需要准备、以及为什么「准备失败」在本机是纯粹的净损失。

**K9 最终裁定：半成立。**

| 子命题 | 裁定 |
|---|---|
| 设沙箱标签需要 `WRITE_OWNER`，故受限模式前必须有这一步 | **成立**（宿主侧文档） |
| 因此准备步骤对**这台机器**是必需的 | **不成立**：根目录已满足前置，准备是空操作 |
| 因此准备步骤对**任意** `workspace-write` 会话都必需 | **不成立**，只在根不满足前置时需要 |
| 缺陷在准备步骤本身 | **不在**；缺陷在 `tools/execute` 上**无条件**跑它、并把空操作的失败当致命（= #112） |

这条结论直接支撑 Q2 的方向：私有插件要做的不是「修准备脚本」，而是**先问一句前置是否已满足，再决定要不要起 5.1**。这个「问」不需要子进程 —— 脚本 `:17-28` 已经在算同一个 effective 掩码，换成进程内的 `[IO.Directory]::GetAccessControl` + owner SID 即可，且与 §5 的 B1 修复方向同源。

---

## Phase 5 记录：logging 补齐 + 部署（重启后）

用户重启后复核现场：装的是 **v0.3.1 基线且无 `lib/trace.js`**；`dsh-ops-ptc` 与 `dsh-ops-file` 启用、`dsh-ops-shell` 仍关闭。因为 `lib/ptc/index.js:25` 在 `resolveWorker` 之前**无条件**调用 `mountWorkspacePreparation`，所以**这个会话里每一次 `pwsh` 调用都跑过准备脚本并成功** —— 这是 v0.3.1 在真宿主机上 B1 通的**推断式**证据（若准备 reject，钩子不会 `next()`，`pwsh` 必然失败）。它同时说明：这条结论此前只能靠推断，正是 logging 要消灭的那种不确定性。

**补齐的边界**（commit `08298a6`，`node test/run.mjs trace` 13/13）：

| 新增 | 位置 | 补的是哪个盲点 |
|---|---|---|
| `mcp` spawn 半 | `handshake.js` | 长活 MCP 子进程的**实际** spawn（含 `childPid`、被强制的 `FASTCTX_NO_PARENT_WATCH=0`） |
| `mcp` 结果半 | `tools.js` `#connect` | `ready` 与 `handshake-failed` 分开；「起来但从不说话」不再等于「没连上」 |
| `worker` spawn 失败 | `ptc/worker.js`、`file/worker.js` | spawn 抛出时**没有任何进程存在**，此前这种情况一条记录都没有 |
| `worker` runner 失败 | `ptc/worker.js` | 宿主 runner 在 worker 之前就拒绝（`0xC0000142` 那类），与 worker 自己崩掉区分开 |
| `probe` | `binary.js` | 唯一「故意执行谁也没担保的二进制」的跳，附它拿到的 env |
| `install` | `profile-install.js` | K12 引导悖论自己的边界（command/argv/是否经 `cmd /c`） |
| `describeArgv()` | `trace.js` | 把「argv 里有没有宿主 ACL runner 包装」变成字段：`runnerWrapped`/`wrapper` |
| `DSH_OPS_TRACE_FILE` | `trace.js` | 一次实验一个文件，扫描式调查不会互相覆盖或轮转掉 |

**部署**：9 个 `lib/` 文件复制进 `~/.dsh/profiles/web/node_modules/dsh-ops`，逐文件 sha256 与仓库一致；原件备份在 `.dsh-probe/backup-v0.3.1-lib`，可原样回滚。**运行中的宿主仍加载旧模块，需再重启一次才生效。**

**关键操作性质**：`traceEnabled()` 是**每次事件现读**的，所以「装一次 + 重启一次」之后，开关只需增删 `<DSH_HOME>\dsh-ops\trace.on` 标记文件，**不再需要停宿主**。

失效模式的完整目录、五条不变量、盲区清单与下一轮实验（X1–X6）见 **[`handoff-failure-modes.md`](handoff-failure-modes.md)**。

**重启前先拿到的两组实测**（宿主外驱动 `runPreparation` / `probeBinary`，因为它们本身就是那一跳）：

| 组 | 做法 | 结果 |
|---|---|---|
| X1 正向 | 真 5.1 + 真 `prepare-workspace.ps1` + 真工作区根 | `preparation` **resolved** 264 ms；`probe` ok（`dsh-ops-worker 0.3.1`）；I1/I2a/I2b 全绿 |
| X4 负向 | 临时注释掉 `preparationEnvironment()` 的 `delete env.PSModulePath`，跑完立刻 `git checkout`（已核对工作树干净、部署副本 sha256 未变） | `rejected` 249 ms、判类 `module-autoload`、`psModulePath{present:true, coreRootIndex:2, inboxRootIndex:4}`、失败文本 `CouldNotAutoloadMatchingModule` |

**正向与负向只差一个字段**：`env.psModulePath.present`。因此 v0.3.1 的准备步骤在本机**成功**这件事，从推断变成了有记录；而「模块类失效」的 trace 签名也从推测变成了实测（报告存 `.dsh-probe/handoff/x1-report.json`、`x4-report.json`）。

### 计划复核：补上的遗漏

| # | 遗漏 | 处置 |
|---|---|---|
| G1 | logging 只覆盖了四个已出过事的跳，其余 spawn 点全裸 | ✅ 本轮补齐（上表） |
| G2 | `worker` 在 spawn 抛出时**一条记录都没有** —— 最深的一跳在最坏的情况下反而静默 | ✅ 已补（`spawn-failed`） |
| G3 | 没办法在一次调查里把多个实验的日志分开 | ✅ `DSH_OPS_TRACE_FILE` |
| G4 | 「runner 有没有包装 argv」只能靠读代码 | ✅ `describeArgv()` 进字段 |
| G5 | 部署链路没写下来（装到哪、怎么回滚） | ✅ 本节 + `.dsh-probe/backup-v0.3.1-lib` |
| G6 | `npm run verify` 全绿**至今没验过**：工作树没有 `node_modules`、没有 Rust 构建，13 个套件在**基线**上也失败 | ⏳ 待办：`pnpm install` 进工作树后重跑；否则任何 PR 都不该声称 verify 绿 |
| G7 | `submissions/` 仍是旧理解 | ✅ 已加 `STATUS.md`；正文重写仍按 D1 冻结 |
| G8 | 私有补丁形态（D9）与 Q2(a/b) 未决 | ⏳ 仍冻结，等用户拍板 |
| G9 | 部署只验过 sha256 一致，**没验过能不能加载** —— 一份 hash 对得上但 import 就抛的副本会让下次重启整插件挂掉 | ✅ `.dsh-probe/handoff/smoke-deployed.mjs`：12 个入口（含 `lib/components/*/index.js`）从**部署目录**逐个 import 全通；`traceFile()` 指向 `C:\Users\david\.dsh\dsh-ops\trace\handoff.jsonl`；无标记时 `traceEnabled()` 为 `false` |

---

## Phase 6 记录：真宿主第一组记录，与一个意外

宿主重启（`cordis.yml` 18:01:52 被重写）。**18:02:12 建标记文件，18:02:20 第一次 `ops_glob` 就写出记录，中间没有重启** —— 目标 ②「一次安装 + 一次重启之后免重启开关」实测成立。

记录本身（`component:'file'`、`runnerWrapped:false`、`mode:'workspace-write'`、`enforcement:'policy'`、`exitCode:0`、`cwd` 正确）同时证明部署生效、B6/file 的真宿主签名成立、I5 的跨进程判定有据可依（`record.pid` 是宿主进程）。

**意外**：B1 一条记录都没有。为排除「记录丢在别处」，把 `bin/prepare-workspace.ps1` 临时改名（随后立即恢复，已核对 `restored: True`、无残留备份），再调一次 `pwsh` —— **照样成功**。若准备钩子拦到那次调用，它必须先 `await prepareWorkspace(...)`，而脚本不存在 → 5.1 非 0 → reject → 工具必然失败。它没失败。

所以只剩两种可能，且**从外部完全不可区分**：钩子没注册，或钩子每次都跳过（`gate` 或 `mode`）。这暴露了目标 ① 的一处真缺口：**我记了「准备做了什么」，没记「要不要准备、为什么」**。

已在 `b9d5bae` 补上：`dispatch` 记录（`gate` ∈ `no-session`/`not-watched`/`watched`，加 `tool`/`mode`/`outcome`），以及钩子挂载本身的一条 `hook-mounted`。`watchGate()` 把判定理由变成一个值，保证记录与行为不会各说一套。`node test/run.mjs trace` 14/14，已部署。

**下次重启后的判读规则**：

| 看到的 | 结论 |
|---|---|
| `hook-mounted` + `dispatch(gate:'watched', mode:'workspace-write')` | 钩子在；此前是我的推断错了，接着查它为什么没产出 `preparation` |
| `hook-mounted` 但没有 `gate:'watched'` 的 dispatch | 看 `gate` 值：`no-session` = 该调用没有 agent 会话；`not-watched` = 工具名不在名单 |
| 连 `hook-mounted` 都没有 | 钩子没注册；本机已用 stub ctx 证明 `apply({required:false})` 会走到 `inject(['sandboxPolicy','tools'], …)`，所以问题在「回调没触发」或「行没加载」 |

顺带记一条与 K9 有关的事实：**这个组合在整个会话里没有跑过一次准备步骤，而文件工具、`pwsh` 全部正常工作** —— 这是 K9「准备步骤对本机是空操作」在真宿主上的第一份行为证据（此前的依据是 ACL 文档 + 静态分析）。

---

## Phase 7 记录：B1 在真宿主上成立（并撤回 Phase 6 的推断）

第二次重启后（宿主 pid `17752`，`hook-mounted` 于 18:05:12），第一次 `pwsh` 调用给出了这条记录：

```json
{"kind":"preparation","pid":17752,"root":"E:\\Users\\David\\Source\\Playgrounds\\etc",
 "executable":"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
 "args":["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",
         "…\\node_modules\\dsh-ops\\bin\\prepare-workspace.ps1","-Workspace","…\\etc",
         "-BackupDir","C:\\Users\\david\\.dsh\\dsh-ops\\acl-backups"],
 "timeoutMs":120000,
 "spawn":{"windowsHide":true,"detached":false,"stdio":["ignore","pipe","pipe"],"inheritsConsole":false},
 "env":{"count":91,"withheld":[],
        "psModulePath":{"present":false,"roots":[],"coreRootIndex":-1,"inboxRootIndex":-1,"raw":null}},
 "outcome":"resolved","durationMs":277}
```

它一次性证明了四件事，全部是**推断换成记录**：

| 项 | 证据 |
|---|---|
| 钩子挂载 | `dispatch{outcome:'hook-mounted', platform:'win32'}`（18:05:12，宿主启动时） |
| 闸门判定 | `dispatch{tool:'pwsh', gate:'watched', mode:'workspace-write'}` |
| 形状契约 I2a | `spawn.inheritsConsole:false`，`stdio:['ignore','pipe','pipe']` |
| 环境契约 I2b | `env.psModulePath.present:false` |
| 真跑通 | `outcome:'resolved'`、277 ms、真 5.1、真脚本、真 root |

**同时撤回 Phase 6 的推断**（R10）：改名探针无效，因为准备结果按 root 缓存。Phase 6 里「钩子可能没挂」的两种可能都不成立——它挂着、也跑了。

留一个**未解释的窗口**：第一个宿主（pid `34492`，18:01:52—18:05 之间）确实一条 `preparation` 都没有，而当时部署的 `workspace-preparation.js` 已带插桩。记为 Q7，**不作为结论**：可能是我当时读到的 `cordis.yml` 时间戳来自配置保存而非启动，也可能是那次进程里 ptc 行未 apply。证据不足以判定，且答案不影响当前状态。

### 两条顺带量到的事实

1. **准备子进程继承 91 个环境名**，`withheld` 为空 —— `preparationEnvironment()` 是「拷贝减一」而非白名单，所以链条上**最不受限**的那个子进程拿到的是宿主环境减去 `PSModulePath`。本机 91 个名字里没有凭据形状的，实测干净。
2. **代理变量的值不被检查**：`HTTP_PROXY`/`HTTPS_PROXY` 在白名单式的意义上从来不过滤（它们本来就在允许集里），而 `childEnv` 与 `preparationEnvironment` 都只按**名字**判断。本机两个代理都无 userinfo（`has userinfo = False`），所以没有实际暴露；但 `http://user:pass@proxy` 这种写法会把凭据带进最不受限的子进程。记为 F10/F11，**不是 trace 的缺陷，是 env 策略的残余风险**，本次不改。

### X2 现场探针：抓到我自己的一个插桩盲区

把 profile 里的 `dsh-ops-worker.exe` 临时改名（随后恢复，sha256 与基线一致），调一次 `ops_glob`：工具正确报 `ENOENT`，但 trace 里**没有 `worker` 记录**。

原因是结构性的 —— 宿主的 subprocess 服务对「可执行不存在」不抛，而是返回 handle、在 **settle** 时拒绝；两处 worker 记录都写在 `await handle.done` 成功之后。于是**最深的一跳在最常见的失效下恰好静默**。`ac0797c` 修掉（`settle-failed` 分支），单测发现不了（测试里的 `subprocess` 永远返回正常 handle），只有真机把东西弄坏才看得见。

这条对方法论的意义写在 `handoff-failure-modes.md` §8.3：**「插桩充分」不能靠读代码断定，只能靠逐个把东西弄坏。**

---

## Phase 8 记录：机器冷启动 + ASLR 之后，以及 X2/X3 收口

系统重启（ASLR 重新随机化 + 冷启动）后宿主 pid `26376`，18:16:58 `hook-mounted`，18:18:17 第一次 `pwsh` → `preparation resolved 252 ms`。三台宿主的准备耗时 277 / 275 / 252 ms，`psModulePath.present` 一律 `false`。

**欠着的两个探针都跑完了**，且每个都做了「备份 → 改坏 → 调一次 → 立刻恢复」，恢复后 sha256 均为 `89B8E1E9…C8225`、无 `.bak` 残留：

| 探针 | 工具结果 | trace 记录 |
|---|---|---|
| 基线 | 成功 | `worker{exitCode:0, dur:155–189ms}` |
| **X2** 隐藏 worker | `spawn … ENOENT` | **`worker{outcome:'settle-failed', dur:71ms}`** ← `ac0797c` 的修复现场验证 |
| **X3** 换成 `where.exe` | `Worker did not return a settled result:` | **`worker{exitCode:2, dur:107ms}`** |

**新问题：没有。** 重启后 23 条记录里，除我自己制造的两条探针外，零异常 `outcome`；5 次 `ops_*` 调用就是 5 个**全新 ASLR 样本**（每次调用都 spawn 一个新 worker 进程），全部 `exit=0`、时长 155–189 ms 无离群。

**但这不等于「ASLR 无影响」**：ASLR 相关的老病在 `bash` 边界的 MSYS fork 上，而 `dsh-ops-shell` 仍关闭，本次**没有对它取到任何观测**。这是组合限制，不是结论。

### 覆盖表（最终）

| 边界 | 已插桩 | 真宿主见过 | 签名已验证 |
|---|---|---|---|
| B1 准备 + 闸门 | ✅ | ✅ | ✅ resolved / `hook-mounted` / `gate:'watched'` |
| B0 探针 | ✅ | 宿主外驱动真二进制 | ✅ `withheld:[]`、`ok 0.3.1` |
| B6 文件 worker | ✅ | ✅ | ✅ 三种结局（exit 0 / settle-failed / exit 2） |
| B5 FastCtx `mcp` | ✅ | ❌ 组合不使用 | 仅单测 |
| B6 PTC worker | ✅ | ❌ 预设无 PTC 工具 | 仅单测 |
| B4 bash | ✅ | ❌ shell 行关闭 | 仅单测 |
| 安装 `install` | ✅ | ❌ | 仅单测 |

后三行是组合决定的盲区：条件一打开，记录会自己出现，不需要再改代码。

---

## Phase 9 记录：PTC 首次实战 —— 最深一跳走通了

用户新建会话（`ptc` preset）按 [`ptc-live-test.md`](ptc-live-test.md) 执行，把 `PTC-REPORT` 整段贴回。

### 发生了什么

| 步 | 结果 |
|---|---|
| C0 | 顶层只有 `run_code`；嵌套桥暴露 31 个工具，其中含 `ops_batch` / `ops_result` / `ops_glob` … |
| C1 控制组 | 首调因**我的 brief 漏了 `description`**（`pwsh` 必填）报 `ToolCallError: invalid arguments: missing required property "description"`；补上后 `ptc-ok`、exit 0 |
| C2 `ops_batch plan` | `status:'planned'`、`phase:'preflight'`、`detailsRef:j-90ea302e…` |
| C3 `ops_batch resume` | `status:'completed'`、`done:1` |
| C4 `ops_result page` | 1 条 item、`state:'completed'`、`revision:80127b27…`、`logical_bytes:1338` |

**副作用只有一处**：`.dsh-probe/handoff/ptc-copy.json`，1338 B，sha256 与源 `x1-report.json` **逐字节一致**。

### trace 里的三条记录

```
10:32:17 ptc batch  exit=0 dur=249 wrap=true enf=partial outcome=settled
10:32:18 ptc batch  exit=0 dur=248 wrap=true enf=partial outcome=settled
10:32:20 ptc result exit=0 dur=243 wrap=true enf=partial outcome=settled
```

第一条的完整 argv（**第一次真正看到宿主 ACL runner 的包装**）：

```
node.exe
…/@deepseek-ai/dsh-sandbox-windows-acl/lib/runner.js
--workspace E:\Users\David\Source\Playgrounds\etc
--temp C:\Users\david\AppData\Local\Temp\dsh-DnBuc9
--mode workspace-write
--write-sid S-1-4-720055349-192371211
--temp-write-sid S-1-4-367061366-754671932-1
--
C:\Users\david\.dsh\profiles\web\node_modules\dsh-ops\runtime\win32-x64\dsh-ops-worker.exe
```

这与 `dsh-sandbox-windows-acl` 文档里的 argv 契约逐项吻合：runner 在前、工作区/私有 temp、两个能力 SID、`--` 之后才是真正的 worker。

### 裁定

| # | 断言 | 结果 |
|---|---|---|
| A1 | preset 正确 | ✅ 顶层只有 `run_code` |
| A2 | 嵌套桥可用 | ✅ `ptc-ok`（首调失败是 brief 的缺陷，不是桥） |
| A3 | 深层 handoff 发生 | ✅ 3 条 `worker{component:'ptc', exitCode:0}` |
| A4 | 沙箱真套上 | ✅ `runnerWrapped:true` + `enforcement:'partial'` —— **不变量 I4 首次被验证** |
| A5 | 效果路径可用 | ✅ `resume` completed，副本逐字节一致 |
| A6 | 审计可读 | ✅ `page` 读回 item 与 revision |

**K3 关闭。** 这是本轮唯一可能推翻「现在能用」的未知，现在有了正面证据。

### 三条需要记下来的细节

1. **`enforcement: 'partial'` 不是退化**。ACL 包自己写明保证是**部分**的（只限写、不限制读；硬链接与 AppContainer 文件仍不可读）。宿主每次 `run_code` 还会附一行 `File sandbox enforcement is partial on this host.`。把它读成「我们的改动导致降级」会是误判。
2. **`run_code` 本身也在准备钩子的 watch 列表里**：18:32:09–18:32:20 有 6 条 `dispatch{tool:'run_code', gate:'watched', dur:0ms}` —— 钩子每次都触发，但 root 已缓存，所以 0 ms。
3. **这次没有重新跑准备**（同一宿主里 root 已被我先前的 `pwsh` 调用缓存），所以 B1 在 PTC 路径上的**首次**执行仍未观测到；要观测，得在重启后的宿主里先跑 PTC 再跑别的东西。记为 Q8。

### 未取到的证据（诚实边界）

- `0xC0000142`（K7）**没有出现** —— 这次没撞上，所以对它的归因没有任何进展。
- `ops_batch` 的 plan 阶段 `done:0, phase:'preflight'`，即 preflight 与执行都在同一个 worker 进程里完成；但没有单独验证「preflight 失败时是否也走同一路径」（未做探针）。

---

## Phase 10 记录：归零到官方 v0.3.1（K1 关闭）

用户的两次实跑：

1. `-StageOnly -FromCache` → 从缓存的两件发布物组装 staging：461 个标签文件 + 5 个运行时文件，校验通过。
2. `-Zero -FromCache` → 先 `uninstall`（`Packages: -5`，移除 `file:...dsh-ops-base`），再 `add file:C:\Users\david\AppData\Local\dsh-ops-src\0.3.1`（`Packages: +4`）；`status` 报 `dependency: file:C:/Users/david/AppData/Local/dsh-ops-src/0.3.1`、`enabled: true`。

**随后核对（不是照抄脚本自述）**：

| 检查 | 结果 |
|---|---|
| 安装副本 vs staging | `lib/` 下 **50 个文件逐个 sha256 一致**，零漂移 |
| 官方性 | 无 `lib/trace.js`；`workspace-preparation.js` 里无 `traceHandoff` |
| 版本 / 运行时 | 安装副本 0.3.1；runtime receipt 0.3.1 `win32-x64`；worker `89B8E1E9…C8225` |
| 可选平台包 | `@dsh-ops/{bash,fastctx,pwsh}-win32-x64` 三个都在（`-5/+4` 没丢东西） |
| 宿主是否已换构建 | **是**：部署后（19:54 之后）trace 记录数为 **0** —— 插桩构建若还在跑，这一次 `pwsh` 调用必然留下 `dispatch` 记录 |
| trace 开关 | 标记 `trace.on` 已删（免得将来重新部署插桩构建时它悄悄开始写日志）；日志文件保留作证据 |

**K1 关闭。** profile 声明与安装副本第一次指向**同一棵由 GitHub 派生、摘要可核**的树。

### 代价（诚实记录）

归零后跑的是**官方构建，没有 trace 代码**。`handoff-failure-modes.md` 里那套现场观测能力**此刻不存在**：日志停在 19:53:41，之后只会有工具结果、没有 handoff 记录。要再取证，把 `audit/handoff-trace`（`ac0797c`）那棵树按同一条安装路径部署回去。

另一个易被误解的细节：`node_modules/dsh-ops` 是 pnpm 从 store **硬链接出来的实体副本**（`linkType` 为空），不是指向 staging 的符号链接。它是**快照** —— 改了 staging 不会自动生效，要重跑一次部署。

---

## 下一步

**handoff logging 这条线已经收口。** 剩下的是明确挂账项，不是未完成的工作：

| ID | 动作 | 状态 |
|---|---|---|
| L6 | 重启后用 X2 确认 `settle-failed`，再跑 X3 / X6 | ✅ 完成（X2 `settle-failed`、X3 `exit=2`、X6 关闭后日志一字未增） |
| L3 | X1 正向与 X4 负向的宿主外实测（`x1-report.json` / `x4-report.json`） | ✅ 完成 |
| R1–R10 | 认知修订（含撤回 Phase 6 的改名探针推断） | ✅ 全部记入 |
| **G6** | `pnpm install` 进工作树，让 `npm run verify` 真正可判 | ⏳ **唯一实质待办**；在此之前任何 PR 都不该声称 verify 绿 |
| **Q7** | 第一个宿主（pid `34492`）为何一条 `preparation` 都没有 | ⏳ 未解释，证据不足，不影响当前状态 |
| **Q2 / D9** | 私有补丁形态与接管程度 | ⏳ 按原议冻结，等用户拍板 |
| B4 / B5 / B6-ptc | 三条边界只有单测覆盖 | ⏳ 组合限制：shell 行打开 / 用 FastCtx / 用 PTC 预设，任一满足即自动获得记录 |

### 历史步骤（已完成，留档）

| ID | 动作 |
|---|---|
| S1 | **读**（不是装）：确认「从 GitHub 安装 0.3.1」的准确形态 ✅ |
| S2 | 按 S1 归零到 0.3.1；确认探针无残留；commit `.dsh` ✅ |
| S3 | 在干净基线上复核 K9（Phase 4）与 K10（verified） ✅ |
| P1 | **Phase 1**：`0.3.0` ↔ `v0.3.1` 机械 diff，重写 claims register ✅ |
| P2 | **Phase 2**：`lib/trace.js` + 四处 handoff 插桩（`97eca7e`） ✅ |
| P3 | **Phase 3**：四个上游报告的全量裁定 → `consistency-audit.md` ✅ |
| P4 | **Phase 4**：K9 结论（半成立） ✅ |
| L1 | 部署进 profile、真宿主取记录、标记免重启 ✅ |
| L2 | 判定准备钩子去向：挂着，B1 真跑通 ✅ |
| L4 | ~~钩子未挂载则查 `apply`~~ 前提不成立，作废（R10） ✅ |
| L5 | X2 探针：抓到 settle 失败无记录的盲区（`ac0797c`） ✅ |
| S4 | 据 Phase 1/3 结论决定 Q2 的 a/b | ⏳ 冻结 |
