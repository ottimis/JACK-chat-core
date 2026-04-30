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
  content: string
  thinking?: string
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
 * Concrete consumer today: `applyUserMessage` and `loadHistory` strip
 * `hiddenWrapperTags` before rendering. Forward-compat: `infoWrapperTags`
 * declares structured metadata wrappers (env context, attachments, IDE
 * hints) — a future renderer release will surface them as chips above
 * the user bubble. Declaring `infoWrapperTags` today is a no-op for the
 * reducer beyond stripping; the rendering side ships in a follow-up.
 *
 * Both arrays carry plain tag names without angle brackets:
 *   `['environment_context', 'jack-system']`
 *
 * The reducer matches `<tag>...</tag>` (XML-like) blocks case-sensitively
 * and non-greedy. Multi-line bodies are supported.
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
   * Wrapper tag names whose content should surface as structured metadata
   * (chips / badges / collapsible panel) instead of being rendered as
   * user-typed text. The reducer strips them from the bubble's text just
   * like `hiddenWrapperTags`, but additionally attaches their parsed
   * payloads to the message for the renderer to display.
   *
   * RESERVED for chat-core ≥ 0.6.0 — chip rendering ships in a follow-up.
   * Declaring it today is safe: the reducer treats `infoWrapperTags`
   * exactly like `hiddenWrapperTags` until renderer support lands.
   */
  infoWrapperTags?: readonly InfoWrapperTagSpec[]
}

export type InfoWrapperTagSpec = {
  tag: string
  /** Short label shown next to the chip. */
  label: string
  /** Hint for the renderer's icon / styling switch. */
  chipKind?: 'env' | 'attachment' | 'workspace' | 'ide' | 'other'
}

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
