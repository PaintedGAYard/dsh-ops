# New issues (drafts, not filed)

Two candidate issues. Each is written as a *claimable unit of work* that one PR can close, per
`docs/CONTRIBUTING.md:34-36`. Plain English, matching the repository's code/comment language.

---

## I1

**Title**

```
Make bin/prepare-workspace.ps1 independent of PowerShell module autoload
```

**Body**

### Summary

The preparation bootstrap fails whenever the host hands Windows PowerShell 5.1 a non-empty
`PSModulePath` **and** launches it detached, which is exactly how `lib/workspace-preparation.js`
launches it. The failure is not confined to one variable: `Get-Acl` is the only module command in the
script that PowerShell 5.1 does not already have at startup, so those two calls are the whole
exposure. Replacing them with the .NET API the script already uses for writing closes the class
instead of relying on an environment rule.

`#83` already deletes `PSModulePath` before the spawn, and that works. This issue is not a request to
revert it; it is that the script should not need a module for a DACL read, and that its rationale and
test do not currently describe the condition that actually triggers the failure.

### What happens today

On a `workspace-write` session, the first `tools/execute` for `run_code` / `pwsh` / `bash` /
`*_persistent` runs the bootstrap. When it exits non-zero, the hook aborts the dispatch; every later
call retries and fails the same way. The reported line is:

```
prepare-workspace.ps1 : The 'Get-Acl' command was found in the module
'Microsoft.PowerShell.Security', but the module could not be loaded.
  + FullyQualifiedErrorId : CouldNotAutoloadMatchingModule
```

### The condition, measured

PowerShell 5.1 rewrites an inherited `PSModulePath` only when it starts attached to the parent's
console with all three stdio handles inherited. In any other launch shape it keeps the inherited
value verbatim, and command discovery then commits to the first `Microsoft.PowerShell.Security`
manifest it finds — the pwsh 7 one, which is `CompatiblePSEditions = @("Core")` and cannot load in
the desktop edition.

Two matrices, one 5.1 binary, `-NoProfile -NonInteractive`, same target directory. "entries" is what
the interpreter itself reported for `PSModulePath`.

| handed in | attached launch (inherited stdio) | detached launch (hidden window + redirected stdio) |
| --- | --- | --- |
| host value: 5 entries incl. `…\PowerShell\7\Modules` | `Get-Acl` OK, entries 5→3 (rewritten) | `Get-Acl` **fails**, entries 5 (verbatim) |
| `@dsh-ops/pwsh-win32-x64/bin/Modules` | OK, variable dropped | **fails**, entries 1 (verbatim) |
| `C:\Program Files\PowerShell\7\Modules` | OK, variable dropped | **fails**, entries 1 (verbatim) |
| absent | OK, entries 3 (defaults) | OK, entries 3 (defaults) |

| launch shape | `Get-Acl` |
| --- | --- |
| same console, all three stdio inherited | OK |
| same console, stdio redirected | **fails** |
| hidden window, stdio inherited | **fails** |
| hidden window, stdio redirected | **fails** |

This is why the failure reproduces only under the plugin and never from a manual shell: a hand-run
`powershell.exe -File …` inherits the console, so the interpreter cleans the variable up first.

### Why it is worth fixing rather than documenting

Inside the failing launch, every other command the script uses still resolves:

| command | module | detached launch |
| --- | --- | --- |
| `Get-Item` | Microsoft.PowerShell.Management | resolves |
| `Join-Path` | Microsoft.PowerShell.Management | resolves |
| `Set-Content` | Microsoft.PowerShell.Management | resolves |
| `Where-Object` | Microsoft.PowerShell.Core | resolves |
| `Add-Type` | Microsoft.PowerShell.Utility | resolves |
| `Write-Output` | Microsoft.PowerShell.Utility | resolves |
| **`Get-Acl` / `Set-Acl`** | **Microsoft.PowerShell.Security** | **unresolved** |

So the exposure is two lines, and the rest of the script already reads and writes its security
descriptor through .NET (`[Security.Principal.*]`, `[IO.Directory]::SetAccessControl`,
`SetKernelObjectSecurity`). One more .NET call makes the bootstrap immune to any future change in
how the interpreter computes its module path — `PSModuleAutoLoadingPreference`, a machine policy, a
redirected `$PSHOME`, or a search-path entry shape nobody has seen yet.

### What I propose

1. `bin/prepare-workspace.ps1`: `[System.IO.Directory]::GetAccessControl($item.FullName)` in both
   places `Get-Acl` appears. `Directory.GetAccessControl(string)` exists in .NET Framework 4.x, which
   is what 5.1 runs on; it is the same overload family the script already calls for writing.
2. `test/permissions.test.mjs`: a behavioural case that spawns 5.1 **detached with redirected stdio**
   and a pwsh 7-shaped `PSModulePath`, runs the real script against a temporary directory, and
   asserts exit 0. The existing cases assert the spawn *arguments*; none of them runs the script
   under a hostile environment, which is why this could regress unnoticed.
3. Correct the comment above the existing cases: the trigger is the detached launch, not merely an
   inherited variable.

### Scope

- No new configuration key, no behaviour change on the `ready` path, no change to what the script
  refuses.
- I will keep the `PSModulePath` deletion in `preparationEnvironment()`; it is still the right thing
  to hand a 5.1 interpreter.
- I am not proposing to remove the owner precheck or change the deny handling; those are `#106`.

### Related

- #146 — the same signature; this issue supersedes its diagnosis, not its report.
- #112 — the availability consequence of any preparation failure.
- #66 / #82 / #83 / #86 — the merged mitigations.

### Environment

Windows 11 `10.0.26200` · DSH `0.2.0-rc.2` · `dsh-ops` `0.3.0` from the registry, and `main` at
`55abbb2` for the comparison · Node `24.19.0` · Windows PowerShell `5.1.26100.9444` · the host
launched from PowerShell 7.6.6.

---

## I2

**Title**

```
Apply the documented child-environment policy to the preparation spawn and the FastCtx probe
```

**Body**

### Summary

`PROVENANCE.md` records a rule the plugin keeps everywhere else:

> the credential rule both spawn paths keep: a child never inherits credential-shaped names or
> ambient `DSH_*` facts *(PROVENANCE.md, "Two spawn paths, one credential policy")*

There are more than two spawn paths. Two of them hand the parent environment over unchanged:

| call site | what the child gets |
| --- | --- |
| `lib/handshake.js` → FastCtx server | `childEnv()` filter — credential-shaped names and ambient `DSH_*` dropped |
| `lib/shells.js` → `ops_bash` | the host subprocess service's own credential scrub |
| **`lib/workspace-preparation.js` → Windows PowerShell 5.1** | **the whole `process.env`, minus `PSModulePath`** |
| **`lib/binary.js` → `probeBinary` (`fastctx --version`)** | **`process.env` by default** |

The preparation comment is explicit that this is deliberate for the three variables it names —
"PATH, SystemRoot and DSH_HOME are the child's own inputs" — but the rule it does not apply is about
*credentials*, not about location inputs.

### Why it matters here specifically

The bootstrap is the least confined process in the chain: it runs with the host's full token, before
the sandbox is entered, on every first shell call of a `workspace-write` session, executing a script
that ships inside the package. Handing it `*_API_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, and the
ambient `DSH_*` facts makes an infrastructure failure at exactly that point a credential-disclosure
question as well as an availability one. I have not observed a leak; this is about the invariant the
project already states.

### What I propose

1. Reuse the existing heuristic rather than adding a second one: `lib/tools.js` `childEnv()`
   already drops `/KEY|PASSWORD|SECRET|TOKEN/i` and the `DSH_` prefix, and is already pinned by the
   mount suite.
2. `preparationEnvironment()` composes it with the `PSModulePath` deletion: scrub first, then delete
   the module path, so both rules hold and the order is explicit.
3. `probeBinary()` defaults to the same scrubbed environment instead of `process.env`.
4. `test/permissions.test.mjs`: assert that a credential-shaped name, an arbitrary `DSH_*` fact, and
   `PSModulePath` are all absent from `preparationSpawnSpec(root).options.env`, while `PATH`,
   `SystemRoot` and `DSH_HOME` survive. The last one matters: `DSH_HOME` is computed in the parent
   and passed as `-BackupDir`, so the child does not need the variable.

### Scope

- Bug-fix sized; no new configuration key, no dependency, no change to the spawning shape.
- Does not touch the FastCtx server's own `childEnv()` call site.
- If you would rather keep `probeBinary` on `process.env` because the probe is a developer-facing
  path, I can drop item 3 and keep the preparation spawn.

### Related

- `PROVENANCE.md`, "Two spawn paths, one credential policy".
- `packages/subprocess/subprocess/README.md:80,84` — the host's own rule that a transport owning its
  own spawn routes around the service *and applies the same scrub*.
