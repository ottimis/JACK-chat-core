# @ottimis/jack-chat-core

Transport-agnostic reducer and type definitions for the Jack chat UI. Shared between the Electron desktop app (`jack/`) and the React Native / Expo mobile app (`jack-mobile/`).

## What this package contains

- **Types** — `ChatMessage`, `ChatState`, `TaskItem`, plus the preload-level contracts (`FileChangeData`, `PermissionRequestData`, `ContextUsageInfo`, `ClaudeCommandDef`).
- **Pure helpers** — `parseSlashEnvelope`, `isCliMarkerOnly`, `expandCommandBody`, `isTaskTool`.
- **Reducer** — `createInitialState()` + `reduce(state, event)` that consumes Anthropic SDK stream events plus out-of-band events (permission, file change, error) and produces the list of message bubbles the UI renders.
- **History loader** — `loadHistory(rawSdkMessages)` that replays a recorded Claude Code JSONL transcript into a starting `ChatMessage[]`.

### `AgentEvent` actions

| `kind`                | Origin  | Purpose                                                                 |
|-----------------------|---------|-------------------------------------------------------------------------|
| `sdk`                 | backend | Anthropic SDK message (stream_event, assistant, user, result, system)   |
| `permission-request`  | backend | Inline pending-permission card (only when `inlineFileDiff` present)     |
| `file-change`         | backend | Replace a tool card with a file-diff card after PostToolUse hook        |
| `agent-error`         | backend | Append an error result card, clear running flag                         |
| `slash-feedback`      | host    | Append a slash feedback chip (host-side slash executor output)          |
| `context-usage`       | host    | Append a context-usage chip                                             |
| `user-prompt`         | client  | User typed and submitted a prompt                                       |
| `reset`               | client  | Reset to an empty state, optionally switching session                   |
| `load-history`        | client  | Replace state entirely with a replayed transcript for a session         |
| `slash-invocation`    | client  | User invoked a slash command (built-in or unknown), append chip         |
| `permission-resolved` | client  | User decided an inline permission: deny removes card, allow marks streaming |
| `interrupt`           | client  | User stopped the turn — reset runtime flags, keep messages              |

## What this package does NOT contain

- React components (desktop uses DOM, mobile uses RN primitives — components are host-specific).
- Transport (desktop uses Electron IPC, mobile will use SSE).
- Slash-command execution (host-specific side effects).

## Consumers

- `jack/` (desktop, Electron): link via `"@ottimis/jack-chat-core": "file:../jack-chat-core"`.
- `jack-mobile/` (Expo RN): same link; requires `metro.config.js` `watchFolders` addition.
