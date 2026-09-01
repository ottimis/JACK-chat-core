# @ottimis/jack-chat-core

Transport-agnostic reducer and type definitions for the Jack chat UI. Shared between the Electron desktop app (`jack/`) and the React Native / Expo mobile app (`jack-mobile/`).

## What this package contains

- **Types** — `ChatMessage`, `ChatState`, `TaskItem`, the provider-neutral message contract (`NormalizedMessage`, `NormalizedBlock`, `NormalizedToolRef`, `ToolShape`, …), plus the preload-level contracts (`FileChangeData`, `PermissionRequestData`, `ContextUsageInfo`, `SlashCommandDef`).
- **Pure helpers** — `isJackTaskTool`, `isTaskTool` (deprecated), `pickStr`, plus the user-content policy utilities (`stripWrapperTags`, `applyUserContentPolicy`, `extractInfoChips`, `mergeUserContentPolicies`) and the host room-tag vocabulary (`DEFAULT_HOST_CONTENT_POLICY`, `ROOM_MESSAGE_TAG_SPEC`, `ROOM_NOTICE_TAG_SPEC`). Slash-command parsing is no longer in this package — see `ReduceContext.parseSlashEnvelope` / `ReduceContext.isCliMarkerOnly` callbacks for the provider injection point.
- **Reducer** — `createInitialState()` + `reduce(state, event, ctx?)` that consumes provider-neutral `NormalizedMessage`s plus out-of-band events (permission, file change, error) and produces the list of message bubbles the UI renders. `ctx` carries the host clock and optional provider-specific text parsers.
- **History loader** — `loadHistory(rawMessages, sessionId, ctx?)` that replays a transcript expressed as `NormalizedMessage[]` into a starting `ChatMessage[]`. Slash envelope detection and CLI-marker filtering happen only when the matching ctx callbacks are injected.

### `AgentEvent` actions

| `kind`                | Origin  | Purpose                                                                 |
|-----------------------|---------|-------------------------------------------------------------------------|
| `sdk`                 | backend | Provider-neutral `NormalizedMessage` (assistant, user, partial_event, turn_result, session_state, …) |
| `permission-request`  | backend | Inline pending-permission card (only when `inlineFileDiff` present)     |
| `file-change`         | backend | Replace a tool card with a file-diff card after PostToolUse hook        |
| `agent-error`         | backend | Append an error result card, clear running flag                         |
| `slash-feedback`      | host    | Append a slash feedback chip (host-side slash executor output)          |
| `context-usage`       | host    | Append a context-usage chip                                             |
| `user-prompt`         | client  | User typed and submitted a prompt                                       |
| `turn-started`        | server  | A new user turn just started; passive observers render the bubble + flip `running` |
| `reset`               | client  | Reset to an empty state, optionally switching session                   |
| `load-history`        | client  | Replace state entirely with a replayed transcript for a session         |
| `slash-invocation`    | client  | User invoked a slash command (built-in or unknown), append chip         |
| `permission-resolved` | client  | User decided an inline permission: deny removes card, allow marks streaming |
| `interrupt`           | client  | User stopped the turn — reset runtime flags, keep messages              |

## 0.11.0

Additive: chat-core now **exports the Coordination Rooms vocabulary**, not just the mechanism 0.10.0 shipped.

- `ROOM_MESSAGE_TAG_SPEC` / `ROOM_NOTICE_TAG_SPEC` — the two host `InfoWrapperTagSpec`s, and `DEFAULT_HOST_CONTENT_POLICY`, the `HostContentPolicy` containing both. Pass it straight through as `ReduceContext.hostContentPolicy`.
- `ROOM_MESSAGE_TAG`, `ROOM_NOTICE_TAG`, `ROOM_BODY_TAG` — the tag names, for hosts that also *compose* envelopes.
- All frozen: they are process-wide singletons, so a consumer that pushed onto `infoWrapperTags` would change what every other call site parses. Extend by spreading, not by mutating.

**Why.** 0.10.0 said "chat-core ships the mechanism, not the vocabulary". Three consumers then declared the same tag independently — jack main `src/main/rooms/envelope.ts`, jack renderer and jack-mobile `roomContentPolicy.ts` — which diverges the first time an attribute or a field name changes. The tags stay *owned* by the host (`_shared/api/coordination-rooms.md` §3 defines them, including the escaping invariants the composing side must satisfy); this package just holds the one copy everybody parses against.

Only the parsing half lives here. Nothing in this package composes an envelope: attribution, the disclaimer and the body neutralisation are host-side, and that is the whole anti-impersonation guarantee.

No breaking changes — a host that keeps its own literal declaration compiles unchanged.

## 0.10.0

Additive: **host-canonical wrapper tags**. Until now every wrapper tag (hidden or info) came from the active provider's `userContent` policy. Envelopes the *host* writes around content it injects — Coordination Rooms' `<jack-room-message …>` is the driving case — must be recognised whatever provider the session runs on, which a provider-supplied policy structurally cannot guarantee.

- `ReduceContext.hostContentPolicy?: HostContentPolicy` — host-declared `hiddenWrapperTags` / `infoWrapperTags`, same shape as `ProviderUserContentPolicy`. Merged over the provider policy before any stripping or chip extraction.
- `applyUserContentPolicy(text, policy, hostPolicy?)` and `extractInfoChips(text, policy, hostPolicy?)` take the host policy as an optional third argument — existing two-argument calls behave exactly as before.
- `mergeUserContentPolicies(hostPolicy, providerPolicy)` is exported for consumers that apply the policy outside the reducer (provider transcript readers, mobile renderers). Host entries come first and **win on a tag-name collision**, across both axes; with no host entries it returns the provider policy by reference.
- **The `jack-` prefix (`JACK_HOST_TAG_PREFIX`) is reserved for host-authored tags.** Provider packages must not declare tags starting with it. Not enforced at runtime — `<jack-system>` predates the split and is still declared through a provider policy, so rejecting the prefix there would be a breaking change — the merge precedence is the backstop.
- Wrapper tags may now carry **attributes** on the opening tag (`<jack-room-message room="r-1" from="codex-reviewer">`). They are stripped as before, and `ParsedChip` gains an optional `attributes: Record<string, string>` (unquoted, XML-entity-decoded, present only when the tag carried at least one `name="value"` pair). Attribute values may not contain `>`. A tag without attributes matches as it always did, and `<env>` still never matches `<environment>`.
- `ChipKind` gains `'room'`.

No breaking changes — existing 0.9.0 consumers keep compiling. Hosts that want the host-level tags pass `hostContentPolicy` in `ReduceContext`. At this version the tag names themselves were still host-side; 0.11.0 exports them (see above).

## 0.5.0

**Breaking**: `parseSlashEnvelope`, `isCliMarkerOnly`, `expandCommandBody`, and `SLASH_ENVELOPE_START` are no longer exported. The reducer's slash-command envelope detection is now optional and provider-driven via two new `ReduceContext` callbacks:

- `parseSlashEnvelope?: (text: string) => ParsedSlashEnvelope | null`
- `isCliMarkerOnly?: (text: string) => boolean`

Hosts targeting Claude must inject those callbacks at runtime; hosts targeting providers without a slash convention (Codex, Gemini, …) omit them and the reducer renders user messages without slash chip detection or marker filtering.

**Renamed (with deprecated alias)**: `ClaudeCommandDef` → `SlashCommandDef`. The old name remains as a `@deprecated` alias and will be removed in 0.6.0.

**Reasoning**: chat-core is provider-neutral; Claude-specific text parsing belongs in the provider package, not in the rendering layer. This change unblocks the multi-provider integration on the host side.

**Migration**:

- Hosts that consume Claude: re-implement `parseSlashEnvelope` / `isCliMarkerOnly` in your provider layer (the previous logic is ~30 lines, see Jack's `providers/claude/slashCommands.ts`) and pass them via `ReduceContext`.
- Type imports: replace `ClaudeCommandDef` with `SlashCommandDef`.
- `expandCommandBody`: re-implement in the host slash-command executor; the body-expansion logic is host-specific anyway.

## 0.4.1

Additive: `ChatMessage` gains optional `toolShape`, `toolRefKind`, `toolMcpServerSlug` fields. The reducer populates them from `NormalizedBlock.tool_use.toolRef` when the final assistant message arrives (and during history replay). Renderers can switch from `toolName`-keyed card selection to `shape`-keyed dispatch; back-compat preserved since the fields are optional.

- Native tools carry their canonical `shape` from the provider's tool catalog (`'fs.read' | 'fs.write' | …`).
- MCP-routed tools always map to `toolShape: 'mcp'` and carry `toolMcpServerSlug` so the renderer can show the MCP badge + server slug without re-parsing `toolName`.
- Streaming-only states (between `content_block_start` and the final assistant message) leave the fields `undefined` — only the wire name is on the wire there. Renderers should fall back to `toolName` matching for that window.
- `'unknown'` shapes (native tools without a catalog entry) are preserved verbatim, not coerced to `undefined`, so the renderer can pick a generic JSON view rather than fall back to provider-name pattern matching.

No breaking changes — existing 0.4.0 consumers keep compiling.

## Breaking changes in 0.4.0

- `AgentEvent.kind = 'sdk'` now carries a provider-neutral `NormalizedMessage` instead of an Anthropic-shaped `SdkMessage`. Hosts must translate provider-native streams to `NormalizedMessage` before dispatching; Jack ≥ 1.3 ships a Claude translator at `src/main/providers/claude/normalize.ts`.
- `loadHistory` and the `load-history` action now consume `NormalizedMessage[]` (was `SdkMessage[]`).
- The Anthropic-shaped block types (`AnthropicContentBlock`, `AnthropicTextBlock`, `AnthropicThinkingBlock`, `AnthropicToolUseBlock`, `AnthropicToolResultBlock`, `AnthropicStreamEvent`, `StreamEventDelta`, `SdkMessage`, `HistorySdkMessage`) are no longer exported.
- Streaming token-level events still expect a Claude `stream_event` shape inside `NormalizedMessage.partial_event.raw`. A normalized partial-block event will land in a follow-up release once a second provider drives the design.
- Use the new `isJackTaskTool(ref: NormalizedToolRef)` helper to detect Jack's task-family MCP tools. The legacy `isTaskTool(name)` helper remains exported but is deprecated.
- The Claude `system/status:compacting` signal is not currently mapped to a normalized kind; the `'Compacting'` status label is unreachable until a follow-up contract update introduces a dedicated state.

## What this package does NOT contain

- React components (desktop uses DOM, mobile uses RN primitives — components are host-specific).
- Transport (desktop uses Electron IPC, mobile will use SSE).
- Slash-command execution (host-specific side effects).
- Provider-native translators. The host (Jack main process) owns those — chat-core only consumes the normalized payload.

## Consumers

- `jack/` (desktop, Electron): link via `"@ottimis/jack-chat-core": "file:../jack-chat-core"`.
- `jack-mobile/` (Expo RN): same link; requires `metro.config.js` `watchFolders` addition.
