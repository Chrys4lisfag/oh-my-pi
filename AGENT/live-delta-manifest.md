# Live fork delta manifest

This manifest classifies the fork delta after merge commit `69a80d946` against
upstream parent `ef44bb570`. Refresh it after every upstream merge; never assume
commit count alone proves behavior survived.

## Fork commit ledger

| Commit      | Status             | Purpose                                                                                                                    |
| ----------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `f26026115` | active, mixed seed | Ported profiles base, Gemini tool fixes, rate-limit policy, retry helper, editor wait, EPIPE, prompt helper, local ignores |
| `8d902d057` | active             | Completed `/profiles` context/delegate wiring                                                                              |
| `e7c9127de` | merge repair only  | Import/conflict repair; no independent contract                                                                            |
| `43bdd1748` | active, profiles   | Set profile cycle default binding to `alt+c`                                                                               |
| `2ddceb26b` | generated-only     | Added stale generated docs index; do not manually reapply                                                                  |
| `5c67adb47` | active             | Propagate runtime advisor enabled state into settings used by subagents                                                    |
| `628a49394` | active             | Keep live advisor runtime synchronized with profiles and late model discovery                                              |
| `33c307bd5` | active             | Raise Anthropic overload backoff cap to 30 seconds                                                                         |
| `087b16dd8` | active             | `/accounts` routing-only account disable system                                                                            |
| `96dfb3bdf` | obsolete           | Repaired legacy bundled config files later deleted upstream; do not restore                                                |
| `9e94e73df` | active             | Treat Codex `k12` as a paid plan                                                                                           |
| `d410d0965` | active             | Classify Codex safety refusals and tag failed OAuth account                                                                |
| `121cbbe40` | active             | Configurable Hindsight reflect timeout; pin recall/reflect top-level                                                       |
| `32b11c08c` | active             | Venice Qwen thinking and per-model tool support                                                                            |
| `68f30cc56` | active             | Merge profile items per key across concurrent processes                                                                    |
| `5708cb1cc` | active, policy     | Default unconfigured native-capable GPT/Codex auto-maintenance to remote-first context-full compaction                     |
| `696bd711d` | active             | Advisor source provenance and restart-safe per-tool successful/attempted telemetry                                         |

`PI_MCP_TIMING` is a live fork delta carried through merge commit history (reference
`9a8062a7f`), so it does not appear in the non-merge ledger above.

## Active source map

### Provider/authentication

- `packages/ai/src/auth-storage.ts`
  - `/accounts` routing flags and selection filters
  - Codex paid-plan token `k12`
- `packages/ai/src/error/rate-limit.ts`
  - excludes Google `resource_exhausted` from credential usage caps
- `packages/ai/src/index.ts`
  - exports retry-after utilities
- `packages/ai/src/providers/anthropic-client.ts`
  - 30-second overload backoff cap
- `packages/ai/src/providers/google-shared.ts`
  - tool-call nudge on final system instruction
- `packages/ai/src/providers/openai-codex-responses.ts`
  - safety-filter classification
- `packages/ai/src/utils/retry-after.ts`
  - dormant incremental schedule helper plus current upstream retry-after code
- `packages/catalog/src/compat/openai.ts`
  - Venice Qwen uses OpenAI thinking format
- `packages/catalog/src/hosts.ts`
  - Venice host classification
- `packages/catalog/src/provider-models/openai-compat.ts`
  - Venice discovery maps unsupported function calling to `supportsTools: false`

`packages/ai/src/providers/google-gemini-cli.ts` differs only by explanatory comments
at this baseline; it is not a separate fork behavior.

### Profiles/advisor

- `packages/coding-agent/src/advisor/config.ts`
  - runtime-only winning `WATCHDOG` source provenance
- `packages/coding-agent/src/advisor/transcript-recorder.ts`
  - append-only advisor transcript replay for restart-safe tool counters
- `packages/coding-agent/src/config/keybindings.ts`
- `packages/coding-agent/src/config/model-registry.ts`
- `packages/coding-agent/src/config/profiles.ts`
- `packages/coding-agent/src/config/settings-schema.ts`
- `packages/coding-agent/src/config/settings.ts`
- `packages/coding-agent/src/modes/controllers/command-controller.ts`
- `packages/coding-agent/src/sdk.ts`
  - restores persisted advisor tool totals before session construction
- `packages/coding-agent/src/modes/controllers/input-controller.ts`
- `packages/coding-agent/src/modes/interactive-mode.ts`
- `packages/coding-agent/src/modes/types.ts`
- `packages/coding-agent/src/session/agent-session.ts`
- `packages/coding-agent/src/session/agent-session-types.ts`
- `packages/coding-agent/src/session/session-advisors.ts`
  - per-advisor successful/attempted accounting and status formatting
- `packages/coding-agent/src/slash-commands/builtin-registry.ts`

`agent-session.ts` is shared with Codex refusal/account attribution and advisor
subagent inheritance. Preserve all domains when resolving its conflicts.

### Account manager UI

- `packages/coding-agent/src/modes/components/account-manager-selector.ts`
- `packages/coding-agent/src/modes/components/oauth-selector.ts`
- `packages/coding-agent/src/modes/controllers/selector-controller.ts`
- `packages/coding-agent/src/modes/interactive-mode.ts`
- `packages/coding-agent/src/modes/types.ts`
- `packages/coding-agent/src/slash-commands/builtin-registry.ts`
- `packages/coding-agent/src/slash-commands/helpers/logout.ts`

### Memory/runtime/platform

- `packages/coding-agent/src/hindsight/client.ts`
- `packages/coding-agent/src/hindsight/config.ts`
- `packages/coding-agent/src/mcp/manager.ts`
- `packages/coding-agent/src/session/session-maintenance.ts`
  - fork-only automatic action selection; upstream owns remote transport and lifecycle
- `packages/coding-agent/src/tools/memory-reflect.ts`
- `packages/coding-agent/src/tools/xdev.ts`
- `packages/coding-agent/src/utils/external-editor.ts`
- `packages/coding-agent/src/utils/tool-choice.ts`
- `packages/utils/src/fs-error.ts`
- `packages/utils/src/postmortem.ts`
- `packages/utils/src/prompt.ts`
- `packages/coding-agent/src/tools/browser/launch.ts`
  - keeps Puppeteer's `--enable-automation` default on Windows so Chrome opens CDP
    instead of exiting cleanly during default headless launch

### Regression tests and fixture compatibility

- `packages/ai/src/providers/__tests__/openai-codex-error.test.ts`
- `packages/ai/test/auth-storage-codex-selection.test.ts`
- `packages/catalog/test/venice-qwen-thinking.test.ts`
- `packages/catalog/test/venice-tool-support.test.ts`
- `packages/coding-agent/test/agent-session-advisor-model-sync.test.ts`
- `packages/coding-agent/test/advisor/config.test.ts`
- `packages/coding-agent/test/advisor/transcript-recorder.test.ts`
- `packages/coding-agent/test/advisor-toggle.test.ts`
- `packages/coding-agent/test/modes/controllers/advisor-status-command.test.ts`
- `packages/coding-agent/test/build-named-tool-choice.test.ts`
- `packages/coding-agent/test/model-registry-models-updated.test.ts`
- `packages/coding-agent/test/profiles-multi-instance.test.ts`
- `packages/coding-agent/test/profiles.test.ts`
- `packages/coding-agent/test/hindsight-bank.test.ts`
- `packages/coding-agent/test/session-maintenance-compaction-action.test.ts`
- `packages/coding-agent/test/memory-tools.test.ts`
- `packages/coding-agent/test/tools/browser-launch.test.ts`
- `packages/coding-agent/test/tools/browser-tab-evaluate.test.ts`

`hindsight-bank.test.ts` and `memory-tools.test.ts` contain required
`HindsightConfig.reflectTimeoutMs` fixture fields but do not directly test timeout
behavior.

## Metadata, generated output, and optional policy

These can appear in the live file diff without defining a reapplication contract:

- `.gitignore` — local artifact policy; review rather than blindly copy
- `packages/ai/CHANGELOG.md`
- `packages/catalog/CHANGELOG.md`
- `packages/coding-agent/CHANGELOG.md`
- `packages/coding-agent/src/internal-urls/docs-index.generated.ts` — generated,
  regenerate from current sources

Do not use changelog or generated-file presence as a survival signal.

## Known test gaps

No focused contract test currently protects:

- Gemini system-instruction nudge insertion/idempotence;
- `/accounts` selection filtering, cache persistence, all-disabled fallback, or UI;
- Hindsight reflect setting/env/client timeout behavior;
- recall/reflect top-level xdev pinning;
- Anthropic 30-second cap;
- GUI editor wait-flag injection;
- `PI_MCP_TIMING` table;
- `jsonStringify` frontmatter escaping;
- advisor enabled-state inheritance by spawned subagents.

Treat these as manual merge-review requirements until tests are added.

## Refresh commands

Run after fetching and merging upstream:

```sh
git log --no-merges --reverse --oneline origin/main..HEAD
git diff --name-status origin/main..HEAD
git diff --stat origin/main..HEAD
git diff origin/main..HEAD -- \
  packages/ai/src \
  packages/catalog/src \
  packages/coding-agent/src \
  packages/utils/src
```

Then update baseline hashes, commit ledger status, source map, and coverage gaps. A
fork commit can remain in history while its implementation is silently lost or
superseded; inspect the live diff and current symbols.
