import { isCliMarkerOnly, isTaskTool, parseSlashEnvelope } from './helpers.js'
import { applyTaskTool } from './task-list.js'
import type {
  AgentEvent,
  AnthropicContentBlock,
  AnthropicStreamEvent,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
  ChatMessage,
  ChatState,
  SdkMessage,
  StreamingBlockEntry
} from './types.js'

/**
 * Build a fresh state. Pass `sessionId` up front so aggregated task-list
 * messages are scoped correctly; callers can omit it if they dispatch a
 * `reset` action with the id later.
 */
export function createInitialState(sessionId: string | null = null): ChatState {
  return {
    messages: [],
    running: false,
    statusLabel: null,
    streamingBlocks: {},
    currentAssistantId: null,
    taskCounter: 0,
    msgCounter: 0,
    sessionId
  }
}

/**
 * Host-provided clock. Tests override this; production uses `Date.now`.
 * Injected through the reducer's second argument so the reducer itself
 * remains a pure function of `(state, event, ctx)`.
 */
export type ReduceContext = {
  now: () => number
}

const defaultCtx: ReduceContext = { now: () => Date.now() }

/**
 * Pure reducer. Consumes one transport-agnostic event, returns the next state.
 * Does not mutate its input.
 */
export function reduce(
  state: ChatState,
  event: AgentEvent,
  ctx: ReduceContext = defaultCtx
): ChatState {
  switch (event.kind) {
    case 'reset':
      return createInitialState(event.sessionId ?? state.sessionId)

    case 'load-history':
      return loadHistory(event.rawMessages, event.sessionId, ctx)

    case 'sdk':
      return applySdkMessage(state, event.message, ctx)

    case 'permission-request':
      return applyPermissionRequest(state, event.data, ctx)

    case 'file-change':
      return applyFileChange(state, event.data, ctx)

    case 'agent-error': {
      const { state: s2, id } = bumpId(state)
      return {
        ...s2,
        running: false,
        streamingBlocks: {},
        currentAssistantId: null,
        messages: [
          ...s2.messages,
          {
            id,
            type: 'result',
            content: `Error: ${event.error}`,
            timestamp: ctx.now()
          }
        ]
      }
    }

    case 'slash-feedback': {
      const { state: s2, id } = bumpId(state)
      return {
        ...s2,
        messages: [
          ...s2.messages,
          {
            id,
            type: 'slash-feedback',
            content: event.text,
            feedbackStatus: event.status ?? 'ok',
            timestamp: ctx.now()
          }
        ]
      }
    }

    case 'context-usage': {
      const { state: s2, id } = bumpId(state)
      return {
        ...s2,
        messages: [
          ...s2.messages,
          {
            id,
            type: 'context-usage',
            content: '',
            contextUsage: event.usage,
            timestamp: ctx.now()
          }
        ]
      }
    }

    case 'user-prompt': {
      const { state: s2, id } = bumpId(state)
      return {
        ...s2,
        running: true,
        messages: [
          ...s2.messages,
          {
            id,
            type: 'user',
            content: event.text,
            timestamp: ctx.now()
          }
        ]
      }
    }

    case 'slash-invocation': {
      // Normalise the command name: strip a single leading '/' if present so
      // client-dispatched invocations render identically to chips derived from
      // the `<command-name>` envelope parser (which captures the bare name).
      const commandName = event.name.startsWith('/') ? event.name.slice(1) : event.name
      const { state: s2, id } = bumpId(state)
      return {
        ...s2,
        messages: [
          ...s2.messages,
          {
            id,
            type: 'slash-command',
            content: '',
            commandName,
            ...(event.args !== undefined && event.args.length > 0
              ? { commandArgs: event.args }
              : {}),
            timestamp: ctx.now()
          }
        ]
      }
    }

    case 'permission-resolved': {
      if (event.decision === 'deny') {
        return {
          ...state,
          messages: state.messages.filter((m) => m.id !== event.toolUseID)
        }
      }
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === event.toolUseID ? { ...m, streaming: true } : m
        )
      }
    }

    case 'interrupt': {
      return {
        ...state,
        running: false,
        statusLabel: null,
        streamingBlocks: {},
        currentAssistantId: null,
        messages: state.messages.some((m) => m.streaming)
          ? state.messages.map((m) => (m.streaming ? { ...m, streaming: false } : m))
          : state.messages
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal handlers
// ─────────────────────────────────────────────────────────────────────────────

function applySdkMessage(
  state: ChatState,
  message: SdkMessage,
  ctx: ReduceContext
): ChatState {
  switch (message.type) {
    case 'stream_event':
      return applyStreamEvent(state, message.event, ctx)
    case 'assistant':
      return applyAssistantFinal(state, message.message?.content ?? [], ctx)
    case 'user':
      return applyUserMessage(state, message.message?.content, ctx)
    case 'result': {
      const next: ChatState = {
        ...state,
        running: false,
        statusLabel: null,
        streamingBlocks: {},
        currentAssistantId: null,
        messages: state.messages.some((m) => m.streaming)
          ? state.messages.map((m) => (m.streaming ? { ...m, streaming: false } : m))
          : state.messages
      }
      const subtype = message.subtype ?? 'unknown'
      if (subtype === 'success') return next
      const { state: s2, id } = bumpId(next)
      return {
        ...s2,
        messages: [
          ...s2.messages,
          {
            id,
            type: 'result',
            content:
              subtype === 'error_max_turns' ? 'Reached max turns' : `Error: ${subtype}`,
            timestamp: ctx.now()
          }
        ]
      }
    }
    case 'system': {
      if (message.subtype !== 'status') return state
      const s = message.status
      return {
        ...state,
        statusLabel:
          s === 'requesting' ? 'Thinking' : s === 'compacting' ? 'Compacting' : null
      }
    }
    default:
      // Unknown SDK message types forwarded from the server — preserve state
      // rather than fall through and return `undefined` (which would crash the
      // next dispatch with `Cannot read property X of undefined`).
      return state
  }
}

function applyStreamEvent(
  state: ChatState,
  event: AnthropicStreamEvent | undefined,
  ctx: ReduceContext
): ChatState {
  if (!event) return state

  switch (event.type) {
    case 'content_block_start': {
      const block = event.content_block
      const idx = event.index
      const blockType = block?.type

      if (blockType === 'thinking' || blockType === 'text') {
        let currentAssistantId = state.currentAssistantId
        if (!currentAssistantId) {
          currentAssistantId = `assistant-${ctx.now()}-${idx}`
        }
        return {
          ...state,
          currentAssistantId,
          running: true,
          streamingBlocks: {
            ...state.streamingBlocks,
            [idx]: { id: currentAssistantId, blockType }
          }
        }
      }

      if (blockType === 'tool_use') {
        const rawId = block?.id
        const id = typeof rawId === 'string' && rawId.length > 0 ? rawId : `tool-${idx}-${ctx.now()}`
        const name = block?.name

        // Close the current text/thinking bubble so its streaming flag clears
        // and a new assistant grouping can start after the tool.
        let messages = state.messages
        if (state.currentAssistantId) {
          const targetId = state.currentAssistantId
          messages = messages.map((m) => (m.id === targetId ? { ...m, streaming: false } : m))
        }

        const nextStreaming: Record<number, StreamingBlockEntry> = {
          ...state.streamingBlocks,
          [idx]: { id, blockType: 'tool' }
        }

        // Aggregated Task tools: no placeholder card, the task-list widget is
        // updated when the final 'assistant' message arrives.
        if (isTaskTool(name)) {
          return {
            ...state,
            messages,
            streamingBlocks: nextStreaming,
            currentAssistantId: null,
            running: true
          }
        }

        // Skip if a pending-permission card already owns this id.
        if (messages.some((m) => m.id === id)) {
          return {
            ...state,
            messages,
            streamingBlocks: nextStreaming,
            currentAssistantId: null,
            running: true
          }
        }

        return {
          ...state,
          currentAssistantId: null,
          running: true,
          streamingBlocks: nextStreaming,
          messages: [
            ...messages,
            {
              id,
              type: 'tool',
              content: '',
              toolName: name,
              toolStatus: 'running',
              timestamp: ctx.now(),
              streaming: true
            }
          ]
        }
      }

      return state
    }

    case 'content_block_delta': {
      const entry = state.streamingBlocks[event.index]
      if (!entry || !event.delta) return state
      if (event.delta.type === 'text_delta' && event.delta.text) {
        return appendDelta(state, entry.id, 'content', event.delta.text, ctx)
      }
      if (event.delta.type === 'thinking_delta' && event.delta.thinking) {
        return appendDelta(state, entry.id, 'thinking', event.delta.thinking, ctx)
      }
      if (event.delta.type === 'input_json_delta' && event.delta.partial_json) {
        return appendDelta(state, entry.id, 'content', event.delta.partial_json, ctx)
      }
      return state
    }

    case 'content_block_stop': {
      const { [event.index]: _removed, ...rest } = state.streamingBlocks
      return { ...state, streamingBlocks: rest }
    }

    case 'message_stop': {
      let messages = state.messages
      if (state.currentAssistantId) {
        const targetId = state.currentAssistantId
        messages = messages.map((m) => (m.id === targetId ? { ...m, streaming: false } : m))
      }
      return {
        ...state,
        messages,
        streamingBlocks: {},
        currentAssistantId: null
      }
    }

    default:
      // Unknown stream event types (e.g. `message_start`, `message_delta`,
      // `ping`) forwarded verbatim from the SDK — ignore but preserve state.
      // Falling through would return `undefined` and crash the next dispatch.
      return state
  }
}

function applyAssistantFinal(
  state: ChatState,
  blocks: AnthropicContentBlock[],
  ctx: ReduceContext
): ChatState {
  let next = state
  for (const block of blocks) {
    if (block.type !== 'tool_use') continue
    const toolBlock = block as AnthropicToolUseBlock
    if (!toolBlock.id) continue

    if (isTaskTool(toolBlock.name)) {
      const sessionId = next.sessionId ?? 'global'
      const result = applyTaskTool(
        next.messages,
        sessionId,
        toolBlock.name,
        toolBlock.input,
        next.taskCounter,
        ctx.now()
      )
      next = { ...next, messages: result.messages, taskCounter: result.taskCounter }
      continue
    }

    next = {
      ...next,
      messages: next.messages.map((m) =>
        m.id === toolBlock.id
          ? {
              ...m,
              toolStatus: 'done' as const,
              streaming: false,
              toolInput: toolBlock.input
            }
          : m
      )
    }
  }
  return next
}

function applyUserMessage(
  state: ChatState,
  content: string | AnthropicContentBlock[] | undefined,
  ctx: ReduceContext
): ChatState {
  if (content === undefined) return state

  let next = state
  const textBlobs: string[] = []

  if (typeof content === 'string') {
    textBlobs.push(content)
  } else if (Array.isArray(content)) {
    for (const c of content) {
      if (c.type === 'tool_result' && (c as AnthropicToolResultBlock).tool_use_id) {
        const toolResult = c as AnthropicToolResultBlock
        const targetId = toolResult.tool_use_id
        const nextStatus: 'error' | 'done' = toolResult.is_error ? 'error' : 'done'
        next = {
          ...next,
          messages: next.messages.map((m) =>
            m.id === targetId ? { ...m, toolStatus: nextStatus, streaming: false } : m
          )
        }
      } else if (c.type === 'text' && typeof c.text === 'string') {
        textBlobs.push(c.text)
      }
    }
  }

  for (const text of textBlobs) {
    const envelope = parseSlashEnvelope(text)
    if (envelope) {
      const { state: s2, id } = bumpId(next)
      next = {
        ...s2,
        messages: [
          ...s2.messages,
          {
            id,
            type: 'slash-command',
            content: '',
            commandName: envelope.commandName,
            ...(envelope.commandArgs !== undefined ? { commandArgs: envelope.commandArgs } : {}),
            ...(envelope.commandStdout !== undefined
              ? { commandStdout: envelope.commandStdout }
              : {}),
            timestamp: ctx.now()
          }
        ]
      }
    }
  }

  return next
}

function applyPermissionRequest(
  state: ChatState,
  data: import('./preload-types.js').PermissionRequestData,
  ctx: ReduceContext
): ChatState {
  // Previously we required `inlineFileDiff` and relied on desktop rendering
  // non-inline requests via a floating PermissionCard. Mobile has no such
  // floating UI, so the user would just see "waiting_input" and nothing
  // actionable in the chat. The filter now lives at the desktop dispatch
  // site (`AgentChat.tsx` drops non-inline requests before dispatching), so
  // the reducer itself is permissive and adds a card for any request it gets.
  const id = data.toolUseID ?? `perm-${ctx.now()}`
  const without = state.messages.filter((m) => m.id !== id)
  return {
    ...state,
    messages: [
      ...without,
      {
        id,
        type: 'pending-permission',
        content: '',
        pendingPermission: data,
        timestamp: ctx.now()
      }
    ]
  }
}

function applyFileChange(
  state: ChatState,
  data: import('./preload-types.js').FileChangeData,
  ctx: ReduceContext
): ChatState {
  const idx = state.messages.findIndex((m) => m.id === data.toolUseId)
  if (idx >= 0) {
    const next = [...state.messages]
    next[idx] = {
      id: data.toolUseId,
      type: 'file-diff',
      content: '',
      fileChange: data,
      timestamp: ctx.now()
    }
    return { ...state, messages: next }
  }
  const { state: s2, id } = bumpId(state)
  return {
    ...s2,
    messages: [
      ...s2.messages,
      {
        id,
        type: 'file-diff',
        content: '',
        fileChange: data,
        timestamp: ctx.now()
      }
    ]
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal utilities
// ─────────────────────────────────────────────────────────────────────────────

function bumpId(state: ChatState): { state: ChatState; id: string } {
  const next = state.msgCounter + 1
  return { state: { ...state, msgCounter: next }, id: String(next) }
}

function appendDelta(
  state: ChatState,
  id: string,
  field: 'content' | 'thinking',
  delta: string,
  ctx: ReduceContext
): ChatState {
  const exists = state.messages.some((m) => m.id === id)
  if (exists) {
    return {
      ...state,
      messages: state.messages.map((m) =>
        m.id === id ? { ...m, [field]: (m[field] ?? '') + delta } : m
      )
    }
  }
  const newMessage: ChatMessage = {
    id,
    type: 'assistant',
    content: field === 'content' ? delta : '',
    timestamp: ctx.now(),
    streaming: true,
    ...(field === 'thinking' ? { thinking: delta } : {})
  }
  return {
    ...state,
    messages: [...state.messages, newMessage]
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// History replay
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rebuild a `ChatMessage[]` from a recorded Claude Code JSONL transcript.
 * Unlike `reduce`, this operates on finalised turns (no streaming deltas),
 * so the logic is a flat iteration rather than delta accumulation.
 *
 * Internal counters are exposed on the returned state so the caller can keep
 * consuming live events without id collisions.
 */
export function loadHistory(
  rawMessages: SdkMessage[],
  sessionId: string,
  ctx: ReduceContext = defaultCtx
): ChatState {
  let state = createInitialState(sessionId)

  for (const msg of rawMessages) {
    if (msg.type === 'user') {
      const content = msg.message?.content
      let text = ''
      if (typeof content === 'string') {
        text = content
      } else if (Array.isArray(content)) {
        text = content
          .filter((b): b is AnthropicContentBlock & { type: 'text'; text: string } => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
      }
      if (!text) continue

      const envelope = parseSlashEnvelope(text)
      if (envelope) {
        const { state: s2, id } = bumpId(state)
        state = {
          ...s2,
          messages: [
            ...s2.messages,
            {
              id,
              type: 'slash-command',
              content: '',
              commandName: envelope.commandName,
              ...(envelope.commandArgs !== undefined ? { commandArgs: envelope.commandArgs } : {}),
              ...(envelope.commandStdout !== undefined
                ? { commandStdout: envelope.commandStdout }
                : {}),
              timestamp: 0
            }
          ]
        }
      } else if (!isCliMarkerOnly(text)) {
        const { state: s2, id } = bumpId(state)
        state = {
          ...s2,
          messages: [...s2.messages, { id, type: 'user', content: text, timestamp: 0 }]
        }
      }
      continue
    }

    if (msg.type === 'assistant') {
      const blocks: AnthropicContentBlock[] = Array.isArray(msg.message?.content)
        ? (msg.message!.content as AnthropicContentBlock[])
        : []
      const texts = blocks
        .filter((b): b is AnthropicContentBlock & { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
      const thinkingTexts = blocks
        .filter(
          (b): b is AnthropicContentBlock & { type: 'thinking'; thinking: string } => b.type === 'thinking'
        )
        .map((b) => b.thinking)
        .join('\n')

      if (texts || thinkingTexts) {
        const { state: s2, id } = bumpId(state)
        state = {
          ...s2,
          messages: [
            ...s2.messages,
            {
              id,
              type: 'assistant',
              content: texts,
              ...(thinkingTexts ? { thinking: thinkingTexts } : {}),
              timestamp: 0
            }
          ]
        }
      }

      for (const block of blocks) {
        if (block.type !== 'tool_use') continue
        const toolBlock = block as AnthropicToolUseBlock

        if (isTaskTool(toolBlock.name)) {
          const result = applyTaskTool(
            state.messages,
            sessionId,
            toolBlock.name,
            toolBlock.input,
            state.taskCounter,
            ctx.now()
          )
          state = { ...state, messages: result.messages, taskCounter: result.taskCounter }
          continue
        }

        const { state: s2, id: fallbackId } = bumpId(state)
        const id = toolBlock.id ?? fallbackId
        state = {
          ...s2,
          messages: [
            ...s2.messages,
            {
              id,
              type: 'tool',
              content: '',
              toolName: toolBlock.name,
              toolInput: toolBlock.input,
              toolStatus: 'done',
              timestamp: 0
            }
          ]
        }
      }
    }
  }

  return state
}
