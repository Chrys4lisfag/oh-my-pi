# Profiles and account routing

## 1. Model profiles

Profiles are named snapshots of model-role assignments and default thinking level.
They are not copies of the whole settings file.

### Stored shape and invariants

Settings keys:

- `profiles.items`: record from profile name to `{ modelRoles,
defaultThinkingLevel }`
- `profiles.active`: active profile name or empty string

Implementation:

- `packages/coding-agent/src/config/settings-schema.ts`
- `packages/coding-agent/src/config/profiles.ts`
  - `ProfileSnapshot`
  - `captureCurrentSnapshot`
  - `listProfiles`
  - `getActiveProfileName`
  - `addProfile`
  - `switchProfile`
  - `deleteProfile`
  - `renameProfile`
  - `saveActiveProfile`
  - `cycleProfile`
  - `ensureDefaultProfile`

Behavior that must survive:

1. A snapshot includes all `modelRoles`, including `default` and `advisor`, plus
   `defaultThinkingLevel`.
2. Creating the first non-`default` profile first captures a `default` snapshot.
3. Switching away auto-saves current live role/thinking settings into the active
   profile, then applies the target snapshot.
4. Switching to the already active profile is an intentional no-op; it must not
   overwrite the saved snapshot from potentially dirty live settings.
5. Cycling sorts names lexically, wraps, and requires at least two profiles. If the
   active name is absent, cycling starts with the first sorted profile.
6. Deleting the active profile selects the first lexically sorted valid remaining
   profile and applies its exact snapshot. If none remains, it clears
   `profiles.active` and retires profile-owned runtime overrides.

`asSnapshot` validates that `modelRoles` is an object,
`defaultThinkingLevel` is a string, and every role value is a string. Public
add/rename functions still accept empty or whitespace names. Tightening profile-name
validation should be a deliberate change with migration coverage.

### Multi-instance persistence

**Problem.** Multiple processes cache `config.yml`. Config-file locking prevented
file corruption but did not notify peers, stop stale snapshots from replacing fresh
ones, or recover a running terminal whose selected profile was deleted. Naively
applying `profiles.active` from disk also caused a switch in one terminal to
force-switch every other terminal.

**Contract.** Profile mutations persist per profile name, not by replacing the whole
map. Persistent `Settings` instances poll `config.yml` without holding filesystem
watch handles and merge fresh profile definitions. Each running terminal keeps its
locally active profile, exact model roles, and thinking level while that profile still
exists. A switch only changes that terminal; `profiles.active` on disk is a startup
default for future sessions. If a terminal's local profile is deleted, only terminals
using that profile switch to the first valid lexical fallback.
Implementation in `packages/coding-agent/src/config/settings.ts`:

- per-profile mutation tracking for create, update, rename, and deletion tombstones
- `setProfileItem`
- `deleteProfileItem`
- save path re-reads the latest on-disk config under the existing lock and applies
  only touched names
- external synchronization preserves each running terminal's valid local profile and
  snapshot, ignoring another terminal's `profiles.active`, `modelRoles`, and thinking
  selection
- deleting a locally active profile reconciles that terminal to the first valid
  lexical fallback and applies its exact model roles and thinking level
- stale clients preserve untouched fresh profile definitions and cannot resurrect
  deleted profiles

All profile-domain mutations must use the per-key methods. Do not reintroduce
`settings.set("profiles.items", wholeMap)` or write a locally cached target snapshot
merely to activate it.

### Command and keybinding wiring

`/profiles` supports:

- `list`
- `add <name>`
- `switch <name>`
- `delete <name>`
- `rename <old> <new>`
- `save`

Wiring spans:

- `packages/coding-agent/src/slash-commands/builtin-fork.ts`
  - `/profiles` command definition
- `packages/coding-agent/src/slash-commands/builtin-registry.ts`
- `packages/coding-agent/src/modes/types.ts`
- `packages/coding-agent/src/modes/interactive-mode.ts`
- `packages/coding-agent/src/modes/controllers/command-controller.ts`
  - `handleProfilesCommand`
- `packages/coding-agent/src/config/keybindings.ts`
  - `app.profile.cycle`, default `alt+c`
- `packages/coding-agent/src/modes/controllers/input-controller.ts`
  - editor binding setup
  - `cycleModelProfile`

A frequent merge failure is preserving the registry entry but losing the
`InteractiveModeContext` method/delegate. Verify all layers, not only command text.

### Live session and advisor synchronization

Cross-process profile definition changes update cached profile lists, but do not apply
another terminal's active selection to a live session. Settings synchronization queues
`AgentSession.applyProfileToSession()` only when effective local profile-controlled
settings change, such as deleted-profile fallback; command switch and cycle apply
their own local selection directly.

Implementation:

- `packages/coding-agent/src/session/agent-session.ts`
  - `applyProfileToSession`: resolve `default`, set model when resolvable, set thinking
    level, then `refreshAdvisors` (or stop advisors if advisor model is unavailable);
    unavailable default models do not block profile selection, but prompt submission
    is blocked until a working model is selected or discovered
  - `ensureAdvisorsBuilt`: idempotently build a missing advisor after late discovery
  - constructor subscription and dispose cleanup
  - `setAdvisorEnabled` writes a runtime settings override so spawned subagents inherit
    the live toggle
- `packages/coding-agent/src/config/model-registry.ts`
  - `#modelsUpdatedListeners`
  - `onModelsUpdated`
  - `#emitModelsUpdated` after runtime discovery settles

Late provider discovery is important: the session may exist before Ollama, LiteLLM,
or extension models arrive. A synchronized apply with an unresolved default model
remains pending, and the registry event retries it after the canonical model list is
finalized. Public `waitForIdle()` includes queued synchronized profile work.

Tests:

- `packages/coding-agent/test/profiles.test.ts`
- `packages/coding-agent/test/profiles-multi-instance.test.ts`
- `packages/coding-agent/test/profile-live-sync.test.ts`
- `packages/coding-agent/test/agent-session-advisor-model-sync.test.ts`
- `packages/coding-agent/test/model-registry-models-updated.test.ts`

## 2. `/accounts` routing control

`/accounts [provider]` manages whether a stored account serves model requests. It is
not logout.

### User contract

- Enter/Space toggles selected account routing on/off.
- Disabled accounts stay stored and continue token refresh, health probes, and usage
  reporting.
- `/logout` remains the deletion path.
- State survives restart.
- Round-robin and session-sticky assignments reset after a toggle.
- A routing-disabled sticky OAuth identity is not used for request attribution.
- If every OAuth account is disabled, selection falls back to all accounts rather
  than bricking authentication. Therefore “routing off” is a preferred exclusion,
  not an absolute deny when every account is off.

### Storage and selection implementation

`packages/ai/src/auth-storage.ts`:

- `#routingDisabledIds`
- `#routingDisabledCacheKey(credentialId)` uses
  `routing:disabled:<credentialId>`
- `#loadRoutingDisabledFromCache` during reload
- `#isRoutingDisabledAtIndex`
- `isRoutingDisabled`
- `setRoutingEnabled`
- provider assignment reset after state change

Preserve all three selection seams:

1. Generic candidate selection excludes routing-disabled credentials alongside
   temporary credential blocks.
2. Active/sticky OAuth identity selection skips disabled accounts and finds the first
   routable identity.
3. OAuth resolution filters disabled accounts, but uses the full set when filtering
   would leave none.

The persisted disabled flag uses the auth store cache with a far-future expiry. Rebuild
the in-memory set only from currently existing credential row IDs so deleted rows do
not leak stale state into later credentials.

Known API limitation: `setRoutingEnabled(provider, credentialId, enabled)` does not
independently validate that the row belongs to the supplied provider. Current TUI
supplies matched values; external callers must do the same.

### TUI and slash-command wiring

- `packages/coding-agent/src/modes/components/account-manager-selector.ts`
  - `AccountManagerSelectorComponent`
- `packages/coding-agent/src/modes/components/oauth-selector.ts`
  - mode union includes `"manage"`
  - manage/logout list stored credentials, not only currently usable auth
- `packages/coding-agent/src/modes/controllers/selector-controller.ts`
  - `showAccountsSelector`
  - account manager presentation and toggle callback
- `packages/coding-agent/src/modes/types.ts`
- `packages/coding-agent/src/modes/interactive-mode.ts`
- `packages/coding-agent/src/slash-commands/builtin-registry.ts`
  - `/accounts [provider]`
- `packages/coding-agent/src/slash-commands/helpers/logout.ts`
  - `LogoutAccount.routingDisabled`
  - `toLogoutAccounts(..., { isRoutingDisabled })`

The account manager currently operates only when multiple rows are available. Preserve
that surrounding selector behavior unless intentionally redesigning the UX.

### Coverage gap

There are no dedicated routing-disable persistence/selection or account-manager UI
tests. Add contract coverage when touching this feature:

1. create two stored credentials;
2. disable one and verify its cache flag survives reload;
3. verify provider assignments reset;
4. verify disabled account is excluded while a sibling is routable;
5. verify the documented all-disabled fallback;
6. verify toggle callback changes the displayed state without logging out.

## Commit references

- `f26026115` — base profiles implementation
- `8d902d057` — command context/delegate wiring
- `43bdd1748` — default `alt+c` binding
- `5c67adb47` — advisor runtime toggle inheritance for subagents
- `628a49394` — profile/advisor live synchronization and model update event
- `087b16dd8` — `/accounts` routing system
- `68f30cc56` — per-profile-key concurrent settings merge
- `96dfb3bdf` — historical legacy bundled config repair; its target files were later
  deleted upstream and must not be restored

## Focused verification
```sh
cd packages/coding-agent
bun test \
  test/profiles.test.ts \
  test/profiles-multi-instance.test.ts \
  test/profile-live-sync.test.ts \
  test/agent-session-advisor-model-sync.test.ts \
  test/model-registry-models-updated.test.ts
bun test test/settings-manager.test.ts
```

Run `settings-manager.test.ts` separately: both suites manipulate process-global
Settings/AgentStorage test singletons, so Bun's cross-file parallel runner can make
their teardown cancel another file's fixture.

Also perform the `/accounts` manual checks above until dedicated tests exist.
