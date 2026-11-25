#!/usr/bin/env node
/**
 * Verification harness for `@local/dsh-quote-annotate`.
 *
 * Runs the plugin's plain-JS client half outside the browser against a minimal
 * fake DOM + module loader, then drives the pure logic and the three integration
 * seams that matter:
 *
 *   - the prompt serializer (the codec the composer calls once per chip),
 *   - the chip insertion path (`insertReference` with the caret span), and
 *   - the chip removal path (`insertText('')` over the chip's detect span),
 *
 * all through the exact objects the plugin publishes to the Harness.
 * Everything asserted here is real plugin code; only the browser around it is
 * faked. The contracts modelled are the ones shipped by Harness 0.2.0-rc.2:
 * clipboard-coordinate occurrences, 1-char chips in detect coordinates, and a
 * span CAS on the live `draftRev`.
 *
 * Run: `node tools/verify-core.mjs`
 */
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = join(here, '..')

/* ------------------------------------------------------------------ *
 * Assertions
 * ------------------------------------------------------------------ */

let pass = 0
let fail = 0
const failures = []

function check(name, condition, extra) {
  if (condition) {
    pass += 1
    console.log(`  \u2713 ${name}`)
  } else {
    fail += 1
    failures.push(name)
    console.error(`  \u2717 ${name}${extra === undefined ? '' : ` \u2014 ${extra}`}`)
  }
}

function eq(name, actual, expected) {
  const same = Object.is(actual, expected)
  check(name, same, same ? undefined : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function group(title) {
  console.log(`\n${title}`)
}

/* ------------------------------------------------------------------ *
 * Fake DOM
 * ------------------------------------------------------------------ */

class FakeElement {
  constructor(selectors = [], attrs = {}) {
    this.nodeType = 1
    this.parentElement = null
    this._selectors = new Set(selectors)
    this.attrs = attrs
  }

  closest(selector) {
    // Attribute selectors only: the fake tree matches a selector when any of the
    // element's declared selectors is a prefix-compatible match.
    const wanted = selector.split(',').map((part) => part.trim())
    let node = this
    while (node !== null && node !== undefined) {
      if (node._selectors !== undefined) {
        for (const want of wanted) {
          for (const own of node._selectors) {
            if (own === want) return node
          }
        }
      }
      node = node.parentElement
    }
    return null
  }

  contains(node) {
    let cursor = node
    while (cursor !== null && cursor !== undefined) {
      if (cursor === this) return true
      cursor = cursor.parentElement
    }
    return false
  }

  getAttribute(name) {
    return this.attrs[name] ?? null
  }
}

function textNode(parent) {
  return { nodeType: 3, parentElement: parent }
}

const RECT = { top: 100, bottom: 112, left: 20, width: 60, height: 12 }

function fakeRange(startContainer, endContainer) {
  return {
    startContainer,
    endContainer,
    getClientRects: () => [RECT],
    getBoundingClientRect: () => RECT,
  }
}

function fakeSelection(text, range, collapsed = false) {
  return {
    isCollapsed: collapsed,
    rangeCount: collapsed ? 0 : 1,
    toString: () => text,
    getRangeAt: () => range,
    removeAllRanges: () => {},
  }
}

const documentStub = {
  documentElement: { getAttribute: () => 'zh' },
  getSelection: () => globalThis.__selection ?? null,
  activeElement: null,
  head: { appendChild: () => {} },
  createElement: () => ({ setAttribute: () => {}, remove: () => {}, textContent: '' }),
  querySelector: () => null,
  addEventListener: () => {},
  removeEventListener: () => {},
}

const ReactStub = {
  Fragment: Symbol('Fragment'),
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useRef: (initial) => ({ current: initial }),
}

const ReactDomStub = { createPortal: (node) => node }

/* ------------------------------------------------------------------ *
 * Load the client half exactly as the Web shell would
 * ------------------------------------------------------------------ */

let handoff = null
globalThis.window = {
  __ModuleLoader__: { load: (next) => { handoff = next } },
  innerWidth: 1200,
  addEventListener: () => {},
  removeEventListener: () => {},
}
globalThis.document = documentStub

/**
 * jsdom (a devDependency) is used for the DOM-touching paths — the sent-message
 * fold walks real text nodes. The plugin's pure logic keeps using the
 * hand-rolled stubs above.
 */
function loadJsdom() {
  try {
    const require = createRequire(import.meta.url)
    const mod = require('jsdom')
    return mod !== undefined && mod.JSDOM !== undefined ? mod.JSDOM : null
  } catch {
    return null
  }
}
const JSDOM = loadJsdom()
if (JSDOM === null) {
  console.error('缺少 devDependency `jsdom`：先在插件目录运行 `npm install`（CI 用 `npm ci`）。')
  process.exit(1)
}
// Node >= 21 ships a read-only `navigator` global; the plugin only reads `language`.
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true })
globalThis.requestAnimationFrame = () => 1
globalThis.cancelAnimationFrame = () => {}
// The ledger persists through localStorage in the browser; a Map-backed fake
// keeps the store's contract (string keys, JSON values) testable in Node.
const storage = new Map()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => { storage.set(key, String(value)) },
    removeItem: (key) => { storage.delete(key) },
  },
})

await import(pathToFileURL(join(pluginDir, 'client.js')).href)

check('client half registers itself through window.__ModuleLoader__', handoff !== null)
eq('bundle id', handoff?.id, '@local/dsh-quote-annotate')

const plugin = handoff.factory((id) => (id === 'react' ? ReactStub : ReactDomStub))
const I = plugin.internals

check('plugin exposes the slots service dependency', Array.isArray(plugin.inject) && plugin.inject.includes('slots'))
check('plugin exposes apply()', typeof plugin.apply === 'function')
check('plugin exposes its internals for this harness', typeof I?.serializeAnnotation === 'function')

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

let seeded = 0

function seed(ref, fields = {}) {
  seeded += 1
  const record = {
    ref,
    seq: fields.seq ?? seeded,
    text: fields.text ?? '',
    markdown: fields.markdown,
    markdownSource: fields.markdownSource === true,
    comment: fields.comment ?? '',
    kind: fields.kind ?? 'assistant-step',
    nodeKey: fields.nodeKey ?? '',
    truncated: fields.truncated === true,
    recovered: fields.recovered === true,
  }
  I.records.set(ref, record)
  return record
}

function live(sessionId, refs) {
  I.liveBySession.set(sessionId, new Set(refs))
}

function reset() {
  I.records.clear()
  I.liveBySession.clear()
  // The ledger and its storage are per-session state: tests must not inherit it.
  I.pendingBySession.clear()
  storage.clear()
  seeded = 0
}

/** Replicate the composer's submit-time splice (clipboard coordinates). */
async function splice(draft, occurrences) {
  const signal = new AbortController().signal
  const parts = await Promise.all(occurrences.map(async (occurrence) => ({
    offset: occurrence.offset,
    length: occurrence.length,
    text: await I.sourceDef.codec.serialize(occurrence.ref, signal),
  })))
  let out = ''
  let cursor = 0
  for (const part of parts) {
    out += draft.slice(cursor, part.offset) + part.text
    cursor = part.offset + part.length
  }
  return (out + draft.slice(cursor)).trim()
}

/* ------------------------------------------------------------------ *
 * 1. Prompt serialization
 * ------------------------------------------------------------------ */

group('1. 提示词序列化 (serializeAnnotation)')

reset()
seed('q1', { text: '第一行\n第二行', comment: '为什么这样？' })
live('s1', ['q1'])
eq(
  '单条批注：前言 + 序号 + 逐行引用 + 我的意见',
  I.serializeAnnotation('q1'),
  '\n以下是我从上面的对话中选取的内容与我的批注，请逐条结合原文回应。\n'
  + '【对话批注 1】\n选取原文：\n> 第一行\n> 第二行\n我的批注：为什么这样？\n',
)

reset()
seed('q1', { text: '甲' })
seed('q2', { text: '乙' })
live('s1', ['q1', 'q2'])
const two = [I.serializeAnnotation('q1'), I.serializeAnnotation('q2')]
eq('两条批注：第一条带前言', two[0].includes('以下是我从上面的对话中选取的内容'), true)
eq('两条批注：第二条不带前言', two[1].includes('以下是我从上面的对话中选取的内容'), false)
eq('两条批注：第一条编号为 1', two[0].includes('【对话批注 1】'), true)
eq('两条批注：第二条编号为 2', two[1].includes('【对话批注 2】'), true)

reset()
seed('q1', { text: '甲' })
seed('q2', { text: '乙', seq: 9 })
live('s1', ['q2'])
eq('删掉第一条后，剩下的重新编号为 1（不留空档）', I.serializeAnnotation('q2').includes('【对话批注 1】'), true)
check('删掉第一条后，幸存者接上前言', I.serializeAnnotation('q2').includes('以下是我从上面的对话中选取的内容'))

reset()
seed('q1', { text: '原文' })
live('s1', ['q1'])
eq('留空的评论不写「我的意见」行', I.serializeAnnotation('q1').includes('我的意见'), false)
seed('q2', { text: '原文', comment: '   ' })
live('s1', ['q2'])
eq('纯空白评论同样不写「我的意见」行', I.serializeAnnotation('q2').includes('我的意见'), false)

reset()
seed('q1', { text: '长文', truncated: true })
live('s1', ['q1'])
check('截断的选区会如实说明', I.serializeAnnotation('q1').includes('以上仅为开头部分'))

reset()
eq('未知 ref 不抛异常（绝不能阻断发送）', typeof I.serializeAnnotation('nope'), 'string')
check('未知 ref 的兜底文本可读', I.serializeAnnotation('nope').includes('原文已丢失'))

reset()
seed('q1', { text: '原文' })
live('s1', ['q1'])
check('codec.serialize 返回 Promise', I.sourceDef.codec.serialize('q1', new AbortController().signal) instanceof Promise)
const unknown = await I.sourceDef.codec.serialize('missing', new AbortController().signal)
check('codec 对未知 ref 也 resolve（不 reject → 不阻断发送）', typeof unknown === 'string')
eq('codec.clipboardText 回落到原文', I.sourceDef.codec.clipboardText('q1'), '原文')
eq('codec 的 source 名与 ReferenceInsert.source 一致', I.sourceDef.name, I.SOURCE)
eq('codec 的源不提供任何候选（菜单里不会多出条目）', (await I.sourceDef.candidates()).length, 0)

group('2. 提交时的最终提示词（模拟 sinkSerialized 的 clipboard 坐标拼接）')
reset()
seed('q1', { text: '这段代码为什么要加锁？', comment: '请给出最小复现。' })
live('s1', ['q1'])
// Clipboard projection: "解释一下" + chip("引用｜…", 8 chars) + " 的写法"
const chipText = '引用｜这段代码'
const promptDraft = `解释一下${chipText} 的写法`
const finalPrompt = await splice(promptDraft, [{ ref: 'q1', offset: '解释一下'.length, length: chipText.length }])
eq(
  '用户自己的话 + 结构化批注块',
  finalPrompt,
  '解释一下\n以下是我从上面的对话中选取的内容与我的批注，请逐条结合原文回应。\n'
  + '【对话批注 1】\n选取原文：\n> 这段代码为什么要加锁？\n我的批注：请给出最小复现。\n 的写法',
)

/* ------------------------------------------------------------------ *
 * 3. Detect-span math + chip removal
 * ------------------------------------------------------------------ */

group('3. 芯片定位与删除 (detectSpanOf / removeAnnotation)')

const OCC = [
  { occurrenceId: 1, source: I.SOURCE, ref: 'a', offset: 0, length: 3, label: 'A', clipboardText: 'AAA' },
  { occurrenceId: 2, source: I.SOURCE, ref: 'b', offset: 5, length: 4, label: 'B', clipboardText: 'BBBB' },
]
eq('第一个芯片在 detect 坐标 0', I.detectSpanOf(OCC, 'a').start, 0)
eq('第一个芯片在 detect 坐标 1 结束（恒定 1 宽）', I.detectSpanOf(OCC, 'a').end, 1)
eq('后续芯片按前面芯片多出的字符数左移', I.detectSpanOf(OCC, 'b').start, 3)
eq('后续芯片同样只占 1 格', I.detectSpanOf(OCC, 'b').end, 4)
eq('未登记的 ref 返回 null', I.detectSpanOf(OCC, 'zzz'), null)
eq(
  '缺少 length 时回落到 clipboardText 长度',
  I.detectSpanOf([{ ref: 'x', offset: 2, clipboardText: 'xx' }, { ref: 'y', offset: 9 }], 'y').start,
  8,
)
eq('空表返回 null', I.detectSpanOf([], 'a'), null)

function removeCtx(options = {}) {
  const calls = []
  const facade = options.noInsertText === true
    ? {}
    : {
      actions: {
        insertText: (text, span) => {
          calls.push({ text, span })
          return options.applies === undefined ? true : options.applies
        },
      },
    }
  return { inputActions: facade, calls }
}

{
  const { inputActions, calls } = removeCtx()
  const quiet = console.warn
  console.warn = () => {}
  eq('删除芯片：用空文本替换它的 span', I.removeAnnotation(inputActions, OCC, 7, 'b'), true)
  eq('删除调用带上了正确 span 起点', calls[0]?.span?.start, 3)
  eq('删除调用带上了正确 span 终点', calls[0]?.span?.end, 4)
  eq('删除调用带上了 draftRev（CAS 前提）', calls[0]?.span?.draftRev, 7)
  eq('替换文本为空串', calls[0]?.text, '')
  eq('拒绝时留下可见告警（不再静默）', (() => {
    const { inputActions: f } = removeCtx({ applies: false })
    I.removeAnnotation(f, OCC, 7, 'a')
    return true
  })(), true)
  console.warn = quiet
}
{
  const { inputActions, calls } = removeCtx()
  eq('未知 ref 不发起删除', I.removeAnnotation(inputActions, OCC, 7, 'zzz'), false)
  eq('未知 ref 没有产生编辑调用', calls.length, 0)
}
{
  const { inputActions } = removeCtx({ noInsertText: true })
  eq('缺少 insertText 时不误操作', I.removeAnnotation(inputActions, OCC, 7, 'a'), false)
}
{
  const { inputActions } = removeCtx({ applies: false })
  eq('编辑器拒绝时如实返回 false', I.removeAnnotation(inputActions, OCC, 7, 'a'), false)
}

group('4. 标签与摘要 (chipLabel / snippet)')
eq('chipLabel 折叠空白并截断', I.chipLabel('a\n   b   c', { chipPrefix: '引用' }), '引用｜a b c')
eq('snippet 超过上限补省略号', I.snippet('abcdef', 4), 'abcd…')
eq('snippet 不超上限时不加省略号', I.snippet('abc', 4), 'abc')
eq('未登记的 ref 序号回落为 1', I.ordinalOf('nope'), 1)

/* ------------------------------------------------------------------ *
 * 5. Selection capture guards (installed DOM anchors)
 * ------------------------------------------------------------------ */

group('5. 选区捕获的边界 (readSelection)')

function buildPane(sessionId = 's1') {
  const pane = new FakeElement(['[data-conversation-session]'], { 'data-conversation-session': sessionId })
  const scroll = new FakeElement(['[data-conversation-scroll]'])
  scroll.parentElement = pane
  const row = new FakeElement(
    ['[data-chat-flow-key]', '[data-chat-turn]', '[data-chat-flow-kind]', '[data-chat-node-key]'],
    {
      'data-chat-flow-key': 'node-42',
      'data-chat-node-key': 'node-42',
      'data-chat-turn': '3',
      'data-chat-flow-kind': 'assistant-step',
    },
  )
  row.parentElement = scroll
  const leaf = textNode(row)
  const group = new FakeElement(['[data-chat-flow]'])
  group.parentElement = scroll
  const composerSeat = new FakeElement(['[data-composer-seat]'])
  composerSeat.parentElement = scroll
  const composerLeaf = textNode(composerSeat)
  const anchor = new FakeElement(['[data-quote-anchor]'])
  anchor.parentElement = composerSeat
  return { pane, scroll, row, leaf, group, composerSeat, composerLeaf, anchor }
}

const pane = buildPane()

globalThis.__selection = fakeSelection('选中的回答片段', fakeRange(pane.leaf, pane.leaf))
const good = I.readSelection(pane.anchor, 's1')
check('命中：返回快照', good !== null)
eq('快照文本已 trim', good?.text, '选中的回答片段')
eq('快照记录了节点种类', good?.kind, 'assistant-step')
eq('快照记录了节点 key', good?.nodeKey, 'node-42')
eq('快照带了矩形', good?.rect?.top, RECT.top)
eq('未超长的选区不标截断', good?.truncated, false)

globalThis.__selection = fakeSelection('选中的回答片段', fakeRange(pane.leaf, pane.leaf))
eq('会话 id 不匹配的面板不触发', I.readSelection(pane.anchor, 'other-session'), null)

const groupPane = buildPane()
globalThis.__selection = fakeSelection('分组里的文字', fakeRange(textNode(groupPane.group), textNode(groupPane.group)))
check('分组容器（data-chat-flow）内的选区也算正文', I.readSelection(groupPane.anchor, 's1') !== null)

globalThis.__selection = fakeSelection('x', fakeRange(pane.leaf, pane.leaf), true)
eq('折叠的选区不触发', I.readSelection(pane.anchor, 's1'), null)

globalThis.__selection = null
eq('没有选区时不触发', I.readSelection(pane.anchor, 's1'), null)

globalThis.__selection = fakeSelection('   ', fakeRange(pane.leaf, pane.leaf))
eq('纯空白选区不触发', I.readSelection(pane.anchor, 's1'), null)

globalThis.__selection = fakeSelection('输入框里的文字', fakeRange(pane.composerLeaf, pane.composerLeaf))
eq('输入框内的选区不触发（只认对话正文）', I.readSelection(pane.anchor, 's1'), null)

const other = buildPane('s2')
globalThis.__selection = fakeSelection('别的面板', fakeRange(other.leaf, other.leaf))
eq('不在本会话面板内的选区不触发', I.readSelection(pane.anchor, 's1'), null)

globalThis.__selection = fakeSelection('跨面板', fakeRange(pane.leaf, other.leaf))
eq('起点或终点落在别的面板不触发', I.readSelection(pane.anchor, 's1'), null)

const longText = 'x'.repeat(I.MAX_QUOTE_CHARS + 50)
globalThis.__selection = fakeSelection(longText, fakeRange(pane.leaf, pane.leaf))
const clipped = I.readSelection(pane.anchor, 's1')
eq('超长选区被截断到上限', clipped?.text.length, I.MAX_QUOTE_CHARS)
eq('超长选区被标记为截断', clipped?.truncated, true)
globalThis.__selection = null

/* ------------------------------------------------------------------ *
 * 6. Chip insertion path
 * ------------------------------------------------------------------ */

group('6. 插入芯片 (addAnnotation)')

const SNAP = {
  text: '选中的原文',
  truncated: false,
  rect: { top: 10, bottom: 20, left: 5, width: 40 },
  kind: 'assistant-step',
  nodeKey: 'node-1',
}

function makeCtx(options = {}) {
  const calls = { insert: [], notify: [] }
  const state = {
    phase: options.phase ?? 'plain',
    draft: options.draft ?? '',
    draftRev: options.draftRev ?? 7,
    occurrences: options.occurrences ?? [],
  }
  const facade = {
    state: { getSnapshot: () => state },
    insertReference: (reference, span) => {
      calls.insert.push({ reference, span })
      return options.insertReturns === undefined ? true : options.insertReturns
    },
    notify: (level, text) => { calls.notify.push({ level, text }) },
  }
  facade.actions = options.noCapture === true
    ? {}
    : {
      captureInsertion: () => ({
        start: options.caret ?? 5,
        end: options.caret ?? 5,
        draftRev: state.draftRev,
      }),
    }
  const scoped = { get: (key) => (key === 'conversation' ? { input: { for: () => facade } } : undefined) }
  const ctx = {
    get: (key) => {
      if (key === 'sessions') return { scope: (id) => (id === 's1' ? scoped : undefined) }
      return undefined
    },
  }
  return { ctx, inputActions: facade, calls, state, facade }
}

reset()
{
  const { ctx, inputActions, calls } = makeCtx({ draft: '已有草稿', caret: 2 })
  I.addAnnotation(ctx, inputActions, 's1', SNAP, I.copy())
  eq('插入调用发生一次', calls.insert.length, 1)
  eq('source 用的是注册的引用源名', calls.insert[0]?.reference.source, I.SOURCE)
  eq('clipboardText 保存完整原文', calls.insert[0]?.reference.clipboardText, '选中的原文')
  eq('label 是折叠后的摘要', calls.insert[0]?.reference.label, '引用｜选中的原文')
  eq('span 取自 captureInsertion（光标处）', calls.insert[0]?.span.start, 2)
  eq('零长 span（插入而非替换）', calls.insert[0]?.span.end, 2)
  eq('span 带上当前 draftRev（CAS 前提）', calls.insert[0]?.span.draftRev, 7)
  eq('记录已登记，评论为空', I.records.get(calls.insert[0].reference.ref)?.comment, '')
  eq('记录保留了来源节点 key', I.records.get(calls.insert[0].reference.ref)?.nodeKey, 'node-1')
  eq('每一次插入都用新的 ref', calls.insert[0].reference.ref.startsWith('q'), true)
}

reset()
{
  const { ctx, inputActions, calls } = makeCtx({ draft: '四个字', noCapture: true })
  I.addAnnotation(ctx, inputActions, 's1', SNAP, I.copy())
  eq('没有 captureInsertion 时插到草稿末尾', calls.insert[0]?.span.start, 3)
  eq('回落路径也带 draftRev', calls.insert[0]?.span.draftRev, 7)
}

reset()
{
  const { ctx, inputActions, calls } = makeCtx({ insertReturns: false })
  I.addAnnotation(ctx, inputActions, 's1', SNAP, I.copy())
  eq('插入失败时不留记录', I.records.size, 0)
  eq('插入失败时给出可见提示', calls.notify[0]?.level, 'error')
}

reset()
{
  const { ctx, inputActions, calls } = makeCtx({ phase: 'submitting' })
  I.addAnnotation(ctx, inputActions, 's1', SNAP, I.copy())
  eq('发送中不插入', calls.insert.length, 0)
  eq('发送中给出提示', calls.notify[0]?.text.includes('正在发送'), true)
  eq('发送中不登记记录', I.records.size, 0)
}

reset()
{
  const { ctx, inputActions, calls } = makeCtx({ phase: 'adjudicating' })
  I.addAnnotation(ctx, inputActions, 's1', SNAP, I.copy())
  eq('命令裁决中不插入', calls.insert.length, 0)
}

reset()
{
  const warnings = []
  const original = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  // The component resolves the facade through the session scope; an unknown
  // session yields none, and the click must degrade to a warning, never a throw.
  I.addAnnotation({ get: () => undefined }, undefined, 'unknown-session', SNAP, I.copy())
  console.warn = original
  eq('解析不到输入框时不抛异常、不插入', warnings.length, 1)
}

/* ------------------------------------------------------------------ *
 * 7. Markdown source (copy-markdown service) + Enter-to-collapse
 * ------------------------------------------------------------------ */

group('7. Markdown 源码（与复制插件联动）')

reset()
seed('q1', { text: '渲染后的纯文本', markdown: '$$E = mc^2$$', markdownSource: true })
live('s1', ['q1'])
check('提示词优先引用 markdown 源码', I.serializeAnnotation('q1').includes('> $$E = mc^2$$'))
eq('markdown 为空时退回纯文本', I.quotedSourceOf({ text: '纯文本', markdown: '' }), '纯文本')
eq('两者都没有时得到空串', I.quotedSourceOf({ text: '', markdown: undefined }), '')

{
  const pane = buildPane()
  globalThis.__selection = fakeSelection('渲染文本', fakeRange(pane.leaf, pane.leaf))
  const snap = I.readSelection(pane.anchor, 's1', () => '**源码**')
  eq('readSelection 采用 markdown 投影', snap?.markdown, '**源码**')
  eq('标记这次引用来自 markdown 源码', snap?.markdownSource, true)
  const fallback = I.readSelection(pane.anchor, 's1', () => '   ')
  eq('投影为空时退回渲染文本', fallback?.markdown, '渲染文本')
  eq('退回时不标 markdownSource', fallback?.markdownSource, false)
  const loud = console.warn
  console.warn = () => {}
  const broken = I.readSelection(pane.anchor, 's1', () => { throw new Error('boom') })
  console.warn = loud
  eq('投影抛错时仍能拿到文本', broken?.markdown, '渲染文本')
  globalThis.__selection = null
}

reset()
{
  const calls = { insert: [], notify: [] }
  const state = { phase: 'plain', draft: 'x', draftRev: 3, occurrences: [] }
  const facade = {
    state: { getSnapshot: () => state },
    actions: { captureInsertion: () => ({ start: 0, end: 0, draftRev: state.draftRev }) },
    insertReference: (reference, span) => { calls.insert.push({ reference, span }); return true },
    notify: (level, text) => { calls.notify.push({ level, text }) },
  }
  const ctx = { get: () => undefined }
  I.addAnnotation(ctx, facade, 's1', {
    text: '渲染文本', markdown: '$$x$$', markdownSource: true, truncated: false,
    rect: { top: 0, bottom: 0, left: 0, width: 0 }, kind: 'assistant-step', nodeKey: 'k',
  }, I.copy())
  const record = I.records.get(calls.insert[0].reference.ref)
  eq('记录保存了 markdown 源码', record?.markdown, '$$x$$')
  eq('记录标记了来源是 markdown', record?.markdownSource, true)
}

group('8. 评论框回车行为')

eq('Enter 收起批注框', I.isCommentSubmitKey({ key: 'Enter' }), true)
eq('Shift+Enter 不收起（用于换行）', I.isCommentSubmitKey({ key: 'Enter', shiftKey: true }), false)
eq('输入法组合中的 Enter 不收起', I.isCommentSubmitKey({ key: 'Enter', isComposing: true }), false)
eq('其他按键不收起', I.isCommentSubmitKey({ key: 'a' }), false)
eq('没有事件时不收起', I.isCommentSubmitKey(null), false)

/* ------------------------------------------------------------------ *
 * 9. 折叠已发送的用户消息（真实 DOM）
 * ------------------------------------------------------------------ */

group('9. 折叠已发送的用户消息')

/** The exact shape the serializer emits, as a sent user message would carry it. */
function serializedBlock(n, quote, comment) {
  const lines = []
  if (n === 1) lines.push('以下是我从上面的对话中选取的内容与我的批注，请逐条结合原文回应。')
  lines.push(`【对话批注 ${n}】`, '选取原文：')
  for (const line of quote.split('\n')) lines.push(`> ${line}`)
  if (comment !== undefined && comment !== '') lines.push(`我的批注：${comment}`)
  return lines.join('\n')
}

const BLOCK = `${serializedBlock(1, '为什么这样写？', '请解释')}\n${serializedBlock(2, '$$x^2$$')}`

{
  const sample = '随便说点什么\n【对话批注 1】\n选取原文：\n> a\n我的意见：b'
  const found = I.annotationRange(sample)
  eq('识别模式：前言不在时也认出批注块', found !== null && found.count === 1, true)
  eq('识别模式：起点落在批注块首行', sample.slice(found.start, found.start + 5), '【对话批注')
  eq('识别模式：终点收在最后一行之后', found.end, sample.length)
  eq('识别模式：块首行之前的寒暄没有被算进去', found.start > 0, true)
}
eq('识别模式：没有批注块时返回 null', I.annotationRange('普通的消息\n就两行'), null)
eq('识别模式：只有「我的意见」不算批注块', I.annotationRange('我的意见：这也太像了'), null)
eq(
  '识别模式：用户的普通引用行不会被误认',
  I.annotationRange('我引用一下\n> 别人的话\n就这样'),
  null,
)

{
  check('jsdom 可用（折叠的真实 DOM 测试）', true)
  const dom = new JSDOM(
    '<!doctype html><html><body><div data-conversation-session="s1">'
    + '<div data-chat-flow-key="user-1" data-chat-flow-kind="user">'
    + '<div class="bubble"><span class="plainRun" id="a"></span><span class="plainRun" id="b"></span></div>'
    + '</div></body></html>',
  )
  // The rendered bubble's text, split across several text nodes exactly as
  // projectUserText lays it out.
  dom.window.document.getElementById('a').textContent = BLOCK.slice(0, 20)
  dom.window.document.getElementById('b').textContent = BLOCK.slice(20)
  globalThis.window.requestAnimationFrame = (fn) => { fn(); return 1 }
  globalThis.document = dom.window.document
  const row = dom.window.document.querySelector('[data-chat-flow-kind="user"]')
  const before = row.textContent

  eq('折叠前正文确实包含批注块', before.includes('【对话批注 2】'), true)
  eq('折叠成功', I.foldUserMessage(row, I.copy()), true)
  eq('折叠是幂等的（不会重复折叠）', I.foldUserMessage(row, I.copy()), false)

  const chip = row.querySelector('[data-dsh-qa-fold]')
  check('出现折叠徽标', chip !== null)
  eq('徽标写着批注条数', chip?.textContent, '引用批注 2 条 · 展开')
  eq('徽标记录了条数', chip?.getAttribute('data-dsh-qa-fold'), '2')
  eq('正文里的长文本被收起（只剩徽标）', row.textContent.includes('选取原文'), false)
  eq('折叠面板默认隐藏', row.querySelector('.dsh-qa-fold-body')?.hidden, true)
  eq('徽标仍是气泡内的节点（未搬动 React 的节点）', chip.parentNode !== null, true)

  chip.dispatchEvent(new dom.window.Event('click', { bubbles: true }))
  const panel = row.querySelector('.dsh-qa-fold-body')
  eq('点击后展开', panel.hidden, false)
  eq('展开后拿到完整块文本', panel.textContent, BLOCK.trim())
  eq('展开后徽标改文案', chip.textContent, '引用批注 2 条 · 收起')
  chip.dispatchEvent(new dom.window.Event('click', { bubbles: true }))
  eq('再点一次收起', panel.hidden, true)
  // `hidden` is defeated by any author `display` rule, so collapsing must also
  // drop the text — otherwise the block stays on screen forever.
  eq('收起时面板文本被清空', panel.textContent, '')
  eq('收起后徽标文案还原', chip.textContent, '引用批注 2 条 · 展开')
  eq('收起后 aria-expanded 还原', chip.getAttribute('aria-expanded'), 'false')
  chip.dispatchEvent(new dom.window.Event('click', { bubbles: true }))
  eq('可以再次展开（来回切换都生效）', panel.hidden, false)
  eq('再次展开后文本回来', panel.textContent, BLOCK.trim())
  eq('再次展开后 aria-expanded 为 true', chip.getAttribute('aria-expanded'), 'true')
  chip.dispatchEvent(new dom.window.Event('click', { bubbles: true }))
  eq('第二次收起同样清空', panel.textContent, '')
}

/* ------------------------------------------------------------------ *
 * 10. 折叠的回归：跨多个 span、以及用户自己的文字
 * ------------------------------------------------------------------ */

group('10. 折叠回归（跨 span / 不误伤用户文字）')

function foldFixture(inner, id) {
  const dom = new JSDOM(
    `<!doctype html><html><body><div data-conversation-session="s1">`
    + `<div data-chat-flow-key="user-1" data-chat-flow-kind="user"><div class="bubble">${inner}</div></div>`
    + `</body></html>`,
  )
  globalThis.document = dom.window.document
  return { dom, row: dom.window.document.querySelector('[data-chat-flow-kind="user"]') }
}

{
  // Exactly how projectUserText lays a message out once it contains @reference:
  // the text is split into several spans around the chip.
  const b = `${serializedBlock(1, '问 @README.md 是什么', '好的')}`
  const head = '看一下\n'
  const mid = '\n选取原文：\n> 问 '
  const dom = new JSDOM(
    '<!doctype html><html><body><div data-conversation-session="s1">'
    + '<div data-chat-flow-kind="user"><div class="bubble">'
    + `<span>${head}【对话批注 1】</span>`
    + '<span class="refChip">@README.md</span>'
    + `<span>${mid.slice(0) + '是什么'}\n我的意见：好的</span>`
    + '</div></div></body></html>',
  )
  globalThis.document = dom.window.document
  const row = dom.window.document.querySelector('[data-chat-flow-kind="user"]')
  const before = row.textContent
  const folded = I.foldUserMessage(row, I.copy())
  check('跨多个 span 时折叠成功', folded === true)
  eq('跨 span 时正文只留徽标与前后文', row.textContent.includes('看一下'), true)
  eq('跨 span 时块文本被收起', row.textContent.includes('选取原文'), false)
  const chip = row.querySelector('[data-dsh-qa-fold]')
  eq('跨 span 时徽标条数正确', chip?.getAttribute('data-dsh-qa-fold'), '1')
  // The destructive path that used to erase the whole message must be impossible:
  // what is left on screen has to be the head text plus the chip.
  eq('用户自己的开头文字没有被抹掉', row.textContent.startsWith('看一下'), true)
  check('折叠前后不是“整条清空”', row.textContent.length > 0 && row.textContent !== before)
  void b
}

{
  // A user typing the pattern by hand must NOT be collapsed: every quoted line in
  // a real block carries the `> ` prefix, and the head line is the serializer's.
  const { row } = foldFixture('<span>我引用一下\n> 别人的话\n就这样</span>')
  eq('用户手写的普通引用行不被折叠', I.foldUserMessage(row, I.copy()), false)
  eq('未被折叠时正文原样保留', row.textContent, '我引用一下\n> 别人的话\n就这样')
}

{
  const { row } = foldFixture('<span>我的批注：这只是我的正文</span>')
  eq('只有「我的批注：」的正文不被折叠', I.foldUserMessage(row, I.copy()), false)
  const legacy = foldFixture('<span>我的意见：这只是我的正文</span>')
  eq('只有旧标签的正文同样不被折叠', I.foldUserMessage(legacy.row, I.copy()), false)
}

/* ------------------------------------------------------------------ *
 * 11. 未发送批注的存活：台账与芯片重建
 * ------------------------------------------------------------------ */

group('11. 离开会话/重启后批注仍然在')

function pendingRecord(ref, seq, markdown, comment) {
  return {
    ref, seq, text: markdown, labelText: markdown, markdown: markdown,
    markdownSource: true, comment: comment ?? '', kind: 'assistant-step', nodeKey: 'k',
    truncated: false, recovered: false, savedAt: Date.now(),
  }
}

// clipboard projection is the markdown source, so a degraded restore still reads well
eq('剪贴板投影优先用 markdown 源码', I.clipboardOf(pendingRecord('q1', 1, '$$E=mc^2$$')), '$$E=mc^2$$')
eq('没有 markdown 时退回纯文本', I.clipboardOf({ text: '纯文本', markdown: '' }), '纯文本')
{
  const ref = I.referenceOf(pendingRecord('q9', 1, '**粗**'), I.copy())
  eq('重建引用时沿用原 ref（codec 才找得到）', ref.ref, 'q9')
  eq('重建引用时 clipboardText 是源码', ref.clipboardText, '**粗**')
  eq('重建引用时 label 用源码做摘要（公式不再显示渲染字形）', ref.label, '引用｜**粗**')
  const formula = I.referenceOf(pendingRecord('qf', 1, '$$E = mc^2$$'), I.copy())
  eq('公式引用的芯片标签显示 TeX 源码', formula.label, '引用｜$$E = mc^2$$')
}

{
  // session switch: the mirror restored the projections as plain text
  storage.clear()
  reset()
  const saved = [pendingRecord('q1', 1, 'MDA'), pendingRecord('q2', 2, 'MDB')]
  for (const record of saved) { I.records.set(record.ref, record); I.rememberPending('s1', record) }
  eq('台账按会话记住未发送批注', I.loadPending('s1').size, 2)

  const calls = []
  const draft = `前言 MDA 中 MDB 结尾`
  const facade = {
    state: { getSnapshot: () => ({ phase: 'plain', draft, draftRev: 7, occurrences: [] }) },
    insertReference: (reference, span) => { calls.push({ reference, span }); return true },
  }
  eq('就地重建数量正确', I.restoreChips(facade, 's1', I.loadPending('s1'), 'in-place', I.copy()), 2)
  eq('两个芯片都插在各自原文的位置（倒序调用）', JSON.stringify(calls.map((c) => [c.span.start, c.span.end])), '[[9,12],[3,6]]')
  eq('倒序插入（先插后面的，前面偏移不失效）', calls[0].reference.ref, 'q2')
  eq('沿用原 ref', calls.map((c) => c.reference.ref).sort().join(','), 'q1,q2')
  eq('带上了当前 draftRev', calls[0].span.draftRev, 7)
}

{
  // app restart: DSH kept no draft, so the annotations are appended
  storage.clear()
  reset()
  for (const record of [pendingRecord('q1', 1, 'MDA'), pendingRecord('q2', 2, 'MDB')]) {
    I.records.set(record.ref, record); I.rememberPending('s2', record)
  }
  const calls = []
  const facade = {
    state: { getSnapshot: () => ({ phase: 'plain', draft: '', draftRev: 3, occurrences: [] }) },
    insertReference: (reference, span) => { calls.push({ reference, span }); return true },
  }
  eq('草稿为空时追加重建', I.restoreChips(facade, 's2', I.loadPending('s2'), 'append', I.copy()), 2)
  eq('追加在草稿末尾（零长 span）', JSON.stringify(calls.map((c) => [c.span.start, c.span.end])), '[[0,0],[0,0]]')
  eq('追加保持插入顺序', calls.map((c) => c.reference.ref).join(','), 'q1,q2')
}

{
  // the ledger round-trips through storage, so a page reload can rebuild it
  storage.clear()
  reset()
  I.rememberPending('s3', pendingRecord('q7', 1, 'MDA', '意见'))
  I.pendingBySession.delete('s3')
  I.records.delete('q7')
  const reloaded = I.loadPending('s3')
  eq('重载后台账还在', reloaded.size, 1)
  eq('重载后评论也还在', reloaded.get('q7')?.comment, '意见')
  eq('重载时把记录塞回 codec 的索引', I.records.get('q7')?.markdown, 'MDA')
  I.forgetPending('s3', 'q7')
  eq('移除单条后台账为空', I.loadPending('s3').size, 0)
  eq('移除后同时清掉 storage', storage.has('dsh-quote-annotate:pending:v1:s3'), false)
}

{
  // sending clears the ledger, which is what stops a resurrected annotation
  storage.clear()
  reset()
  I.rememberPending('s4', pendingRecord('q8', 1, 'MDA'))
  I.forgetAllPending('s4')
  eq('发送后台账清空', I.loadPending('s4').size, 0)
  // The codec record is KEPT: an emptied composer is also a failed send about
  // to restoreDraft the same chips, which must not serialize as "原文已丢失".
  I.records.set('q8', pendingRecord('q8', 1, 'MDA'))
  I.rememberPending('s4', I.records.get('q8'))
  I.forgetAllPending('s4')
  eq('清空台账但保留 codec 记录（失败重发/撤销还能展开）', I.records.has('q8'), true)
}

{
  // too old to be resurrected
  storage.clear()
  reset()
  const stale = pendingRecord('q5', 1, 'MDA')
  stale.savedAt = Date.now() - 8 * 24 * 60 * 60 * 1000
  storage.set('dsh-quote-annotate:pending:v1:s5', JSON.stringify([stale]))
  I.pendingBySession.delete('s5')
  eq('超过保留期的批注不会被复活', I.loadPending('s5').size, 0)
}

{
  // only our own chips count
  const state = { occurrences: [
    { source: 'file', ref: 'f1' },
    { source: I.SOURCE, ref: 'q1' },
    { source: I.SOURCE, ref: 'q2' },
  ] }
  eq('只认自己的芯片', I.ownOccurrences(state).map((o) => o.ref).join(','), 'q1,q2')
  eq('空状态不报错', I.ownOccurrences(undefined).length, 0)
}

/* ------------------------------------------------------------------ *
 * 12. 验收回归（2026-10-01）
 * ------------------------------------------------------------------ */

group('12. 验收回归')

{
  // ✕ must count foreign chips: `@README.md` before our chip shifts detect coordinates
  const all = [
    { source: 'file', ref: 'f1', offset: 0, length: 10, clipboardText: '@README.md' },
    { source: I.SOURCE, ref: 'q1', offset: 11, length: 5, clipboardText: 'hello' },
  ]
  eq('完整占位表下 span 正确（含别人的芯片）', JSON.stringify(I.detectSpanOf(all, 'q1')), '{"start":2,"end":3}')
  const calls = []
  const facade = { actions: { insertText: (text, span) => { calls.push(span); return true } } }
  I.removeAnnotation(facade, all, 4, 'q1')
  eq('✕ 删除的是芯片本身', calls[0]?.start, 2)
}

{
  // multi-line comment keeps the fold going and cannot forge a header
  reset()
  seed('a', { text: 'alpha', comment: '第一行\n【对话批注 2】\n选取原文：\n> 伪造' })
  seed('b', { text: 'beta', comment: 'ok' })
  live('s', ['a', 'b'])
  const block = I.serializeAnnotation('a')
  check('评论续行带固定前缀', block.includes('\n｜【对话批注 2】\n｜选取原文：\n｜> 伪造'), JSON.stringify(block))
  check('评论无法伪造第二个批注头', !/\n【对话批注 2】/u.test(block))
  const prompt = `我的话${block}${I.serializeAnnotation('b')}`.trim()
  const range = I.annotationRange(prompt)
  eq('多行评论后仍折叠全部批注', range?.count, 2)
  eq('折叠到消息末尾，不漏后续批注', range?.end, prompt.length)
}

{
  // the user's own header-looking text is never folded
  eq('非数字头不折叠', I.annotationRange('【对话批注 说明】这是我自己写的\n请帮我改一下'), null)
  eq('手打数字头但没有原文行不折叠', I.annotationRange('请看：\n【对话批注 1】\n我手打的笔记\n后面还有'), null)
  const real = `【对话批注 1】\n我的笔记\n\n以下是我从上面的对话中选取的内容与我的批注，请逐条结合原文回应。\n【对话批注 1】\n选取原文：\n> x`
  eq('前面的仿冒头不挡住后面真正的批注块', I.annotationRange(real)?.count, 1)
}

{
  // ordinals are per session and follow document order
  reset()
  seed('old', { seq: 7, text: 'A' })
  seed('new', { seq: 1, text: 'B' })
  live('s1', ['old', 'new'])
  eq('序号按草稿中的位置（旧芯片在前）', I.ordinalOf('old'), 1)
  eq('新芯片排第二', I.ordinalOf('new'), 2)
  seed('other', { text: 'C' })
  live('s2', ['other'])
  eq('另一会话的唯一批注编号为 1', I.ordinalOf('other'), 1)
  check('另一会话的唯一批注带引言', I.serializeAnnotation('other').includes('以下是我从上面的对话中'))
}

{
  // restored seq feeds the counter
  reset()
  I.rememberPending('s7', pendingRecord('qold', 41, 'MDA'))
  I.pendingBySession.delete('s7')
  I.records.delete('qold')
  I.loadPending('s7')
  const facade = {
    state: { getSnapshot: () => ({ phase: 'plain', draft: '', draftRev: 1 }) },
    actions: { captureInsertion: () => ({ start: 0, end: 0, draftRev: 1 }) },
    insertReference: () => true,
    notify: () => {},
  }
  const ref = I.addAnnotation({}, facade, 's7', { text: 'x', markdown: 'x', truncated: false, kind: '', nodeKey: '' }, I.copy())
  check('新批注的 seq 排在恢复的批注之后', I.records.get(ref)?.seq > 41)
  eq('新批注记下了所属会话', I.records.get(ref)?.sessionId, 's7')
}

{
  // large ledgers are written compactly and never exceed what the reader accepts
  reset()
  const big = 'x'.repeat(5990)
  for (let i = 0; i < 30; i += 1) I.rememberPending('s8', pendingRecord(`qb${i}`, i + 1, `${big}${i}`))
  const raw = storage.get('dsh-quote-annotate:pending:v1:s8')
  check('30 条长引用写入未超过读取上限', raw.length <= I.PENDING_MAX_STORAGE_CHARS, String(raw.length))
  check('存储不重复 text/labelText', !raw.includes('"labelText"') && !raw.includes('"text"'))
  I.pendingBySession.delete('s8')
  eq('重载后全部恢复', I.loadPending('s8').size, 30)
  eq('恢复后 text 回填为 markdown', I.records.get('qb0')?.text, `${big}0`)

  reset()
  const huge = 'y'.repeat(6000)
  let dropped = 0
  for (let i = 0; i < 120; i += 1) dropped = I.rememberPending('s9', pendingRecord(`qh${i}`, i + 1, `${huge}${i}`, huge))
  check('超出上限时报告未持久化的条数', dropped > 0)
  const kept = storage.get('dsh-quote-annotate:pending:v1:s9')
  check('仍写入一份可被读取的台账', kept !== undefined && kept.length <= I.PENDING_MAX_STORAGE_CHARS)
  check('丢弃的是最早的批注', !kept.includes('"qh0"') && kept.includes('"qh119"'))
  I.pendingBySession.delete('s9')
  check('重载能读回保留下来的部分', I.loadPending('s9').size > 0)
}

{
  // legacy oversized payloads are salvaged, not discarded whole
  reset()
  const legacy = []
  for (let i = 0; i < 30; i += 1) {
    const t = 'z'.repeat(6000)
    legacy.push({ ref: `ql${i}`, seq: i, text: t, labelText: t, markdown: t, comment: '', savedAt: Date.now() })
  }
  storage.set('dsh-quote-annotate:pending:v1:s10', JSON.stringify(legacy))
  eq('旧版超大台账仍能恢复', I.loadPending('s10').size, 30)
}

{
  // in-place restore anchors on the chip's last offset, unmatched ones are appended
  reset()
  const record = pendingRecord('qy', 1, '是的')
  record.offset = 10
  const lost = pendingRecord('qz', 2, '找不到的原文')
  I.records.set('qy', record); I.records.set('qz', lost)
  const map = new Map([['qy', record], ['qz', lost]])
  const draft = '是的，我同意。关于"是的"这一点'
  const calls = []
  let current = draft
  const facade = {
    state: { getSnapshot: () => ({ phase: 'plain', draft: current, draftRev: 1 }) },
    insertReference: (reference, span) => { calls.push({ ref: reference.ref, span }); return true },
  }
  eq('就地 + 追加共恢复 2 条', I.restoreChips(facade, 's11', map, 'in-place', I.copy()), 2)
  eq('同文本按原偏移就近匹配', calls.find((c) => c.ref === 'qy')?.span.start, 10)
  eq('找不到投影的批注追加到末尾而不是丢掉', calls.find((c) => c.ref === 'qz')?.span.start, draft.length)
}

{
  // codec and chip agree on the clipboard projection
  reset()
  seed('qm', { text: 'E = mc2', markdown: '$E = mc^2$' })
  eq('codec.clipboardText 与芯片一致', I.sourceDef.codec.clipboardText('qm'), I.referenceOf(I.records.get('qm'), I.copy()).clipboardText)
}

{
  // keyCode 229 (WebKit composition confirm) never closes the card
  eq('keyCode 229 的回车不收起卡片', I.isCommentSubmitKey({ key: 'Enter', isComposing: false, keyCode: 229 }), false)
}

{
  // the record index stays bounded but never evicts what is live or pending
  reset()
  for (let i = 0; i < I.MAX_RECORDS + 50; i += 1) seed(`qr${i}`, { seq: i + 1, text: `t${i}` })
  live('s12', ['qr0'])
  I.pruneRecords()
  check('记录索引有上限', I.records.size <= I.MAX_RECORDS)
  check('在草稿中的记录不被淘汰', I.records.has('qr0'))
  check('最新的记录保留', I.records.has(`qr${I.MAX_RECORDS + 49}`))
}

/* ------------------------------------------------------------------ *
 * 13. Slash commands: plain text only
 *
 * A claimed command's submit builds its arguments from the draft's clipboard
 * projection and never calls a codec (Harness SubmitMachine.argsAfter). The
 * plugin therefore expands live annotations to their serialized text right
 * before such a submit. These cases model the machine's args derivation and the
 * editor's replace-span edit, so the "comment lost" bug stays reproducible.
 * ------------------------------------------------------------------ */

group('13. 斜杠命令：一次回车自动拆成两条发送')

/** Replicate SubmitMachine.argsAfter (installed Harness source). */
function argsAfter(draft, token) {
  const text = String(draft ?? '').trimStart()
  const base = String(token ?? '').trimEnd()
  if (base === '' || !text.startsWith(base)) return ''
  const rest = text.slice(base.length)
  return /^\s/u.test(rest) ? rest.slice(1) : rest
}

/** Let every queued microtask (the guard's deferred split) run. */
const flush = async () => { await Promise.resolve(); await Promise.resolve() }

/**
 * A composer facade with just enough of the real editor for the split: the
 * claimed command chip, reference chips, the detect/clipboard coordinate
 * difference, edits, submit and settle.
 */
function splitFacade({ draft, occurrences = [], claimToken = '/计划 ', phase = 'claimed', failRebuild = 0 }) {
  const state = {
    phase,
    draft,
    draftRev: 1,
    occurrences: occurrences.map((occurrence) => ({ ...occurrence })),
    ...(claimToken === undefined ? {} : { claim: { name: 'plan', token: claimToken } }),
  }
  const listeners = new Set()
  const notifyState = () => { for (const listener of [...listeners]) listener() }
  // detect index -> clipboard index (the command chip and every reference chip
  // are one character wide in detect coordinates).
  const positions = () => {
    const out = []
    let clipboard = 0
    let detect = 0
    const claimWidth = typeof state.claim?.token === 'string' ? state.claim.token.trimEnd().length : 0
    if (claimWidth > 0) { out[detect] = clipboard; detect += 1; clipboard += claimWidth }
    for (const chip of [...state.occurrences].sort((left, right) => left.offset - right.offset)) {
      while (clipboard < chip.offset) { out[detect] = clipboard; detect += 1; clipboard += 1 }
      out[detect] = clipboard
      detect += 1
      clipboard += chip.length
    }
    while (clipboard <= String(state.draft).length) { out[detect] = clipboard; detect += 1; clipboard += 1 }
    return out
  }
  const at = (position) => {
    const table = positions()
    return table[Math.max(0, Math.min(position, table.length - 1))]
  }
  const submitted = []
  const notices = []
  let rebuildFailures = failRebuild
  const facade = {
    state: {
      getSnapshot: () => state,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    actions: {
      insertText: (text, span) => {
        if (state.phase === 'plain' && rebuildFailures > 0) {
          rebuildFailures -= 1
          return false
        }
        const start = at(span.start)
        const end = at(span.end)
        const delta = text.length - (end - start)
        state.draft = state.draft.slice(0, start) + text + state.draft.slice(end)
        state.occurrences = state.occurrences
          .filter((occurrence) => !(occurrence.offset >= start && occurrence.offset + occurrence.length <= end))
          .map((occurrence) => (occurrence.offset >= end ? { ...occurrence, offset: occurrence.offset + delta } : occurrence))
        // Replacing from detect 0 would remove the command chip.
        if (span.start === 0 && state.claim !== undefined) delete state.claim
        state.draftRev += 1
        return true
      },
    },
    insertReference: (reference, span) => {
      const start = at(span.start)
      const end = at(span.end)
      const tail = state.draft[end] ?? ''
      const inserted = reference.clipboardText + (tail === ' ' ? '' : ' ')
      const delta = inserted.length - (end - start)
      state.draft = state.draft.slice(0, start) + inserted + state.draft.slice(end)
      state.occurrences = state.occurrences.map((occurrence) => (occurrence.offset >= end
        ? { ...occurrence, offset: occurrence.offset + delta }
        : occurrence))
      state.occurrences.push({
        source: reference.source,
        ref: reference.ref,
        offset: start,
        length: reference.clipboardText.length,
        label: reference.label,
        clipboardText: reference.clipboardText,
      })
      state.occurrences.sort((left, right) => left.offset - right.offset)
      state.draftRev += 1
      return true
    },
    notify: (level, text) => { notices.push({ level, text }) },
    submit: (...args) => {
      submitted.push({
        draft: state.draft,
        argsText: argsAfter(state.draft, state.claim?.token),
        mode: args[0],
        chips: state.occurrences.length,
      })
      state.phase = 'submitting'
      notifyState()
    },
  }
  /** Simulate the command plane: commit clears the draft, a failure keeps it. */
  const settle = (ok) => {
    if (ok) {
      state.draft = ''
      state.occurrences = []
      delete state.claim
    }
    state.phase = 'plain'
    notifyState()
  }
  return { facade, state, submitted, notices, settle }
}

const SPLIT_DRAFT = '/计划 看看原文A'
const splitChip = () => ({ source: I.SOURCE, ref: 'c1', offset: 6, length: 3, label: '引用｜原文A', clipboardText: '原文A' })

{
  // 1) the recipe: detect width, the message part, the chips to rebuild
  reset()
  seed('c1', { text: '原文A', comment: '评论A' })
  const { state } = splitFacade({ draft: SPLIT_DRAFT, occurrences: [splitChip()] })
  eq('detect 宽度：命令芯片与批注芯片各占 1', I.detectLengthOf(state), 5)
  eq('命令 token 之后就是消息正文', I.tokenRest(SPLIT_DRAFT, '/计划 '), '看看原文A')
  const plan = I.splitPlanOf(state)
  eq('配方取到消息正文', plan?.rest, '看看原文A')
  eq('配方记录芯片相对位置', plan?.chips?.[0]?.offset, 2)
  eq('配方带 1 个待重建的芯片', plan?.pending?.size, 1)
  eq('有别的来源的芯片时不拆', I.splitPlanOf({ ...state, occurrences: [...state.occurrences, { source: '@file', ref: 'f0', offset: 0, length: 4, clipboardText: '@a.md' }] }), null)
  eq('只有命令没有正文时不拆', I.splitPlanOf({ ...state, draft: '/计划 ' }), null)
  eq('没有认领芯片时不拆', I.splitPlanOf({ ...state, claim: undefined }), null)
  eq('带附件时不拆（附件重建不出来）', I.splitPlanOf({ ...state, attachmentIds: ['a1'] }), null)
}

{
  // 2) one Enter: command first (empty arguments), then the message automatically
  reset()
  seed('c1', { text: '原文A', comment: '评论A' })
  const run = splitFacade({ draft: SPLIT_DRAFT, occurrences: [splitChip()] })
  I.installCommandGuard(run.facade, 's13', () => null)
  run.facade.submit('queue', 'enter')
  eq('回车先不提交（离开编辑器 update）', run.submitted.length, 0)
  await flush()
  eq('命令先单独发出', run.submitted.length, 1)
  eq('命令的参数是空的', run.submitted[0].argsText, '')
  eq('发出时草稿只剩命令芯片', run.submitted[0].draft, '/计划')
  eq('芯片已从草稿里移走', run.state.occurrences.length, 0)
  eq('提交后进入发送中', run.state.phase, 'submitting')
  run.settle(true)
  await flush()
  eq('命令结算后自动发出批注消息', run.submitted.length, 2)
  eq('第二条不再带命令 token', run.submitted[1].draft.startsWith('/计划'), false)
  check('第二条带上消息正文', run.submitted[1].draft.includes('看看'))
  eq('第二条把批注芯片恢复了', run.submitted[1].chips, 1)
  eq('整个过程没有报错提示', run.notices.filter((notice) => notice.level === 'error').length, 0)
}

{
  // 3) the command keeping its draft (refused/failed) must not drop the message
  reset()
  seed('c1', { text: '原文A', comment: '评论A' })
  const run = splitFacade({ draft: SPLIT_DRAFT, occurrences: [splitChip()] })
  I.installCommandGuard(run.facade, 's14', () => null)
  run.facade.submit('queue', 'enter')
  await flush()
  eq('命令先发出', run.submitted.length, 1)
  run.settle(false)
  await flush()
  eq('命令失败时不自动发第二条', run.submitted.length, 1)
  check('消息被放回输入框', run.state.draft.includes('看看'))
  eq('批注芯片也放回来了', run.state.occurrences.length, 1)
  eq('给出错误提示', run.notices[0]?.level, 'error')
}

{
  // 4) chips from another source cannot be rebuilt: refuse instead of splitting
  const foreign = splitFacade({
    draft: `${SPLIT_DRAFT}`,
    occurrences: [
      splitChip(),
      { source: '@file', ref: 'f1', offset: 4, length: 5, label: '@a.md', clipboardText: '@a.md' },
    ],
  })
  I.installCommandGuard(foreign.facade, 's15', () => null)
  foreign.facade.submit('queue', 'enter')
  await flush()
  eq('有别的引用时拒绝发送', foreign.submitted.length, 0)
  eq('有别的引用时草稿原样', foreign.state.draft, SPLIT_DRAFT)
  eq('有别的引用时给出提示', foreign.notices[0]?.level, 'error')
}

{
  // 5) a native quote makes the split unsafe: refuse
  reset()
  seed('c1', { text: '原文A', comment: '评论A' })
  const quoted = splitFacade({ draft: SPLIT_DRAFT, occurrences: [splitChip()] })
  const seat = { querySelector: () => ({}) }
  I.installCommandGuard(quoted.facade, 's16', () => seat)
  quoted.facade.submit('queue', 'enter')
  eq('有原生引用时拒绝发送', quoted.submitted.length, 0)
  eq('有原生引用时给出提示', quoted.notices[0]?.level, 'error')
}

{
  // 6) the ordinary paths still submit untouched
  const plain = splitFacade({ draft: '看看原文A', occurrences: [splitChip()], claimToken: undefined, phase: 'plain' })
  I.installCommandGuard(plain.facade, 's17', () => null)
  plain.facade.submit('queue', 'enter')
  eq('普通消息直接提交', plain.submitted.length, 1)
  eq('普通消息不动芯片', plain.state.occurrences.length, 1)

  const bare = splitFacade({ draft: '/计划', occurrences: [], claimToken: '/计划' })
  I.installCommandGuard(bare.facade, 's18', () => null)
  bare.facade.submit('queue', 'enter')
  eq('没有批注的命令直接提交', bare.submitted.length, 1)
  eq('没有批注的命令参数为空', bare.submitted[0].argsText, '')
}

{
  // 7) a second Enter while the split is in flight never double-submits
  reset()
  seed('c1', { text: '原文A', comment: '评论A' })
  const run = splitFacade({ draft: SPLIT_DRAFT, occurrences: [splitChip()] })
  I.installCommandGuard(run.facade, 's19', () => null)
  run.facade.submit('queue', 'enter')
  run.facade.submit('queue', 'enter')
  await flush()
  eq('拆分进行中再次回车不会多提交', run.submitted.length, 1)
}

{
  // 7b) a transient edit refusal is retried instead of losing the message
  reset()
  seed('c1', { text: '原文A', comment: '评论A' })
  const run = splitFacade({ draft: SPLIT_DRAFT, occurrences: [splitChip()], failRebuild: 1 })
  I.installCommandGuard(run.facade, 's20', () => null)
  run.facade.submit('queue', 'enter')
  await flush()
  run.settle(true)
  await flush()
  await flush()
  eq('重建被拒一次后会重试并发出第二条', run.submitted.length, 2)
  check('重试后消息正文还在', run.submitted[1]?.draft.includes('看看'))
  eq('重试成功不报错', run.notices.filter((notice) => notice.level === 'error').length, 0)
}

{
  // 8) the card tells the user what will happen
  check('卡片提示：命令与批注会分成两条', I.copy().commandHint.includes('分成两条'))
  check('拒绝文案：说明先单独发送命令', I.copy().commandUnsupported.includes('先单独发送命令'))
  eq('旧的成功提示文案已移除', I.copy().commandExpanded, undefined)
  eq('旧的展开失败文案已移除', I.copy().commandExpandFailed, undefined)
  eq('旧的引用块提示文案已移除', I.copy().commandBlockedByQuote, undefined)
}

{
  // 9) the claimed command chip still shifts detect coordinates (✕ removal)
  reset()
  seed('c6', { text: '原文F', comment: '评论F' })
  const { state } = splitFacade({
    draft: '/计划 原文F',
    occurrences: [{ source: I.SOURCE, ref: 'c6', offset: 4, length: 4, label: '引用｜原文F', clipboardText: '原文F' }],
  })
  eq('命令芯片的 detect 折扣', I.commandChipShift(state), 2)
  eq('不给折扣时算出来的位置是错的', I.detectSpanOf(state.occurrences, 'c6').start, 4)
  eq('给折扣后落在真实的 detect 位置', I.detectSpanOf(state.occurrences, 'c6', I.commandChipShift(state)).start, 2)
  eq('没有命令时折扣为 0', I.commandChipShift({ phase: 'plain', draft: '/计划 看看' }), 0)
  eq('没有 claim 字段时折扣为 0', I.commandChipShift({}), 0)
  eq('空状态安全', I.commandChipShift(undefined), 0)
  eq('命令 token 带分隔符时按 trimEnd 计', I.commandChipShift({ claim: { token: '/plan ' } }), 4)
  eq('命令 token 无分隔符时原样计', I.commandChipShift({ claim: { token: '/plan' } }), 4)
}

{
  // 10) isCommandDraft covers the two ways a line becomes a command
  eq('普通草稿不算命令', I.isCommandDraft({ phase: 'plain', draft: '你好' }), false)
  eq('前导斜杠算命令（含前导空白）', I.isCommandDraft({ phase: 'plain', draft: '   /计划 看看' }), true)
  eq('已认领的命令算命令', I.isCommandDraft({ phase: 'claimed', draft: '/计划 ' }), true)
  eq('认领状态与草稿内容无关', I.isCommandDraft({ phase: 'claimed', draft: '' }), true)
  eq('空状态安全', I.isCommandDraft(undefined), false)
  eq('空草稿不算命令', I.isCommandDraft({ phase: 'plain', draft: '' }), false)
  eq('裁决中不再重复处理', I.isCommandDraft({ phase: 'adjudicating', draft: '/计划 看看' }), false)
  eq('发送中不再重复处理', I.isCommandDraft({ phase: 'submitting', draft: '/计划 看看' }), false)
  eq('已发送等待中不再重复处理', I.isCommandDraft({ phase: 'sending', draft: '/计划 看看' }), false)
}

{
  // 11) removing a chip across a native quote refuses instead of editing blind
  reset()
  seed('c8', { text: '原文H' })
  const occurrences = [{ source: I.SOURCE, ref: 'c8', offset: 0, length: 1, label: 'x', clipboardText: 'x' }]
  const calls = []
  const facade = { actions: { insertText: (...args) => { calls.push(args); return true } } }
  const quoted = { querySelector: () => ({}) }
  eq('有原生引用时拒绝移除', I.removeAnnotation(facade, occurrences, 1, 'c8', 0, quoted), 'quote')
  eq('拒绝时不动输入框', calls.length, 0)
  eq('没有原生引用时照常移除', I.removeAnnotation(facade, occurrences, 1, 'c8', 0, { querySelector: () => null }), true)
  eq('正常移除提交空文本替换', calls[0]?.[0], '')
  eq('移除请求带上 draftRev CAS', calls[0]?.[1]?.draftRev, 1)
  eq('hasComposerQuote 识别挂载的引用', I.hasComposerQuote(quoted), true)
  eq('hasComposerQuote 没有引用时为 false', I.hasComposerQuote({ querySelector: () => null }), false)
  eq('hasComposerQuote 空座位安全', I.hasComposerQuote(undefined), false)
  eq('hasComposerQuote 没有 DOM 查询也不抛', I.hasComposerQuote({}), false)
  const seat = { querySelector: () => null }
  eq('composerSeatOf 找到座位', I.composerSeatOf({ closest: () => seat }), seat)
  eq('composerSeatOf 不在座位内时为 null', I.composerSeatOf({ closest: () => null }), null)
  eq('composerSeatOf 空节点安全', I.composerSeatOf(null), null)
}

/* ------------------------------------------------------------------ *
 * 14. The native quote button beside a selection
 *
 * The shipped quote plugin renders its action into the keyed `quote` cell of
 * `conversation.chat.text-interaction` at the default priority 0. Since DSH
 * 0.2.3 a keyed slot allows the same key only at different priorities and the
 * lowest priority renders, so this plugin registers an empty component at -1
 * to shadow that occupant, leaving quoting itself (insertQuote, `> ` previews)
 * to the shipped plugin.
 * ------------------------------------------------------------------ */

group('14. 选区旁的按钮：顶掉原生「引用」')

function fakeApplyCtx({ failShadow = false } = {}) {
  const registrations = []
  const injections = []
  const sources = []
  const scope = {
    effect: (run) => { const disposer = run(); return typeof disposer === 'function' ? disposer : () => {} },
    inputTriggers: {
      registerSource: (definition) => { sources.push(definition); return () => {} },
    },
  }
  const ctx = {
    effect: (run) => { const disposer = run(); return typeof disposer === 'function' ? disposer : () => {} },
    inject: (deps, callback) => { injections.push(deps.join(',')); callback(scope); return () => {} },
    slots: {
      inject: (name, callback) => { injections.push(name); return callback() },
      register: (options, component) => {
        if (failShadow && options.name === 'conversation.chat.text-interaction') {
          throw new Error('keyed slot "conversation.chat.text-interaction" already has an entry for key "quote" at priority -1')
        }
        registrations.push({ options, component })
        return () => {}
      },
    },
    get: () => undefined,
  }
  return { ctx, registrations, injections, sources }
}

{
  const { ctx, registrations, injections, sources } = fakeApplyCtx()
  // The fold installer runs inside apply(); earlier groups leave jsdom's document
  // installed, and Node has no global MutationObserver.
  const observer = globalThis.MutationObserver
  if (typeof observer !== 'function') {
    globalThis.MutationObserver = class { observe() {} disconnect() {} }
  }
  try {
    plugin.apply(ctx)
  } finally {
    if (typeof observer !== 'function') delete globalThis.MutationObserver
  }
  const quoteAction = registrations.find((row) => row.options.name === I.QUOTE_ACTION_SLOT)
  eq('给选区面板注册了一个条目', quoteAction !== undefined, true)
  eq('占的是原生按钮那一格', quoteAction?.options.key, 'quote')
  eq('顶替使用的 priority 就是这个常量', quoteAction?.options.priority, I.NATIVE_QUOTE_PRIORITY)
  check('priority 低于原生默认 0（0.2.3 起 lowest 渲染）', typeof quoteAction?.options.priority === 'number' && quoteAction.options.priority < 0)
  eq('组件就是 HiddenQuoteAction', quoteAction?.component, I.HiddenQuoteAction)
  eq('渲染结果为空（没有按钮）', quoteAction === undefined ? 'missing' : quoteAction.component({}), null)
  eq('原生按钮那格只注册一次', registrations.filter((row) => row.options.name === I.QUOTE_ACTION_SLOT).length, 1)

  const dock = registrations.find((row) => row.options.name === 'conversation.input.dock')
  eq('输入框上方的批注卡片位仍然注册', dock?.options.id, 'quote-annotate')
  eq('卡片位排序不变', dock?.options.order, 30)
  eq('引用源仍然注册', sources[0]?.name, 'dsh-quote')
  check('两个槽都走「等声明」再注册', injections.includes(I.QUOTE_ACTION_SLOT) && injections.includes('conversation.input.dock'))
}

{
  // A refused shadow registration must cost only the button, never the plugin:
  // the 0.2.3 same-priority rejection used to fail the whole client half.
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  const observer = globalThis.MutationObserver
  if (typeof observer !== 'function') {
    globalThis.MutationObserver = class { observe() {} disconnect() {} }
  }
  const { ctx, registrations, sources } = fakeApplyCtx({ failShadow: true })
  let threw = null
  try {
    try {
      plugin.apply(ctx)
    } catch (error) {
      threw = error
    }
  } finally {
    console.warn = originalWarn
    if (typeof observer !== 'function') delete globalThis.MutationObserver
  }
  eq('阴影注册被拒时 apply 不抛异常', threw, null)
  check('阴影注册被拒时留下可见警告', warnings.some((line) => line.includes('quote action')))
  eq('阴影失败不影响批注卡片位', registrations.find((row) => row.options.name === 'conversation.input.dock')?.options.id, 'quote-annotate')
  eq('阴影失败不影响引用源', sources[0]?.name, 'dsh-quote')
}

/* ------------------------------------------------------------------ *
 * Summary
 * ------------------------------------------------------------------ */

console.log(`\n${pass} 项通过, ${fail} 项失败`)
if (fail > 0) {
  console.error(`失败项: ${failures.join('; ')}`)
  process.exitCode = 1
}
