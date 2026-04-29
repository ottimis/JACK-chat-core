// Provider-specific shape; will be replaced by NormalizedPartialBlockEvent in
// a follow-up. The Claude provider currently ships its native `stream_event`
// SDKMessage payload verbatim under `NormalizedMessage.partial_event.raw`,
// and the reducer parses Anthropic-shaped delta events from it.
//
// When a second provider drives the streaming design (Codex first), this
// file disappears in favour of a proper normalized partial-block event.
// Keep these types confined to the streaming hot path — nothing outside
// the reducer's `applyStreamEvent` should reach for them.

export type ClaudeContentBlockStub = {
  type?: string
  id?: string
  name?: string
  text?: string
  thinking?: string
}

export type ClaudeStreamDelta =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'input_json_delta'; partial_json: string }

export type ClaudeStreamEvent =
  | {
      type: 'content_block_start'
      index: number
      content_block?: ClaudeContentBlockStub
    }
  | { type: 'content_block_delta'; index: number; delta?: ClaudeStreamDelta }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_stop' }

export type ClaudePartialEventRaw = {
  type: 'stream_event'
  event?: ClaudeStreamEvent
}

/**
 * Narrow `NormalizedMessage.partial_event.raw` to the Claude `stream_event`
 * SDKMessage shape. Returns false for any other provider's payload — the
 * reducer treats it as a no-op until a normalized partial-block event lands.
 */
export function isClaudeStreamEvent(raw: unknown): raw is ClaudePartialEventRaw {
  return (
    !!raw &&
    typeof raw === 'object' &&
    (raw as { type?: unknown }).type === 'stream_event'
  )
}
