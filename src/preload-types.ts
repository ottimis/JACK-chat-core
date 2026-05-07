/**
 * Types originally defined in `jack/src/preload/index.ts`, duplicated here so
 * the core package has no dependency on the desktop project. Keep these in
 * sync manually when the Electron preload contract evolves.
 */

import type { ToolShape } from './normalized.js'

export type InlineFileDiff = {
  /** Canonical shape — `fs.write` for whole-file replace, `fs.edit` for
   *  in-place patch. Provider-neutral; same value Claude `Write`/`Edit` and
   *  Codex `apply_patch` collapse to. */
  toolShape: 'fs.write' | 'fs.edit'
  filePath: string
  oldString?: string
  newString?: string
  replaceAll?: boolean
  content?: string
}

export type PermissionRequestData = {
  sessionId: string
  toolName: string
  /** Canonical shape from the active provider's tool catalog. Renderers
   *  should key icons / copy off this and only fall back to `toolName`
   *  when undefined. */
  toolShape?: ToolShape
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
  /** Provider-emitted tool name. `'Edit'` / `'Write'` from Claude,
   *  `'apply_patch'` from Codex, etc. The renderer shouldn't switch on
   *  this — it's display detail. */
  toolName: string
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
