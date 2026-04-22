import type { ClaudeCommandDef } from './preload-types.js'
import type { ParsedSlashEnvelope } from './types.js'

/**
 * Tool names the reducer aggregates into a single task-list widget instead of
 * rendering as individual tool cards.
 */
export const TASK_TOOLS: ReadonlySet<string> = new Set([
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet'
])

export function isTaskTool(name?: string): boolean {
  return !!name && TASK_TOOLS.has(name)
}

export const SLASH_ENVELOPE_START = '<command-name>'

/**
 * Claude Code logs slash commands into the session JSONL as a user message
 * whose text is an XML-ish envelope. Detect it so we can render a chip
 * instead of a raw bubble.
 */
export function parseSlashEnvelope(text: string): ParsedSlashEnvelope | null {
  if (!text.trimStart().startsWith(SLASH_ENVELOPE_START)) return null
  const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(text)
  if (!name || !name[1]) return null
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)
  const stdout = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(text)
  const commandName = name[1].trim()
  if (!commandName) return null
  return {
    commandName,
    commandArgs: args && args[1] ? args[1].trim() : undefined,
    commandStdout: stdout && stdout[1] ? stdout[1] : undefined
  }
}

const CLI_MARKER_PATTERNS: readonly RegExp[] = [
  /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g,
  /<local-command-stderr>[\s\S]*?<\/local-command-stderr>/g,
  /<command-name>[\s\S]*?<\/command-name>/g,
  /<command-args>[\s\S]*?<\/command-args>/g,
  /<command-message>[\s\S]*?<\/command-message>/g
]

/**
 * True when `text` contains only Claude Code CLI internal markers and no real
 * user-authored content. These messages are noise in the transcript and the
 * reducer drops them.
 */
export function isCliMarkerOnly(text: string): boolean {
  let stripped = text
  for (const pattern of CLI_MARKER_PATTERNS) stripped = stripped.replace(pattern, '')
  return stripped.trim().length === 0
}

/**
 * Substitute `$N` and `$ARGUMENTS` placeholders in a slash command body.
 * `$N` is substituted before `$ARGUMENTS` so literal `$1` tokens inside the
 * raw args survive.
 */
export function expandCommandBody(def: ClaudeCommandDef, rawArgs: string): string {
  const args = rawArgs.trim()
  const positional = args.length > 0 ? args.split(/\s+/) : []
  return def.body
    .replace(/\$(\d+)/g, (_, n: string) => positional[parseInt(n, 10) - 1] ?? '')
    .replace(/\$ARGUMENTS/g, args)
}

export function pickStr(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const v = (input as Record<string, unknown>)[key]
  return typeof v === 'string' ? v : undefined
}
