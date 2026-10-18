# Replies on existing threads (drafts, not posted)

Three posts. English, matching the repository's code/comment language and the maintainers' own
replies. `#146`'s body is Chinese — if you would rather mirror that thread, say so and I will produce
a Chinese version of C1.

---

## C1 → #146

*Suggested framing: this is evidence and a correction, not a duplicate report.*

---

Reproduced on a second machine, and the condition is narrower than the report states. The variable is
real, but on its own it does not cause the failure: the launch *shape* has to cooperate.

### The condition, measured

Windows PowerShell 5.1 rewrites an inherited `PSModulePath` only when it starts attached to the
parent's console with all three stdio handles inherited. In any detached launch it keeps the
inherited value **verbatim**, and command discovery then commits to the first
`Microsoft.PowerShell.Security` manifest it finds — the pwsh 7 one, `CompatiblePSEditions = @("Core")`,
which the desktop edition cannot load.

One 5.1 binary, `-NoProfile -NonInteractive`, same target directory. "entries" is what the interpreter
itself reported for `PSModulePath`.

| handed in | attached launch (inherited stdio) | detached launch (hidden window + redirected stdio) |
| --- | --- | --- |
| host value, 5 entries incl. `…\PowerShell\7\Modules` | `Get-Acl` OK, entries 5→3 (rewritten) | `Get-Acl` **fails**, entries 5 (verbatim) |
| `@dsh-ops/pwsh-win32-x64/bin/Modules` | OK, variable dropped | **fails**, entries 1 (verbatim) |
| `C:\Program Files\PowerShell\7\Modules` | OK, variable dropped | **fails**, entries 1 (verbatim) |
| absent | OK, entries 3 (defaults) | OK, entries 3 (defaults) |

| launch shape | `Get-Acl` |
| --- | --- |
| same console, all three stdio inherited | OK |
| same console, stdio redirected | **fails** |
| hidden window, stdio inherited | **fails** |
| hidden window, stdio redirected | **fails** |

### Why this matters for the report

`lib/workspace-preparation.js` spawns with `windowsHide: true` and
`stdio: ['ignore', 'pipe', 'pipe']` — a detached launch, so it lands in the failing column every time.
A hand-run `powershell.exe -NoProfile -NonInteractive -File …prepare-workspace.ps1 …` inherits the
console and therefore never reproduces it. That is why the reproduction in this thread is hard to
follow, and why I could not confirm the stated mechanism at first.

The suggestion A in this issue (pass a clean `PSModulePath`) is what PR #83 implemented and it does
fix the symptom: with the variable absent, 5.1 builds its defaults in both launch shapes. Suggestion
B is not redundant with A, though — see below.

### The exposure is two lines

In the failing launch, every other command the script uses still resolves:

| command | module | detached launch |
| --- | --- | --- |
| `Get-Item`, `Join-Path`, `Set-Content` | Microsoft.PowerShell.Management | resolves |
| `Where-Object` | Microsoft.PowerShell.Core | resolves |
| `Add-Type`, `Write-Output` | Microsoft.PowerShell.Utility | resolves |
| **`Get-Acl`, `Set-Acl`** | **Microsoft.PowerShell.Security** | **unresolved** |

So a DACL *read* is the only reason the bootstrap needs a module at all, while the DACL *write*
already goes through .NET (`[IO.Directory]::SetAccessControl`, and `SetKernelObjectSecurity` since
#74). Replacing the two `Get-Acl` calls with
`[System.IO.Directory]::GetAccessControl($item.FullName)` removes the dependency entirely, so the
script stops caring how the interpreter computes its module path — `PSModuleAutoLoadingPreference`, a
machine policy, a redirected `$PSHOME`, or a search-path shape nobody has seen yet.

### What I would like to do

I would send that as a PR, with a behavioural test that spawns 5.1 **detached** with a pwsh 7-shaped
`PSModulePath` and runs the real script against a temporary directory. The existing cases in
`test/permissions.test.mjs` assert the spawn *arguments*; none runs the script under a hostile
environment, which is why this can regress unnoticed.

Two questions before I start, so I do not duplicate the work:

1. Do you want that PR to close **this** issue, or would you rather I open a separate work issue
   ("make the bootstrap independent of module autoload") and leave #146 as the report?
2. Is the argument-shape assertion in `test/permissions.test.mjs` intentionally the contract, or is a
   behavioural case against the real interpreter welcome there?

### Environment

Windows 11 `10.0.26200` · DSH `0.2.0-rc.2` · `dsh-ops` `0.3.0` (registry) and `main`@`55abbb2` ·
Node `24.19.0` · Windows PowerShell `5.1.26100.9444` · host launched from PowerShell 7.6.6 ·
session policy `workspace-write`. The host's `PSModulePath` in the failing run was captured from the
child: `E:\Users\David\Documents\PowerShell\Modules;C:\Program Files\PowerShell\Modules;c:\program
files\powershell\7\Modules;C:\Program Files\WindowsPowerShell\Modules;C:\WINDOWS\system32\WindowsPowerShell\v1.0\Modules`.

---

## C2 → #112

*Suggested framing: third environment, plus two facts the trade-off list does not have yet.*

---

Third environment, and one answer to the open trade-off in the issue.

**Environment.** Windows 11 `10.0.26200` · DSH `0.2.0-rc.2` · `dsh-ops` `0.3.0` (registry) ·
`workspace-write` · the failure started the moment a component that mounts `mountWorkspacePreparation`
was enabled, not at install time: the two calls before it succeeded, the one after it failed, and
every call after that failed too.

**It is not a transient condition — and the cache makes it permanent in both directions.**
`prepared` (`lib/workspace-preparation.js`) is populated only on success. On failure nothing is
cached, so each subsequent call retries the script and fails identically: no backoff, no "already
reported" state, one failing PowerShell spawn per tool call. The same cache is never invalidated on
success, so a root that prepared once stays "prepared" for the lifetime of the host process even if
the directory's DACL or the sandbox's capability grant changes underneath it. One module-level `Set`
decides both.

**What stays usable is exactly the file tools.** The four `ops_*` file tools kept working throughout,
because they report `enforcement: 'policy'` and do not enter the sandbox at all. That is the same
split raphael-y7 reported, and it is why the failure reads like a permission problem: half the tool
surface works, and the half that does not is the half you would use to diagnose it.

**A data point for option 2 in the issue (capability probe instead of prepare-all).** In my case the
workspace root *already* held an effective `WRITE_OWNER` through the user's inherited `FullControl`.
The script's own `ready` path proves it: when I ran it directly it printed `ready` and exited 0
without writing anything, and the DACL was byte-identical before and after. So the outage was caused
by a preparation step that had nothing to prepare. A capability probe would have skipped it and the
shell would have worked. That is a concrete instance of the case the issue describes as "a root that
is not owned by the caller but already grants effective `WRITE_OWNER`"; #106 reaches the same
conclusion from the ordering side.

**One thing the diagnosis path is missing.** `classifyPreparationFailure()` splits execution-policy
refusals from prerequisite failures, which is a real improvement. It has no branch for a
module-autoload failure, so a report of that class (`CouldNotAutoloadMatchingModule`,
`CommandNotFoundException: … could not be loaded`) falls through to
`exited with code 1 … (no output)`. That is the case in #146, and it is the one where the operator can
actually do something cheap: it is an interpreter-environment problem, not a folder-permission
problem. A branch that names it would have saved this thread and #94 several rounds.

**On option 1 (preflight).** It looks nearly free for the same reason: the `ready` path writes no
receipt and touches no ACL, so "run it, classify the result, keep the shell" is available without a
check-only mode.

I am preparing a PR for the module-autoload half of this (it removes the trigger rather than gating
it); I will link it here. Nothing in this comment asks you to decide the availability question.

---

## C3 → #94

*Suggested framing: the publish request is correct; here is the A/B that justifies it, from a machine
where the trigger is not execution policy.*

---

Confirming the request, from a machine whose execution policy is **not** the cause, plus the A/B that
shows the merged fix is what fixes it.

**Registry state on 2026-10-18.**

```
$ npm view dsh-ops dist-tags --json
{ "beta": "0.2.5-beta.1", "latest": "0.3.0" }

$ npm view dsh-ops versions --json
["0.0.0-stage","0.2.1","0.2.2","0.2.3","0.2.4","0.2.5-beta.1","0.2.5","0.2.6","0.2.9","0.3.0"]
```

`v0.3.1` exists as a GitHub Release (2026-10-16) but carries only
`native-{darwin-arm64,linux-x64,win32-x64}-runtime-v0.3.1.zip` — no npm artifact. So nothing has
changed for `0.3.0` users since this issue was opened.

**A second, independent trigger.** This machine's policy is `LocalMachine = RemoteSigned`; the
script is a local file with no zone identifier, so execution policy never blocked it. `0.3.0` still
fails, deterministically, with

```
DSH workspace preparation failed (not a user permission denial):
… \bin\prepare-workspace.ps1 : The 'Get-Acl' command was found in the module
'Microsoft.PowerShell.Security', but the module could not be loaded.
  + FullyQualifiedErrorId : CouldNotAutoloadMatchingModule
```

That is #146's signature, not #66/#82's. It is worth stating in the 0.3.1 release note that the same
error line has at least two distinct causes — execution policy and interpreter module resolution — so
users on the old version do not conclude the release does not apply to them.

**A/B on the installed package.** Against the profile's `node_modules/dsh-ops` (0.3.0):

| step | first `pwsh` call after the host restart |
| --- | --- |
| 0.3.0 as published | **fails**, message above |
| copy `main`'s `lib/workspace-preparation.js` **and** `bin/prepare-workspace.ps1` over the installed files, nothing else changed | **succeeds** |

Both files were needed for a clean comparison, but the relevant delta is the spawn: `main` passes
`-ExecutionPolicy Bypass` and `env: preparationEnvironment()` (no inherited `PSModulePath`), and
raises the timeout from 10 s to 120 s. The `bin/prepare-workspace.ps1` in `main` **still calls
`Get-Acl`**, so the script-level fix is not in `main` yet — only the spawn-level mitigation is.

So: publishing `0.3.1` (or any tag containing #83/#86/#74) is the fix for this class of report, and it
is the only thing standing between 0.3.0 users and a working shell. I am also preparing a PR that
makes the script itself independent of PowerShell module autoload, so the mitigation stops being the
only line of defence; I will link it here when it exists.
