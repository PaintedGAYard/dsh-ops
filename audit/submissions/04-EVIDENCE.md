# Evidence pack

Everything a reviewer can re-run. No claim in `01-ISSUES.md` / `02-COMMENTS.md` goes beyond what is
recorded here.

---

## 1. Launch-shape matrix (trigger of #146's signature)

One Windows PowerShell 5.1 binary (`5.1.26100.9444`), `-NoProfile -NonInteractive -ExecutionPolicy
Bypass`, `-File rung-5.1.ps1 -Target E:\Users\David\Source\Playgrounds\etc`.

"entries" is the `PSModulePath` entry count the *interpreter itself* reported
(`[Environment]::GetEnvironmentVariable('PSModulePath')`).

| handed in | attached launch | detached launch |
| --- | --- | --- |
| host value (5 entries, incl. `…\PowerShell\7\Modules`) | `Get-Acl` OK · entries 3 (rewritten) | `Get-Acl` **FAILED** · entries 5 (verbatim) |
| `C:\Users\david\.dsh\profiles\web\node_modules\@dsh-ops\pwsh-win32-x64\bin\Modules` | OK · variable absent | **FAILED** · entries 1 (verbatim) |
| `C:\Program Files\PowerShell\7\Modules` | OK · variable absent | **FAILED** · entries 1 (verbatim) |
| absent | OK · entries 3 (defaults) | OK · entries 3 (defaults) |

Failure text, identical in the three failing cells:

```
The 'Get-Acl' command was found in the module 'Microsoft.PowerShell.Security', but the module could
not be loaded. For more information, run 'Import-Module Microsoft.PowerShell.Security'.
  FullyQualifiedErrorId: CouldNotAutoloadMatchingModule
```

## 2. Which part of "detached" matters

Fixed input: the host-shaped `PSModulePath`.

| mode | console | stdio | `Get-Acl` |
| --- | --- | --- | --- |
| A | parent's console | all three inherited | OK |
| B | parent's console | redirected | **FAILED** |
| C | hidden window | all three inherited | **FAILED** |
| D | hidden window | redirected | **FAILED** |

`lib/workspace-preparation.js` uses D (`windowsHide: true`, `stdio: ['ignore','pipe','pipe']`).

## 3. Per-command resolution inside the failing launch

`Get-Command -Name <cmd> -All` evaluated inside 5.1, same process, both launch shapes.

| command | module (attached) | detached launch |
| --- | --- | --- |
| `Get-Item` | Microsoft.PowerShell.Management | resolves |
| `Join-Path` | Microsoft.PowerShell.Management | resolves |
| `Set-Content` | Microsoft.PowerShell.Management | resolves |
| `Where-Object` | Microsoft.PowerShell.Core | resolves |
| `Add-Type` | Microsoft.PowerShell.Utility | resolves |
| `Write-Output` | Microsoft.PowerShell.Utility | resolves |
| `Get-Date` | Microsoft.PowerShell.Utility | resolves |
| **`Get-Acl`** | **Microsoft.PowerShell.Security** | **`<UNRESOLVED>`** |
| **`Set-Acl`** | **Microsoft.PowerShell.Security** | **`<UNRESOLVED>`** |

## 4. What the host actually hands in

Captured from inside `preparationEnvironment()` in the live host process (0.3.0 code, i.e. before the
`#83` scrub), then from the 5.1 child after it.

```
host PSModulePath = "E:\Users\David\Documents\PowerShell\Modules;C:\Program Files\PowerShell\Modules;
                     c:\program files\powershell\7\Modules;C:\Program Files\WindowsPowerShell\Modules;
                     C:\WINDOWS\system32\WindowsPowerShell\v1.0\Modules"
host PSModuleAutoLoadingPreference = null
---
child: psversion=5.1.26100.9444  pshome=C:\Windows\System32\WindowsPowerShell\v1.0
       PSModulePath=<absent>          (after #83's scrub)
       PSExecutionPolicyPreference=Bypass
```

## 5. #106 — partial reproduction

`E:\` is owned by `S-1-5-32-544` (BUILTIN\Administrators) and the current user does **not** hold
`WRITE_OWNER` there under a filtered token:

```
$ powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass `
    -File …\dsh-ops\bin\prepare-workspace.ps1 -Workspace 'E:\' -BackupDir $env:TEMP\__probe__
Workspace is not owned by the current user; refusing automatic ACL preparation
  at …\bin\prepare-workspace.ps1:36
exit 1
```

So the *error* reproduces, but the aggravating condition in #106 (foreign owner **and** effective
`WRITE_OWNER` already present) could not be built on this machine: assigning ownership to another
principal needs `SeRestorePrivilege`. A scan of nine candidate directories found only
`owner = me & no WRITE_OWNER` or `owner = someone else & no WRITE_OWNER`, plus
`owner = me & WRITE_OWNER`, i.e. the opposite asymmetry. Recorded as a limitation, not as a fix.

## 6. #94 / #112 facts

```
$ npm view dsh-ops dist-tags --json
{"beta":"0.2.5-beta.1","latest":"0.3.0"}
$ npm view dsh-ops versions --json
[...,"0.2.9","0.3.0"]
$ gh api repos/T-Auto/dsh-ops/releases/tags/v0.3.1 --jq '.assets[].name'
native-darwin-arm64-runtime-v0.3.1.zip
native-linux-x64-runtime-v0.3.1.zip
native-win32-x64-runtime-v0.3.1.zip
```

A/B on the installed 0.3.0 tree, one host restart between the two rows:

| installed preparation files | first `pwsh` after restart |
| --- | --- |
| `0.3.0` as published | fails, `CouldNotAutoloadMatchingModule` (twice, on both attempts) |
| `main`@`55abbb2` `lib/workspace-preparation.js` + `bin/prepare-workspace.ps1`, everything else 0.3.0 | succeeds |

`main`'s `bin/prepare-workspace.ps1` still contains two `Get-Acl` calls, so only the spawn-level
mitigation is in `main`; the script-level fix is not.

## 7. Reproduction scripts used

Left in place for re-running; they are not part of any submission.

| file | role |
| --- | --- |
| `.dsh-probe\handoff\rung-5.1.ps1` | receiver rung: logs the interpreter's own context and per-command resolution, then attempts `Get-Acl` |
| `.dsh-probe\handoff\probe-146.ps1` | sender rung + the 2×4 matrix + the #106 check |
| `.dsh-probe\handoff\iso-launch.ps1` | isolates console vs stdio |
| `.dsh-probe\handoff\sender.jsonl` / `rung.jsonl` | the records behind sections 1–3 |
| `.dsh-probe\handoff\host-prep-env.txt` | section 4 |

## 8. Limitations to state in any submission

- The host-shaped `PSModulePath` in section 1 was captured from the real host (section 4), not
  invented; but the matrix itself ran under a PowerShell 7 shell, not from the DSH host. The DSH-host
  half of the evidence is section 6's A/B.
- Only Windows x64 / Windows PowerShell 5.1 is claimed.
- The proposed regression test could not be executed in the environment this pack was produced in: the
  confined shell refuses `child_process.spawn` with piped stdio (`spawn EPERM`), so the test must be
  run by `npm run verify` on an unconfined Windows host before the PR is opened.
