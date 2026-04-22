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

export type ClaudeCommandDef = {
  name: string
  scope: 'user' | 'project' | 'builtin'
  description?: string
  argumentHint?: string
  body: string
  filePath: string
}
