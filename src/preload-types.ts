/**
 * Types originally defined in `jack/src/preload/index.ts`, duplicated here so
 * the core package has no dependency on the desktop project. Keep these in
 * sync manually when the Electron preload contract evolves.
 */

export type InlineFileDiff = {
  toolName: 'Edit' | 'Write'
  filePath: string
  oldString?: string
  newString?: string
  replaceAll?: boolean
  content?: string
}

export type PermissionRequestData = {
  sessionId: string
  toolName: string
  toolInput: Record<string, unknown>
  title?: string
  description?: string
  displayName?: string
  decisionReason?: string
  suggestions?: unknown[]
  toolUseID?: string
  cwd: string
  inlineFileDiff?: InlineFileDiff
}

export type FileChangeData = {
  toolName: 'Edit' | 'Write'
  toolUseId: string
  filePath: string
  originalFile: string | null
  newContent?: string
  structuredPatch: Array<{
    oldStart: number
    oldLines: number
    newStart: number
    newLines: number
    lines: string[]
  }>
  type?: string
}

export type ContextUsageInfo = {
  total?: number
  totalTokens?: number
  maxTokens?: number
  rawMaxTokens?: number
  percentage?: number
  model?: string
  by_category?: Record<string, number>
  [k: string]: unknown
}

/**
 * Provider-neutral slash-command definition. Different providers source
 * these differently (Claude scans `~/.claude/commands/`; Codex would scan
 * `~/.codex/prompts/`); the shape is the same once parsed. The host
 * loads them via the active provider's slash-commands module and feeds
 * them into the renderer's autocomplete + dispatch.
 */
export type SlashCommandDef = {
  name: string
  scope: 'user' | 'project' | 'builtin'
  description?: string
  argumentHint?: string
  body: string
  filePath: string
}

/** @deprecated Use {@link SlashCommandDef}. Will be removed in 0.6.0. */
export type ClaudeCommandDef = SlashCommandDef
