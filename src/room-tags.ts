/**
 * Coordination Rooms vocabulary — the host-authored wrapper tags, exported so
 * the host and the mobile client import one declaration instead of writing
 * three copies of it.
 *
 * 0.10.0 shipped the *mechanism* ({@link HostContentPolicy}, the merge, the
 * attribute parsing) and deliberately left the vocabulary host-side. Three
 * consumers then declared the same tag independently (jack main
 * `src/main/rooms/envelope.ts`, jack renderer and jack-mobile
 * `roomContentPolicy.ts`), which diverges the moment an attribute or a field
 * name changes. This module is the single declaration they collapse onto.
 *
 * **The tags stay host-owned.** `_shared/api/coordination-rooms.md` §3 is
 * where the vocabulary is *defined* — attributes, body layout, escaping rules,
 * and the invariants the composing side must satisfy. This module only mirrors
 * the *parsing* half of §3.4: what a client needs to strip an envelope out of a
 * bubble and read a chip back. Nothing here composes an envelope; that is the
 * host's job and it is not provider-neutral enough to live in this package.
 *
 * @module
 */

import type { HostContentPolicy, InfoWrapperTagSpec } from './types.js'

/**
 * One delivered room message. Written by the host around a peer agent's body,
 * for every provider — which is why it is a host tag and not a provider one.
 *
 * Carries its routing on the opening tag (`room-id`, `room`, `from`,
 * `from-role`, `kind`, `message-id`, `seq`, `wakes-left`); see
 * {@link ROOM_MESSAGE_TAG_SPEC}.
 */
export const ROOM_MESSAGE_TAG = 'jack-room-message'

/**
 * A host statement *about* a room rather than *in* one — the Start kickoff and
 * the mailbox notice. It has no `from` attribute because nobody wrote it.
 *
 * It exists for the mailbox case: that notice is prepended to the *human's*
 * own next prompt, and unwrapped it would render inside their chat bubble as
 * text they never typed.
 */
export const ROOM_NOTICE_TAG = 'jack-room-notice'

/**
 * The fence around the sender's body inside a {@link ROOM_MESSAGE_TAG} block.
 *
 * A `---` separator cannot do this job: bodies are markdown and markdown has
 * horizontal rules. The host neutralises every `<jack-room-` in the body
 * before wrapping, so a body that tries to close the fence early produces
 * visible escaped text instead of a forged envelope.
 */
export const ROOM_BODY_TAG = 'jack-room-body'

/**
 * Declaration for {@link ROOM_MESSAGE_TAG} — contract §3.4, verbatim.
 *
 * `body` is a declared field rather than an attribute because it is a nested
 * element: a message body is multi-line markdown. Everything else is read off
 * `ParsedChip.attributes`, which needs no per-attribute declaration.
 *
 * Two consequences renderers rely on: `fields.body` is the **only** part the
 * sender wrote — the host preamble (attribution, disclaimer, reply
 * instruction, wake budget) stays in `raw` and must not be rendered twice —
 * and N coalesced messages produce N chips on one `type: 'user'` message, in
 * `seq` order.
 */
export const ROOM_MESSAGE_TAG_SPEC: InfoWrapperTagSpec = Object.freeze({
  tag: ROOM_MESSAGE_TAG,
  label: 'Room message',
  chipKind: 'room',
  fields: Object.freeze([Object.freeze({ name: 'body', from: ROOM_BODY_TAG })])
})

/**
 * Declaration for {@link ROOM_NOTICE_TAG}. No `fields`: the whole body is the
 * notice, so the chip exposes it as `raw`.
 */
export const ROOM_NOTICE_TAG_SPEC: InfoWrapperTagSpec = Object.freeze({
  tag: ROOM_NOTICE_TAG,
  label: 'Room',
  chipKind: 'room'
})

/**
 * The host policy a Jack-family client should pass as
 * `ReduceContext.hostContentPolicy` — both room tags, nothing else.
 *
 * Pass it at **every** reduce call site. A call site that forgets it renders
 * the raw envelope, and it will be the one running a provider that declares no
 * `userContent` policy of its own.
 *
 * A host that declares tags beyond the room vocabulary spreads over it rather
 * than replacing it:
 *
 * ```ts
 * const policy: HostContentPolicy = {
 *   infoWrapperTags: [...(DEFAULT_HOST_CONTENT_POLICY.infoWrapperTags ?? []), myTag]
 * }
 * ```
 *
 * Frozen — as are the two specs and the `fields` array — because these are
 * module-level singletons shared by every call site in the process: a consumer
 * that pushed onto the array, or renamed a `label` in place, would change what
 * every other call site parses.
 */
export const DEFAULT_HOST_CONTENT_POLICY: HostContentPolicy = Object.freeze({
  infoWrapperTags: Object.freeze([ROOM_MESSAGE_TAG_SPEC, ROOM_NOTICE_TAG_SPEC])
})
