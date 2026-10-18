# STATUS — these drafts are out of date, deliberately kept

**Do not file anything from this folder without re-reading it against the current audit.**

State on 2026-10-18, after Phase 1–4 of the handoff audit:

| file | state |
|---|---|
| `00-PLAN.md` | The original plan. Superseded by `dev-diary/2026-10-18-execution-handoff-audit.md` + `dev-diary/consistency-audit.md`. |
| `01-ISSUES.md` | **I1 is still valid** and is now the only open claim: `bin/prepare-workspace.ps1` should not depend on PowerShell module autoload (upstream `#146`'s suggestion B, never done). Its *condition* section needs the Phase 1 correction: order matters, and the launch shape is "no inherited console handle", not "hidden window".<br>**I2 is obsolete**: `lib/env.js`'s allow-list `childEnv()` landed in v0.3.1 and covers the FastCtx spawn and `probeBinary`; `preparationEnvironment()` is a different helper on purpose, not a gap. Nothing to file. |
| `02-COMMENTS.md` | C1/C2/C3 are written from the pre-v0.3.1 understanding. C1's launch-shape table says "detached = hidden window or redirected stdio", which Phase 1 showed is **only the stdio/console half** (`windowsHide:false` + redirected stdio fails identically). Any revival must fix that row. |
| `03-PRS.md` | Not reviewed since Phase 1. |
| `04-EVIDENCE.md` | §1–§3 still reproduce, §2's wording needs the same correction as C1. §5 (#106) is unchanged. §1's poison-root row for the bundled `@dsh-ops/pwsh-win32-x64/bin/Modules` is what `#146` reports as *the* root. |

**Standing decision D1**: nothing in this folder is submitted, pushed, or opened as an issue or PR. The fork (`PaintedGAYard/dsh-ops`) is a private sandbox; `upstream` is only ever read.
