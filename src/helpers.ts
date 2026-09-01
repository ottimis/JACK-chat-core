import type { NormalizedToolRef } from './normalized.js'
import type {
  HostContentPolicy,
  InfoWrapperTagSpec,
  ParsedChip,
  ProviderUserContentPolicy
} from './types.js'

/**
 * Tool names the reducer aggregates into the task-list widget. Two
 * routing surfaces produce them today:
 *
 *   - The Jack MCP server (`mcp__jack__TaskCreate`, …) — legacy path.
 *   - Provider-native tools whose catalog entry declares `shape: 'task'`
 *     (Claude SDK's built-in `TaskCreate` / `TaskUpdate` / … — the Agent
 *     Teams coordination tools).
 *
 * The names listed here are the *local* tool names without any provider
 * wire prefix. Used by:
 *   - `isTaskCoordinationTool` for the MCP back-compat branch
 *   - the streaming `tool_use` start path in the reducer, which only sees
 *     the wire name (no shape yet) — see `isTaskWireName`
 */
export const TASK_TOOLS: ReadonlySet<string> = new Set([
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'TaskStop',
  'TaskOutput',
  'TaskDelete'
])

/**
 * @deprecated Prefer {@link isTaskCoordinationTool} — it disambiguates Jack's MCP
 * task tools from any native tool that happens to share a name. Retained
 * for tests and downstream consumers that still pattern-match on raw names.
 */
export function isTaskTool(name?: string): boolean {
  return !!name && TASK_TOOLS.has(name)
}

/**
 * True when a normalized tool reference is one the reducer should fold
 * into the aggregated task-list widget instead of rendering as its own
 * tool card.
 *
 * Two routing surfaces match:
 *   - **Native**: provider's tool catalog declares `shape: 'task'`. Used
 *     by Claude's SDK-built-in `TaskCreate` / `TaskUpdate` / … (Agent
 *     Teams coordination tools).
 *   - **MCP**: Jack's in-process MCP server exposes the same coordination
 *     surface for providers without native task-tools (`mcp__jack__TaskCreate`).
 *
 * The check intentionally does NOT pattern-match native tool names — the
 * provider's catalog is the source of truth, so any future provider that
 * declares `shape: 'task'` gets aggregated without touching this file.
 */
export function isTaskCoordinationTool(ref: NormalizedToolRef): boolean {
  if (ref.kind === 'native') return ref.shape === 'task'
  return ref.serverSlug === 'jack' && TASK_TOOLS.has(ref.toolName)
}

/**
 * @deprecated Renamed to {@link isTaskCoordinationTool} when the native
 * `shape: 'task'` branch landed. Kept as an alias so external consumers
 * (Jack-mobile, downstream tests) keep building during the deprecation
 * window.
 */
export function isJackTaskTool(ref: NormalizedToolRef): boolean {
  return isTaskCoordinationTool(ref)
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
 * Regex fragment matching the optional attribute list of an opening tag:
 * either nothing (`<env>`) or whitespace followed by anything up to the
 * closing `>` (`<jack-room-message room="r1" from="alice">`).
 *
 * Deliberately simple — attribute *values* may not contain `>`. Host-authored
 * envelopes carry ids, aliases and kinds, never markup, so this holds; the
 * alternative (a full attribute grammar) buys nothing and backtracks.
 *
 * The leading `\s` is what keeps the match anchored to the whole tag name:
 * `<env…>` never matches `<environment>` because `i` is neither `\s` nor `>`.
 */
const TAG_ATTRS = '(?:\\s[^>]*)?'

/**
 * Strip every `<tag>...</tag>` block whose tag name appears in `tags`, with or
 * without attributes on the opening tag. Returns the cleaned text with
 * surrounding whitespace and bare `---` separators collapsed. Regex is
 * case-sensitive and non-greedy. Multi-line bodies are supported. When `tags`
 * is empty / undefined, returns the input unchanged.
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
    const re = new RegExp(`<${escaped}${TAG_ATTRS}>[\\s\\S]*?<\\/${escaped}>`, 'g')
    out = out.replace(re, '')
  }
  return out.replace(/^\s*---\s*$/gm, '').trim()
}

/**
 * Prefix reserved for wrapper tags authored by the host. Provider packages
 * must not declare tags starting with it; on a collision the host declaration
 * wins (see {@link mergeUserContentPolicies}).
 *
 * Not enforced at runtime: `<jack-system>` predates the split and is still
 * declared through provider policies, so rejecting the prefix there would be
 * a breaking change. Treat it as the naming contract it is.
 */
export const JACK_HOST_TAG_PREFIX = 'jack-'

/**
 * Merge a host-declared {@link HostContentPolicy} with the active provider's
 * {@link ProviderUserContentPolicy} into the single policy the strip / chip
 * passes consume.
 *
 * Rules:
 *   - host declarations come first and **win on tag-name collision** — a
 *     provider entry for a tag the host already claims (in either axis) is
 *     dropped, so a provider cannot redefine `<jack-room-message>`;
 *   - the two axes are merged independently, but the collision check spans
 *     both: a tag the host declares as `info` removes the provider's `hidden`
 *     entry of the same name (and vice versa);
 *   - duplicates inside one list collapse to the first occurrence.
 *
 * Returns the provider policy unchanged (same reference) when the host
 * declares nothing — including `undefined`, which keeps the "no policy at
 * all" fast path intact for providers that ship no `userContent` policy.
 */
export function mergeUserContentPolicies(
  hostPolicy: HostContentPolicy | undefined,
  providerPolicy: ProviderUserContentPolicy | undefined
): ProviderUserContentPolicy | undefined {
  const hostHidden = hostPolicy?.hiddenWrapperTags ?? []
  const hostInfo = hostPolicy?.infoWrapperTags ?? []
  if (hostHidden.length === 0 && hostInfo.length === 0) return providerPolicy

  const claimed = new Set<string>()
  const hidden: string[] = []
  for (const tag of hostHidden) {
    if (claimed.has(tag)) continue
    claimed.add(tag)
    hidden.push(tag)
  }
  const info: InfoWrapperTagSpec[] = []
  for (const spec of hostInfo) {
    if (claimed.has(spec.tag)) continue
    claimed.add(spec.tag)
    info.push(spec)
  }
  for (const tag of providerPolicy?.hiddenWrapperTags ?? []) {
    if (claimed.has(tag)) continue
    claimed.add(tag)
    hidden.push(tag)
  }
  for (const spec of providerPolicy?.infoWrapperTags ?? []) {
    if (claimed.has(spec.tag)) continue
    claimed.add(spec.tag)
    info.push(spec)
  }

  const merged: {
    hiddenWrapperTags?: readonly string[]
    infoWrapperTags?: readonly InfoWrapperTagSpec[]
  } = {}
  if (hidden.length > 0) merged.hiddenWrapperTags = hidden
  if (info.length > 0) merged.infoWrapperTags = info
  return merged
}

/**
 * Apply a {@link ProviderUserContentPolicy} to a user message body. Both
 * `hiddenWrapperTags` and `infoWrapperTags` are stripped from the visible
 * text. The structured payloads behind `infoWrapperTags` are surfaced
 * separately by {@link extractInfoChips} — the reducer calls both on
 * each user text block.
 *
 * `hostPolicy` is the optional host-declared overlay (see
 * {@link mergeUserContentPolicies}); omitting it reproduces the pre-0.10
 * behaviour exactly, which is why it is the third parameter and not part of
 * the policy object.
 *
 * Returns the text with every declared wrapper removed, trimmed. When both
 * policies are undefined or declare nothing, returns input.
 */
export function applyUserContentPolicy(
  text: string,
  policy: ProviderUserContentPolicy | undefined,
  hostPolicy?: HostContentPolicy
): string {
  const effective = mergeUserContentPolicies(hostPolicy, policy)
  if (!effective) return text
  const tags = [
    ...(effective.hiddenWrapperTags ?? []),
    ...(effective.infoWrapperTags?.map((s) => s.tag) ?? [])
  ]
  return stripWrapperTags(text, tags)
}

/**
 * Extract structured chip payloads from declared `infoWrapperTags` — the
 * provider's, plus the host's when `hostPolicy` is supplied (host wins on a
 * tag-name collision, see {@link mergeUserContentPolicies}). For each tag
 * occurrence found in `text`, build a {@link ParsedChip} with the opening
 * tag's attributes and the declared `fields` sub-matched out of the wrapper
 * body. Multiple occurrences of the same wrapper produce multiple chips.
 *
 * Returns an empty array when neither policy declares `infoWrapperTags` or
 * none match.
 *
 * Implementation notes:
 *   - Outer regex: `<tag[ attrs]>([\s\S]*?)<\/tag>` (non-greedy, multi-line)
 *   - Attributes on the opening tag land in `chip.attributes` (absent when
 *     the tag carried none) — that is how a host envelope passes routing
 *     data like `room` / `from` / `id` without an inner field per value
 *   - Field sub-matches: first occurrence wins, captured text trimmed
 *   - No nesting of identical tags (the non-greedy outer match closes
 *     on the first inner `</tag>`); declare distinct outer tags if you
 *     need it.
 */
export function extractInfoChips(
  text: string,
  policy: ProviderUserContentPolicy | undefined,
  hostPolicy?: HostContentPolicy
): readonly ParsedChip[] {
  if (!text) return []
  const specs = mergeUserContentPolicies(hostPolicy, policy)?.infoWrapperTags
  if (!specs || specs.length === 0) return []
  const out: ParsedChip[] = []
  for (const spec of specs) {
    const escapedTag = escapeRegex(spec.tag)
    const wrapperRe = new RegExp(
      `<${escapedTag}(${TAG_ATTRS})>([\\s\\S]*?)<\\/${escapedTag}>`,
      'g'
    )
    let match: RegExpExecArray | null
    while ((match = wrapperRe.exec(text)) !== null) {
      const inner = match[2] ?? ''
      const attributes = parseTagAttributes(match[1] ?? '')
      const fields: Record<string, string> = {}
      if (spec.fields) {
        for (const f of spec.fields) {
          const fieldEsc = escapeRegex(f.from)
          const fieldRe = new RegExp(`<${fieldEsc}${TAG_ATTRS}>([\\s\\S]*?)<\\/${fieldEsc}>`)
          const fm = inner.match(fieldRe)
          if (fm) fields[f.name] = (fm[1] ?? '').trim()
        }
      }
      out.push({
        tag: spec.tag,
        label: spec.label,
        ...(spec.chipKind ? { chipKind: spec.chipKind } : {}),
        fields,
        ...(attributes ? { attributes } : {}),
        raw: inner.trim()
      })
    }
  }
  return out
}

/**
 * Parse the raw attribute run of an opening tag (` room="r1" from='alice'`)
 * into a plain record. Values may be double-quoted, single-quoted, or bare;
 * XML entities in them are decoded. Valueless attributes (`<tag flag>`) carry
 * no data for a chip and are ignored.
 *
 * Returns `undefined` when nothing was parsed, so the caller can leave
 * `ParsedChip.attributes` off entirely for the common attribute-less tag.
 */
function parseTagAttributes(raw: string): Record<string, string> | undefined {
  if (!raw.trim()) return undefined
  const attrRe = /([A-Za-z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g
  // A Map + `fromEntries` rather than a mutated object literal: attribute
  // names come from message text, and `out['__proto__'] = …` on a literal
  // would set the prototype instead of an own property.
  const out = new Map<string, string>()
  let m: RegExpExecArray | null
  while ((m = attrRe.exec(raw)) !== null) {
    const name = m[1]!
    // First occurrence wins, mirroring the field sub-match rule.
    if (out.has(name)) continue
    out.set(name, decodeXmlEntities(m[2] ?? m[3] ?? m[4] ?? ''))
  }
  return out.size > 0 ? Object.fromEntries(out) : undefined
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
