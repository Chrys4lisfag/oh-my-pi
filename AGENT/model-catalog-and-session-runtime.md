# Model catalog, profile-bound sessions, and runtime model display

This document records the fork contracts added during the 2026-08 model/runtime
work. Preserve behavior rather than exact code shape when merging upstream.

## 1. Custom provider discovery transport

Custom providers may separate inference and catalog traffic:

```yaml
providers:
  split-proxy:
    baseUrl: https://gateway.example/v1/oneapi/proxy/11
    api: openai-completions
    apiKey: ${INFERENCE_API_KEY}
    discovery:
      type: openai-models-list
      baseUrl: https://gateway.example/v1
      auth: none
```

Contracts:

- `baseUrl` remains the inference URL on every discovered model.
- `discovery.baseUrl` is used only for catalog/native metadata requests.
- `discovery.auth` defaults to `provider`; `none` suppresses automatic bearer
  authentication only for discovery. Provider inference still resolves `apiKey`.
- Query strings are preserved byte-for-byte while endpoint paths are appended.
- OpenAI-list, proxy, LiteLLM rich/fallback, LM Studio native, and llama.cpp
  probes honor the discovery authentication policy.
- Cache identities include effective endpoint, discovery protocol, and explicit
  anonymous authentication. Authenticated and anonymous catalogs never share a
  row, and explicit overrides never consume ambiguous legacy rows.
- Legacy no-override cache rows migrate only as stale, safe fallback data; an
  unwritable cache DB must still return the migrated models in memory.

Primary implementation:

- `packages/coding-agent/src/config/models-config-schema-bundle.ts`
- `packages/coding-agent/src/config/model-discovery.ts`
- `packages/coding-agent/src/config/model-registry.ts`
- `packages/catalog/src/provider-models/openai-compat.ts`

Regression coverage:

- `packages/coding-agent/test/config/models-config-validation.test.ts`
- `packages/coding-agent/test/model-discovery.test.ts`
- `packages/coding-agent/test/model-registry.test.ts`
- `packages/catalog/test/litellm-provider.test.ts`

## 2. Discovery result truth and zero-model recovery

`ModelResolutionResult.fetched` means this refresh cycle actually attempted
remote sources. It is not inferred from an empty result or refresh strategy.
`ProviderDiscoveryState.attemptedAt` records the last actual attempt in the
current process.

Contracts:

- An unfetched empty retry/cache row is `cached`/idle, never a successful
  authoritative empty discovery.
- Only an actually fetched, successful empty catalog may authoritatively prune
  stale provider models.
- `/models` waits for startup background discovery before offline hydration.
- Discoverable zero-model providers auto-refresh with bounded concurrency,
  cooldown, and a finite retry count. Closing/reopening the hub does not strand
  them behind a process-lifetime success guard.
- Registry model-update events settle pending zero-to-populated transitions and
  redraw the open hub; unrelated events never cancel explicit refresh.
- Provider refresh timers/listeners are disposed with the overlay.

Primary implementation:

- `packages/catalog/src/model-manager.ts`
- `packages/coding-agent/src/config/model-provider-discovery.ts`
- `packages/coding-agent/src/config/model-registry.ts`
- `packages/coding-agent/src/modes/components/model-hub.ts`

Regression coverage:

- `packages/catalog/test/build.test.ts`
- `packages/coding-agent/test/model-hub.test.ts`
- `packages/coding-agent/test/model-registry.test.ts`
- `packages/coding-agent/test/model-registry-models-updated.test.ts`

## 3. Profile identity belongs to the session

A resumed transcript may restore a model from its `model_change` history while
the process startup default points at another profile. Model restoration alone
must never imply profile ownership.

Contracts:

- New session headers record optional `profile` identity.
- Resume binds terminal-local `Settings` to the recorded profile before role
  and model resolution, without changing the durable startup profile marker.
- Explicit profile add/switch/cycle/rename/delete-fallback re-stamps session
  identity and applies model, thinking, and advisor state.
- Legacy headers without identity remain unbound. They do not auto-apply the
  disk-active profile and cannot persist model/thinking edits into an unrelated
  profile. An explicit `/profiles switch` establishes ownership.
- Same-profile edits still synchronize across terminals; different terminal-
  local profiles remain isolated.

Primary implementation:

- `packages/coding-agent/src/session/session-entries.ts`
- `packages/coding-agent/src/session/session-manager.ts`
- `packages/coding-agent/src/config/settings.ts`
- `packages/coding-agent/src/sdk.ts`
- `packages/coding-agent/src/session/agent-session.ts`
- `packages/coding-agent/src/modes/controllers/command-controller.ts`
- `packages/coding-agent/src/modes/controllers/input-controller.ts`

Regression coverage:

- `packages/coding-agent/test/profile-live-sync.test.ts`
- `packages/coding-agent/test/profiles-multi-instance.test.ts`
- `packages/coding-agent/test/profiles-process-sync.test.ts`
- `packages/coding-agent/test/agent-session-model-persistence.test.ts`

## 4. Runtime model versus configured default

The status line reports the live runtime model. Role cycling intentionally
changes runtime state without replacing `modelRoles.default`.

Contracts:

- Selecting `smol`/`slow` renders that live model, not the resolved default.
- If the configured default is unresolved, prompt dispatch remains blocked and
  the footer renders the full configured selector plus `[unavailable]` instead
  of the retained runtime model.
- Colon-bearing model IDs and route suffixes are preserved in unavailable
  diagnostics.
- Runtime thinking/fast badges are hidden while rendering an unavailable
  configured selector.
- Prompt preflight and footer unavailable detection share
  `getConfiguredDefaultModelState()`.

Primary implementation:

- `packages/coding-agent/src/session/agent-session.ts`
- `packages/coding-agent/src/modes/components/status-line/segments.ts`

Regression coverage:

- `packages/coding-agent/test/status-line-model.test.ts`
- `packages/coding-agent/test/agent-session-role-thinking.test.ts`

## 5. Advisor picker must offer runtime-resolvable models

Session-scoped `Model` objects can survive provider refresh, auth disable, or
catalog pruning. The advisor runtime resolves persisted selectors against the
current registry, so stale objects must not be offered as successful choices.

Contracts:

- `/advisor configure` refreshes the registry before opening. Refresh rejection
  warns and continues with the current snapshot rather than aborting the editor.
- Scoped choices are intersected with live models by case-normalized
  provider/model identity and replaced with canonical live objects.
- Removed models and duplicate stale copies are excluded.
- Every selector offered by the picker resolves through the same advisor runtime
  path immediately after save.

Primary implementation:

- `packages/coding-agent/src/modes/components/advisor-config.ts`
- `packages/coding-agent/src/modes/controllers/selector-controller.ts`
- `packages/coding-agent/src/session/session-advisors.ts`

Regression coverage:

- `packages/coding-agent/test/advisor-config-model-picker.test.ts`
- `packages/coding-agent/test/agent-session-advisor-model-sync.test.ts`
- `packages/coding-agent/test/advisor-watchdog.test.ts`

## 6. Native tokenizer compatibility

`Tokenizer` uses the model-declared native encoding in production and supports
an injected native counter for deterministic production-branch tests.

Contracts:

- Strict counting propagates native errors and never silently approximates.
- Approximate/upper-bound modes catch only napi-rs `InvalidArg` errors proving a
  stale native addon lacks the requested encoding enum.
- Unsupported native encodings fall back to byte estimates appropriate to the
  requested mode; a different tokenizer must never be labelled exact.
- All unrelated native failures still propagate.

Primary implementation and coverage:

- `packages/agent/src/tokenizer.ts`
- `packages/agent/test/tokenizer.test.ts`

## 7. Related compaction runtime work

Try-shake million-context checkpoints and the tracked compact-reminder extension
are specified in `memory-and-runtime.md`. Preserve their session-boundary reset,
monotonic checkpoint consumption, visible follow-up prompt, and extension tests
when merging session-maintenance changes.

## Merge survival checks

Run at minimum:

```sh
cd packages/agent && bun test test/tokenizer.test.ts && bun run check:types
cd packages/catalog && bun test test/build.test.ts test/litellm-provider.test.ts && bun run check:types
cd packages/coding-agent && bun test \
  test/config/models-config-validation.test.ts \
  test/model-discovery.test.ts \
  test/model-registry.test.ts \
  test/model-registry-models-updated.test.ts \
  test/model-hub.test.ts \
  test/profile-live-sync.test.ts \
  test/profiles-multi-instance.test.ts \
  test/profiles-process-sync.test.ts \
  test/status-line-model.test.ts \
  test/advisor-config-model-picker.test.ts \
  test/agent-session-advisor-model-sync.test.ts \
  test/shake.test.ts \
  test/slash-commands/tryshake.test.ts
cd packages/coding-agent && bun run check:types
```

Also run Biome on changed files and `git diff --check`. On Windows,
`profile-cli.test.ts` has a pre-existing environment-specific issue because its
child process overrides `HOME` while `os.homedir()` resolves `USERPROFILE`; do
not misattribute that failure to these model/profile changes.
