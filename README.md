# @local/dsh-quote-annotate — 对话引用批注

[English](README.en.md) | 中文

[![verify](https://github.com/Rayzenchen/dsh-quote-annotate/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Rayzenchen/dsh-quote-annotate/actions/workflows/ci.yml)

把 Codex Desktop 的「选中回答文字 → 添加到输入框 → 写批注」搬到 DSH：
在对话正文里**选中一段文字**，选区旁浮出 **添加到输入框** 按钮；点一下，这段原文就以
**引用芯片**的形式进入输入框，同时输入框上方出现一张**批注卡**，可以为它单独写一条评论。
发送时，每条引用连同评论被序列化成一段结构化的中文批注块交给模型。

<p><img src="icon.svg" width="72" height="72" alt="对话引用批注图标：双引号"></p>

## 安装

**要求**：DeepSeek Harness `0.2.3-alpha.2` 或更新（清单里用 `engines.dsh` 声明了范围）。
纯 JavaScript，没有构建步骤。

从 GitHub 安装（`v1.0.0` 是标签，也可以省略跟 `main`）：

```sh
dsh plugin --profile <profile> add github:Rayzenchen/dsh-quote-annotate#v1.0.0
```

从本地目录安装：

```sh
dsh plugin --profile <profile> add /path/to/dsh-quote-annotate
```

在 Desktop 应用里，也可以让 agent 用 `plugin_manager` 的 `install_bundle` 装同一个 spec。
装完**刷新页面**即可（功能全在浏览器侧）；卸载用
`dsh plugin --profile <profile> remove @local/dsh-quote-annotate`。

如果你用 `link:` 方式把本目录装进某个 profile，那么在这里改代码 = 改已安装插件：
Client 半边改动刷新页面生效，Host 半边改动需要重启 DSH。

## 目录

```
dsh-quote-annotate-plugin/
├── package.json         清单：dsh.bundle.patch + dsh.client(platform=web)
├── cordis.patch.yml     Loader 补丁：插入 id=dsh-quote-annotate 这一行
├── index.js             Host 半边：无逻辑（功能全在浏览器侧），只为让包进入组合
├── client.js            Client 半边：引用源+codec、选区浮出按钮、批注卡片
├── icon.svg             插件管理页的图标（36×36，双引号，无底图）
├── locale/{zh,en}.json  插件管理页的标题、说明与详情入口
├── docs/                插件页的详情文档（DETAIL.zh.md / DETAIL.md）
├── tools/verify-core.mjs 276 项断言：序列化、芯片定址/增删、选区边界、插入、折叠、斜杠命令、按钮顶替
├── LICENSE              MIT
├── CHANGELOG.md         版本记录
├── README.en.md         英文 README
└── README.md            （本文件）
```

## 交互

1. 在对话正文里用鼠标选中一段文字（助手回答、你的消息、代码块、分组内的过程内容都行）。
2. 选区旁浮出 **＋ 添加到输入框**（DSH 自带的「引用」按钮已被本插件顶掉，见下节）。
   滚动、点别处、选区消失，按钮就消失。
3. 点它 → 输入框里出现一枚 **引用｜原文摘要** 芯片（插在编辑器光标处；没有光标时追加到末尾），
   输入框上方出现一张批注卡。
4. 在卡片里写 **你的批注**，写完 **按一次回车，卡片直接消失**——输入框里只留下那枚引用芯片；
   想再改就 **点输入框里的芯片**，卡片会重新展开并把光标放进批注框。**Shift+回车**才是换行。
   - 卡片很小：标题 + 最多两行原文（长文可「展开原文」）+ 批注输入框；**✕** 移除这条引用。
   - 直接在输入框里对着芯片按退格删掉，卡片会同步消失（芯片才是唯一事实来源）。
5. Enter 发送。输入框里只保留你自己的话和芯片。
6. 发送后，那条用户消息里的批注长文**被折成一枚「引用批注 N 条 · 展开」徽标**——
   提示词里当然还是完整内容（模型需要），但对话里不再把同一段原文再铺一遍；点徽标可当场展开核对。

## 原生「引用」按钮去哪了

DSH 自带的消息引用插件会在选区旁再浮出一个「引用」按钮，和本插件的「＋ 添加到输入框」并排。
本插件把这个按钮顶掉了：在 `conversation.chat.text-interaction`（keyed 槽）里注册了
`key: 'quote'`、`priority: -1` 的空组件。

> DSH 0.2.3 起，keyed 槽的规则从「同 key 后注册者替换先注册者」改成了「同 key 必须不同 priority，
> **priority 最低者渲染**，其余被遮蔽」。原生 `@deepseek-ai/dsh-message-quotes` 用的是默认 0，
> 所以这里用 -1 恰好顶掉它；两边 priority 相同时插件会直接抛
> `keyed slot "conversation.chat.text-interaction" already has an entry for key "quote"`，
> 整个 Client 半边激活失败。

- **顶的是按钮，不是引用**：原生引用本身（`insertQuote`、输入框里的引用块、消息里 `> ` 的引用预览）
  全部保持原样，那条发送通道照常可用。
- 选中文字时只剩本插件一个入口；禁用本插件，原生按钮就回来了。

## 未发送的批注不会丢

DSH 把每个会话的草稿镜像到会话 store 里，离开再回来时会用 `setDraft` 重新灌入——而
`setDraft` 会把编辑器清空重建为**纯文本**，芯片必然被销毁（唯一能重建芯片的 `restoreDraft`
只对"发送失败重发"开放）。所以本插件自己维护一份**按会话的待发台账**（内存 + `localStorage`，
保留 7 天），并在回到会话时把芯片重新铸回来：

| 情形 | 行为 |
|---|---|
| 切走再切回（草稿里还留着引用投影） | **就地重建**：把每段投影替换回芯片，你自己的文字位置不变 |
| 刷新页面 / 重启 DSH（草稿没了） | **追加重建**：把芯片补回输入框末尾，批注内容与评论都还在 |
| 已发送 | 台账清空（草稿被清空即视为发完），绝不会过一会儿又冒出来 |
| 发送失败 / 全选删除后撤销 | 台账清空时 **codec 记录保留**，芯片回来后会被重新收进台账，提示词仍是原文 + 批注（不会变成"原文已丢失"） |
| 手动删掉芯片 | 台账同步删掉；但记录保留，**Cmd+Z 撤销后**卡片与提示词仍能正确展开 |
| 同一段文字在草稿里出现多次 | 就地重建按芯片上次所在的偏移就近匹配；实在找不到的批注**追加到末尾**而不是丢掉 |
| 待发批注很多 | 只存源码一份（不再三份重复），写入前保证不超过读取上限；放不下时丢最早的并在输入框提示 |
| 超过 7 天没发 | 不再复活（避免陈旧批注突然出现） |

codec 记录本身有上限（200 条），只淘汰既不在任何草稿里、也不在任何台账里的旧记录。

芯片的"剪贴板投影"也改成了 **Markdown 源码**，所以在任何降级路径上（比如插件没加载）你看到的
仍是可读的源码而不是被打散的渲染字形；芯片标签同样用源码做摘要，公式会显示成 `引用｜$E = mc^2$`。

## 发送给模型的格式

每条引用独立成块；只有第一条带前言；编号只数**本会话草稿里当前还活着的**引用、按它们在草稿里的
先后排（分屏的另一个会话不参与计数），删掉前面那条不会留空档。多行评论的第二行起统一加 `｜` 前缀，
所以评论里写的 `【对话批注 2】` 之类文字既不会被模型读成另一条批注，也不会打断折叠：

```text
以下是我从上面的对话中选取的内容与我的批注，请逐条结合原文回应。
【对话批注 1】
选取原文：
> 第一行
> 第二行
我的批注：为什么这里要加锁？
【对话批注 2】
选取原文：
> …
我的批注：这条我保留意见。
｜第二行评论
```

## 斜杠命令消息（`/计划` 等）：一次回车，自动拆成两条发送

斜杠命令走的是另一条发送通道：命令拿到的是**草稿的纯文本投影**，不经过引用芯片的 codec
展开（安装版的 `SubmitMachine.argsAfter` 只做「去掉开头的命令 token」）。所以在命令消息里，
芯片只会退化成它的剪贴板投影——对引用批注来说就是"被选中的原文"，评论会整段丢掉；DSH 也没有
公开接口能把一段文字直接递给命令当参数。

**所以插件把「命令 + 批注」这一条自动拆成两条发**，你只需要按一次回车：

1. 先单独发送命令（参数为空，例如 `/计划` 只进入 plan 模式、不发消息）；
2. 等命令结算后，把批注消息在输入框里重建出来，再作为**普通消息**发出去——普通消息走 codec，
   批注块完整送达，评论不会再丢。

你会看到：按回车 → 输入框里先只剩命令芯片、命令先走 → 批注消息随后作为第二条出现。
批注卡里会提前提示「斜杠命令和批注会分成两条发送」。

**拆不了的时候（拒绝，不发送）**：草稿里还有别的来源的引用芯片（`@README.md` 之类）、DSH 原生
引用块，或带着附件——这些的投影或载荷没有公开来源，重建不出来。这时插件不冒险：给一条提示
（"请先单独发送命令，再发送这条批注消息"），草稿、芯片全部原样保留，你手动走两步即可。

**草稿里还有 DSH 原生引用块时**：消息上的「引用」动作会往输入框里放一种原生引用块，它在 detect
坐标里同样只占 1 个字符、在草稿里却是整段 Markdown 引用；`InputState` 不发布它的文本和长度，
所以跨过它按坐标改会落到**错误的字符**上。插件因此让卡片上的 ✕ 拒绝移除并提示（而不是删掉
旁边的字）——这条限制在加斜杠命令支持之前就存在。

实现上是在会话输入框对象（`SessionInput`）上包了一层 `submit`：DSH 没有提供"提交前"的
public 钩子，而这是唯一能在草稿被冻结之前介入的时机。这个包装只做一件事——发现"命令 + 批注"
就把它拆成两段发送——其余情况原样放行。升级 DSH 后需要回归这一处（见"已知限制"）。

## 为什么能做到（DSH 侧的三个扩展点）

- **芯片 = 输入机原生的引用**：`client.js` 用 `ctx.inputTriggers.registerSource()` 注册了引用源
  `dsh-quote`（`trigger: '@'`，候选列表恒为空，所以 @ 菜单里不会多出任何条目）。
  它的 `codec.serialize(ref)` 就是「批注 → 提示词文本」的唯一出口。
- **程序化插入**：`ctx.sessions.scope(sessionId)` → `actx.get('conversation')`
  → `input.for(actx).insertReference(reference, span)`；`span` 直接取会话套件公开的
  `inputActions.captureInsertion()`（编辑器光标 + 当前 `draftRev`）。
  `insertReference` 只要求相位是 `plain`/`claimed` 且 span 的 `draftRev` 命中，
  **不要求存在 @ 触发符**，所以插件可以凭空往输入框里放一枚芯片。
- **提交时展开**：发送时 `sinkSerialized` 对每个 occurrence 调用
  `inputTriggers.serializeReference(source, ref, signal)`，把返回文本替换掉该芯片在
  **clipboard 投影**里的 `[offset, offset+length)` 区间。评论因此**完全不需要写进草稿**——
  它留在插件内存里，只在提交那一刻被读出来。这条契约还保证：codec 抛错会**阻断发送**并提示，
  而不是静默降级，所以本插件的 codec 对未知 ref 也返回兜底文本、绝不 reject。
- **删除芯片**：occurrence 表给出芯片在 clipboard 坐标里的 `offset/length`，而 detect 坐标里
  每个芯片恒占 1 个 U+FFFC，于是 `detectSpanOf()` 能把它换算成编辑动词需要的 span，
  再用公开的 `inputActions.insertText('', span)` 把芯片替换为空——不会碰到其它芯片
  （安装版的 `setDraft` 会清空整个编辑器，正是因此不能用它来删单条）。

UI 侧只用公开座位与公开服务，没有改 DSH 任何源码（兼容性：在已安装的 Harness 0.2.3-alpha.2 上
按运行时与安装包源码核对过下表这些契约）：

| 用途 | 扩展点 | 依据 |
|---|---|---|
| 批注卡 | `conversation.input.dock`（session 作用域，order 30，id `quote-annotate`） | 拿到 `sessionId` 与 owner 快照 `{ session, input }`；实时状态与编辑动词走服务层（见"已知限制"） |
| 浮动按钮 | 同一组件内 `createPortal(..., document.body)` + `position:fixed` | 绕开 `.frame{overflow:hidden}` 裁剪 |
| 顶掉原生「引用」按钮 | `conversation.chat.text-interaction` 槽的 `key: quote` 格（空组件，`priority: -1`） | 0.2.3 起同 key 必须不同 priority、最低者渲染（原生用默认 0）；只遮这一格，引用能力不受影响 |
| 选中内容的**源码** | `ctx.get('markdownSource').fromRange(range)`（来自 `@local/dsh-copy-markdown`） | 公式/表格/代码块按 Markdown 源码引用；已在 `dsh.client.inject` 声明依赖，插件不在时退回渲染文本并在控制台警告一次 |
| 选区判定 | `[data-conversation-session]`（本会话面板）、`[data-chat-flow-key]`/`[data-chat-turn]`/`[data-chat-flow]`（正文行）、`[data-composer-seat]`（排除输入区） | 随包发出的稳定 data 属性；CSS Module 类名是哈希，不可用 |
| 写草稿 | `ctx.sessions.scope(id).get('conversation')` + `inputActions` | 与 shipped `ui-commands`/`ui-conversation` 同一用法 |
| 样式 | 自注入 `<style data-dsh-plugin="dsh-quote-annotate">`，只用 `--dsw-alias-*` 主题 token | 暗色主题自动跟随 |

## 已知限制

- **只认 chat 视图**：正文行必须带 `data-chat-flow-key` / `data-chat-turn`；轨迹等其他视图不触发。
- **折叠依赖序列化格式**：折叠靠识别自己发出去的那几行（前言 / `【对话批注 N】` / `> ` 引用行 /
  `我的批注：` 及其 `｜` 续行）。块头必须是行首的**数字编号**头，且块内必须真的有 `> ` 原文行（或
  "原文无法恢复"说明）才折叠——所以随手打的 `【对话批注 说明】…` 或只有一行仿冒头的文字不会被藏起来。
  反过来，若你**完整手打**出前言/编号头/`选取原文：`/`> ` 这套格式，它仍会被折叠（可点开查看）。
  改提示词格式时要同步改 `annotationRange()`；旧格式 `我的意见：` 仍然能折叠。
- **折叠会移动 React 拥有的文本节点**（`extractContents`）：目前未见问题，但若 DSH 之后对已发送
  消息做局部重渲染，理论上可能出现块文本与徽标并存。这是未在真实 UI 里复现的风险，暂未改动。
- **命令消息的自动拆分依赖 submit 钩子与草稿重建**：DSH 没有"提交前"的 public 钩子，所以插件
  在会话输入框对象（`SessionInput`）上包了一层 `submit`：命令消息带批注时，先改草稿让它只带命令、
  提交；命令结算后在空草稿里填回正文，再用原有的引用源把芯片重建出来（`restoreChips` 的 in-place
  模式），最后原样调用 `submit` 发第二条。它依赖三件公开事实——`submit` 是实例上的方法、回车和
  发送按钮都走它、芯片可以用 `insertReference` 重建——升级 DSH 后要回归这一处（确认 `submit`
  仍被这样调用、命令参数仍取草稿的剪贴板投影、`insertReference` 仍按文本位置落芯片）。
  重建的取舍：芯片按"投影文本"在正文里重新定位，若同一段原文在消息里多次出现且位置提示失效，
  芯片可能落到后一处；落不进去时不会自动发送，消息留在输入框并提示。
- **命令芯片与原生引用都不在 occurrence 表里**：前者按 `claim.token` 的长度折算（已处理），后者
  的剪贴板长度没有公开来源，所以只要草稿里有原生引用，跨过它的坐标换算就不可信——插件对这一
  情况选择拒绝编辑并提示，不做"大概对"的改动。
- **顶替原生按钮靠"优先级遮蔽"，而且有兜底**：0.2.3 起 keyed 槽的同 key 必须挂不同 priority、
  **最低者渲染**；原生用默认 0，我们用 -1。若将来规则再变（或别的插件也用 -1 占同一格），注册会抛错——
  这一处已包在 try/catch 里：**只丢遮蔽（原生按钮回来），不会连累批注本身**，控制台留一条
  `could not shadow the shipped quote action` 警告。这个槽要在注册前已声明，所以
  `dsh.client.inject` 里声明了 `@deepseek-ai/dsh-client-ui-chat`；另外也声明了
  `@deepseek-ai/dsh-message-quotes`（按"后注册者胜"的旧规则兜底加载顺序；目标插件缺席时客户端名册
  会跳过这条依赖，不会阻断本插件）。升级后仍需复核。
- **浮动按钮的键盘可达性有限**：按钮挂在 `document.body` 末尾，可用 Tab 到达，Esc 可关闭；
  但没有专门的快捷键把它聚焦到选区旁边。
- **折叠用 Range 精确切除、且先判定后修改**：块范围用 `Range.extractContents()` 按字符坐标切走
  （而不是按节点索引消费——那样会在 `splitText` 之后越界，把用户自己的文字一并清空且无法回滚）。
  切除后校验取出的文本与预期完全一致，不一致就放回原样并放弃折叠。
- **批注卡与写入都走服务层**：`conversation.input.dock` 的 owner 是 `{ session, input }` 快照，
  所以卡片通过 `useSyncExternalStore` 订阅 `SessionInput.state`，插入/删除走 `SessionInput` 与
  `input.actions`；删不掉时会在输入框里给出提示，不再静默失败。（0.2.2-rc.5 的座位标准 props 里
  也给了 `useInput`/`inputActions`，但服务层才是实时状态与编辑动词的同一个来源，故不切换。）
- **你打的正文归 DSH 管**：插件只负责批注本身。若 DSH 自己没有保住草稿（例如重启后草稿为空），
  插件会把批注芯片补回输入框，但你之前手打的正文无法恢复——那部分不在插件的可及范围内。
- **选区过长会截断**：单次选区上限 6000 字，卡片与提示词里都会如实注明。
- **发送/裁决中不加引用**：`phase` 为 `submitting`/`adjudicating` 时点击会得到一条输入框内提示。
- **不做每条消息的操作栏按钮**：本次只按选定的「选区浮出按钮」形态实现；若要再加一个
  `conversation.chat.assistant-actions` 条目，注册新 id 即可与现有条目并存。
- **i18n 走 `document.documentElement.lang` / `navigator.language`**，没走 `ctx.locale`。
- **依赖内部 data 属性**：`data-conversation-session` / `data-chat-flow-*` 是随包实现细节而非冻结契约；
  DSH 升级后若改名，插件需要跟着改（改 `readSelection` 里的一处选择器即可）。

## 验证

```sh
npm install                     # 只装 devDependency（jsdom，用来模拟真实 DOM）
npm run check                   # node --check 两个入口
npm test                        # 276 项断言，全部通过
```

CI（GitHub Actions）在每次 push 与 PR 上跑 `npm ci`、`npm run check`、`npm test`。

图标按插件管理器的读取契约自检：`package.json` 的 `icon`（相对路径、留在包内）或
`./icon` 导出指向 `icon.svg`；文件是自包含 SVG（36×36、无 `<text>`/`<script>`/`<style>`、
渐变 id 唯一、透明底），654 字节，远低于 256 KiB 上限——宿主会把它读成 Base64 data URL
交给「设置 → 插件」渲染。

`verify-core.mjs` 在 Node 里搭了一个最小假 DOM + 假 `window.__ModuleLoader__`，加载**真实的**
`client.js`，然后断言：

- **序列化**：单条/多条编号与前言、删掉前一条后重新编号不留空档、空评论不写「我的批注」、
  截断提示、未知 ref 不抛异常；
- **提交拼接**：按安装版的 clipboard 坐标替换规则模拟，逐字比对最终提示词；
- **芯片定址**：恒定 1 宽的 detect 坐标换算、多芯片位移、缺少 `length` 的回落、未知 ref；
- **芯片删除**：`insertText('')` 的 span/draftRev 形状、未知 ref 不误操作、缺少 API 不误操作；
- **选区边界**：命中、会话 id 不匹配的面板、分组容器内、折叠、空选区、输入框内、跨面板、超长截断；
- **插入路径**：source/ref/label/clipboardText 的形状、`captureInsertion` 与末尾回落的 span 与
  draftRev、插入失败清理记录并提示、发送中/裁决中拒绝、未知会话不抛异常；
- **Markdown 源码联动**：提示词优先用源码、投影为空/抛错时退回渲染文本、记录里保存源码与来源标记；
- **未发送批注的存活**：剪贴板投影取源码（含公式标签）、台账按会话读写 `localStorage`、
  重载后记录回到 codec 索引、就地重建的 span 与倒序插入、空草稿时追加、删除/发送/过期三条清理路径；
- **回车收起**：Enter 收起、Shift+Enter 换行、输入法组合中的 Enter 不算提交、其他键不误触；
- **已发送消息的折叠（jsdom 真实 DOM）**：跨多个文本节点的块被精确切出、只留徽标、幂等、
  点击展开拿到完整块文本、再点收起；**跨多个 `<span>`**（消息里含 `@引用` 芯片时的真实排版）也能
  正确切出且不抹掉用户自己的文字；用户的普通 `> 引用` 行、「我的批注：」与旧标签「我的意见：」
  都不会被误认；**折叠可以来回切换**（展开后文本就位、收起时文本清空——`hidden` 会被作者
  `display` 规则压过，只改属性是不够的）；
- **验收回归**：前面有别的芯片时 ✕ 删的是自己的芯片、多行评论不截断折叠也伪造不了批注头、
  非数字/无原文的仿冒头不折叠、按会话按位置编号、恢复后的 seq 续号、大台账紧凑写入不超读取上限且
  能读回、旧版超大台账能抢救、同文本就近重建与未匹配追加、codec 与芯片投影一致、keyCode 229、
  记录索引有上限但不淘汰在用记录；
- **斜杠命令（命令参数只取纯文本）**：先复现"命令参数里只剩被选中的原文、评论整段丢失"这条原始
  故障；再断言一次回车会自动拆成两条——命令先以空参数发出、发出时草稿只剩命令芯片、命令结算后
  批注消息被重建并自动作为普通消息发出（芯片恢复、没有命令 token）；命令失败时消息被放回输入框
  且不自动发第二条；有别的来源的芯片/原生引用/附件时**拒绝拆**且草稿原样；普通消息照常提交；
  拆分进行中再次回车不重复提交；命令芯片的 detect 折扣、原生引用下 ✕ 拒绝移除等仍保留覆盖；
- **命令芯片的坐标折扣**：`claimed` 时命令芯片同样占 1 个 detect 字符、却是整段 token 的剪贴板
  宽度，测试同时断言"不给折扣会算错 2 个字符"与"给折扣后正好落在芯片上"（✕ 删除仍走这条路径）；
  原生引用在场时 ✕ 删除改为拒绝（命令路径已不再编辑草稿，没有展开用例）；
- **选区旁的按钮**：用假 ctx 跑一遍 `apply()`，断言向 `conversation.chat.text-interaction` 注册了
  `key: quote`、`priority: -1`（低于原生默认 0）的空组件（渲染结果为 null）、原有卡片位与引用源注册不变、
  两个槽都走"等声明"再注册；另有一组"阴影注册被拒"的用例，断言 `apply()` 不抛异常、留警告，
  卡片位与引用源照常注册（0.2.3 同优先级撞车曾让整个 Client 半边失败）。

另外已实测（host 侧）：

- `plugin_manager install_bundle` 成功；profile `desktop` 的 `dsh.profile.bundles` 与依赖里都出现
  `@local/dsh-quote-annotate`；
- host inspect `Config.listConfigs(name=@local/dsh-quote-annotate)` 返回在册条目
  `include:dsh-quote-annotate`（patchId `dsh-quote-annotate`），说明这一行已在**运行中**的 loader 里挂上；
- HMR 事件端点 `/plugins/events` 吐出的 boot graph 里含
  `{"id":"@local/dsh-quote-annotate","url":"plugins/…/client.js?rev=…","immediately":true,"inject":["@deepseek-ai/dsh-client-ui-conversation","@deepseek-ai/dsh-client-ui-chat","@deepseek-ai/dsh-client-ui-input-trigger","@deepseek-ai/dsh-message-quotes","@local/dsh-copy-markdown"]}`
  —— 即客户端名册确实会把这个 bundle 发给页面（`immediately` 表示页面加载即预取）。

**浏览器端到端已验证**（2026-11-23、DSH 0.2.3-alpha.2，临时 profile + 独立 Web 服务 + 无头 Chrome，
并复制了一个真实历史会话进去）：

- 插件页不再出现 `@local/dsh-quote-annotate` 的同步失败提示，页面 0 条 console error；
- 在历史会话里选中一段文字：选区旁只有本插件的「＋ 添加到输入框」一个按钮，原生的「引用文本」按钮数量为 0
  （`priority: -1` 遮蔽成立）；
- 点按钮后：输入框上方出现「批注 1」卡片、输入框里出现 `@引用｜…` 芯片，功能链路照旧；
- **A/B 反证**：把同一个插件复制一份、删掉 `priority: -1`（回到默认 0）再装进另一个临时 profile，
  页面立刻复现 `keyed slot "conversation.chat.text-interaction" already has an entry for key "quote" at priority 0`
  ——说明这次报错确实是 priority 撞车，而不是别的服务问题。

**运行中桌面端的复核**（2026-11-23 下午、DSH 0.2.3-alpha.2）：用客户端 Slot 检查确认同一格有两个占位
——本插件 `priority: -1 / active: true`，原生 `message-quotes / priority: 0 / active: false`；
本插件的批注卡片位（`quote-annotate`）与原生引用预览节点（`conversation.user.text.node` 的 `quote` 键）
均 `active: true`，说明遮蔽只影响按钮、没影响引用能力。

仍未验证：提交后模型实际收到的提示词（临时环境没有可用模型，未真正发送）。

## 卸载

在「设置 → 插件」里移除 `@local/dsh-quote-annotate`，或让 DSH 代为执行 `remove_bundle`。
也可以直接删掉本目录（`link:` 安装不会复制文件）。

## 许可证

[MIT](LICENSE) © 2026 Rayzenchen
