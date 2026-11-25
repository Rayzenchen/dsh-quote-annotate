/**
 * Client half of `@local/dsh-quote-annotate`.
 *
 * Codex-style response annotations for DSH, built with no DSH package imports —
 * only `react` / `react-dom` from the platform module table.
 *
 * The whole feature is three moves:
 *
 *  1. A selection inside the chat transcript (a row carrying
 *     `data-chat-flow-key` / `data-chat-turn`) opens a floating "添加到输入框"
 *     button next to it (rendered through a portal, so no composer overflow or
 *     stacking context can clip it).
 *  2. Clicking it mints one reference chip into the composer through the public
 *     input facade (`ctx.sessions.scope(id).get('conversation').input.for(actx)`
 *     → `insertReference(ref, span)`), taking the span from the session kit's
 *     `inputActions.captureInsertion()`. The chip carries the selected text as
 *     its `clipboardText` and a snippet as its label.
 *  3. A card above the composer (`conversation.input.dock`) shows the quote and
 *     a comment box. The comment never touches the draft: the reference SOURCE
 *     registered with `ctx.inputTriggers` owns a codec, and the composer expands
 *     every chip through that codec at submit time. The prompt therefore gets
 *     the structured annotation block while the box keeps only the user's own
 *     words plus one chip per quote.
 *
 * Deleting a chip in the composer drops its card (the occurrence table is the
 * single source of truth); pressing a card's ✕ replaces that chip's span with
 * empty text. Either way the model sees exactly what is still in the box.
 *
 * Written against the installed Harness (0.2.0-rc.2): the composer is a Lexical
 * editor whose `InputState.draft` is the *clipboard* projection, chips are
 * exactly one U+FFFC wide in detect coordinates, and edit verbs take detect
 * spans with the live `draftRev` as their CAS.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-quote-annotate',
  factory(require) {
    const React = require('react')
    const { createPortal } = require('react-dom')
    const h = React.createElement

    /* ---------------------------------------------------------------- *
     * Constants
     * ---------------------------------------------------------------- */

    /** Reference source name: also the identity the submit serializer looks up. */
    const SOURCE = 'dsh-quote'
    /** Trigger bucket of the source. The candidate list is empty on purpose. */
    const TRIGGER = '@'
    /** The seat above the composer card. */
    const SLOT = 'conversation.input.dock'
    /** Keyed surface the chat view dispatches for a text gesture; its `quote` cell holds the shipped action. */
    const QUOTE_ACTION_SLOT = 'conversation.chat.text-interaction'
    /** Cell key the shipped quote plugin (`@deepseek-ai/dsh-message-quotes`) renders its button into. */
    const NATIVE_QUOTE_KEY = 'quote'
    /**
     * Slot priority of the empty replacement.
     *
     * Since DSH 0.2.3 a keyed slot rejects a second entry for the same key at
     * the same priority; sharing a key is only a shadow, and the **lowest**
     * priority renders. The shipped quote plugin registers at the default 0, so
     * -1 takes that cell over (and stays a one-step, visible intent rather than
     * a far-away number that could tie with another shadow later).
     */
    const NATIVE_QUOTE_PRIORITY = -1
    /** After queue (20), i.e. closest to the input card. */
    const DOCK_ORDER = 30
    /** A single selection longer than this is truncated (and said so). */
    const MAX_QUOTE_CHARS = 6000
    /** Characters of the quote that fit on a chip label. */
    const LABEL_CHARS = 18
    /** localStorage key prefix for one session's unsent annotations. */
    const PENDING_KEY = 'dsh-quote-annotate:pending:v1:'
    /** How long an unsent annotation survives an app restart. */
    const PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000
    /** Refuse pathological storage payloads before parsing them. */
    const PENDING_MAX_STORAGE_CHARS = 512 * 1024
    /** Keep restored comments bounded even if localStorage was edited externally. */
    const MAX_COMMENT_CHARS = 20000
    /** How long the restore pass waits for the composer to re-seed its draft. */
    const RESTORE_WAIT_MS = 1200

    /* ---------------------------------------------------------------- *
     * Copy (zh / en, switched on the document language)
     * ---------------------------------------------------------------- */

    const COPY = {
      zh: {
        addToInput: '添加到输入框',
        addTitle: '把选中的对话内容加入输入框',
        cardsAria: '正在编辑的对话批注',
        cardTitle: (n) => `批注 ${n}`,
        foldedChip: (n) => `引用批注 ${n} 条 · 展开`,
        foldedChipOpen: (n) => `引用批注 ${n} 条 · 收起`,
        expandQuote: '展开原文',
        collapseQuote: '收起原文',
        remove: '移除这条批注',
        removeFailed: '没能移除引用：输入框正忙或状态已变，请再点一次。',
        commentPlaceholder: '写下你的批注（回车收起，Shift+回车换行）',
        commentAria: (n) => `第 ${n} 条批注`,
        truncated: '原文过长，仅保留前 6000 字。',
        busy: '正在发送，稍后再添加引用。',
        insertFailed: '没能插入引用：输入框当前不接受引用（可能正在执行命令）。',
        notPersisted: '待发送的批注过多或存储不可用：部分批注在刷新或重启后不会保留。',
        chipPrefix: '引用',
        commandHint: '斜杠命令和批注会分成两条发送：先发命令，再自动发这条批注消息。',
        commandUnsupported: '这条草稿没法自动拆成「命令 + 批注」两条（里面有别的引用或原生引用）：请先单独发送命令，再发送这条批注消息。',
        commandSplitFailed: '自动拆分发送失败，这次没有发送；草稿已留在输入框，请重新按一次回车。',
        commandKeptAfterFailure: '命令没有发送成功；批注消息已放回输入框，请确认后重新发送。',
        commandPartialRestore: '批注没能全部恢复成芯片，消息已留在输入框，请检查后再发送。',
        removeBlockedByQuote: '草稿里那条 DSH 原生引用会影响定位：先删掉它，再移除这条批注。',
      },
      en: {
        addToInput: 'Add to input',
        addTitle: 'Add the selected conversation text to the composer',
        cardsAria: 'Annotations being edited',
        cardTitle: (n) => `Annotation ${n}`,
        foldedChip: (n) => `${n} quoted annotation${n === 1 ? '' : 's'} · expand`,
        foldedChipOpen: (n) => `${n} quoted annotation${n === 1 ? '' : 's'} · collapse`,
        expandQuote: 'Expand quote',
        collapseQuote: 'Collapse quote',
        remove: 'Remove this annotation',
        removeFailed: 'Could not remove the quote: the composer is busy — try again.',
        commentPlaceholder: 'Write your comment (Enter to put away, Shift+Enter for a newline)',
        commentAria: (n) => `Comment for annotation ${n}`,
        truncated: 'Long selection: only the first 6000 characters are kept.',
        busy: 'Still sending — try again in a moment.',
        insertFailed: 'Could not insert the quote: the composer is not accepting references right now.',
        notPersisted: 'Too many unsent annotations (or storage unavailable): some will not survive a reload.',
        chipPrefix: 'Quote',
        commandHint: 'A slash command and annotations go as two messages: the command first, then this annotated message automatically.',
        commandUnsupported: 'This draft cannot be split into "command + annotation" automatically (it holds another reference or a native quote): send the command by itself, then send the annotated message.',
        commandSplitFailed: 'The automatic split failed; nothing was sent and the draft is still in the composer. Press Enter again.',
        commandKeptAfterFailure: 'The command did not go through; the annotated message is back in the composer — check it and send again.',
        commandPartialRestore: 'Not every annotation came back as a chip; the message stays in the composer for review.',
        removeBlockedByQuote: 'A native DSH quote in the draft shifts the coordinates: remove that quote first, then remove this annotation.',
      },
    }

    /** Active copy table, re-read on every render so a language switch is picked up. */
    function copy() {
      const raw = (document.documentElement.getAttribute('lang') || navigator.language || 'en').toLowerCase()
      return raw.startsWith('zh') ? COPY.zh : COPY.en
    }

    /* ---------------------------------------------------------------- *
     * Annotation store
     *
     * Keyed by reference id (globally unique, because the codec is resolved by
     * ref alone). `liveBySession` mirrors the occurrence table the machine
     * publishes, and exists for one reason: ordinal numbering. A chip that the
     * user deleted must not leave a gap in the prompt's numbering.
     * ---------------------------------------------------------------- */

    /** ref → { ref, seq, text, comment, kind, nodeKey, truncated, recovered }. */
    const records = new Map()
    /** sessionId → Set(ref) currently present in that session's draft. */
    const liveBySession = new Map()
    let seq = 0
    let refSeq = 0

    function nextRef() {
      refSeq += 1
      return `q${refSeq}-${Date.now().toString(36)}`
    }

    /** Single-line snippet for chip labels and card headers. */
    function snippet(text, max) {
      const flat = String(text).replace(/\s+/g, ' ').trim()
      return flat.length > max ? `${flat.slice(0, max)}…` : flat
    }

    function chipLabel(text, strings) {
      return `${strings.chipPrefix}｜${snippet(text, LABEL_CHARS)}`
    }

    /**
     * 1-based position of one live annotation inside ITS OWN session's draft
     * (falls back to 1 when unknown). The live set is built from the occurrence
     * table, so its iteration order is document order: numbering follows where
     * the chips sit, not when they were minted (a restored chip keeps an old
     * `seq`), and two split-view sessions never share one counter.
     */
    function ordinalOf(ref) {
      for (const refs of liveBySession.values()) {
        if (!refs.has(ref)) continue
        let index = 0
        for (const live of refs) {
          if (live === ref) return index + 1
          if (records.has(live)) index += 1
        }
      }
      return 1
    }

    /** Continuation prefix of every comment line after the first. */
    const COMMENT_CONTINUATION = '｜'

    /**
     * The comment as block lines. Only the first line follows `我的批注：`; every
     * further line carries a fixed prefix, so a multi-line comment stays inside
     * the block (the fold keeps scanning) and a typed `【对话批注 2】` line can
     * never read as a second, forged annotation header.
     */
    function commentLines(comment) {
      const [first, ...rest] = String(comment).split('\n')
      return [`我的批注：${first}`, ...rest.map((line) => `${COMMENT_CONTINUATION}${line}`)]
    }

    /**
     * The model form of one annotation. This is the whole prompt contract: a
     * submit with any chip calls it once per chip and splices the answer over
     * the chip's clipboard range. It must never throw — a rejected promise
     * blocks the send.
     * @param ref - the occurrence's reference id.
     * @returns the Chinese structured block handed to the model.
     */
    function serializeAnnotation(ref) {
      const record = records.get(ref)
      if (record === undefined) return '\n【对话批注】（原文已丢失，请以我接下来的说明为准。）\n'
      const ordinal = ordinalOf(ref)
      const text = quotedSourceOf(record)
      const comment = record.comment.trim()
      const lines = []
      if (ordinal === 1) lines.push('以下是我从上面的对话中选取的内容与我的批注，请逐条结合原文回应。')
      lines.push(`【对话批注 ${ordinal}】`)
      if (text === '') {
        lines.push('（原文无法恢复，请以我接下来的说明为准。）')
      } else {
        lines.push('选取原文：')
        for (const line of text.split('\n')) lines.push(`> ${line}`)
        if (record.truncated === true) lines.push('（原文过长，以上仅为开头部分。）')
      }
      if (comment !== '') lines.push(...commentLines(comment))
      return `\n${lines.join('\n')}\n`
    }

    /** The text one annotation quotes: the Markdown source when we captured it. */
    function quotedSourceOf(record) {
      const source = typeof record.markdown === 'string' && record.markdown !== '' ? record.markdown : record.text
      return String(source ?? '').trim()
    }

    /**
     * The chip's clipboard/persistence projection.
     *
     * It is deliberately the quoted SOURCE, because that string is what the
     * composer's draft mirror stores and what `setDraft` re-materialises when the
     * user returns to a session: the chip itself does not survive that round trip
     * (the shell rebuilds the editor as plain text), so the text that comes back
     * has to be good enough to recognise AND good enough to read as a fallback.
     */
    function clipboardOf(record) {
      return quotedSourceOf(record)
    }

    /* ---------------------------------------------------------------- *
     * Unsent annotations survive leaving the session (and the app)
     *
     * The shell mirrors a session's draft into its chat store and, on the next
     * mount, re-seeds it through `setDraft` — which rebuilds the editor from
     * plain text, so every chip is destroyed and replaced by its clipboard
     * projection. `restoreDraft` (the only API that rebuilds chips) is private to
     * the failed-send path, so the plugin keeps its own per-session ledger and
     * re-mints the chips itself:
     *
     *  - draft still carries the projections (session switch) → replace each one
     *    with a chip, in place, so the user's own text keeps its shape;
     *  - draft is empty (page reload, app restart, DSH never persisted it) →
     *    append the chips, because the annotation is the only thing left to save.
     * ---------------------------------------------------------------- */

    /** sessionId → Map(ref → record) for annotations that have not been sent. */
    const pendingBySession = new Map()

    /**
     * The persisted form of one record: only what the codec and cards need.
     * `text` is written only when it differs from `markdown`, and the label is
     * re-derived on load, so a long quote costs one copy instead of three.
     */
    function storedFormOf(record) {
      const out = {
        ref: record.ref,
        seq: record.seq,
        markdown: record.markdown,
        markdownSource: record.markdownSource === true,
        comment: record.comment,
        kind: record.kind,
        nodeKey: record.nodeKey,
        truncated: record.truncated === true,
        savedAt: record.savedAt,
      }
      if (record.text !== record.markdown) out.text = record.text
      if (Number.isFinite(record.offset)) out.offset = record.offset
      return out
    }

    /**
     * Write one session's ledger. The payload is kept under the size the reader
     * accepts: when it would not fit, the oldest annotations are left out of
     * STORAGE (they stay in memory for this run) rather than writing a payload
     * that the next load would discard whole.
     * @returns how many annotations could not be persisted (0 when all fit).
     */
    function savePending(sessionId, map) {
      pendingBySession.set(sessionId, map)
      const key = PENDING_KEY + String(sessionId)
      let dropped = 0
      try {
        if (map.size === 0) {
          localStorage.removeItem(key)
          return 0
        }
        const stored = [...map.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)).map(storedFormOf)
        let payload = JSON.stringify(stored)
        while (payload.length > PENDING_MAX_STORAGE_CHARS && stored.length > 1) {
          stored.shift()
          dropped += 1
          payload = JSON.stringify(stored)
        }
        if (payload.length > PENDING_MAX_STORAGE_CHARS) {
          dropped += stored.length
          localStorage.removeItem(key)
        } else {
          localStorage.setItem(key, payload)
        }
      } catch (error) {
        // Private mode / denied storage / quota: the in-memory ledger still
        // covers a session switch, which is the common case.
        console.warn('[dsh-quote-annotate] pending store unavailable', error)
        dropped = map.size
      }
      if (dropped > 0) console.warn(`[dsh-quote-annotate] ${dropped} unsent annotation(s) will not survive a reload`)
      return dropped
    }

    /**
     * Accept only the persisted fields needed by the codec and cards. Storage is
     * user-editable, so this boundary must not let arbitrary values reach string
     * methods such as `serializeAnnotation`.
     */
    function normalizePendingRecord(value, now) {
      if (value === null || typeof value !== 'object' || typeof value.ref !== 'string') return null
      const ref = value.ref.trim()
      if (ref === '' || ref.length > 200) return null
      const savedAt = value.savedAt
      if (savedAt !== undefined && (!Number.isFinite(savedAt) || savedAt > now || now - savedAt > PENDING_TTL_MS)) return null
      const markdown = typeof value.markdown === 'string' ? value.markdown.slice(0, MAX_QUOTE_CHARS) : ''
      // `text` is omitted from storage when it equals `markdown`.
      const text = typeof value.text === 'string' ? value.text.slice(0, MAX_QUOTE_CHARS) : markdown
      if (markdown === '' && text === '') return null
      return Object.assign({}, value, {
        ref,
        seq: Number.isFinite(value.seq) ? value.seq : 0,
        markdown,
        text,
        labelText: typeof value.labelText === 'string' ? value.labelText.slice(0, MAX_QUOTE_CHARS) : text,
        comment: typeof value.comment === 'string' ? value.comment.slice(0, MAX_COMMENT_CHARS) : '',
        offset: Number.isFinite(value.offset) ? value.offset : undefined,
        sessionId: undefined,
        savedAt: typeof savedAt === 'number' ? savedAt : now,
      })
    }

    function loadPending(sessionId) {
      const cached = pendingBySession.get(sessionId)
      if (cached !== undefined) return cached
      const map = new Map()
      try {
        const raw = localStorage.getItem(PENDING_KEY + String(sessionId))
        // The reader tolerates more than the writer produces: payloads written
        // by older builds (three copies of every quote, no size check) are still
        // salvaged instead of being discarded whole.
        if (raw !== null && raw.length <= PENDING_MAX_STORAGE_CHARS * 4) {
          const parsed = JSON.parse(raw)
          const now = Date.now()
          for (const candidate of Array.isArray(parsed) ? parsed : []) {
            const record = normalizePendingRecord(candidate, now)
            if (record === null) continue
            record.sessionId = sessionId
            // New chips must number after restored ones (seq orders appends).
            if (record.seq > seq) seq = record.seq
            map.set(record.ref, record)
            // The codec resolves by ref alone, so a restored chip must find its
            // record even in a freshly loaded page.
            if (!records.has(record.ref)) records.set(record.ref, record)
          }
        }
      } catch (error) {
        console.warn('[dsh-quote-annotate] pending store unreadable', error)
      }
      pendingBySession.set(sessionId, map)
      return map
    }

    function rememberPending(sessionId, record) {
      const map = loadPending(sessionId)
      record.savedAt = Date.now()
      record.sessionId = sessionId
      map.set(record.ref, record)
      return savePending(sessionId, map)
    }

    function forgetPending(sessionId, ref) {
      const map = loadPending(sessionId)
      if (!map.delete(ref)) return
      savePending(sessionId, map)
    }

    /**
     * Clear one session's ledger (the batch was sent, or the box was emptied).
     *
     * The codec records are KEPT: an empty composer also happens while a send is
     * in flight, after select-all + delete, and right before a failed send's
     * `restoreDraft` brings the very same chips back — deleting the records
     * would make those chips serialize as "原文已丢失". Records are evicted by
     * {@link pruneRecords} instead, once nothing can reference them.
     */
    function forgetAllPending(sessionId) {
      const map = loadPending(sessionId)
      if (map.size === 0) return
      map.clear()
      savePending(sessionId, map)
      pruneRecords()
    }

    /** Upper bound on codec records kept around for undo / failed-send restores. */
    const MAX_RECORDS = 200

    /**
     * Bound the codec index. A record that is live in some draft or still in a
     * ledger is never evicted; beyond that only the newest {@link MAX_RECORDS}
     * survive, which comfortably covers undo and failed-send restores.
     */
    function pruneRecords() {
      if (records.size <= MAX_RECORDS) return
      const pinned = new Set()
      for (const refs of liveBySession.values()) for (const ref of refs) pinned.add(ref)
      for (const map of pendingBySession.values()) for (const ref of map.keys()) pinned.add(ref)
      const evictable = [...records.values()]
        .filter((record) => !pinned.has(record.ref))
        .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
      for (const record of evictable) {
        if (records.size <= MAX_RECORDS) break
        records.delete(record.ref)
      }
    }

    /** The plugin's own chips in one published input state, in document order. */
    function ownOccurrences(state) {
      const out = []
      for (const occurrence of state?.occurrences ?? []) {
        if (occurrence.source === SOURCE) out.push(occurrence)
      }
      return out
    }

    /* ---------------------------------------------------------------- *
     * Selection capture
     * ---------------------------------------------------------------- */

    function elementOf(node) {
      if (node === null || node === undefined) return null
      return node.nodeType === 1 ? node : (node.parentElement ?? null)
    }

    /** The selection's first on-screen rect (null when it has no box). */
    function firstRect(range) {
      const rects = range.getClientRects()
      for (const rect of rects) {
        if (rect.width > 0 || rect.height > 0) return rect
      }
      const box = range.getBoundingClientRect()
      return box.width > 0 || box.height > 0 ? box : null
    }

    /**
     * The transcript row a node belongs to, or null when the node is not part of
     * this conversation pane's transcript.
     *
     * The installed shell renders the chat list in `ui-chat`: every message row
     * carries `data-chat-flow-key` / `data-chat-turn`, and `data-chat-flow` sits
     * on the turn-process group container. The composer lives in the same scroll
     * body, so the composer seat is excluded explicitly.
     */
    function transcriptRowOf(el, pane) {
      if (el === null) return null
      const row = el.closest('[data-chat-flow-key], [data-chat-turn], [data-chat-flow]')
      if (row === null || !pane.contains(row)) return null
      if (row.closest('[data-composer-seat]') !== null) return null
      return row
    }

    /**
     * Read the current browser selection as an annotation candidate.
     *
     * Only a selection that lives inside this session's transcript qualifies:
     * the sidebar, the composer (Lexical contenteditable), our own cards and
     * every form control are excluded by construction.
     * @param rootEl - this entry's own DOM node, used to find the session pane.
     * @param sessionId - the session this entry belongs to.
     * @param markdownOf - optional Markdown projection of a range (the
     * `markdownSource` service); null when that plugin is absent.
     * @returns snapshot { text, markdown, truncated, rect, kind, nodeKey } or null.
     */
    function readSelection(rootEl, sessionId, markdownOf) {
      if (rootEl === null || rootEl === undefined) return null
      const pane = rootEl.closest('[data-conversation-session]')
      if (pane === null) return null
      const paneSession = pane.getAttribute('data-conversation-session')
      if (sessionId !== undefined && paneSession !== null && paneSession !== sessionId) return null
      const selection = document.getSelection()
      if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return null
      const range = selection.getRangeAt(0)
      const startEl = elementOf(range.startContainer)
      const endEl = elementOf(range.endContainer)
      if (startEl === null || endEl === null) return null
      if (transcriptRowOf(startEl, pane) === null || transcriptRowOf(endEl, pane) === null) return null
      const raw = selection.toString().replace(/\u00a0/g, ' ').trim()
      if (raw === '') return null
      const rect = firstRect(range)
      if (rect === null) return null
      // Prefer the Markdown source: a formula, a table or a code block survives
      // it, while the rendered text does not.
      let markdown = ''
      try {
        // The service belongs to another plugin: anything but a string is
        // treated as "no projection" rather than crashing every later selection.
        const projected = markdownOf === undefined ? '' : markdownOf(range)
        markdown = typeof projected === 'string' ? projected : ''
      } catch (error) {
        console.warn('[dsh-quote-annotate] markdown projection failed', error)
        markdown = ''
      }
      const source = markdown.trim() === '' ? raw : markdown.trim()
      const kindEl = startEl.closest('[data-chat-flow-kind]')
      const keyEl = startEl.closest('[data-chat-node-key]') ?? startEl.closest('[data-chat-flow-key]')
      return {
        text: raw.length > MAX_QUOTE_CHARS ? raw.slice(0, MAX_QUOTE_CHARS) : raw,
        markdown: source.length > MAX_QUOTE_CHARS ? source.slice(0, MAX_QUOTE_CHARS) : source,
        markdownSource: markdown.trim() !== '',
        truncated: raw.length > MAX_QUOTE_CHARS || source.length > MAX_QUOTE_CHARS,
        rect: { top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width },
        kind: kindEl === null ? '' : (kindEl.getAttribute('data-chat-flow-kind') ?? ''),
        nodeKey: keyEl === null
          ? ''
          : (keyEl.getAttribute('data-chat-node-key') ?? keyEl.getAttribute('data-chat-flow-key') ?? ''),
      }
    }

    /* ---------------------------------------------------------------- *
     * Composer writes
     * ---------------------------------------------------------------- */

    /**
     * Detect-coordinate span of one live chip.
     *
     * The composer publishes occurrences in *clipboard* coordinates (the draft
     * itself is the clipboard projection), while every edit verb takes *detect*
     * coordinates. Chips are exactly 1 character wide in detect coordinates
     * (one U+FFFC each), so the offset shift is the sum of the preceding chips'
     * clipboard lengths minus one apiece. A claimed command chip is a chip too,
     * but it lives outside the occurrence table; {@link commandChipShift}
     * supplies its share.
     * @param occurrences - the published occurrence table, in document order.
     * @param ref - the reference id to locate.
     * @param leadingShift - the command chip's clipboard-minus-detect surplus.
     * @returns { start, end } in detect coordinates, or null when absent.
     */
    function detectSpanOf(occurrences, ref, leadingShift = 0) {
      let shift = leadingShift
      for (const occurrence of occurrences) {
        if (occurrence.ref === ref) {
          const start = occurrence.offset - shift
          return { start, end: start + 1 }
        }
        const clipboardLength = typeof occurrence.length === 'number'
          ? occurrence.length
          : String(occurrence.clipboardText ?? '').length
        shift += clipboardLength - 1
      }
      return null
    }

    /**
     * Detect-coordinate surplus of the leading command chip.
     *
     * A claimed command is an atomic chip as well: it occupies one U+FFFC in
     * detect coordinates and its token (without the argument separator) in the
     * clipboard projection. `InputState` has no occurrence entry for it, so its
     * clip-minus-detect width has to be discounted explicitly — otherwise every
     * span computed while a command is claimed lands a few characters too far
     * right, and an edit would hit the user's own text instead of the chip.
     * @param state - the published composer state.
     * @returns the shift (0 when no command chip leads the draft).
     */
    function commandChipShift(state) {
      const token = state?.claim?.token
      if (typeof token !== 'string') return 0
      return Math.max(0, token.trimEnd().length - 1)
    }

    /**
     * Turn one captured selection into an annotation: record it, then insert the
     * reference chip at the composer's caret (or at the draft end when it has no
     * selection).
     * @param ctx - the plugin's root Client context.
     * @param facade - the session's composer facade (`SessionInput`), or undefined.
     * @param sessionId - the session whose composer receives the chip.
     * @param snap - the selection snapshot from {@link readSelection}.
     * @param strings - active copy table.
     */
    function addAnnotation(ctx, facade, sessionId, snap, strings) {
      const input = facade
      if (input === undefined) {
        console.warn('[dsh-quote-annotate] no input facade for session', sessionId)
        return undefined
      }
      const state = input.state.getSnapshot()
      if (state.phase === 'submitting' || state.phase === 'adjudicating') {
        input.notify('error', strings.busy)
        return undefined
      }
      // The caret span carries the live revision, so the chip lands where the
      // user was typing; without the capture the chip goes to the draft's end.
      const actions = input.actions
      const span = typeof actions?.captureInsertion === 'function'
        ? actions.captureInsertion()
        : { start: (state.draft ?? '').length, end: (state.draft ?? '').length, draftRev: state.draftRev }
      const ref = nextRef()
      seq += 1
      const record = {
        ref,
        seq,
        text: snap.text,
        labelText: snap.text,
        markdown: snap.markdown ?? snap.text,
        markdownSource: snap.markdownSource === true,
        comment: '',
        kind: snap.kind,
        nodeKey: snap.nodeKey,
        truncated: snap.truncated,
        recovered: false,
        sessionId,
        savedAt: Date.now(),
      }
      records.set(ref, record)
      let applied = false
      try {
        applied = input.insertReference(referenceOf(record, strings), span) === true
      } catch (error) {
        console.warn('[dsh-quote-annotate] insertReference threw', error)
      }
      if (!applied) {
        records.delete(ref)
        input.notify('error', strings.insertFailed)
        return undefined
      }
      if (rememberPending(sessionId, record) > 0) input.notify('error', strings.notPersisted)
      pruneRecords()
      return ref
    }

    /** The ReferenceInsert one record turns into. */
    function referenceOf(record, strings) {
      const text = clipboardOf(record)
      // The label summarises the SOURCE: a quoted formula reads `引用｜$E = mc^2$`
      // rather than the rendered glyphs, which is what the user sees on the chip.
      return {
        source: SOURCE,
        ref: record.ref,
        label: chipLabel(text !== '' ? text : (record.labelText ?? record.text ?? ''), strings),
        clipboardText: text,
      }
    }

    /**
     * Re-mint the chips of one session's unsent annotations.
     * @param facade - the session's composer facade.
     * @param sessionId - whose ledger to restore.
     * @param pending - the ledger (a Map keyed by ref).
     * @param mode - `in-place` replaces each projection where it sits in the
     * restored draft; `append` puts the chips at the end (nothing left to anchor
     * to: the app was restarted and DSH kept no draft).
     * @param strings - active copy table.
     * @returns how many chips came back.
     */
    /**
     * Where one projection sits in a re-seeded draft. Prefers the match closest
     * to the offset the chip last occupied, so a quote of `是的` re-anchors on
     * the quoted copy rather than on the user's own `是的` earlier in the text.
     * @returns the start offset (>= cursor), or -1 when the text is absent.
     */
    function projectionAt(draft, text, cursor, hint) {
      let at = draft.indexOf(text, cursor)
      if (at < 0 || !Number.isFinite(hint)) return at
      let best = at
      while (at >= 0) {
        if (Math.abs(at - hint) < Math.abs(best - hint)) best = at
        if (at > hint) break
        at = draft.indexOf(text, at + 1)
      }
      return best
    }

    function restoreChips(facade, sessionId, pending, mode, strings) {
      if (facade === undefined) return 0
      const ordered = [...pending.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
      if (ordered.length === 0) return 0
      const busy = (state) => state.phase === 'submitting' || state.phase === 'adjudicating'
      let restored = 0
      let leftovers = ordered
      if (mode === 'in-place') {
        const draft = String(facade.state.getSnapshot().draft ?? '')
        const spans = []
        leftovers = []
        let cursor = 0
        for (const record of ordered) {
          const text = clipboardOf(record)
          if (text === '') continue
          const at = projectionAt(draft, text, cursor, record.offset)
          if (at < 0) {
            // Never drop an annotation silently: what cannot be anchored is
            // appended once the anchored ones are back.
            leftovers.push(record)
            continue
          }
          spans.push({ record, start: at, end: at + text.length })
          cursor = at + text.length
        }
        // Backwards: inserting at a later offset leaves the earlier ones valid.
        for (let index = spans.length - 1; index >= 0; index -= 1) {
          const state = facade.state.getSnapshot()
          if (busy(state)) return restored
          const span = spans[index]
          if (facade.insertReference(referenceOf(span.record, strings), {
            start: span.start,
            end: span.end,
            draftRev: state.draftRev,
          }) === true) restored += 1
        }
      }
      for (const record of leftovers) {
        const state = facade.state.getSnapshot()
        if (busy(state)) break
        const at = String(state.draft ?? '').length
        if (facade.insertReference(referenceOf(record, strings), {
          start: at,
          end: at,
          draftRev: state.draftRev,
        }) === true) restored += 1
      }
      return restored
    }

    /**
     * Remove one annotation by replacing its chip with nothing. The span comes
     * from the occurrence table, so this is the same edit the composer would do
     * for a backspace over the chip — and it leaves every other chip intact.
     * @param facade - the session's composer facade (`SessionInput`).
     * @param occurrences - the live occurrence table.
     * @param draftRev - the current draft revision (span CAS).
     * @param ref - the annotation to drop.
     * @param leadingShift - the claimed command chip's surplus (see commandChipShift).
     * @param seat - the composer seat, for the native-quote refusal.
     * @returns whether the edit applied, or 'quote' when a native quote makes the
     *   span unsafe (the caller keeps the card and explains instead of editing).
     */
    function removeAnnotation(facade, occurrences, draftRev, ref, leadingShift = 0, seat = null) {
      // A native quote's clipboard expansion is not published, so the span
      // computed across one would delete the wrong characters: refuse.
      if (hasComposerQuote(seat)) return 'quote'
      const span = detectSpanOf(occurrences, ref, leadingShift)
      const actions = facade?.actions
      if (span === null || typeof actions?.insertText !== 'function') return false
      const applied = actions.insertText('', { start: span.start, end: span.end, draftRev }) === true
      if (!applied) console.warn('[dsh-quote-annotate] chip removal was refused (stale revision or busy composer)')
      return applied
    }

    /* ---------------------------------------------------------------- *
     * Slash commands receive plain text, never codec output
     *
     * A command submit builds its arguments from the draft's CLIPBOARD
     * projection (`SubmitMachine.argsAfter`) and never calls a reference codec;
     * only the plain-message sink serializes chips. A chip in a command's line
     * therefore degrades to its clipboard text — the quoted source arrives and
     * the comment is lost. There is no public way to hand a command its
     * arguments directly, and smuggling the block in through the draft needs a
     * visible expand-then-send step. So one Enter on such a line is split into
     * two sends automatically: the command goes out alone (empty arguments), and
     * once it settled, the annotated message is rebuilt in the composer and sent
     * through the ordinary sink, whose codec serializes the chips.
     * ---------------------------------------------------------------- */

    /**
     * The composer seat that owns one of the plugin's own DOM nodes.
     * @param rootEl - the entry's anchor element.
     * @returns the seat element, or null when the entry is not mounted.
     */
    function composerSeatOf(rootEl) {
      if (rootEl === null || rootEl === undefined || typeof rootEl.closest !== 'function') return null
      try {
        return rootEl.closest('[data-composer-seat]')
      } catch {
        return null
      }
    }

    /**
     * Whether the composer holds a DSH-native quote chip (the `引用` message
     * action inserts one).
     *
     * A quote is atomic as well: one U+FFFC in detect coordinates, its Markdown
     * blockquote in the clipboard projection. Unlike a command chip, `InputState`
     * publishes neither its text nor its length, so that surplus cannot be
     * discounted and any span computed across a quote would land on the wrong
     * characters. When one is mounted, the ✕ removal refuses instead of editing
     * someone else's text.
     * @param seat - the composer seat element.
     * @returns whether a quote chip is mounted.
     */
    function hasComposerQuote(seat) {
      if (seat === null || seat === undefined || typeof seat.querySelector !== 'function') return false
      try {
        return seat.querySelector('[data-composer-quote]') !== null
      } catch {
        return false
      }
    }

    /**
     * Whether this composer state submits through the slash-command plane.
     * `claimed` means a command chip owns the leading seat already; a leading
     * `/` means the line is adjudicated as a command on Enter (which freezes the
     * draft before the editor can be touched again).
     * @param state - the published composer state.
     * @returns whether the submit becomes command arguments instead of a prompt.
     */
    function isCommandDraft(state) {
      if (state === undefined || state === null) return false
      // A frozen plane already decided: the machine owns the frozen attempt, and
      // the editor refuses every edit anyway (that submit is a no-op).
      if (state.phase === 'adjudicating' || state.phase === 'submitting' || state.phase === 'sending') return false
      if (state.phase === 'claimed') return true
      return /^\s*\//u.test(String(state.draft ?? ''))
    }

    /** Facades already carrying the submit guard in this module generation. */
    const guardedFacades = new WeakSet()

    /** Facades with one automatic two-step send in flight. */
    const splittingFacades = new WeakSet()

    /**
     * The message part of a command draft, i.e. what the command's argument
     * separator leaves behind (`SubmitMachine.argsAfter`).
     * @param draft - the draft's clipboard projection.
     * @param token - the claimed command's token.
     * @returns the message text ('' when the draft holds only the command).
     */
    function tokenRest(draft, token) {
      const base = String(token ?? '').trimEnd()
      const text = String(draft ?? '').trimStart()
      if (base === '' || !text.startsWith(base)) return ''
      const rest = text.slice(base.length)
      return /^\s/u.test(rest) ? rest.slice(1) : rest
    }

    /**
     * Detect-coordinate width of a draft: chips (including the command chip) are
     * one character wide there, their clipboard projections are not.
     * @param state - the published composer state.
     * @returns the width in detect coordinates.
     */
    function detectLengthOf(state) {
      const projection = String(state?.draft ?? '')
      let surplus = 0
      if (typeof state?.claim?.token === 'string') {
        surplus += Math.max(0, state.claim.token.trimEnd().length - 1)
      }
      for (const occurrence of state?.occurrences ?? []) {
        surplus += (typeof occurrence.length === 'number'
          ? occurrence.length
          : String(occurrence.clipboardText ?? '').length) - 1
      }
      return Math.max(0, projection.length - surplus)
    }

    /**
     * The recipe for one automatic two-step send, or null when the draft cannot
     * be split safely.
     *
     * Only a claimed command is handled (its chip is at the start, and the
     * command stays the same after the strip). The message must hold only this
     * plugin's chips: another source's chip cannot be rebuilt (its payload is
     * not public), and a native quote's projection is not published at all.
     * @param state - the published composer state.
     * @returns { projection, token, rest, chips, pending, detectLength } or null.
     */
    function splitPlanOf(state) {
      const projection = String(state?.draft ?? '')
      const token = typeof state?.claim?.token === 'string' ? state.claim.token : null
      if (token === null || !projection.startsWith(token)) return null
      const rest = tokenRest(projection, token)
      if (rest.trim() === '') return null
      // Attachments ride with the send and cannot be rebuilt after the command.
      if (Array.isArray(state?.attachmentIds) && state.attachmentIds.length > 0) return null
      const occurrences = state?.occurrences ?? []
      if (occurrences.some((occurrence) => occurrence.source !== SOURCE)) return null
      const prefix = projection.length - rest.length
      const chips = occurrences
        .map((occurrence) => ({
          ref: occurrence.ref,
          offset: occurrence.offset - prefix,
          length: typeof occurrence.length === 'number'
            ? occurrence.length
            : String(occurrence.clipboardText ?? '').length,
        }))
        .sort((left, right) => left.offset - right.offset)
      if (chips.length === 0 || chips.some((chip) => chip.offset < 0)) return null
      const pending = new Map()
      for (let index = 0; index < chips.length; index += 1) {
        const record = records.get(chips[index].ref)
        if (record === undefined) return null
        // Positional sequence: the in-place restore matches in draft order.
        pending.set(chips[index].ref, { ...record, offset: chips[index].offset, seq: index + 1 })
      }
      return { projection, token, rest, chips, pending, detectLength: detectLengthOf(state) }
    }

    /**
     * Run a callback once the submit plane leaves its frozen phases.
     * @param facade - the session's composer facade.
     * @param callback - runs on the first settled snapshot (or the timeout).
     */
    function whenSettled(facade, callback) {
      const frozen = (phase) => phase === 'submitting' || phase === 'sending' || phase === 'adjudicating'
      const phaseOf = () => {
        try {
          return facade?.state?.getSnapshot?.()?.phase
        } catch (_error) {
          return undefined
        }
      }
      let finished = false
      const done = () => {
        if (finished) return
        finished = true
        if (timer !== undefined) clearTimeout(timer)
        try { off?.() } catch { /* store gone */ }
        callback()
      }
      if (!frozen(phaseOf())) {
        done()
        return
      }
      let off
      let timer = setTimeout(done, 30000)
      timer?.unref?.()
      try {
        if (typeof facade?.state?.subscribe === 'function') {
          off = facade.state.subscribe(() => { if (!frozen(phaseOf())) done() })
          return
        }
      } catch {
        // Poll below instead.
      }
      const poll = () => {
        if (finished) return
        if (!frozen(phaseOf())) { done(); return }
        timer = setTimeout(poll, 150)
        timer?.unref?.()
      }
      timer = setTimeout(poll, 150)
      timer?.unref?.()
    }

    /**
     * Put the annotated message back after the command ran, then send it as the
     * ordinary message the codec was made for. Never sends a lossy message: when
     * the text or one chip cannot be rebuilt, the draft is kept for review.
     * @param facade - the session's composer facade.
     * @param sessionId - whose annotations are rebuilt.
     * @param plan - the captured split recipe.
     * @param strings - active copy table.
     * @param submit - the original `submit`, for the second send.
     * @param args - the original call's arguments (mode/source).
     */
    function finishSplit(facade, sessionId, plan, strings, submit, args, attempt = 0) {
      const notify = (text) => {
        if (typeof facade?.notify === 'function') facade.notify('error', text)
      }
      const retry = () => {
        if (attempt >= 3) {
          notify(strings.commandSplitFailed)
          return
        }
        queueMicrotask(() => finishSplit(facade, sessionId, plan, strings, submit, args, attempt + 1))
      }
      const state = facade?.state?.getSnapshot?.()
      if (state === undefined || state === null) return
      if (state.phase !== 'plain') {
        // The plane is busy again (or never settled): wait for the next settle.
        if (attempt >= 3) {
          notify(strings.commandSplitFailed)
          return
        }
        whenSettled(facade, () => {
          queueMicrotask(() => finishSplit(facade, sessionId, plan, strings, submit, args, attempt + 1))
        })
        return
      }
      const cleared = String(state.draft ?? '').trim() === ''
      const actions = facade.actions
      if (typeof actions?.insertText !== 'function') {
        notify(strings.commandSplitFailed)
        return
      }
      const applied = actions.insertText(plan.rest, {
        start: 0,
        end: detectLengthOf(state),
        draftRev: state.draftRev,
      }) === true
      if (!applied) {
        // A busy editor can refuse one edit; give it a moment before giving up.
        retry()
        return
      }
      let restored = 0
      try {
        restored = restoreChips(facade, sessionId, plan.pending, 'in-place', strings)
      } catch (error) {
        console.warn('[dsh-quote-annotate] rebuilding the annotation chips failed', error)
        restored = 0
      }
      if (restored < plan.pending.size) {
        notify(strings.commandPartialRestore)
        return
      }
      if (!cleared) {
        // The command kept its draft (refused or failed): keep the message and
        // let the user decide, instead of sending it without the command.
        notify(strings.commandKeptAfterFailure)
        return
      }
      try {
        submit.apply(facade, args)
      } catch (error) {
        console.warn('[dsh-quote-annotate] sending the rebuilt message failed', error)
        notify(strings.commandSplitFailed)
      }
    }

    /**
     * Guard one session's `submit` so a slash command and its annotations go out
     * as two messages instead of one lossy one.
     *
     * A command's arguments come from the draft's clipboard projection, where a
     * chip degrades to its clipboard text (the quoted source): the comment lives
     * only in this plugin's ledger and the command plane never serializes it.
     * So when a command line still holds live annotations, this wrapper sends
     * the command alone (empty arguments) once, waits for the plane to settle,
     * rebuilds the annotated message in the composer, and sends it through the
     * ordinary path (where the codec runs). Splits that cannot be rebuilt safely
     * are refused with one instruction instead.
     * @param facade - the session's composer facade, or undefined before it exists.
     * @param sessionId - the session whose annotations are re-sent.
     * @param seatOf - resolves the composer seat (the native-quote check).
     */
    function installCommandGuard(facade, sessionId, seatOf) {
      if (facade === undefined || facade === null || guardedFacades.has(facade)) return
      const submit = facade.submit
      if (typeof submit !== 'function') return
      guardedFacades.add(facade)
      facade.submit = function guardedSubmit(...args) {
        const strings = copy()
        let state
        try {
          state = this.state?.getSnapshot?.()
        } catch (_error) {
          state = undefined
        }
        if (state === undefined || !isCommandDraft(state) || ownOccurrences(state).length === 0) {
          return submit.apply(this, args)
        }
        const seat = typeof seatOf === 'function' ? seatOf() : null
        const plan = hasComposerQuote(seat) ? null : splitPlanOf(state)
        // A second Enter while the first split is in flight is simply ignored.
        if (splittingFacades.has(this)) return undefined
        if (plan === null) {
          if (typeof this.notify === 'function') this.notify('error', strings.commandUnsupported)
          return undefined
        }
        splittingFacades.add(this)
        // Leave the editor's own update first: an edit made inside it stays
        // pending, and the strip must be observable before the submit freezes
        // the draft (DSH 0.2.3).
        queueMicrotask(() => {
          let now
          try {
            now = this.state?.getSnapshot?.()
          } catch (_error) {
            now = undefined
          }
          if (now === undefined || String(now.draft ?? '') !== plan.projection || !isCommandDraft(now)) {
            splittingFacades.delete(this)
            if (typeof this.notify === 'function') this.notify('error', strings.commandSplitFailed)
            return
          }
          const actions = this.actions
          const stripped = typeof actions?.insertText === 'function'
            && actions.insertText('', {
              start: 1,
              end: plan.detectLength,
              draftRev: now.draftRev,
            }) === true
          if (!stripped) {
            splittingFacades.delete(this)
            if (typeof this.notify === 'function') this.notify('error', strings.commandSplitFailed)
            return
          }
          try {
            submit.apply(this, args)
          } catch (error) {
            splittingFacades.delete(this)
            console.warn('[dsh-quote-annotate] command submit failed', error)
            finishSplit(this, sessionId, plan, strings, submit, args)
            return
          }
          whenSettled(this, () => {
            // Leave the publish that announced the settle before editing again.
            queueMicrotask(() => {
              splittingFacades.delete(this)
              finishSplit(this, sessionId, plan, strings, submit, args)
            })
          })
        })
        return undefined
      }
    }

    /**
     * Whether a comment-box key press files the comment away (collapsing the
     * card). Enter collapses; Shift+Enter keeps the newline — the composer's own
     * shortcut — and an IME composition Enter is never a submit.
     */
    function isCommentSubmitKey(event) {
      if (event === null || event === undefined) return false
      if (event.key !== 'Enter') return false
      if (event.shiftKey === true) return false
      if (event.isComposing === true) return false
      // WebKit delivers the composition-confirming Enter with isComposing=false
      // but keyCode 229 — that one must not put the card away either.
      if (event.keyCode === 229) return false
      return true
    }

    /* ---------------------------------------------------------------- *
     * Folding the sent user message
     *
     * The prompt really does carry every annotation — the model needs it. What
     * the user should not have to read again is that same text rendered back at
     * them in their own bubble. So the rendered bubble is post-processed: the
     * annotation span is lifted out of the text and replaced by one summary
     * chip that expands on click.
     *
     * React safety: React owns the text nodes, so nothing is ever MOVED into a
     * foreign parent (that would break React's removeChild bookkeeping). The
     * block's characters are cleared in place, and only newly created nodes
     * (from splitText + our own elements) are inserted.
     * ---------------------------------------------------------------- */

    /** First line of a serialized block; also the fold's sentinel. */
    const FOLD_PREAMBLE = '以下是我从上面的对话中选取的内容'
    /** Block header sentinel searched before parsing, e.g. `【对话批注 2】`. */
    const FOLD_HEADER_PREFIX = '【对话批注 '
    /** `<response>`-style block header, e.g. `【对话批注 2】`. */
    const FOLD_HEADER_RE = /^【对话批注 \d+】$/u
    /** Header at a line start; a reference chip may follow it on the same line. */
    const FOLD_HEADER_START_RE = /^【对话批注 \d+】/u

    /**
     * The character range one or more adjacent annotation blocks occupy inside a
     * rendered message, or null when the text holds none.
     *
     * The grammar is the serializer's own output, so this parses rather than
     * guesses: quoted lines always carry the `> ` prefix, which is exactly why a
     * user's own text can never be mistaken for a quote line.
     * @param full - the message's concatenated rendered text.
     * @returns { start, end, count } in that text's coordinates.
     */
    function annotationRange(full) {
      const text = String(full ?? '')
      const starts = [0]
      for (let i = 0; i < text.length; i += 1) {
        if (text.charAt(i) === '\n') starts.push(i + 1)
      }
      const lineAt = (index) => {
        const from = starts[index]
        const next = starts[index + 1]
        return text.slice(from, next === undefined ? text.length : next - 1)
      }
      const isPreamble = (line) => line.startsWith(FOLD_PREAMBLE)
      const hasQuoteLine = (from, to, read) => {
        for (let i = from; i <= to; i += 1) {
          const line = read(i)
          if (line.startsWith('> ') || line.trim() === '>') return true
        }
        return false
      }
      const isHeader = (line) => FOLD_HEADER_RE.test(line.trim())
      // A reference chip can land at the end of a header or quote line, because
      // projectUserText splits the message around `@`-tokens: the header then reads
      // `【对话批注 1】@README.md`. Matching a prefix keeps the block detectable.
      // The match is anchored and numeric: `【对话批注 说明】…` typed by the user is
      // not a header.
      const startsHeader = (line) => FOLD_HEADER_START_RE.test(line.trim())
      const isCommentLine = (line) => {
        const trimmed = line.trim()
        return trimmed.startsWith('我的批注：') || trimmed.startsWith('我的意见：')
      }
      const belongs = (line) => {
        const trimmed = line.trim()
        if (isPreamble(line) || startsHeader(line)) return true
        if (trimmed === '选取原文：') return true
        if (line.startsWith('> ')) return true
        // A reference chip inside the quote renders as a chip element, so the
        // line's text is `… @filename …` rather than a `> ` prefix. The blank
        // line that follows the block is what actually ends it, which is why the
        // scan below also stops on two consecutive blank lines.
        if (trimmed.startsWith('>') || trimmed === '>') return true
        // Two generations of the label: annotations already in a transcript were
        // serialized as `我的意见：`, newer ones as `我的批注：`.
        if (isCommentLine(line)) return true
        if (trimmed.startsWith('（原文过长') || trimmed.startsWith('（原文无法恢复')) return true
        return false
      }
      // A block is only folded when it is well formed: a numbered header plus
      // the quote itself (or the serializer's "cannot recover" note). A line that
      // merely looks like a header is the user's own text and stays visible.
      const wellFormed = (from, to) => {
        if (hasQuoteLine(from, to, lineAt)) return true
        for (let i = from; i <= to; i += 1) {
          if (lineAt(i).trim().startsWith('（原文无法恢复')) return true
        }
        return false
      }
      // Every candidate start is tried in turn: a malformed look-alike earlier in
      // the message must not hide a real block that follows it.
      for (let i = 0; i < starts.length; i += 1) {
        const line = lineAt(i)
        if (!isPreamble(line) && !startsHeader(line)) continue
        const found = scanFrom(i)
        if (found !== null) return found
      }
      return null

      function scanFrom(first) {
      let last = first
      let count = 0
      let blanks = 0
      const afterQuote = () => count > 0 && last > first && hasQuoteLine(first, last, lineAt)
      let inComment = false
      for (let i = first; i < starts.length; i += 1) {
        const line = lineAt(i)
        // Continuation lines of a multi-line comment (see commentLines) belong
        // only right after a comment line — elsewhere `｜` is ordinary text.
        if (inComment && line.startsWith(COMMENT_CONTINUATION)) {
          blanks = 0
          last = i
          continue
        }
        inComment = false
        if (!belongs(line)) {
          // Quoted material can be followed by the user's own prose, so a run of
          // blank lines — not the first foreign line — ends the block.
          if (afterQuote() && line.trim() === '' && blanks < 2) {
            blanks += 1
            last = i
            continue
          }
          break
        }
        blanks = 0
        if (startsHeader(line)) count += 1
        if (isCommentLine(line)) inComment = true
        last = i
      }
      if (count === 0 || !wellFormed(first, last)) return null
      const next = starts[last + 1]
      return { start: starts[first], end: next === undefined ? text.length : next - 1, count }
      }
    }

    /**
     * Every text node under one element, in document order. Recursion rather than
     * `createTreeWalker` on purpose — the walk is over a handful of nodes, and the
     * simpler API keeps the pure fold logic testable in any DOM implementation.
     */
    function textNodesOf(root) {
      const nodes = []
      const visit = (node) => {
        for (const child of node.childNodes) {
          if (child.nodeType === 3) nodes.push(child)
          else if (child.nodeType === 1) visit(child)
        }
      }
      visit(root)
      return nodes
    }

    /** The text node + offset a concatenated index lands on. */
    function locateText(nodes, index) {
      let acc = 0
      for (const node of nodes) {
        const length = (node.nodeValue ?? '').length
        if (index <= acc + length) return { node, offset: index - acc }
        acc += length
      }
      const last = nodes[nodes.length - 1]
      return last === undefined ? { node: null, offset: 0 } : { node: last, offset: (last.nodeValue ?? '').length }
    }

    /** Fold one already-rendered user message, when it carries a block. */
    function foldUserMessage(row, strings) {
      if (row.querySelector('[data-dsh-qa-fold]') !== null) return false
      const nodes = textNodesOf(row)
      const full = nodes.map((node) => node.nodeValue ?? '').join('')
      if (!full.includes(FOLD_HEADER_PREFIX)) return false
      const found = annotationRange(full)
      if (found === null) return false
      const blockText = full.slice(found.start, found.end)

      // Resolve BOTH endpoints before touching anything, so every failure path
      // leaves the message exactly as it was.
      const startPoint = locateText(nodes, found.start)
      const endPoint = locateText(nodes, found.end)
      if (startPoint.node === null || endPoint.node === null) return false
      const host = startPoint.node.parentNode
      if (host === null) return false
      // The block may span several spans: `projectUserText` splits a message
      // around every `@reference` chip. A Range still covers that correctly, but
      // the anchor chip must be inserted in ONE host, so the fold takes the
      // block's first host and the boundary is expressed inside the Range.
      const anchorHost = host

      // Build the replacement with Range: splitting the two boundary text nodes
      // first (which keeps the surviving head/tail text in place), then deleting
      // exactly the block's characters. Nothing is consumed by index arithmetic,
      // which is what used to run past the block and blank the user's own words.
      const head = startPoint.offset > 0
        ? startPoint.node.splitText(startPoint.offset)
        : startPoint.node
      // Re-locate the END after the split: `splitText` replaced the node that
      // held the block's first character, so the walk order changed under us.
      const afterSplit = textNodesOf(row)
      const endWalk = locateText(afterSplit, found.start + blockText.length)
      if (endWalk.node === null) return false
      const ownerDocument = row.ownerDocument ?? document
      const range = ownerDocument.createRange()
      // Both boundaries are character positions inside text nodes: the range can
      // never be expressed with setStartBefore/setEndBefore here, because the two
      // boundary nodes may be siblings (they are, whenever the message contains a
      // reference chip) and a Range cannot sit "between" two text nodes.
      range.setStart(head, 0)
      range.setEnd(endWalk.node, endWalk.offset)
      const removed = range.extractContents()
      if (removed.textContent !== blockText) {
        // Defensive: put the text back rather than leave a half-eaten message.
        anchorHost.insertBefore(removed, head)
        return false
      }

      const chip = ownerDocument.createElement('button')
      chip.type = 'button'
      chip.className = 'dsh-qa-fold'
      chip.setAttribute('data-dsh-qa-fold', String(found.count))
      chip.setAttribute('aria-expanded', 'false')
      chip.textContent = strings.foldedChip(found.count)
      const panel = ownerDocument.createElement('div')
      panel.className = 'dsh-qa-fold-body'
      panel.hidden = true
      chip.addEventListener('click', () => {
        const opening = panel.hidden
        // Both halves matter: `hidden` is defeated by any author `display` rule
        // (the stylesheet sets one), so the text itself has to be dropped when
        // closing — otherwise the block stays on screen and never collapses.
        panel.textContent = opening ? blockText : ''
        panel.hidden = !opening
        chip.textContent = opening ? strings.foldedChipOpen(found.count) : strings.foldedChip(found.count)
        chip.setAttribute('aria-expanded', opening ? 'true' : 'false')
      })
      anchorHost.insertBefore(chip, head)
      anchorHost.insertBefore(panel, head)
      return true
    }

    /**
     * Watch the transcript for sent annotations and fold them. The observer is
     * cheap: rows that carry no block fail one string search, and a folded row
     * is recognised by its own chip.
     */
    function installTranscriptFold() {
      const root = document.body
      if (root === null || root === undefined) return () => {}
      let queued = false
      const scan = () => {
        queued = false
        let rows
        try {
          rows = document.querySelectorAll('[data-chat-flow-kind="user"]')
        } catch {
          return
        }
        for (const row of rows) {
          try {
            foldUserMessage(row, copy())
          } catch (error) {
            console.warn('[dsh-quote-annotate] fold failed', error)
          }
        }
      }
      const schedule = () => {
        if (queued) return
        queued = true
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(scan)
        else scan()
      }
      const observer = new MutationObserver(schedule)
      observer.observe(root, { childList: true, subtree: true, characterData: true })
      schedule()
      return () => { observer.disconnect() }
    }

    /** Warn once if the sibling @local/dsh-copy-markdown service is missing. */
    let warnedMissingMarkdownSource = false
    function warnMissingMarkdownSource() {
      if (warnedMissingMarkdownSource) return
      warnedMissingMarkdownSource = true
      console.warn('[quote-annotate] markdownSource service is unavailable (is @local/dsh-copy-markdown enabled?); quotes fall back to plain text, so formulas and tables may lose their source form')
    }

    /* ---------------------------------------------------------------- *
     * Components
     * ---------------------------------------------------------------- */

    /**
     * Empty replacement for the shipped selection action.
     *
     * The shipped quote plugin renders its 「引用」 button into the keyed
     * `quote` cell of the text-interaction surface. Since DSH 0.2.3 a keyed
     * slot allows several entries for one key only when their priorities
     * differ; the lowest priority renders and the rest are shadowed. This
     * component registers one step below the shipped default (0), so it takes
     * the cell over while leaving quoting itself untouched: the shipped plugin
     * keeps its interaction, `insertQuote`, and the `> ` transcript previews.
     * Only this plugin's own floating button remains beside a selection.
     * Rendering null leaves the surface empty — the container has no chrome and
     * collapses to 0×0, so nothing is seen or clicked there.
     */
    function HiddenQuoteAction() {
      return null
    }

    /** Floating "add to input" pill, portal-mounted so nothing can clip it. */
    function SelectionButton({ snapshot, onAdd, strings }) {
      const rect = snapshot.rect
      const above = rect.top - 44 > 8
      const half = 70
      const style = {
        left: `${Math.min(Math.max(rect.left + rect.width / 2, half + 8), window.innerWidth - half - 8)}px`,
        top: above ? `${rect.top - 6}px` : `${rect.bottom + 6}px`,
        transform: above ? 'translate(-50%, -100%)' : 'translate(-50%, 0)',
      }
      // macOS Desktop (0.2.2-rc.1+) only auto-excludes controls inside
      // `data-window-drag` rows; a body portal must declare its own region or the
      // pill turns into a window drag when the selection sits over the header.
      return h('div', { className: 'dsh-qa-floating', style, role: 'presentation', 'data-window-drag-exclude': '' },
        h('button', {
          type: 'button',
          className: 'dsh-qa-floating-button',
          title: strings.addTitle,
          // Keep the selection alive through the press so the click can read it.
          onMouseDown: (event) => { event.preventDefault() },
          onClick: (event) => { event.preventDefault(); event.stopPropagation(); onAdd() },
        }, h('span', { className: 'dsh-qa-floating-plus', 'aria-hidden': 'true' }, '＋'), strings.addToInput))
    }

    /**
     * One annotation being edited: its quote and its comment box.
     *
     * The card is transient — it exists only while the user is editing this
     * annotation. Enter puts it away (the chip in the composer is what stays), and
     * clicking that chip brings the card back. Shift+Enter keeps the newline,
     * matching the composer's own shortcut.
     */
    function AnnotationCard({ record, occurrences, draftRev, facade, strings, command, leadingShift, seatOf, onClose }) {
      const [expanded, setExpanded] = React.useState(false)
      const [comment, setComment] = React.useState(record.comment)
      const areaRef = React.useRef(null)
      const ordinal = ordinalOf(record.ref)
      const source = quotedSourceOf(record)
      const long = source.length > 90 || source.split('\n').length > 2
      React.useEffect(() => {
        if (areaRef.current !== null) areaRef.current.focus()
      }, [])
      const remove = () => {
        const seat = typeof seatOf === 'function' ? seatOf() : null
        const applied = removeAnnotation(facade, occurrences, draftRev, record.ref, leadingShift, seat)
        if (applied === 'quote') {
          // The card stays open: the user has to remove that quote first.
          if (facade !== undefined && typeof facade.notify === 'function') facade.notify('error', strings.removeBlockedByQuote)
          return
        }
        if (applied !== true && facade !== undefined && typeof facade.notify === 'function') {
          facade.notify('error', strings.removeFailed)
        }
        onClose(record.ref)
      }
      const onCommentKeyDown = (event) => {
        if (!isCommentSubmitKey({
          key: event.key,
          shiftKey: event.shiftKey,
          isComposing: event.nativeEvent?.isComposing,
          keyCode: event.nativeEvent?.keyCode ?? event.keyCode,
        })) return
        event.preventDefault()
        event.currentTarget.blur()
        onClose(record.ref)
      }
      return h('section', { className: 'dsh-qa-card', 'data-quote-ref': record.ref },
        h('header', { className: 'dsh-qa-card-head' },
          h('span', { className: 'dsh-qa-badge' }, strings.cardTitle(ordinal)),
          h('span', { className: 'dsh-qa-spacer' }),
          long && h('button', {
            type: 'button',
            className: 'dsh-qa-link',
            onClick: () => { setExpanded((value) => !value) },
          }, expanded ? strings.collapseQuote : strings.expandQuote),
          h('button', {
            type: 'button',
            className: 'dsh-qa-remove',
            title: strings.remove,
            'aria-label': strings.remove,
            onClick: remove,
          }, '✕')),
        h('blockquote', { className: expanded ? 'dsh-qa-quote dsh-qa-quote-open' : 'dsh-qa-quote' }, source),
        record.truncated === true && h('div', { className: 'dsh-qa-note' }, strings.truncated),
        command === true && h('div', { className: 'dsh-qa-note dsh-qa-command-note' }, strings.commandHint),
        h('textarea', {
          ref: areaRef,
          className: 'dsh-qa-comment',
          rows: 2,
          maxLength: MAX_COMMENT_CHARS,
          value: comment,
          placeholder: strings.commentPlaceholder,
          'aria-label': strings.commentAria(ordinal),
          onKeyDown: onCommentKeyDown,
          onChange: (event) => {
            setComment(event.target.value)
            record.comment = event.target.value
            const pending = pendingBySession.get(record.sessionId)
            if (pending !== undefined) savePending(record.sessionId, pending)
          },
        }))
    }

    /**
     * The cards above the composer card, one per annotation currently being
     * edited. The occurrence table stays the source of truth (a chip deleted in
     * the composer drops its card), and the open set is owned by the entry so a
     * chip click can re-open a card after Enter put it away.
     */
    function AnnotationCards({ sessionId, state, facade, editing, seatOf, onClose, strings }) {
      const occurrences = ownOccurrences(state)
      // Removal needs the FULL table: other sources' chips (`@README.md`) also
      // shift detect coordinates, and skipping them deletes the wrong character.
      const allOccurrences = state?.occurrences ?? []
      liveBySession.set(sessionId, new Set(occurrences.map((occurrence) => occurrence.ref)))
      React.useEffect(() => () => { liveBySession.delete(sessionId) }, [sessionId])
      const shown = occurrences.filter((occurrence) => editing.has(occurrence.ref))
      if (shown.length === 0) return null
      const draftRev = state?.draftRev
      // A command line only carries plain text, so the card says to send the
      // command alone and this annotation as a normal message.
      const command = isCommandDraft(state)
      const leadingShift = commandChipShift(state)
      const cards = shown.map((occurrence) => {
        let record = records.get(occurrence.ref)
        if (record === undefined) {
          // The chip outlived our ledger (cleared storage, another window):
          // rebuild a degraded record from the chip's own projection so the codec
          // still has something to serialize.
          seq += 1
          record = {
            ref: occurrence.ref,
            seq,
            text: occurrence.clipboardText || occurrence.label || '',
            labelText: occurrence.label || '',
            markdown: occurrence.clipboardText || occurrence.label || '',
            markdownSource: false,
            comment: '',
            kind: '',
            nodeKey: '',
            truncated: false,
            recovered: true,
            sessionId,
          }
          records.set(occurrence.ref, record)
        }
        record.sessionId = sessionId
        return h(AnnotationCard, {
          key: occurrence.ref,
          record,
          occurrences: allOccurrences,
          draftRev,
          facade,
          strings,
          command,
          leadingShift,
          seatOf,
          onClose,
        })
      })
      return h('div', { className: 'dsh-qa-cards', role: 'group', 'aria-label': strings.cardsAria }, cards)
    }

    /** Track the transcript selection for one session entry. */
    function useSelectionTracking(rootRef, setSnapshot, sessionId, markdownOf) {
      // Read through a ref: the projection closure is rebuilt every render, and
      // re-subscribing the document listeners for that would be wasteful.
      const markdownRef = React.useRef(markdownOf)
      markdownRef.current = markdownOf
      React.useEffect(() => {
        let frame = 0
        const hide = () => {
          if (frame !== 0) { cancelAnimationFrame(frame); frame = 0 }
          setSnapshot(null)
        }
        const update = () => {
          frame = 0
          setSnapshot(readSelection(rootRef.current, sessionId, markdownRef.current))
        }
        const schedule = () => { if (frame === 0) frame = requestAnimationFrame(update) }
        // Scrolling (including the transcript auto-scrolling while a reply
        // streams) re-measures the selection instead of hiding the button: the
        // selection is still valid, only its rect moved. readSelection drops the
        // button by itself once the selection has no on-screen box.
        const onKeyDown = (event) => { if (event.key === 'Escape') hide() }
        document.addEventListener('selectionchange', schedule)
        document.addEventListener('mouseup', schedule, true)
        document.addEventListener('scroll', schedule, true)
        document.addEventListener('keydown', onKeyDown, true)
        window.addEventListener('resize', schedule)
        return () => {
          if (frame !== 0) cancelAnimationFrame(frame)
          document.removeEventListener('selectionchange', schedule)
          document.removeEventListener('mouseup', schedule, true)
          document.removeEventListener('scroll', schedule, true)
          document.removeEventListener('keydown', onKeyDown, true)
          window.removeEventListener('resize', schedule)
        }
      }, [sessionId])
    }

    /**
     * The composer facade for one session, plus a reactive subscription to its
     * state.
     *
     * The dock slot's owner share is only `{ session, input }` — a point-in-time
     * snapshot with no `useInput`/`inputActions` — so the live face has to come
     * from the service layer: `ctx.sessions.scope(id)` → `actx.get('conversation')`
     * → `input.for(actx)`. Its `state` is a snapshot store, which is exactly what
     * `useSyncExternalStore` wants.
     * @param ctx - the plugin's root Client context.
     * @param sessionId - the session this entry belongs to.
     * @param fallback - the owner's snapshot, used when the facade is not (yet) up.
     * @returns { facade, state } with `facade` possibly undefined.
     */
    function useComposerFacade(ctx, sessionId, fallback) {
      const [facade, setFacade] = React.useState(undefined)
      React.useEffect(() => {
        let resolved
        try {
          const actx = ctx.get('sessions')?.scope?.(sessionId)
          const conversation = actx !== undefined ? actx.get('conversation') : undefined
          resolved = conversation?.input?.for !== undefined ? conversation.input.for(actx) : undefined
        } catch (error) {
          console.warn('[dsh-quote-annotate] composer facade unavailable', error)
          resolved = undefined
        }
        setFacade(resolved)
      }, [ctx, sessionId])
      const state = React.useSyncExternalStore(
        (listener) => {
          const store = facade?.state
          if (store === undefined || typeof store.subscribe !== 'function') return () => {}
          return store.subscribe(listener)
        },
        () => {
          const store = facade?.state
          if (store === undefined || typeof store.getSnapshot !== 'function') return fallback ?? null
          return store.getSnapshot()
        },
        () => fallback ?? null,
      )
      return { facade, state }
    }

    /**
     * The dock entry: the open cards, the floating pill (portal), and the three
     * behaviours that tie the composer to them — restoring unsent annotations,
     * pruning what is gone, and re-opening a card when its chip is clicked.
     */
    function QuoteAnnotateEntry({ ctx, sessionId, input }) {
      const rootRef = React.useRef(null)
      const [snapshot, setSnapshot] = React.useState(null)
      const [editing, setEditing] = React.useState(() => new Set())
      const strings = copy()
      const { facade, state } = useComposerFacade(ctx, sessionId, input)
      const live = ownOccurrences(state)
      const liveKey = live.map((occurrence) => occurrence.ref).join('|')
      const armedRef = React.useRef(false)
      const stateRef = React.useRef(state)
      stateRef.current = state

      const openEditor = React.useCallback((ref) => {
        setEditing((previous) => {
          if (previous.has(ref)) return previous
          const next = new Set(previous)
          next.add(ref)
          return next
        })
      }, [])
      const closeEditor = React.useCallback((ref) => {
        setEditing((previous) => {
          if (!previous.has(ref)) return previous
          const next = new Set(previous)
          next.delete(ref)
          return next
        })
      }, [])

      // Bring back the chips a session switch (or a restart) took away. The shell
      // re-seeds the draft with `setDraft`, which rebuilds the editor as plain
      // text, so this runs once the re-seed has landed: in place when the
      // projections are still there, appended when the draft is gone entirely.
      React.useEffect(() => {
        armedRef.current = false
        if (facade === undefined) return undefined
        const pending = loadPending(sessionId)
        if (pending.size === 0) {
          armedRef.current = true
          return undefined
        }
        let cancelled = false
        let timer = 0
        const startedAt = Date.now()
        const step = () => {
          if (cancelled) return
          const current = facade.state.getSnapshot()
          if (ownOccurrences(current).length > 0) {
            armedRef.current = true
            return
          }
          if (String(current.draft ?? '').trim() !== '') {
            restoreChips(facade, sessionId, pending, 'in-place', strings)
            armedRef.current = true
            return
          }
          if (Date.now() - startedAt >= RESTORE_WAIT_MS) {
            restoreChips(facade, sessionId, pending, 'append', strings)
            armedRef.current = true
            return
          }
          timer = setTimeout(step, 120)
        }
        timer = setTimeout(step, 0)
        return () => {
          cancelled = true
          clearTimeout(timer)
        }
      }, [facade, sessionId])

      // Keep the ledger honest: a chip the user deleted is gone for good, and an
      // emptied composer means the batch was sent.
      React.useEffect(() => {
        if (!armedRef.current) return
        // An empty ledger still has work when live chips came back after a clear.
        const map = pendingBySession.get(sessionId) ?? loadPending(sessionId)
        if (map.size === 0 && live.length === 0) return
        if (live.length === 0 && String(state?.draft ?? '').trim() === '') {
          forgetAllPending(sessionId)
          return
        }
        const liveRefs = new Set(live.map((occurrence) => occurrence.ref))
        let changed = false
        // Re-adopt chips that came back after the ledger was cleared (a failed
        // send's restoreDraft, an undo of select-all + delete), and remember
        // where every live chip sits so an in-place restore re-anchors on it.
        for (const occurrence of live) {
          const record = records.get(occurrence.ref)
          if (record === undefined) continue
          if (!map.has(occurrence.ref)) {
            record.sessionId = sessionId
            map.set(occurrence.ref, record)
            changed = true
          }
          if (Number.isFinite(occurrence.offset) && record.offset !== occurrence.offset) {
            record.offset = occurrence.offset
            changed = true
          }
        }
        for (const ref of [...map.keys()]) {
          if (liveRefs.has(ref)) continue
          // Drop the ledger entry (never resurrect a deleted annotation) but keep
          // the record: undoing the deletion brings the chip back with the same
          // ref, and the codec must still be able to expand it.
          map.delete(ref)
          changed = true
        }
        if (changed) savePending(sessionId, map)
      }, [liveKey, state?.draft, sessionId])

      // An editing set never outlives the chips it points at.
      React.useEffect(() => {
        setEditing((previous) => {
          const liveRefs = new Set(live.map((occurrence) => occurrence.ref))
          const next = new Set([...previous].filter((ref) => liveRefs.has(ref)))
          return next.size === previous.size ? previous : next
        })
      }, [liveKey])

      // Clicking a chip re-opens its card. Chips are addressed by source name and
      // document order, which is exactly the order the occurrence table uses.
      React.useEffect(() => {
        const onPointerDown = (event) => {
          const target = event.target
          if (target === null || target === undefined || typeof target.closest !== 'function') return
          let chip = null
          try {
            chip = target.closest(`[data-composer-chip="${SOURCE}"]`)
          } catch {
            chip = null
          }
          if (chip === null) return
          const seat = chip.closest('[data-composer-seat]')
          if (seat === null) return
          const all = [...seat.querySelectorAll(`[data-composer-chip="${SOURCE}"]`)]
          const index = all.indexOf(chip)
          const current = ownOccurrences(stateRef.current)
          const occurrence = index < 0 ? undefined : current[index]
          if (occurrence !== undefined) openEditor(occurrence.ref)
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        return () => { document.removeEventListener('pointerdown', onPointerDown, true) }
      }, [openEditor])

      const markdownOf = (range) => {
        const source = ctx.get('markdownSource')
        if (source === undefined || typeof source.fromRange !== 'function') {
          warnMissingMarkdownSource()
          return ''
        }
        return source.fromRange(range)
      }
      // Command submissions only carry plain text; the guard must be in place
      // before the user can press Enter on a slash-command line.
      React.useEffect(() => {
        installCommandGuard(facade, sessionId, () => composerSeatOf(rootRef.current))
      }, [facade, sessionId])
      useSelectionTracking(rootRef, setSnapshot, sessionId, markdownOf)
      const onAdd = () => {
        const captured = snapshot
        setSnapshot(null)
        const selection = document.getSelection()
        if (selection !== null) selection.removeAllRanges()
        if (captured === null) return
        const ref = addAnnotation(ctx, facade, sessionId, captured, strings)
        if (ref !== undefined) openEditor(ref)
      }
      return h(React.Fragment, null,
        h('div', { ref: rootRef, className: 'dsh-qa-anchor', 'data-quote-anchor': sessionId },
          h(AnnotationCards, {
            sessionId,
            state,
            facade,
            editing,
            seatOf: () => composerSeatOf(rootRef.current),
            onClose: closeEditor,
            strings,
          })),
        snapshot !== null && createPortal(
          h(SelectionButton, { snapshot, onAdd, strings }),
          document.body,
        ))
    }

    /* ---------------------------------------------------------------- *
     * Styles (theme tokens only; every class carries the dsh-qa- prefix)
     * ---------------------------------------------------------------- */

    const CSS = `
.dsh-qa-anchor { display: contents; }
.dsh-qa-cards { display: flex; flex-direction: column; gap: 4px; margin-bottom: 4px; }
.dsh-qa-card {
  display: flex; flex-direction: column; gap: 4px;
  padding: 5px 8px 6px; border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px; background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary); font-size: 12px; line-height: 1.4;
}
.dsh-qa-card-head { display: flex; align-items: center; gap: 6px; }
.dsh-qa-badge { font-weight: 600; color: var(--dsw-alias-brand-primary); }
.dsh-qa-spacer { flex: 1 1 auto; }
.dsh-qa-link {
  padding: 0; border: none; background: none; cursor: pointer;
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 11px;
}
.dsh-qa-link:hover { color: var(--dsw-alias-label-primary); }
.dsh-qa-remove {
  padding: 0 2px; border: none; background: none; cursor: pointer;
  color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 1;
}
.dsh-qa-remove:hover { color: var(--dsw-alias-state-error-primary); }
.dsh-qa-quote {
  margin: 0; padding: 2px 7px; max-height: 38px; overflow: hidden;
  border-left: 2px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary);
  white-space: pre-wrap; overflow-wrap: anywhere;
  font-size: 11.5px; line-height: 1.45;
}
.dsh-qa-quote-open { max-height: none; }
.dsh-qa-note { color: var(--dsw-alias-state-warn-primary); font-size: 11px; }
.dsh-qa-command-note { color: var(--dsw-alias-label-secondary); }
.dsh-qa-comment {
  box-sizing: border-box; width: 100%; min-height: 28px; padding: 4px 7px;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px;
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
  font: inherit; font-size: 12px; line-height: 1.4; resize: vertical;
}
.dsh-qa-comment:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.dsh-qa-comment::placeholder { color: var(--dsw-alias-state-idle-primary); }
.dsh-qa-floating { position: fixed; z-index: 850; }
.dsh-qa-floating-button {
  display: inline-flex; align-items: center; gap: 4px; height: 28px;
  padding: 0 10px; border-radius: 999px; cursor: pointer; white-space: nowrap;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-overlay);
  color: var(--dsw-alias-label-primary);
  box-shadow: 0 4px 14px rgb(0 0 0 / 18%); font-size: 12px;
}
.dsh-qa-floating-button:hover {
  border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary);
}
.dsh-qa-floating-plus { font-size: 13px; line-height: 1; }
.dsh-qa-fold {
  display: inline-block; margin: 4px 0 0; padding: 1px 8px;
  border: 1px dashed var(--dsw-alias-border-l2); border-radius: 999px;
  background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 12px; line-height: 1.6; cursor: pointer;
}
.dsh-qa-fold:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-brand-primary); }
.dsh-qa-fold[aria-expanded="true"] { color: var(--dsw-alias-label-primary); border-style: solid; }
.dsh-qa-fold-body[hidden] { display: none; }
.dsh-qa-fold-body {
  display: block; margin: 6px 0 0; padding: 6px 8px;
  border-left: 2px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-secondary);
  white-space: pre-wrap; overflow-wrap: anywhere;
  font-size: 12px; line-height: 1.5; text-align: left;
}
`

    /** Run one fiber-owned effect, tolerating a ctx without `effect` (tests). */
    function effectOf(ctx, run, label) {
      if (typeof ctx.effect === 'function') return ctx.effect(run, label)
      const disposer = run()
      return typeof disposer === 'function' ? disposer : () => {}
    }

    function installStyles(ctx) {
      effectOf(ctx, () => {
        const selector = 'style[data-dsh-plugin="dsh-quote-annotate"]'
        const existing = document.querySelector(selector)
        // A hot-reloaded generation may leave the previous element behind: carry
        // the current CSS instead of skipping it, or new rules silently never load.
        if (existing !== null) {
          existing.textContent = CSS
          return () => {}
        }
        const style = document.createElement('style')
        style.setAttribute('data-dsh-plugin', 'dsh-quote-annotate')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => { style.remove() }
      }, 'quote-annotate: styles')
    }

    /**
     * The reference source: what lets a chip survive submit. `candidates` is
     * empty by design (nothing is ever picked from a menu — the chip is inserted
     * programmatically), and the codec is the only member that matters.
     */
    const SOURCE_DEF = {
      trigger: TRIGGER,
      name: SOURCE,
      order: 900,
      candidates: async () => [],
      onPick: () => undefined,
      codec: {
        // Must agree with the `clipboardText` the chip was minted with
        // (referenceOf), or the draft mirror re-projects a string the in-place
        // restore can no longer find.
        clipboardText: (ref) => {
          const record = records.get(ref)
          return record === undefined ? '' : clipboardOf(record)
        },
        serialize: async (ref) => serializeAnnotation(ref),
      },
    }

    /* ---------------------------------------------------------------- *
     * Plugin
     * ---------------------------------------------------------------- */

    return {
      inject: ['slots'],
      apply(ctx) {
        installStyles(ctx)
        effectOf(ctx, installTranscriptFold, 'quote-annotate: transcript fold')
        ctx.inject(['inputTriggers'], (scope) => {
          effectOf(scope, () => scope.inputTriggers.registerSource(SOURCE_DEF), 'quote-annotate: reference source')
        })
        ctx.slots.inject(SLOT, () => ctx.slots.register({
          name: SLOT,
          id: 'quote-annotate',
          order: DOCK_ORDER,
        }, (props) => h(QuoteAnnotateEntry, Object.assign({}, props, { ctx }))))
        // Shadow the shipped selection action so the only quote affordance beside
        // a selection is this plugin's own floating button. The shipped quote
        // plugin keeps everything else (interaction, insertQuote, `> ` previews).
        //
        // Contained on purpose: DSH 0.2.3 rejects a second entry for one key at the
        // same priority, and a throw here would fail this whole client half (the
        // plugin page then reports a sync failure). Losing the shadow only brings
        // the shipped button back; it must never cost the annotations too.
        ctx.slots.inject(QUOTE_ACTION_SLOT, () => {
          try {
            return ctx.slots.register({
              name: QUOTE_ACTION_SLOT,
              key: NATIVE_QUOTE_KEY,
              priority: NATIVE_QUOTE_PRIORITY,
            }, HiddenQuoteAction)
          } catch (error) {
            console.warn('[dsh-quote-annotate] could not shadow the shipped quote action; the native button stays', error)
            return () => {}
          }
        })
      },
      /**
       * Pure logic exposed for `tools/verify-core.mjs`. Cordis ignores unknown
       * members on a plugin object, and the browser never reads this.
       */
      internals: {
        SOURCE,
        QUOTE_ACTION_SLOT,
        NATIVE_QUOTE_KEY,
        NATIVE_QUOTE_PRIORITY,
        HiddenQuoteAction,
        MAX_QUOTE_CHARS,
        records,
        liveBySession,
        serializeAnnotation,
        quotedSourceOf,
        isCommentSubmitKey,
        annotationRange,
        foldUserMessage,
        textNodesOf,
        locateText,
        ordinalOf,
        snippet,
        chipLabel,
        detectSpanOf,
        commandChipShift,
        removeAnnotation,
        commentLines,
        projectionAt,
        pruneRecords,
        storedFormOf,
        MAX_RECORDS,
        PENDING_MAX_STORAGE_CHARS,
        AnnotationCards,
        clipboardOf,
        referenceOf,
        ownOccurrences,
        restoreChips,
        loadPending,
        savePending,
        rememberPending,
        forgetPending,
        forgetAllPending,
        pendingBySession,
        nextRef,
        readSelection,
        transcriptRowOf,
        addAnnotation,
        isCommandDraft,
        installCommandGuard,
        splitPlanOf,
        detectLengthOf,
        tokenRest,
        whenSettled,
        composerSeatOf,
        hasComposerQuote,
        sourceDef: SOURCE_DEF,
        copy,
      },
    }
  },
})
