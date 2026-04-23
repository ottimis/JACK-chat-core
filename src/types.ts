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
 * Block currently receiving streaming deltas. Keyed by the Anthropic
 * `content_block_start.index` so subsequent deltas find their target.
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

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic SDK message shapes (partial — only what the reducer reads)
// ─────────────────────────────────────────────────────────────────────────────

export type AnthropicTextBlock = { type: 'text'; text: string }
export type AnthropicThinkingBlock = { type: 'thinking'; thinking: string }
export type AnthropicToolUseBlock = {
  type: 'tool_use'
  id: string
  name: string
  input?: Record<string, unknown>
}
export type AnthropicToolResultBlock = {
  type: 'tool_result'
  tool_use_id: string
  is_error?: boolean
  content?: unknown
}
export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicThinkingBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock

export type StreamEventDelta =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'input_json_delta'; partial_json: string }

export type AnthropicStreamEvent =
  | {
      type: 'content_block_start'
      index: number
      content_block?: Partial<AnthropicContentBlock> & { type?: string; id?: string; name?: string }
    }
  | { type: 'content_block_delta'; index: number; delta?: StreamEventDelta }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_stop' }

export type SdkMessage =
  | {
      type: 'stream_event'
      event: AnthropicStreamEvent
    }
  | {
      type: 'assistant'
      message?: { content?: AnthropicContentBlock[] }
    }
  | {
      type: 'user'
      message?: { content?: string | AnthropicContentBlock[] }
    }
  | {
      type: 'result'
      subtype?: 'success' | 'error_max_turns' | string
    }
  | {
      type: 'system'
      subtype?: 'status' | string
      status?: 'requesting' | 'compacting' | null
    }

/**
 * History rows as produced by `window.api.agentGetMessages` (replay of the
 * Claude Code JSONL transcript). Shape mirrors the stored SDK events, so
 * `loadHistory` accepts the same `SdkMessage` union above.
 */
export type HistorySdkMessage = SdkMessage

// ─────────────────────────────────────────────────────────────────────────────
// Reducer actions
// ─────────────────────────────────────────────────────────────────────────────

export type AgentEvent =
  | { kind: 'sdk'; message: SdkMessage }
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
   * first `stream_event` to trickle in.
   *
   * The reducer de-duplicates against the most recent user message in
   * state so a client that already dispatched `user-prompt` locally
   * (e.g. the mobile app when it itself was the originator) doesn't
   * render the same bubble twice.
   */
  | { kind: 'turn-started'; text: string }
  | { kind: 'reset'; sessionId?: string | null }
  | { kind: 'load-history'; rawMessages: SdkMessage[]; sessionId: string }
  | { kind: 'slash-invocation'; name: string; args?: string }
  | { kind: 'permission-resolved'; toolUseID: string; decision: 'allow' | 'always_allow' | 'deny' }
  | { kind: 'interrupt' }
