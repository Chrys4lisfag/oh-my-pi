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
6. Deleting the active profile clears `profiles.active`.

Known validation limits: `asSnapshot` checks that `modelRoles` is an object and
`defaultThinkingLevel` is a string, but does not prove every role value is a string.
Public add/rename functions also accept empty or whitespace names. Do not accidentally
make validation weaker; tightening it should be a deliberate change with migration
coverage.

### Multi-instance persistence

**Problem.** `profiles.items` is one settings path. Two processes loading the same
stale map and writing different profile keys used to overwrite each other despite the
file lock.

**Contract.** Profile mutations persist per profile name, not by replacing the whole
map.

Implementation in `packages/coding-agent/src/config/settings.ts`:

- `#modifiedProfileItems: Map<string, "upsert" | "delete">`
- `setProfileItem`
- `deleteProfileItem`
- save path re-reads the latest on-disk config under the existing lock and applies
  only touched names

All profile-domain mutations must call these methods. Do not reintroduce
`settings.set("profiles.items", wholeMap)`.

`profiles.active` is still a normal whole-path setting and can race between processes;
only profile item content has per-key merge semantics.

### Command and keybinding wiring

`/profiles` supports:

- `list`
- `add <name>`
- `switch <name>`
- `delete <name>`
- `rename <old> <new>`
- `save`

Wiring spans:

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

A settings update alone does not update already-instantiated model/advisor agents.
After switch or cycle, call `AgentSession.applyProfileToSession()`.

Implementation:

- `packages/coding-agent/src/session/agent-session.ts`
  - `applyProfileToSession`: resolve `default`, set model when resolvable, set thinking
    level, then `refreshAdvisors`
  - `refreshAdvisors`: rebuild active advisor runtime from current settings
  - `ensureAdvisorsBuilt`: idempotently build a missing advisor after late discovery
  - constructor subscription and dispose cleanup
  - `setAdvisorEnabled` writes a runtime settings override so spawned subagents inherit
    the live toggle
- `packages/coding-agent/src/config/model-registry.ts`
  - `#modelsUpdatedListeners`
  - `onModelsUpdated`
  - `#emitModelsUpdated` after runtime discovery settles

Late provider discovery is important: the session may exist before Ollama, LiteLLM,
or extension models arrive. The registry event retries a previously skipped advisor
build. If upstream moves discovery finalization, re-home `#emitModelsUpdated` after the
canonical model list is finalized.

Tests:

- `packages/coding-agent/test/profiles.test.ts`
- `packages/coding-agent/test/profiles-multi-instance.test.ts`
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
(cd packages/coding-agent && bun test \
  test/profiles.test.ts \
  test/profiles-multi-instance.test.ts \
  test/agent-session-advisor-model-sync.test.ts \
  test/model-registry-models-updated.test.ts)
```

Also perform the `/accounts` manual checks above until dedicated tests exist.
