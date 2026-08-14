# Reapply and merge checklist

Use this procedure either to rebuild the fork from fresh upstream or to verify a
large upstream merge. It prioritizes behavioral contracts over old patch shape.

## A. Capture the current state

```sh
git status --short --branch
git fetch origin
git rev-list --left-right --count HEAD...origin/main
git log --no-merges --reverse --oneline origin/main..HEAD
git diff --name-status origin/main..HEAD
```

Before a risky rebuild, create a named backup branch from the current fork head.
Keep untracked scratch files out of the implementation inventory.

For normal recurring merges, verify that the upstream parent of the previous merge
is still an ancestor of `origin/main`. If yes, perform a normal merge; large commit
counts alone do not imply rewritten history.

## B. Fresh-fork reapplication order

Create a work branch from current `origin/main`. Do **not** cherry-pick merge commits.
Use the active commits in `live-delta-manifest.md` as reference patches, but transplant
intent into current upstream architecture.

### 1. Profiles persistence and domain

1. Add `profiles.items` and `profiles.active` schema keys.
2. Add per-profile dirty tracking and locked freshest-file merge in `Settings`.
3. Add `config/profiles.ts`; ensure every mutation uses `setProfileItem` or
   `deleteProfileItem`.
4. Add `/profiles` registry/context/delegate/controller layers.
5. Add `app.profile.cycle = alt+c` and input-controller cycle behavior.
6. Run profile and concurrent-instance tests before adding advisor coupling.

### 2. Advisor synchronization

1. Add `ModelRegistry.onModelsUpdated` listener storage, unsubscribe contract, and an
   emit after the canonical runtime-discovery model list settles.
2. Subscribe `AgentSession` during construction and unsubscribe during dispose.
3. Add `refreshAdvisors`, `ensureAdvisorsBuilt`, and `applyProfileToSession`.
4. Make both slash-command switch and keybinding cycle call the centralized session
   method.
5. Preserve `setAdvisorEnabled` runtime settings override so spawned subagents inherit
   the current toggle.

### 3. `/accounts`

1. Add routing-disabled persistence and all three AuthStorage selection seams.
2. Add `LogoutAccount.routingDisabled` projection.
3. Extend OAuth selector mode with `manage`.
4. Add account-manager component and selector-controller flow.
5. Add context/delegate and `/accounts [provider]` registry entry.
6. Manually verify persistence, sibling exclusion, assignment reset, and all-disabled
   fallback; dedicated automated coverage is still missing.

### 4. Provider/auth fixes

Apply independently so each can be reviewed and tested:

1. Gemini named-tool choice.
2. Gemini final-system-part tool-call nudge.
3. Venice host classification and Qwen OpenAI thinking format.
4. Venice `supportsFunctionCalling: false` mapping.
5. Codex safety refusal source classification, agent fallback, retry/persistence
   handling, and OAuth identity tag.
6. K12 paid-plan token.
7. Google `resource_exhausted` usage-limit exclusion.
8. Anthropic 30-second retry cap.

Never edit generated catalog JSON for Venice.

### 5. Memory and runtime

1. Add `hindsight.reflectTimeoutMs` schema/env/config/client/tool flow.
2. Union `recall` and `reflect` into current upstream `XDEV_KEEP_TOP_LEVEL`.
3. Add `isEpipe` and the closed generic EPIPE guard beside upstream postmortem guards.
4. Add GUI external-editor wait injection.
5. Restore `PI_MCP_TIMING` around current MCP connect/list lifecycle.
6. Keep `jsonStringify` registered while agent frontmatter uses it.
7. Decide deliberately whether to keep the dormant incremental backoff utility.
8. On Windows, keep Puppeteer's `--enable-automation` default in the headless
   browser launch. Current Chrome can exit with code 0 before CDP opens when that
   flag is suppressed; retain `--disable-blink-features=AutomationControlled` for
   `navigator.webdriver`.
9. Preserve advisor config provenance, per-tool successful/attempted status, and
   process-startup reconstruction from named advisor transcripts.
10. Reapply Memory Advisor retrieval enforcement: the interval setting, per-advisor
    classifier/state, instruction artifact injection, per-slug injection counter,
    runtime signature/settings-selector rebuild wiring, and structured/text/TUI
    `/advisor status` telemetry.
11. Preserve the fork's remote-first automatic default only for unconfigured,
    provider-native-capable GPT/Codex candidates; upstream owns `/compact remote`,
    transport, fallback, and lifecycle semantics.

### 6. Generated and optional files

- Regenerate docs/tool views/catalog outputs using current upstream scripts.
- Do not restore deleted legacy bundled key/registry files.
- Review `.gitignore` additions for the current environment rather than copying
  historical duplicates.
- Add changelog entries only under current `[Unreleased]` sections.

## C. Recurring conflict recipes

### `packages/ai/src/error/rate-limit.ts`

Take upstream's newest expanded usage-limit pattern, then remove
`resource.?exhausted`. Keep the rationale adjacent to the pattern and decision tree.

### `packages/ai/src/auth-storage.ts`

Adopt upstream's current credential-block method signature and ranking logic, then
restore routing-disabled checks at generic candidate, sticky identity, and OAuth
resolution seams. Preserve K12 paid classification separately.

### `packages/coding-agent/src/tools/xdev.ts`

Union additions. Required fork entries are `recall` and `reflect`; required upstream
entries at the audit baseline include `todo`, `ask`, `grep`, and `web_search`.

### `packages/coding-agent/src/config/model-registry.ts`

If upstream replaces the refresh subsystem, keep its architecture and re-home
`#emitModelsUpdated` immediately after the final model list settles. Retain listener
registration and exception isolation.

### `packages/coding-agent/src/session/agent-session.ts`

Union subscription fields/dispose cleanup, profile/advisor methods, advisor toggle
inheritance, and Codex refusal/account annotation with upstream session lifecycle.
Do not force old hooks into removed fields.

### `packages/coding-agent/src/config/settings.ts`

Reapply per-profile-name merge inside the current locked freshest-file save path.
Never replace upstream locking/save semantics wholesale.

### `packages/utils/src/postmortem.ts`

Keep upstream's specific IPC/cleanup guards and the fork's broad `isEpipe` guard as
separate closed blocks.

### `packages/coding-agent/src/tools/browser/launch.ts`

Preserve upstream browser discovery and backend architecture. In
`stealthIgnoreDefaultArgs`, suppress `--enable-automation` only outside Windows and
for non-Edge executables. Explicit `app.path` uses the spawned backend and can hide
this default-headless failure, so verify both paths separately.

### `packages/coding-agent/src/session/session-maintenance.ts`

Take upstream's full maintenance lifecycle first, including retries, native-failure
boundaries, dead-end recovery, and continuation logic. Reapply
`resolveAutoCompactionAction` as a narrow policy seam: only an unconfigured strategy
with an authenticated native-capable OpenAI candidate and remote enabled may override
the schema's local `snapcompact` default. Never replace the maintenance method with
the older fork body.

### Generated-file delete/modify conflicts

Accept upstream deletion when the source subsystem is gone. Regenerate from live
sources; never preserve stale generated output merely because the fork modified it.

## D. Fast survival audit

```sh
git grep -n "appendGeminiToolCallNudge"
git grep -n "buildNamedToolChoice" packages/coding-agent/src/utils/tool-choice.ts
git grep -n "venice" packages/catalog/src/hosts.ts packages/catalog/src/compat/openai.ts
git grep -n "supportsFunctionCalling" packages/catalog/src/provider-models/openai-compat.ts
git grep -n "CODEX_CONTENT_FLAG_MESSAGE"
git grep -n "annotateAssistantErrorWithAccount"
git grep -n "k12: true" packages/ai/src/auth-storage.ts
git grep -n "MAX_RETRY_DELAY_S = 30"
git grep -n "resource.?exhausted" packages/ai/src/error/rate-limit.ts
git grep -n "handleProfilesCommand"
git grep -n "setProfileItem"
git grep -n "applyProfileToSession"
git grep -n "onModelsUpdated"
git grep -n "app.profile.cycle"
git grep -n "setRoutingEnabled"
git grep -n "routingDisabled"
git grep -n "hindsight.reflectTimeoutMs"
git grep -n "HINDSIGHT_REFLECT_TIMEOUT_MS"
git grep -n "recall: true" packages/coding-agent/src/tools/xdev.ts
git grep -n "reflect: true" packages/coding-agent/src/tools/xdev.ts
git grep -n "isEpipe"
git grep -n "PI_MCP_TIMING"
git grep -n "jsonStringify"
git grep -n 'process.platform !== "win32"' packages/coding-agent/src/tools/browser/launch.ts
git grep -n "loadAdvisorTranscriptToolStats"
git grep -n "Tools usage (successful/attempts)"
git grep -n "advisor.memoryReminderInterval"
git grep -n "Memory reminder injections"
```

Interpret the `resource.?exhausted` result carefully: the fork contract requires that
it be absent from `USAGE_LIMIT_PATTERN`; explanatory comments may still contain it.
A source grep is only a merge audit, never a substitute for behavioral tests.

## E. Focused test matrix

Run direct Bun tests from each package so package-level CI wrapper scripts do not
expand a file argument into a large test bucket.

```sh
(cd packages/coding-agent && bun test \
  test/build-named-tool-choice.test.ts \
  test/profiles.test.ts \
  test/profiles-multi-instance.test.ts \
  test/agent-session-advisor-model-sync.test.ts \
  test/model-registry-models-updated.test.ts \
  test/memory-tools.test.ts \
  test/write-xdev-dispatch.test.ts \
  test/tools/browser-launch.test.ts \
  test/tools/browser-tab-evaluate.test.ts \
  test/session-maintenance-compaction-action.test.ts \
  test/advisor/config.test.ts \
  test/advisor/transcript-recorder.test.ts \
  test/advisor/memory-reminder.test.ts \
  test/advisor-memory-reminder-integration.test.ts \
  test/advisor-toggle.test.ts \
  test/modes/controllers/advisor-status-command.test.ts \
  test/modes/controllers/selector-controller-settings.test.ts)

(cd packages/catalog && bun test \
  test/venice-qwen-thinking.test.ts \
  test/venice-tool-support.test.ts)

(cd packages/ai && bun test \
  src/providers/__tests__/openai-codex-error.test.ts \
  test/auth-storage-codex-selection.test.ts \
  test/rate-limit-utils.test.ts \
  test/anthropic-client.test.ts \
  test/anthropic-stream-timeout.test.ts)

(cd packages/utils && bun test test/postmortem-epipe.test.ts)
```

Then run targeted Biome/type checks for touched packages. If upstream itself currently
fails a package type-check, record the exact external/upstream diagnostics separately
from fork regressions; do not hide fork-specific errors among them.

## F. Manual contracts still lacking tests

- `/accounts`: two-account toggle, restart persistence, sibling exclusion, assignment
  reset, and all-disabled fallback.
- Hindsight: setting and env override, timeout abort, actual-duration error message.
- xdev: recall/reflect direct top-level presence and absence from mounted registry.
- Google request: nudge appended once to final system part.
- External editor: wait flag injected once for each supported GUI launcher.
- MCP timing: unset has no output; set prints sorted connect/list table.
- Agent frontmatter: names/descriptions containing quotes, backslashes, and newlines.
- Advisor runtime toggle: newly spawned subagent inherits the live parent toggle.
- Advisor session switch: historical target-session tool totals currently rehydrate
  only after process restart/resume, not an in-process switch.

## G. Finish and update handbook

1. Confirm no unresolved markers or unstaged implementation edits.
2. Compare `origin/main..HEAD` live source delta, not only commit history.
3. Update baseline hashes and file/commit classifications in this folder.
4. Record any upstream-absorbed feature as upstream-owned and remove obsolete fork
   patches deliberately.
5. Commit only when explicitly authorized; push the fork only when requested.
