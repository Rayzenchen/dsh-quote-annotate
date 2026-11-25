# Quote & annotate

![对话引用批注图标](../icon.svg)

Select a passage inside a transcript, click "Add to input" next to the selection, and the passage
becomes a quote chip in the composer with a comment card above it. On send, the plugin turns
"source + comment" into one structured Chinese annotation block, so the model sees a numbered,
self-contained annotation instead of an unattributed quote.

## Why it exists

- **Every quote keeps its source** — each annotation carries the selected text; formulas, tables and
  code blocks are quoted as Markdown source, so the model can pair each comment with its text.
- **Comments never get lost** — for an ordinary message the block is serialized by the chip's codec.
- **Slash commands work too** — when a command and annotations share the draft, one Enter splits it
  into two sends: the command first (e.g. `/计划` enters plan mode), then the annotated message.
- **Native quotes stay** — only the native "Quote" action next to a selection is shadowed; native
  quote blocks and `> ` previews are untouched.

## Usage

1. Select text in the transcript (selections inside the composer are ignored);
2. Click "Add to input";
3. Write the comment in the card above the composer (Shift+Enter for a newline, Enter collapses);
4. Press Enter — the model receives a structured block with a preamble, numbering, `> ` source lines
   and `我的批注：`;
5. To edit, click the chip in the composer; click ✕ on the card to remove the quote.

Annotations are numbered in draft order. In the sent message the block folds into a
"引用批注 N 条 · 展开" badge that can be expanded in place.

## Slash commands: one Enter, two sends

A command's arguments come from the draft's plain text, where a chip degrades to its quoted source —
the comment would be dropped — and DSH has no public API to hand a command bytes directly. So the
plugin sends the command alone first (empty arguments; `/计划` only enters plan mode), then rebuilds
the annotated message and sends it as an ordinary message.

If the draft also holds chips from other sources, a native DSH quote or attachments, the split cannot
be rebuilt safely: the send is refused with an instruction, and the draft stays untouched.

## Privacy and boundaries

- Everything runs in the browser; the host half is inert and only exists so the client roster loads the bundle.
- No DSH source is modified — only public composer seats, slots and the reference source API are used.
- Selections and comments live in a local per-session ledger and leave only with the message.

## Install

```sh
dsh plugin --profile <profile> add github:Rayzenchen/dsh-quote-annotate#v1.0.0
```

Or from a local directory: `dsh plugin --profile <profile> add /path/to/dsh-quote-annotate`.
Refresh the page afterwards (the feature is entirely client-side).

## Compatibility

Verified on DSH `0.2.3-alpha.2`; `engines.dsh` declares `>=0.2.3-alpha.2 <0.3.0`. DSH's slot and seat
contracts carry no compatibility promise — after upgrading, run `node tools/verify-core.mjs` and send
one annotated message as a smoke test.

## Verification

```sh
node --check index.js && node --check client.js
node tools/verify-core.mjs      # 276 assertions
```

## License

[MIT](../LICENSE) © 2026 Rayzenchen
