import type { NormalizedToolRef } from './normalized.js'

/**
 * Tool names the reducer aggregates into a single task-list widget instead of
 * rendering as individual tool cards. These are Jack-specific MCP tools
 * exposed by the `jack` server (e.g. `mcp__jack__TaskCreate`); the entry
 * here is the local tool name the server emits, without the provider-side
 * wire prefix.
 */
export const TASK_TOOLS: ReadonlySet<string> = new Set([
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet'
])

/**
 * @deprecated Prefer {@link isJackTaskTool} — it disambiguates Jack's MCP
 * task tools from any native tool that happens to share a name. Retained
 * for tests and downstream consumers that still pattern-match on raw names.
 */
export function isTaskTool(name?: string): boolean {
  return !!name && TASK_TOOLS.has(name)
}

/**
 * True when a normalized tool reference points at one of the Jack-server
 * MCP task tools (`mcp__jack__TaskCreate` etc.). The reducer aggregates
 * these into the task-list widget instead of rendering individual cards.
 */
export function isJackTaskTool(ref: NormalizedToolRef): boolean {
  return ref.kind === 'mcp' && ref.serverSlug === 'jack' && TASK_TOOLS.has(ref.toolName)
}

export function pickStr(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const v = (input as Record<string, unknown>)[key]
  return typeof v === 'string' ? v : undefined
}
