# Fork implementation handbook

This folder is the durable specification for the custom behavior carried by the
`Chrys4lisfag/oh-my-pi` fork. Use it when merging upstream or rebuilding the fork
from a fresh `can1357/oh-my-pi` checkout.

## Audit baseline

- Audited fork merge: `048f62e34d`
- Audited upstream parent: `3a8591a8af1a09b129188017513e7a0b1b088e4e`
- Audit date: 2026-08-06
- Live delta refresh: upstream v17.2.10 and trusted-extension changes

Hashes are checkpoints, not permanent patch targets. Current code is authoritative;
these documents describe behavior and reapplication intent so upstream refactors can
be adopted without silently losing fork features.

## Documents

| Document                                             | Scope                                                                                                                                                    |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [provider-fixes.md](provider-fixes.md)               | Gemini request normalization, Venice compatibility, Codex safety handling/account attribution, K12 classification, rate-limit and Anthropic retry policy |
| [profiles-and-accounts.md](profiles-and-accounts.md) | Model profiles, advisor synchronization, multi-instance persistence, `/accounts` routing controls                                                        |
| [memory-and-runtime.md](memory-and-runtime.md)       | Hindsight memory behavior, advisor provenance/tool telemetry, Windows EPIPE/browser launch, GUI editor wait, MCP timing, prompt helper                   |
| [live-delta-manifest.md](live-delta-manifest.md)     | Active commit/file map, generated or stale changes, coverage gaps                                                                                        |
| [reapply-checklist.md](reapply-checklist.md)         | Ordered fresh-fork and recurring-merge procedure, survival checks, test matrix                                                                           |

## Active fork contracts

1. Gemini named-tool forcing uses a named choice, never bare `required`, and Google
   system instructions nudge exact tool names plus valid JSON arguments.
2. Profiles snapshot `modelRoles` and `defaultThinkingLevel`; command switching and
   `alt+c` cycling update the live model, thinking level, and advisor runtime.
3. `/accounts` disables individual stored credentials for request routing without
   logging them out or stopping refresh/usage collection.
4. Venice-hosted Qwen models use the OpenAI thinking dialect; Venice discovery maps
   `supportsFunctionCalling: false` to `supportsTools: false`.
5. Hindsight `reflect` has a configurable 60-second default timeout; `recall` and
   `reflect` remain direct top-level tools while xdev mounting is active.
6. Anthropic overload retries cap at 30 seconds, and Google
   `RESOURCE_EXHAUSTED` remains a transient provider-capacity failure rather than a
   credential usage-limit signal.
7. Codex safety-filter failures are classified as terminal refusals, annotated with
   the serving OAuth identity, removed from active/persisted conversational context,
   and not retried on the same model.
8. OpenAI Codex `k12` accounts count as paid educational accounts.
9. Benign Windows/Bun `EPIPE` unhandled rejections do not crash the process.
10. GUI editor launchers get a wait flag; runtime advisor toggles propagate to
    spawned subagents; optional MCP startup timing identifies slow servers.
11. Windows headless Chrome keeps Puppeteer's `--enable-automation` launch default;
    removing it can make current Chrome exit before opening CDP, while
    `--disable-blink-features=AutomationControlled` still masks `navigator.webdriver`.
12. `/advisor status` identifies each advisor's winning config source and reports
    per-tool successful/attempted calls; persisted advisor transcripts restore those
    counts after process restart.
13. Zero-config OpenAI GPT/Codex auto-maintenance selects provider-native
    context-full compaction when available; explicit strategies and remote-disable
    settings still win.
14. Memory-related advisors receive a retrieval reminder after the configured number
    of advisor context reads without `recall`/`reflect`; `/advisor status` reports
    actual reminder injections per advisor and in aggregate.

## Important memory corrections

- The configurable standalone timeout is for **Hindsight `reflect`**, not `recall`.
  Other Hindsight requests keep the 30-second client timeout.
- Both `recall` **and** `reflect` are pinned top-level. `retain` remains discoverable
  and may mount under `xd://`.
- Current Codex cybersecurity/content-policy behavior intentionally **omits the
  refusal turn from persisted and active context**. The visible failure is tagged
  with `[oauth <email|accountId|projectId>]` before refusal handling. If the desired
  product behavior changes to retaining those turns, change code and this handbook
  together; do not “fix” it during a merge based only on memory.
- `getIncrementalBackoffMs()` and `INCREMENTAL_BACKOFF_MS` currently have no caller.
  They are dormant compatibility utilities, not proof that a 5s/15s/50s retry
  schedule is active.

## Rules for future merges

- Preserve behavior, not old code shape. Adopt upstream supersets and re-home fork
  hooks at the new equivalent seam.
- Never resolve a conflict by taking all of ours when upstream refactored the
  subsystem. Take upstream architecture, then restore the contract documented here.
- Do not hand-edit generated files such as
  `packages/coding-agent/src/internal-urls/docs-index.generated.ts` or
  `packages/catalog/src/models.json`.
- After every merge, compare live content with upstream, run the survival checks and
  focused tests in [reapply-checklist.md](reapply-checklist.md), then update this
  baseline and [live-delta-manifest.md](live-delta-manifest.md).
