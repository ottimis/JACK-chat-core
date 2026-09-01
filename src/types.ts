import type { NormalizedMessage, ToolShape } from './normalized.js'
import type {
  ContextUsageInfo,
  FileChangeData,
  PermissionRequestData
} from './preload-types.js'

export type TaskItem = {
  id: string
  subject: string
  description?: string
  activeForm?: string
  status: 'pending' | 'in_progress' | 'completed' | 'deleted'
  createdAt: number
  updatedAt: number
}

export type ChatMessageType =
  | 'user'
  | 'assistant'
  | 'tool'
  | 'system'
  | 'result'
  | 'file-diff'
  | 'pending-permission'
  | 'task-list'
  | 'slash-command'
  | 'slash-feedback'
  | 'context-usage'

export type ChatMessage = {
  id: string
  type: ChatMessageType
  /**
   * Stable per-message id assigned by the provider's transcript (Claude
   * JSONL `uuid`, Codex `item.id`). Surfaced on the chat row when the
   * source event carries it (`NormalizedMessage.messageId`). The renderer
   * uses it as `upToMessageId` when asking the provider to fork at a
   * specific point — `id` alone is a synthetic counter and would never
   * match the provider's transcript.
   *
   * `undefined` when the message originated locally and hasn't been echoed
   * back by the provider yet (e.g. an optimistic `user-prompt` bubble
   * before the wire roundtrip lands the corresponding `kind: 'user'`).
   */
  providerMessageId?: string
  content: string
  thinking?: string
  /**
   * Structured chip payloads extracted from declared `infoWrapperTags`
   * during reducer processing. Renderers display them as compact pills
   * above/inside the user bubble (e.g. a background-bash completion
   * notification). When absent or empty, the bubble renders normally.
   *
   * Populated only on `type: 'user'` messages today.
   */
  chips?: readonly ParsedChip[]
  toolName?: string
  /**
   * Canonical shape from the provider's tool catalog. Set by the reducer
   * when the assistant final message lands (`NormalizedBlock.tool_use.toolRef`)
   * and during `loadHistory` replay. The renderer should key card selection
   * off this — `toolName` becomes a fallback / display detail rather than
   * the dispatch axis.
   *
   * `undefined` while only the streaming `tool_use` start has arrived
   * (the stream event only carries the wire name, not the shape).
   * Renderers should fall back to `toolName` matching in that window.
   *
   * For MCP-routed tools the value is `'mcp'` — the renderer combines it
   * with `toolMcpServerSlug` to render the MCP badge.
   */
  toolShape?: ToolShape
  /**
   * Distinguishes native tools from MCP-routed tools. Set together with
   * `toolShape` at applyAssistantFinal / loadHistory time. Lets the
   * renderer show the MCP badge + server slug without re-parsing
   * `toolName`. `undefined` while only streaming start info is available.
   */
  toolRefKind?: 'native' | 'mcp'
  /**
   * MCP server slug when `toolRefKind === 'mcp'`. Same source as
   * `NormalizedToolRef.serverSlug`. `undefined` for native tools.
   */
  toolMcpServerSlug?: string
  toolInput?: Record<string, unknown>
  toolStatus?: 'running' | 'done' | 'error'
  fileChange?: FileChangeData
  pendingPermission?: PermissionRequestData
  tasks?: TaskItem[]
  commandName?: string
  commandArgs?: string
  commandStdout?: string
  /** 'ok' → success tint, 'error' → warning tint. */
  feedbackStatus?: 'ok' | 'error'
  contextUsage?: ContextUsageInfo
  /**
   * Concrete model id reported by the provider for this assistant turn
   * (e.g. `claude-opus-4-8`). Surfaces the *resolved* version when the
   * user-facing model selection is a family alias like `opus`, which by
   * itself doesn't disclose which version actually ran. Sourced from
   * `NormalizedMessage.kind === 'assistant'`'s `model` field — the
   * provider populates it from its native event shape (Claude:
   * `assistant.message.model`; Codex: `turn.completed.model`; etc.).
   *
   * Populated only on `type === 'assistant'` rows. Optional — providers
   * that don't expose the per-turn model in their normalized envelope
   * simply leave it unset.
   */
  model?: string
  timestamp: number
  streaming?: boolean
}

export type StatusLabel = 'Thinking' | 'Compacting' | null

/**
 * Block currently receiving streaming deltas. Keyed by the provider's
 * `content_block_start.index` (Claude — see internal/claude-stream.ts) so
 * subsequent deltas find their target.
 */
export type StreamingBlockEntry = {
  id: string
  blockType: 'text' | 'thinking' | 'tool'
}

/**
 * Complete reducer state. `messages` is what the UI renders; the rest is
 * runtime bookkeeping that hosts shouldn't need to touch directly.
 */
export type ChatState = {
  messages: ChatMessage[]
  running: boolean
  statusLabel: StatusLabel
  streamingBlocks: Record<number, StreamingBlockEntry>
  currentAssistantId: string | null
  taskCounter: number
  msgCounter: number
  /**
   * Session-scoped id used when aggregating task tools into a single
   * task-list message. Set via `resetSession` when switching sessions.
   */
  sessionId: string | null
}

export type ParsedSlashEnvelope = {
  commandName: string
  commandArgs?: string
  commandStdout?: string
}

/**
 * Declarative rules for how Jack should interpret a provider's user-role
 * content. Different from the capability matrix (what the provider can do)
 * — this lives in the policy axis (how the host renders / sanitizes data).
 *
 * Two complementary axes:
 *   - `hiddenWrapperTags` — stripped from text, nothing surfaced. For pure
 *     plumbing the user shouldn't see (Codex `<environment_context>`,
 *     host `<jack-system>` envelope).
 *   - `infoWrapperTags` — stripped from text AND parsed into structured
 *     {@link ParsedChip} payloads attached to the resulting `ChatMessage`
 *     for the renderer to display as compact pills (Claude's
 *     `<task-notification>` for background-bash completions, future
 *     IDE-context blocks, …).
 *
 * Both arrays carry plain tag names without angle brackets:
 *   `['environment_context', 'jack-system']`
 *
 * The reducer matches `<tag>...</tag>` and `<tag attr="…">...</tag>`
 * (XML-like) blocks case-sensitively and non-greedy. Multi-line bodies are
 * supported. Nesting of the same tag is not handled — declare a distinct
 * outer tag if you need it.
 *
 * **Reserved prefix**: tag names starting with `jack-` belong to the host
 * (see {@link HostContentPolicy} and `JACK_HOST_TAG_PREFIX`). Providers must
 * not declare them — on a collision the host declaration wins.
 */
export type ProviderUserContentPolicy = {
  /**
   * Wrapper tag names whose content is fully hidden from the chat. Drops
   * the user bubble entirely if nothing remains after stripping. Use this
   * for provider self-injected boilerplate (Codex's `<environment_context>`,
   * IDE-provided context blocks) and host-injected markers (Jack's
   * `<jack-system>` envelope around the appended workspace context).
   */
  hiddenWrapperTags?: readonly string[]
  /**
   * Wrapper tag specs whose content is parsed into {@link ParsedChip}
   * payloads and attached to the resulting `ChatMessage.chips`. The
   * wrapper itself is stripped from the visible text (same as
   * `hiddenWrapperTags`), so the renderer doesn't see the raw XML — it
   * sees structured fields per spec instead.
   *
   * When `fields` is omitted, the chip carries only `label` + `raw`
   * (the inner content) — useful for tags whose body is free-form text.
   */
  infoWrapperTags?: readonly InfoWrapperTagSpec[]
}

/**
 * Declaration for a wrapper tag whose body should be parsed into a
 * structured chip payload. The reducer:
 *   1. Locates each `<tag>...</tag>` block in the user text, with or
 *      without attributes on the opening tag.
 *   2. Parses the opening tag's attributes into {@link ParsedChip.attributes}.
 *   3. For each declared field, runs a sub-match `<from>...</from>`
 *      inside the wrapper body. The captured text (trimmed) is stored
 *      under `fields[name]`.
 *   4. Emits one {@link ParsedChip} per wrapper occurrence.
 *
 * Multiple occurrences of the same wrapper in one user message produce
 * multiple chips. A field that doesn't match is simply omitted from
 * `fields` — renderers handle absence gracefully.
 */
export type InfoWrapperTagSpec = {
  tag: string
  /** Short label shown next to the chip. */
  label: string
  /** Hint for the renderer's icon / styling switch. */
  chipKind?: ChipKind
  /**
   * Inner tags to surface as named fields on the chip. Each entry maps
   * a renderer-side `name` to the wrapper-side `from` tag name. Omit
   * for free-form bodies (the chip then exposes only `raw`).
   */
  fields?: readonly { name: string; from: string }[]
}

export type ChipKind =
  | 'env'
  | 'attachment'
  | 'workspace'
  | 'ide'
  | 'task'
  /** Host-authored coordination envelope (Coordination Rooms). */
  | 'room'
  | 'other'

/**
 * Renderer-facing payload extracted from a declared `infoWrapperTag`
 * occurrence in a user message. The reducer attaches an array of these
 * to `ChatMessage.chips`. The renderer keys visual choice off `chipKind`
 * and reads named fields out of `fields`. `raw` carries the original
 * wrapper body (trimmed) for tooltip / expand-on-click.
 */
export type ParsedChip = {
  tag: string
  label: string
  chipKind?: ChipKind
  fields: Record<string, string>
  /**
   * Attributes parsed off the opening tag (`<jack-room-message room="r1"
   * from="codex-reviewer">` → `{ room: 'r1', from: 'codex-reviewer' }`).
   * Values are unquoted and XML-entity-decoded. Present only when the
   * opening tag carried at least one `name="value"` pair — bare
   * valueless attributes are ignored.
   */
  attributes?: Record<string, string>
  raw: string
}

/**
 * Host-declared counterpart of {@link ProviderUserContentPolicy}. Same two
 * axes, but sourced from Jack itself instead of from a provider package:
 * these wrappers are written by the *host* around content it injects into a
 * session, so recognising them must not depend on which provider the session
 * runs on (Coordination Rooms' `<jack-room-message>` envelope is the driving
 * case — the host authors it for every provider).
 *
 * Merged with the provider policy by `mergeUserContentPolicies` before any
 * stripping or chip extraction happens; host declarations win on a tag-name
 * collision. The `jack-` prefix (`JACK_HOST_TAG_PREFIX`) is reserved for host
 * tags, so collisions should not exist in the first place — the precedence
 * rule is a backstop, not a design affordance.
 */
export type HostContentPolicy = ProviderUserContentPolicy

// ─────────────────────────────────────────────────────────────────────────────
// Reducer actions
// ─────────────────────────────────────────────────────────────────────────────

export type AgentEvent =
  | { kind: 'sdk'; message: NormalizedMessage }
  | { kind: 'permission-request'; data: PermissionRequestData }
  | { kind: 'file-change'; data: FileChangeData }
  | { kind: 'agent-error'; error: string }
  | { kind: 'slash-feedback'; text: string; status?: 'ok' | 'error' }
  | { kind: 'context-usage'; usage: ContextUsageInfo }
  | { kind: 'user-prompt'; text: string }
  /**
   * Server-originated notification that a new user turn just started.
   * Emitted alongside `sendUserTurn()` regardless of the source (desktop
   * IPC or mobile HTTP) so that passive observers (e.g. a mobile app
   * watching a desktop-driven session) can render the prompt bubble and
   * flip `running: true` immediately, without having to wait for the
   * first `partial_event` to trickle in.
   *
   * The reducer de-duplicates against the most recent user message in
   * state so a client that already dispatched `user-prompt` locally
   * (e.g. the mobile app when it itself was the originator) doesn't
   * render the same bubble twice.
   */
  | { kind: 'turn-started'; text: string }
  | { kind: 'reset'; sessionId?: string | null }
  | { kind: 'load-history'; rawMessages: NormalizedMessage[]; sessionId: string }
  | { kind: 'slash-invocation'; name: string; args?: string }
  | { kind: 'permission-resolved'; toolUseID: string; decision: 'allow' | 'always_allow' | 'deny' }
  | { kind: 'interrupt' }
