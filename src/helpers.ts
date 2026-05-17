import type { NormalizedToolRef } from './normalized.js'
import type { ParsedChip, ProviderUserContentPolicy } from './types.js'

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

// ─── User-content policy helpers ─────────────────────────────────────────────
//
// Pure-string utilities for applying a {@link ProviderUserContentPolicy} to a
// user message body. Live here so both the chat-core reducer and consumers
// outside the reducer (provider on-disk transcript readers, mobile renderers)
// share one regex set — the only place to update when a new wrapper tag
// joins the catalog.

/**
 * Strip every `<tag>...</tag>` block whose tag name appears in `tags`. Returns
 * the cleaned text with surrounding whitespace and bare `---` separators
 * collapsed. Regex is case-sensitive and non-greedy. Multi-line bodies are
 * supported. When `tags` is empty / undefined, returns the input unchanged.
 *
 * Tag names must be plain identifiers (`environment_context`, `jack-system`).
 * They're escaped before being interpolated into the regex source so a tag
 * containing regex meta-chars stays inert.
 */
export function stripWrapperTags(text: string, tags: readonly string[] | undefined): string {
  if (!text) return ''
  if (!tags || tags.length === 0) return text
  let out = text
  for (const tag of tags) {
    const escaped = escapeRegex(tag)
    const re = new RegExp(`<${escaped}>[\\s\\S]*?<\\/${escaped}>`, 'g')
    out = out.replace(re, '')
  }
  return out.replace(/^\s*---\s*$/gm, '').trim()
}

/**
 * Apply a {@link ProviderUserContentPolicy} to a user message body. Both
 * `hiddenWrapperTags` and `infoWrapperTags` are stripped from the visible
 * text. The structured payloads behind `infoWrapperTags` are surfaced
 * separately by {@link extractInfoChips} — the reducer calls both on
 * each user text block.
 *
 * Returns the text with every declared wrapper removed, trimmed. When the
 * policy is undefined or both arrays are empty/missing, returns input.
 */
export function applyUserContentPolicy(
  text: string,
  policy: ProviderUserContentPolicy | undefined
): string {
  if (!policy) return text
  const tags = [
    ...(policy.hiddenWrapperTags ?? []),
    ...(policy.infoWrapperTags?.map((s) => s.tag) ?? [])
  ]
  return stripWrapperTags(text, tags)
}

/**
 * Extract structured chip payloads from declared `infoWrapperTags`. For
 * each tag occurrence found in `text`, build a {@link ParsedChip} with
 * the declared `fields` sub-matched out of the wrapper body. Multiple
 * occurrences of the same wrapper produce multiple chips.
 *
 * Returns an empty array when the policy has no `infoWrapperTags` or
 * none match.
 *
 * Implementation notes:
 *   - Outer regex: `<tag>([\s\S]*?)<\/tag>` (non-greedy, multi-line)
 *   - Field sub-matches: first occurrence wins, captured text trimmed
 *   - No nesting of identical tags (the non-greedy outer match closes
 *     on the first inner `</tag>`); declare distinct outer tags if you
 *     need it.
 */
export function extractInfoChips(
  text: string,
  policy: ProviderUserContentPolicy | undefined
): readonly ParsedChip[] {
  if (!text) return []
  const specs = policy?.infoWrapperTags
  if (!specs || specs.length === 0) return []
  const out: ParsedChip[] = []
  for (const spec of specs) {
    const escapedTag = escapeRegex(spec.tag)
    const wrapperRe = new RegExp(`<${escapedTag}>([\\s\\S]*?)<\\/${escapedTag}>`, 'g')
    let match: RegExpExecArray | null
    while ((match = wrapperRe.exec(text)) !== null) {
      const inner = match[1] ?? ''
      const fields: Record<string, string> = {}
      if (spec.fields) {
        for (const f of spec.fields) {
          const fieldEsc = escapeRegex(f.from)
          const fieldRe = new RegExp(`<${fieldEsc}>([\\s\\S]*?)<\\/${fieldEsc}>`)
          const fm = inner.match(fieldRe)
          if (fm) fields[f.name] = (fm[1] ?? '').trim()
        }
      }
      out.push({
        tag: spec.tag,
        label: spec.label,
        ...(spec.chipKind ? { chipKind: spec.chipKind } : {}),
        fields,
        raw: inner.trim()
      })
    }
  }
  return out
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
