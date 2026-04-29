import type {
  NormalizedBlock,
  NormalizedMessage,
  NormalizedToolRef,
  ToolShape
} from '../../src/normalized.js'

/**
 * Build a `tool_use` block with a `native` toolRef. Mirrors what the Claude
 * translator produces for first-party tools (`Read`, `Edit`, `Bash`, …).
 */
export function nativeToolUse(
  toolName: string,
  shape: ToolShape,
  toolUseId: string,
  input: unknown
): NormalizedBlock {
  return {
    type: 'tool_use',
    toolUseId,
    toolRef: { kind: 'native', toolName, shape, raw: toolName },
    input
  }
}

/**
 * Build a `tool_use` block with an `mcp` toolRef. The `serverSlug` defaults
 * to `'jack'` because the only mcp tools the reducer special-cases today
 * are Jack's task family (`mcp__jack__TaskCreate` …).
 */
export function mcpToolUse(
  toolName: string,
  toolUseId: string,
  input: unknown,
  serverSlug = 'jack'
): NormalizedBlock {
  const ref: NormalizedToolRef = {
    kind: 'mcp',
    serverSlug,
    toolName,
    raw: `mcp__${serverSlug}__${toolName}`
  }
  return { type: 'tool_use', toolUseId, toolRef: ref, input }
}

/**
 * Server-slug-first variant — preferred when the test's emphasis is on
 * the server boundary (e.g. `figma`, `linear`, `jack`) rather than the
 * tool family. Equivalent to {@link mcpToolUse} with reordered params.
 */
export function mcpBlock(
  serverSlug: string,
  toolName: string,
  toolUseId: string,
  input: unknown
): NormalizedBlock {
  return mcpToolUse(toolName, toolUseId, input, serverSlug)
}

export function textBlock(text: string): NormalizedBlock {
  return { type: 'text', text }
}

export function thinkingBlock(text: string): NormalizedBlock {
  return { type: 'thinking', text }
}

export function toolResult(
  toolUseId: string,
  isError = false,
  content: unknown = ''
): NormalizedBlock {
  return { type: 'tool_result', toolUseId, isError, content }
}

export function assistantMsg(blocks: NormalizedBlock[]): NormalizedMessage {
  return { kind: 'assistant', blocks, raw: {} }
}

export function userMsg(blocks: NormalizedBlock[]): NormalizedMessage {
  return { kind: 'user', blocks, raw: {} }
}

export function turnResultSuccess(): NormalizedMessage {
  return { kind: 'turn_result', success: true, raw: {} }
}

export function turnResultError(errorMessage: string): NormalizedMessage {
  return { kind: 'turn_result', success: false, errorMessage, raw: {} }
}

export function sessionState(
  state: 'idle' | 'running' | 'requires_action'
): NormalizedMessage {
  return { kind: 'session_state', state, raw: {} }
}

/**
 * Build a `partial_event` whose `raw` carries a Claude-shaped
 * `stream_event` SDKMessage. The reducer narrows on this exact shape via
 * `isClaudeStreamEvent` — see `src/internal/claude-stream.ts`.
 */
export function claudeStream(event: unknown): NormalizedMessage {
  return {
    kind: 'partial_event',
    raw: { type: 'stream_event', event }
  }
}
