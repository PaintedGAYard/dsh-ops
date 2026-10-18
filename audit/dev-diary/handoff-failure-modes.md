# handoff logging · 失效模式调查设计

日期 2026-10-18。分支 `audit/handoff-trace`（`08298a6`），已部署到 live profile（9 个 `lib/` 文件，sha256 与仓库逐个比对一致）。

本文回答两件事：**边界上都记了什么**（任务 1）、**拿它怎么查失效模式**（任务 2）。裁定用的同签名多成因表在 `consistency-audit.md`，本文只讲 instrument。

---

## 0. 怎么开、怎么分文件

| 动作 | 做法 | 是否需要重启 |
|---|---|---|
| 开 | 环境变量 `DSH_OPS_TRACE=1`，或写 `<DSH_HOME>\dsh-ops\trace.on` | 环境变量要；**标记文件不要**（`traceEnabled()` 每次事件现读） |
| 关 | `DSH_OPS_TRACE=0`（压过标记文件），或删标记 | 同上 |
| 分文件 | `DSH_OPS_TRACE_FILE=<绝对路径>` | 要（宿主环境变量） |
| 默认落盘 | `<DSH_HOME>\dsh-ops\trace\handoff.jsonl`，4 MiB 一轮转 | — |

**关键设计**：模块在宿主启动时就已加载，**是否记录是每次事件现读的**。所以「装一次 + 重启一次」之后，整场调查靠增删标记文件即可，不必再停宿主。代价：`DSH_OPS_TRACE_FILE` 是环境变量，改它要重启 —— 所以分文件的正确用法是**在探测脚本进程内设置**（探针自己 spawn 子进程时），而不是改宿主环境。

---

## 1. 边界与记录

一条记录 = 一次跨边界。`record.pid` 是**写记录的那个进程**的 pid，于是「这一跳换没换进程」本身就是可读事实。

| kind | 发出位置 | 主要字段 |
|---|---|---|
| `probe` | `binary.js` `probeBinary` | `file`、`argv`、`outcome`、`exitCode`、`signal`、`detail`、`env` |
| `preparation` | `workspace-preparation.js` `runPreparation` | `root`、`executable`、`args`、`timeoutMs`、`spawn{stdio,inheritsConsole,windowsHide}`、`env`、`outcome`、`durationMs`、`failure` |
| `bash` | `shells.js` `bashToolDefinition.execute` | `file`、`source`、`workdir`、`head`、`runnerWrapped`、`wrapper`、`argv`、`env`、`outcome`、`exitCode`、`signal`、`timedOut`、`durationMs` |
| `mcp`（spawn 半） | `handshake.js` `start` | `file`、`argv`、`cwd`、`childPid`、`spawn`、`env`、`timeoutMs` |
| `mcp`（结果半） | `tools.js` `#connect` | `outcome`（`ready`/`handshake-failed`）、`serverName`、`serverVersion`、`toolCount`、`shared`、`durationMs`、`failure` |
| `worker` | `ptc/worker.js`、`file/worker.js` | `component`、`tool`、`head`、`runnerWrapped`、`wrapper`、`argv`、`mode`、`enforcement`、`exitCode`、`signal`；失败分支另带 `outcome`（`spawn-failed`/`runner-failure`）与 `stderrHead` |
| `install` | `profile-install.js` | `operation`、`target`、`command`、`prefix`、`args`、`via`（`cmd /c`/`direct`）、`env` |
| `dispatch` | `workspace-preparation.js` `mountWorkspacePreparation` | `gate`（`no-session`/`not-watched`/`watched`）、`tool`、`mode`、`outcome`（`hook-mounted`/`prepared`/`skipped`/`preparation-failed`）、`failure` |

`env` 的形状固定：`{count, names, withheld, psModulePath{present,roots,coreRootIndex,inboxRootIndex,raw}, fastctxBash}`。**名字全记，凭据形状的值一个不记**。

---

## 2. 失效模式目录

每条给三样：**trace 签名**（怎么从记录认出来）、**触发手段**（怎么造）、**可判定性**（是不是唯一解释）。

### 2.1 `probe`（唯一故意执行「谁也没担保」的二进制的那一跳）

| 模式 | trace 签名 | 触发 | 唯一？ |
|---|---|---|---|
| 候选不存在 | `outcome:'failed'`、`detail` 含 `ENOENT`、`exitCode:null` | 删掉 `runtime/win32-x64/dsh-ops-worker.exe` 后触发一次工具挂载 | 是 |
| 候选存在但不可执行 | `detail` 含 `EPERM`/`EACCES` | 把 worker 的 DACL 改成拒绝执行 | 是 |
| 是别的程序/坏构建 | `outcome:'failed'`、`exitCode:1` | 把 `dsh-ops-worker.exe` 换成任意 exe | 是 |
| 挂死 | `durationMs ≈ timeoutMs`、`signal:'SIGTERM'`、`detail` 含 `ETIMEDOUT` | 换成 `cmd /c ping -t 127.0.0.1` 之类 | 是 |
| 探针拿到宿主环境（安全回归） | **`env.withheld` 非空**（例如出现 `GH_TOKEN`） | 把 `probeBinary` 的默认 `env` 改回 `process.env` | 是（唯一的哨兵） |

### 2.2 `preparation`（B1，本机唯一会起 5.1 的地方）

| 模式 | trace 签名 | 触发 | 唯一？ |
|---|---|---|---|
| 执行策略拦截 | `outcome:'rejected'`、`failure` 含 `UnauthorizedAccess`/`PSSecurityException` | `-ExecutionPolicy Bypass` 被组策略压过，或 MOTW + `RemoteSigned` | 与模块类靠文案区分（见 §2.6） |
| 模块自动加载失败 | `failure` 含 `CouldNotAutoloadMatchingModule`/`is not recognized`；**且** `env.psModulePath.present:false` | 让准备器继承毒 `PSModulePath`（回退 `env` 选项） | 是 |
| 前置条件不满足 | `failure` 含 `not owned by the current user`/`Explicit effective denial` | 拿一个别人 owner 的目录当 root（`E:\`） | 是 |
| 超时 | `failure` 含 `timed out after`、`durationMs ≈ timeoutMs` | 极慢/极大工作区；或把 `PREPARATION_TIMEOUT_MS` 调到很小 | 是 |
| 解释器不存在 | `failure` 含 `could not start` | `SystemRoot` 指向不存在的盘 | 是 |
| **形状回归**（静默） | `spawn.inheritsConsole:true`，或 `spawn.stdio` 不是 `['ignore','pipe','pipe']` | 把 spawn 改成 `inherit` | 是 |

**这一跳最值钱的两条不变量**：
`spawn.inheritsConsole === false` 与 `env.psModulePath.present === false`。它们合起来就是「这个 handoff 的形状契约」。任何一条翻转，都是 5.1 会开始改写/继承模块路径的前兆 —— 而不是等到 `Get-Acl` 挂掉才发现。

### 2.3 `mcp`（B5，起一个长活进程并等它说协议）

| 模式 | trace 签名 | 触发 | 唯一？ |
|---|---|---|---|
| 可执行不存在 | spawn 半 `childPid:null` + 结果半 `handshake-failed`（`ENOENT`） | 删 runtime | 是 |
| 起来即死 | spawn 半有 pid；结果半 `handshake-failed` 且 `durationMs` 很小 | 换成一个立刻退出的 exe | 是 |
| 起来但从不说话 | 结果半 `handshake-failed`、`durationMs ≈ 60000` | 换成 `cmd /c pause` | 是 |
| 正常 | `outcome:'ready'` + `toolCount` | — | — |
| 重连风暴 | 短窗口内多条 `mcp` spawn 半记录、pid 各不相同 | 反复杀 runtime 进程 | 是（计数即可判定） |
| 环境被改 | spawn 半 `env.names` 里没有 `FASTCTX_NO_PARENT_WATCH`，或值不是 `'0'` | 改 `handshake.start` | 是 |

### 2.4 `bash`（B4）

| 模式 | trace 签名 | 触发 | 唯一？ |
|---|---|---|---|
| shell 不存在 | `outcome:'handoff-failed'`（spawn 抛）或工具返回 `EXECUTOR_UNAVAILABLE` + `runnerWrapped:true` | 清空 `bashPath`、把 provisioned 副本改名 | 是 |
| runner 起不来 | `runnerWrapped:true` + `exitCode` 非 0（如 `0xC0000142` = 3221225794） | 受限令牌下高频 spawn | 是 |
| workdir 非法 | 根本到不了 spawn（插件自己先拒） | 传一个不存在/是文件的 workdir | 是（`handoff` 为 `undefined`，无记录） |
| 超时 | `timedOut:true`、`durationMs ≈ timeoutMs`、`signal` | 跑 `ping -t` | 是 |
| 拒绝检测失效（locale） | 记录里 `env.LC_MESSAGES` 与 `LC_ALL` 的形状；`LC_ALL:''` 且 `LC_CTYPE` 存在 | 宿主设 `LC_ALL=zh_CN.UTF-8` | 是 |

### 2.5 `worker` / `install`（B6 与安装）

| 模式 | trace 签名 | 触发 | 唯一？ |
|---|---|---|---|
| 宿主 subprocess 服务拒绝 spawn | `outcome:'spawn-failed'` + `failure` | 策略/服务缺失 | 是 |
| runner 拒绝（未到 worker） | `outcome:'runner-failure'` + `stderrHead` | 受限令牌 + 缺前置 | 是 |
| worker 自己非 0 | 无 `outcome` 字段（settled 记录） + `exitCode` 非 0 | 换坏 worker | 是 |
| 走了哪个 worker | `head` + `runnerWrapped` + `argv` | — | 是 |
| 安装器 launcher 不存在 | `install` 记录里的 `command`/`via` + 随后 `spawnSync` 的 `ENOENT` | npx 宿主停机后跑安装（K12 引导悖论） | 是 |

### 2.6 跨模式的归因规则

同签名多成因的分辨，靠**三个读数**而不是错误文案：

1. `preparation.failure` 的文案 → 策略类 / 模块类 / 前置类 / 超时。
2. `preparation.env.psModulePath.coreRootIndex` 与 `inboxRootIndex` 的**大小关系** → 模块类是「毒在」还是「毒在前」。
3. `env.withheld` / `env.names` → 是不是环境被谁换过。

---

## 3. 五条不变量（可写成断言，也可以人工扫）

| # | 不变量 | 违反意味着 |
|---|---|---|
| I1 | `probe.env.withheld` 为空 | 探针开始拿到凭据名 —— `lib/env.js` 的 allow-list 被绕开 |
| I2 | `preparation.spawn.inheritsConsole === false` 且 `env.psModulePath.present === false` | 准备器的形状契约破了，5.1 会重新继承/改写 |
| I3 | 每个 `mcp` spawn 记录的 `env` 里 `FASTCTX_NO_PARENT_WATCH === '0'` | 父进程守护被关掉（崩溃/强杀失去兜底） |
| I4 | `worker.runnerWrapped === true` ⇔ `mode !== 'danger-full-access'`（`component:'ptc'`） | 受限模式没走 runner（或反之）—— 沙箱边界穿帮。**已现场验证**：3 条 `worker{component:'ptc', runnerWrapped:true}`, argv 见日记 Phase 9 |
| I5 | 同一条命令链上 `record.pid` 只在跨进程处变化 | 多了一个本不该存在的转发进程 |

I1–I5 都不需要额外工具：把 JSONL 读进来逐条断言即可。这也是「用 logging 查失效模式」最省力的形态 —— **先查不变量，再看个案**。

---

## 4. 盲区（记不到的东西，必须写清楚）

1. **bash 的 fork 子进程**：MSYS 的 fork 在 bash 内部，插件看不到。只能从 `exitCode`/`stderr` 反推（例如 `0xC0000142`）。
2. **ACL runner 内部**：`worker` 记录能证明 argv 被包装过、能记到 exit code 与匹配到 runner 失败规则的 stderr 头，但 runner 自己内部的每一步不可见。
3. **DSH 宿主的 `subprocess` 服务**：它是插件与子进程之间的转发者，插件只能记「交出去什么」与「拿回什么」。
4. **MCP 协议内的非 JSON 输出**：落在 `McpStdioClient.stderrLines`，不进 trace。若要，可在 `#onExit` 里补一条。
5. **凭据值**：结构性不记，这是设计约束不是遗漏。

---

## 5. 下一轮要跑的实验（等重启后）

按「一次重启、一个标记文件、逐条增删」的顺序：

| # | 实验 | 期望判出 |
|---|---|---|
| X1 | 正常一次 `pwsh` + 一次 `ops_*` + 一次 PTC | 基线记录组：`preparation`(resolved) → `worker`/`mcp`(ready)，pid 关系符合 I5 |
| X2 | 在标记文件开启下，把 runtime 改名 → 触发一次 | §2.1 的 ENOENT 与 §2.3 的 spawn 半 `childPid:null` |
| X3 | 把 worker 换成 `cmd /c pause` | §2.3「起来但从不说话」，`durationMs ≈ 60000` |
| X4 | 让准备器继承毒 `PSModulePath`（改 `preparationEnvironment` 返回 `process.env`） | §2.2 模块类签名 + `psModulePath.coreRootIndex < inboxRootIndex` |
| X5 | 把 5.1 的执行策略改成 `Restricted` | §2.2 策略类签名，与 X4 同一工具结果、不同记录 |
| X6 | **恢复**并确认标记文件关闭后 `handoff.jsonl` 不再增长 | 关闭路径有效 |

X2–X5 都需要改产品文件（改完再改回），因此必须在 fork 分支上做、逐条 commit，**绝不进上游**。

---

## 6. 实测记录（2026-10-18，宿主外驱动）

宿主还没重启（部署写入 17:57–17:59，`~/.dsh\dsh-ops` 尚不存在），但 **B1 与 B0 不依赖宿主**：`runPreparation` / `probeBinary` 本身就是那一跳。用真 5.1、真 worker、真工作区根驱动，得到了第一组**正面证据**。

### X1（正向）· `.dsh-probe/handoff/x1-report.json`

| 项 | 实测 |
|---|---|
| `preparation` | **resolved**，264 ms（真 `powershell.exe` 5.1，真 `bin/prepare-workspace.ps1`，真 root） |
| `probe` | `ok`，`dsh-ops-worker 0.3.1`（profile 里那份二进制） |
| I2a | ✅ `spawn = {windowsHide:true, detached:false, stdio:['ignore','pipe','pipe'], inheritsConsole:false}` |
| I2b | ✅ `env.psModulePath.present === false` |
| I1 | ✅ `probe.env.withheld === []` |
| 记录格式 | `preparation@21172`、`probe@21172` —— 同一进程，`v:1`，`at` 合法 |

**这条的意义**：v0.3.1 的准备步骤在本机**成功**，此前只有推断（「若失败 `pwsh` 必然报错」）。现在有了记录。

### X4（负向）· `.dsh-probe/handoff/x4-report.json`

临时把 `preparationEnvironment()` 的 `delete env.PSModulePath` 注释掉（= 回退成 0.3.0 的继承形状），跑同一条路径，然后立刻 `git checkout` 还原（已核对工作树干净、部署副本 sha256 未变）：

| 项 | 实测 |
|---|---|
| `outcome` | `rejected`，249 ms |
| 判类 | `module-autoload` |
| `shape` | `present:true`、`coreRootIndex:2`、`inboxRootIndex:4`、**`poisonAheadOfInbox:true`** |
| 失败文本 | `CouldNotAutoloadMatchingModule` / `CommandNotFoundException (Get-Acl)` |

**这条的意义**：正向与负向**只差一个字段** —— `env.psModulePath.present`。也就是说 §2.2 里「模块类」这一行的判定，不是推测，是实测：`present:false` ⇔ 通；`present:true` + `coreRootIndex < inboxRootIndex` ⇔ 必死，且死法与现场逐字一致。

### 还没验的

- `mcp` 的两条记录（`ready` 在 `tools.js#connect` 里）需要真宿主，等重启。
- `worker`（`component:'file'|'ptc'`）需要宿主 subprocess 服务，等重启。
- X5（执行策略类）：要让 5.1 的 effective 策略低于 `RemoteSigned` 且压过 `-ExecutionPolicy Bypass`，只能靠组策略或改本机策略。**不改用户机器**，因此这一行保留为「外部报告 + 未本机复现」（见 `consistency-audit.md` §3）。

---

## 7. 真宿主第一组记录（2026-10-18 18:02，重启后）

部署后宿主重启（`cordis.yml` 于 18:01:52 被重写）。创建标记文件 **18:02:12**，下一次 `ops_glob` 在 **18:02:20** 就写出了记录 —— 中间没有重启：

```json
{"v":1,"at":"2026-10-18T10:02:20.528Z","pid":34492,"kind":"worker","component":"file","tool":"glob",
 "head":"…\\profiles\\web\\node_modules\\dsh-ops\\runtime\\win32-x64\\dsh-ops-worker.exe",
 "runnerWrapped":false,"wrapper":null,"argv":["…\\dsh-ops-worker.exe"],
 "cwd":"E:\\Users\\David\\Source\\Playgrounds\\etc","mode":"workspace-write","enforcement":"policy",
 "exitCode":0,"signal":null}
```

这一条同时钉住四件事：

1. **部署生效**：记录来自部署目录里的 `lib/file/worker.js`。
2. **标记文件免重启生效**（目标 ② 实测）：18:02:12 建标记，18:02:20 出记录，中间无重启。
3. **B6/file 的真宿主签名**：`component:'file'`、`runnerWrapped:false`（文件工具不走 ACL runner）、`mode:'workspace-write'`、`enforcement:'policy'`、`exitCode:0`。
4. `record.pid` 是宿主进程，与我的 shell 进程不同 —— I5 的跨进程判定有据可依。

### 当时的推断 —— **已撤回，见 §8**

把 `bin/prepare-workspace.ps1` 临时改名（随后立即恢复，已核对 `restored: True`、无残留备份）之后，一次 `pwsh` 调用**照样成功**。若准备钩子真的拦到了那次调用，它必须先 `await prepareWorkspace(...)`，脚本不存在 → 5.1 非 0 → reject → 工具调用必然失败。它没失败。

于是只剩两种可能，而**从外部看它们完全一样**：

| 可能 | 含义 |
|---|---|
| 钩子根本没注册 | `dsh-ops-ptc` 的 `apply` 没跑，或 `root.inject(['sandboxPolicy','tools'], …)` 的回调没触发 |
| 钩子注册了但每次都跳过 | `gate` 判定为 `no-session`/`not-watched`，或 `mode !== 'workspace-write'` |

这不是「准备失败」，而是**准备的判定过程此前根本没进日志** —— 目标 ①「补齐边界」漏掉的正是这一跳：我记了「准备做了什么」，没记「要不要准备、为什么」。

已在 `b9d5bae` 补上：`dispatch` 记录带 `gate`/`tool`/`mode`/`outcome`，并且**钩子挂载本身**也写一条 `hook-mounted`。于是下次重启后：

- 出现 `hook-mounted` + `dispatch(gate:'watched', mode:'workspace-write')` → 钩子在，之前是我的推断有误；
- 出现 `hook-mounted` 但没有 `watched` 的 dispatch → 看 `gate` 值就知道卡在哪一档；
- 连 `hook-mounted` 都没有 → 钩子没注册，`dsh-ops-ptc` 的 `apply` 没跑到，下一步查它为什么不跑（已在本机用 stub ctx 证明 `apply` 走到 `inject(['sandboxPolicy','tools'], …)`，所以问题在「回调没触发」或「行没加载」）。

---

## 8. 第二次重启：B1 落地，§7 的推断撤回

宿主 pid `17752`，`hook-mounted` 于 18:05:12；第一次 `pwsh` 在 18:05:55 给出完整 `preparation` 记录：`outcome:'resolved'`、277 ms、`spawn.inheritsConsole:false`、`env.psModulePath.present:false`、`env.count:91`、`withheld:[]`。

**§7 里「改名探针」的结论作废**（R10）：准备结果按 root 缓存，第一次成功之后改脚本不会让任何后续调用失败，因此那个探针**不能**区分「钩子没挂」与「钩子挂了但已缓存」。真答案是：钩子挂着，也跑了。

`dispatch.durationMs` 由此成为必需字段 —— 首跳 277 ms、后续同 root 的调用 ~0 ms。没有它，`prepared` 这一个词会同时指「这次起了 5.1」和「这次什么都没做」。

### 8.1 每条边界的现场覆盖

| 边界 | kind | 已插桩 | 真宿主见过 | 签名已验证 |
|---|---|---|---|---|
| B1 准备 | `preparation` + `dispatch` | ✅ | ✅ 18:05:55 | ✅ 见上 |
| B0 探针 | `probe` | ✅ | 宿主外驱动真二进制 | ✅ `withheld:[]`、`ok`、`0.3.1` |
| B6 文件 worker | `worker{component:'file'}` | ✅ | ✅ 18:02 起多次 | ✅ 三种结局：`exit=0`（基线）、`settle-failed`（X2）、`exit=2`（X3） |
| B5 FastCtx | `mcp` | ✅ | ❌ 本组合不用 FastCtx | 仅单测 |
| B6 PTC worker | `worker{component:'ptc'}` | ✅ | ✅ 10-18 18:32（3 条） | ✅ `runnerWrapped:true`、`enforcement:'partial'`、exit 0、243–249 ms；argv 是 ACL runner 包裹形态 |
| B4 bash | `bash` | ✅ | ❌ `dsh-ops-shell` 关闭 | 仅单测 |
| 安装 | `install` | ✅ | ❌ | 仅单测 |

后三行是**组合决定的盲区，不是插桩缺口**：shell 行一打开、预设换成 PTC、或跑一次安装，记录会自己出现，不需要再改代码。

### 8.2 两条量出来的事实

| # | 事实 | 含义 |
|---|---|---|
| F10 | 准备子进程继承 **91** 个环境名，`withheld` 空 | `preparationEnvironment()` 是「拷贝减一」而非白名单：链条上**最不受限**的子进程拿到的是宿主环境减 `PSModulePath`。本机 91 个名字里无凭据形状 |
| F11 | 代理变量按**名字**放行、值不过滤；本机 `HTTP_PROXY`/`HTTPS_PROXY` 的 `has userinfo = False` | `http://user:pass@proxy` 这类写法会把凭据带进那个子进程。属于 env 策略的残余风险，不是 trace 缺陷；本次不改 |

### 8.3 X2 / X3 现场：三种 worker 结局，三种可区分记录

每个探针都走「备份原件 → 改坏 → 调一次 `ops_*` → 立刻恢复」，恢复后 sha256 一律 `89B8E1E9…C8225`，插件目录无 `.bak` 残留。

| 探针 | 做法 | 工具结果 | trace 记录 |
|---|---|---|---|
| 基线 | 正常 worker | 成功 | `worker{exitCode:0, dur:155–189ms}` |
| **X2** | `dsh-ops-worker.exe` 改名（文件不存在） | `spawn … ENOENT` | **`worker{outcome:'settle-failed', dur:71ms, failure:'Error: spawn … ENOENT'}`** |
| **X3** | 换成系统 `where.exe`（能启动、不会说协议） | `Worker did not return a settled result:` | **`worker{exitCode:2, dur:107ms}`** —— 无 `outcome` 字段即「已 settle」 |

三者互不混淆：

- **无 `outcome` + 有 `exitCode`** = 进程跑完并给了答案（对或错）；
- **`outcome:'settle-failed'`** = 进程根本没被创建（宿主在 settle 时才报 ENOENT）；
- **`outcome:'spawn-failed'`** = 宿主在 spawn 当场拒绝（防御分支，真机上尚未见到）。

X2 还纠正了一个结构性误解：宿主的 subprocess 服务对「可执行不存在」**不抛**，它返回 handle、在 settle 时拒绝。所以 `spawn-failed` 分支在真机上几乎不触发，真正要覆盖的是 settle —— `ac0797c` 补的就是这个。

> 结论：**「插桩充分」不能靠读代码断定，只能靠逐个把东西弄坏。** 单测里的 `subprocess` 是假的、永远返回正常 handle，因此这类盲区只有真机探针能发现。

### 8.4 机器冷启动 + ASLR 之后：没有新失效模式

系统重启（ASLR 重新随机化 + 冷启动）后宿主 pid `26376`，到 18:19 为止的 23 条记录：

| 项 | 结果 |
|---|---|
| `preparation` | 1 条，**resolved 252 ms**（前两台宿主为 277 / 275 ms），`psModulePath.present:false` |
| `worker` | 7 条：X2 的 `settle-failed`、X3 的 `exit=2`、**5 条 `exit=0`**（dur 155–189 ms） |
| 异常 `outcome` | 除我自己制造的两条探针外，**零** |
| `dispatch` | 15 条，全部 `gate:'watched'` / `mode:'workspace-write'` |

每次 `ops_*` 调用都会 spawn 一个新的 worker 进程，**所以那 5 条 `exit=0` 是 5 次全新的 ASLR 样本**，全部干净，时长也在同一区间内没有离群值。

这只能说明**文件/准备两条边界**在 ASLR 打开后没有变化；ASLR 相关的老病（provisioned git bash 的 MSYS fork）在 `bash` 边界上，而 `dsh-ops-shell` 仍关闭，所以**本次没有对它取到任何观测** —— 这是组合限制，不是「ASLR 无影响」的结论。
