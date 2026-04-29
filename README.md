# @ottimis/jack-chat-core

Transport-agnostic reducer and type definitions for the Jack chat UI. Shared between the Electron desktop app (`jack/`) and the React Native / Expo mobile app (`jack-mobile/`).

## What this package contains

- **Types** — `ChatMessage`, `ChatState`, `TaskItem`, the provider-neutral message contract (`NormalizedMessage`, `NormalizedBlock`, `NormalizedToolRef`, `ToolShape`, …), plus the preload-level contracts (`FileChangeData`, `PermissionRequestData`, `ContextUsageInfo`, `ClaudeCommandDef`).
- **Pure helpers** — `parseSlashEnvelope`, `isCliMarkerOnly`, `expandCommandBody`, `isJackTaskTool`, `isTaskTool` (deprecated).
- **Reducer** — `createInitialState()` + `reduce(state, event)` that consumes provider-neutral `NormalizedMessage`s plus out-of-band events (permission, file change, error) and produces the list of message bubbles the UI renders.
- **History loader** — `loadHistory(rawMessages)` that replays a transcript expressed as `NormalizedMessage[]` into a starting `ChatMessage[]`.

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
