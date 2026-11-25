# Quote & annotate (@local/dsh-quote-annotate)

[中文](README.md) | English

Bring Codex Desktop's "select an answer, add it to the composer, write a comment" flow to
DeepSeek Harness. Select a passage in the transcript, click **Add to input** next to the
selection: the passage becomes a **quote chip** in the composer and a **comment card** appears
above it. On send, each annotation — source plus comment — is serialized into a structured
Chinese block that the model reads annotation by annotation.

![Quote & annotate icon](icon.svg)

## What it does

- **Selection becomes a quote chip.** The chip carries the selected text; formulas, tables and code
  blocks are quoted as Markdown source (via the `@local/dsh-copy-markdown` service when installed).
- **A comment card per annotation.** Write the comment, press Enter to collapse, click the chip to
  reopen it, click ✕ to remove that quote.
- **One structured block on send.** Every annotation becomes a preamble, `【对话批注 N】`, the quoted
  source as `> ` lines, and `我的批注：…` — in draft order, with multi-line comments kept intact.
- **Slash commands still work.** A command and annotations in one draft are split into two sends
  automatically: the command goes out first with empty arguments (e.g. `/计划` just enters plan
  mode), then the annotated message is sent as an ordinary message. Splits that cannot be rebuilt
  safely are refused with one instruction, and the draft is kept.
- **Native quoting is preserved.** Only the native "Quote" action next to a selection is shadowed;
  native quote blocks and the `> ` preview they render in sent messages are untouched.

## Usage

1. Select text in the conversation body (assistant answers, your own messages, code blocks and
   grouped reasoning blocks all work; selections inside the composer are ignored).
2. Click **Add to input** next to the selection.
3. Write the comment in the card above the composer — Shift+Enter adds a newline, Enter collapses.
4. Press Enter. The model receives the full annotation block.
5. Later: click the chip in the composer to reopen its card; click ✕ on the card to drop the quote.

Numbers follow the draft order. In a sent message the block folds into a "引用批注 N 条 · 展开"
badge; click it to see the exact block in place.

## The prompt format

```
以下是我从上面的对话中选取的内容与我的批注，请逐条结合原文回应。
【对话批注 1】
选取原文：
> …
我的批注：这条我保留意见。
｜第二行评论
```

## Slash commands

A command takes its arguments from the draft's plain-text projection, where a chip degrades to its
quoted source — the comment would be lost — and DSH exposes no API to hand a command bytes directly.
So the plugin sends the command alone, then rebuilds the annotated message and sends it through the
ordinary path, where the codec runs.

## Known limitations

- Folding relies on the serialized format (preamble, numbered headers, `> ` lines); hand-typing the
  same shape also folds.
- A native DSH quote block in the draft makes cross-chip edits unsafe: the ✕ removal refuses, and
  the automatic split refuses.
- The automatic split cannot rebuild chips from other sources (e.g. `@file`), native quote blocks or
  attachments; it refuses and tells you to send the command alone instead.

## Install

**Requirement:** DeepSeek Harness `0.2.3-alpha.2` or newer (`engines.dsh` declares the range).
Plain JavaScript, no build step.

```sh
dsh plugin --profile <profile> add github:Rayzenchen/dsh-quote-annotate#v1.0.0
```

From a local directory:

```sh
dsh plugin --profile <profile> add /path/to/dsh-quote-annotate
```

Refresh the page afterwards — the whole feature is client-side. Remove it with
`dsh plugin --profile <profile> remove @local/dsh-quote-annotate`.

## Verification

```sh
npm install                     # devDependency only (jsdom, for the DOM paths)
npm run check
npm test                        # 276 assertions
```

CI (GitHub Actions) runs `npm ci`, `npm run check` and `npm test` on every push and PR.

The suite covers serialization, chip addressing/insertion/removal, selection boundaries, prompt
assembly, folding, the annotation ledger, slash-command splitting and the native-button shadow.

## Compatibility

Verified on DSH `0.2.3-alpha.2`. DSH's slot and seat contracts carry no compatibility promise;
after upgrading, run the suite and send one annotated message as a smoke test.

## License

[MIT](LICENSE) © 2026 Rayzenchen
