import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Backdrop } from './components/Backdrop'
import BrandTitle from './components/BrandTitle'
import { FontSizeControl } from './components/FontSizeControl'
import ColumnDivider from './components/ColumnDivider'
import ColumnToggles from './components/ColumnToggles'
import { ChatPanel } from './components/ChatPanel'
import { DocPanel } from './components/DocPanel'
import { EvidencePanel } from './components/EvidencePanel'
import { HistoryList } from './components/HistoryList'
import { ParamSliders } from './components/ParamSliders'
import ThinkingPanel from './components/ThinkingPanel'
import { useCapabilities } from './hooks/useCapabilities'
import { useChat, type ChatPersist } from './hooks/useChat'
import { useConversations } from './hooks/useConversations'
import { useDoc } from './hooks/useDoc'
import { useLayout } from './hooks/useLayout'
import { useMediaQuery } from './hooks/useMediaQuery'
import {
  EMPTY_TITLE,
  params,
  saveParams,
  titleFrom,
  type Conversation,
  type QaParams,
} from './lib/conversations'
import { clampFontPt, loadFontPt, saveFontPt } from './lib/fontSize'
import type { Hit } from './lib/events'
import type { ColumnKey } from './lib/layout'
import { MIN_WIDTH } from './lib/layout'

const LIBS = [
  { id: 'ai4s', label: 'AI4S' },
  { id: 'mito', label: 'Mitochondria' },
]

const THEME_KEY = 'ragqa:theme'
const WIDE = '(min-width: 1280px)'

export default function App() {
  const [lib, setLib] = useState('ai4s')
  const [theme, setTheme] = useState<'dark' | 'light'>(
    () => (localStorage.getItem(THEME_KEY) as 'dark' | 'light') ?? 'dark',
  )
  /** 全站字号（pt）。初始值从存储读，越界/损坏一律回落默认（见 `lib/fontSize.ts`）。 */
  const [fontPt, setFontPtState] = useState<number>(() => loadFontPt())
  const setFontPt = useCallback((next: number) => {
    const clamped = clampFontPt(next)
    setFontPtState(clamped)
    saveFontPt(clamped)
  }, [])
  const wide = useMediaQuery(WIDE)
  // 栏宽/开合的真值在这里（T50/T51）：宽度不再由类名写死，而是 state 驱动 + 夹紧。
  // 持久化失败会把 `storage.lastWriteFailed` 置真，由下方 HUD 如实告知（宪法 §4.3）。
  const { layout, storage, resizePair: resizePairFromLayout, toggle, resetPair, ackStorageNotice } =
    useLayout()

  /**
   * 分隔线的拖动语义：`delta` 是**分隔线自身的位移**（`ColumnDivider`: `clientX - 起始x`）。
   * `delta > 0` = 分隔线右移 = **左栏**变宽、右栏变窄（两侧**此消彼长**，spec「相邻栏合计不变」）。
   * 分隔线跟着指针走，即 SC-18「拖动后栏宽与指针意图一致」。
   *
   * 夹紧集中在 `useLayout.resizePair`（纯函数 `applyPairResize`）里做：单栏可读下限、
   * 越界折叠、以及每栏上限 `MAX_WIDTH`。
   * ⚠️ 曾经存在的「三栏合计上限」已按实测**删除**（它会把正常拖动截断），勿再引入——
   * 见 `layout.ts::applyPairResize` 的返工记录；「对话栏不被挤没」由它自己的 DOM `min-width` 保证。
   */
  const resizePair = useCallback(
    (a: ColumnKey, b: ColumnKey) => (delta: number) => {
      resizePairFromLayout(a, b)(delta)
    },
    [resizePairFromLayout],
  )
  // 生成参数（T28，plan §12.5）：真值在这里，落盘走 `saveParams`（写前夹紧）。
  const [qaParams, setQaParams] = useState<QaParams>(() => params())

  /**
   * 生成参数的**后端能力**（T49 修复 Defect 1）：滑杆的「已生效 / 未生效」标注由它驱动。
   *
   * 只在功能栏真的挂载时才请求（`wide && layout.rail.open`，与下方渲染条件逐字一致）：
   * 滑杆不在屏上就没有需要标注的东西，此时 hook 返回 UNCONFIRMED，界面不做任何断言。
   * 不缓存答复：能力随配置变化，缓存会把这句「如实」重新变成会过期的话。
   */
  const railMounted = wide && layout.rail.open
  const capabilities = useCapabilities(lib, railMounted)

  // 会话真值（列表 / 当前对话 / 内容）由 useConversations 独家持有；useChat 只管
  // 「这一轮怎么跑」，内容变更经 `onPersist` 回到会话里（plan §12.1）。二者分家的
  // 收益是逐轮依据（evidenceByRound）与会话同源落盘 —— 刷新后依据不会丢。
  const conv = useConversations(lib)
  const doc = useDoc()

  /**
   * 会话内容的唯一写入路径。`useChat` 每完成一次内容变更（跑完一轮 / 中断 / reset）
   * 交回消息与逐轮依据，这里原样写进当前会话。
   */
  const persist = useCallback(
    (update: ChatPersist) => {
      const id = conv.currentId
      if (id === null) return
      const patch: Partial<Omit<Conversation, 'id' | 'createdAt'>> = { ...update }
      // 首条 user 消息折叠成标题（功能栏的历史列表要显示它）；已有标题不再改写。
      if (conv.current?.title === EMPTY_TITLE) {
        const first = update.messages.find((m) => m.role === 'user')
        if (first) patch.title = titleFrom(first.content)
      }
      conv.update(id, patch)
    },
    [conv.currentId, conv.current, conv.update],
  )

  const chat = useChat({
    lib,
    conversationId: conv.currentId,
    initialMessages: conv.current?.messages ?? [],
    initialEvidenceByRound: conv.current?.evidenceByRound ?? {},
    onPersist: persist,
  })

  /**
   * 随会话留存的思考摘要与耗时（003，plan §4.4）的**读取路径**。
   *
   * 刷新后本轮的实时思考不在内存里（`useChat` 的状态随页面加载清空），但会话里存着
   * 摘要与耗时 —— 面板据此仍能显示「等待期看到了什么」，而不是把两个字段写成只进不出的死状态。
   *
   * 只在**任一字段真的存在**时构造：两个都没有时给 `undefined`，而不是
   * `{ summary: '', ms: undefined }`（后者会让面板渲染一行没有内容的留存行）。
   * 摘要缺失而耗时存在是真实形态（服务端发过 reasoning 阶段、但思考正文没留下），
   * 故不要求摘要非空。
   */
  const storedThinking =
    conv.current?.reasoningSummary !== undefined || conv.current?.reasoningMs !== undefined
      ? { summary: conv.current?.reasoningSummary ?? '', ms: conv.current?.reasoningMs }
      : undefined

  // 切库会中断在飞请求（T11 契约，双库隔离优先于一次生成），故请求在飞时禁用切库，
  // 避免用户静默丢弃一次生成。表达式与 ChatPanel 内的 busy 一致。
  const busy =
    chat.status === 'rewriting' ||
    chat.status === 'retrieving' ||
    chat.status === 'streaming'
  // 侧栏空态只依据 useChat 的真值：**当前显示的那些轮次**是否都已经返回过 evidence 事件。
  // 不能用「状态机是否离开 idle」这类启发式——那会把在飞的一轮、或点选到尚未留存的
  // 历史轮次，直接说成「未找到依据」，正是 spec「历史恢复后不谎报空态」禁止的。
  // 三态与 ChatPanel 内联证据一致：有轮次已记录 ⇒ 零命中；有轮次在查 ⇒ 检索中；
  // 一轮都没问过 ⇒ 中性占位。显示哪几轮由 useChat 的显示规则（Ruling 66）给出。
  const shownRecorded =
    chat.shownRounds.length > 0 &&
    chat.shownRounds.every((r) => Object.prototype.hasOwnProperty.call(chat.evidenceByRound, r))
  // 取回命中**之前**才算「正在检索」：流式生成答案期间不该再说「正在检索」。
  const retrieving = chat.status === 'rewriting' || chat.status === 'retrieving'
  // 「正在检索新一轮」标记与空态**并存而非互斥**（复审 Minor ②）：列表里还有上一轮命中时，
  // 标记说明它们在为哪一轮让位；空态要宣告「上一轮零命中」这个结论时，标记说明结论来自上一轮、
  // 新一轮还在查。只有第一轮在飞时例外 —— 那里列表本身就写着「正在检索依据…」，再加标记是重复。
  const searching = retrieving && (chat.evidence.length > 0 || shownRecorded)
  const emptyLabel = shownRecorded
    ? '未找到依据'
    : busy
      ? '正在检索依据…'
      : '提问后这里会显示依据来源'

  // 当前**显示集合**的 rowid：会员守卫（App 侧）。依据栏只渲染显示集合，
  // 但取文的对象必须是用户屏上真能看到的那一条，故这里与 useChat 内部守卫同一判据。
  const visibleRowids = useMemo(
    () => new Set(chat.evidence.map((h) => h.rowid)),
    [chat.evidence],
  )

  const selectHit = useCallback(
    (hit: Hit) => {
      if (!visibleRowids.has(hit.rowid)) return
      chat.onSelectHit(hit)
      // 再次点选同一条 = 取消选中：关闭由下方 effect 统一处理（选中态一旦清空就关）。
      if (chat.selectedRowid !== hit.rowid) doc.open(lib, hit.ref)
    },
    [visibleRowids, chat.onSelectHit, chat.selectedRowid, doc, lib],
  )

  /**
   * 答案里的引用标记（T56）→ **与点证据卡同一条选中路径**（`useChat` 的显示/选中 state），
   * 只多带一个「这条答案属于哪一轮」：依据栏默认只显示最新一轮，跨轮的引用要先把依据栏
   * 切到那一轮，屏上才会有那张卡 —— `selectCitedHit` 用**一次** state 更新同时做这两件事
   * （分成两次调用时，后一次会读到切换前的显示集合而被会员守卫挡下）。
   *
   * 是否可跳转已由渲染层判定（`AnswerMarkdown`：命中必须存在且**有可读原文**，
   * 与证据卡的可点判据 I2 同一套）；这里只管选中与取文，不重复判定。
   */
  const selectCitation = useCallback(
    (round: number, hit: Hit) => {
      // 取文是**副作用**，闸门放在状态层给出的结果上：`selectCitedHit` 只在「该 rowid 属于
      // 那一轮、且这次点击确实把它选中了」时返回真。被拒时不取文 —— 于是这条保证不依赖
      // 「渲染层传下来的 hit 一定合法」这个假设（Ruling 74 的「不得错开」落在副作用这一侧）。
      // 同一条再点一次是取消选中（返回假）：这里不重复取同一篇，关闭由下方 effect 统一处理。
      if (!chat.selectCitedHit(round, hit)) return
      doc.open(lib, hit.ref)
    },
    [chat.selectCitedHit, doc, lib],
  )

  /**
   * 关闭文献卡 = **关面板 + 清选中态**（I1）。
   *
   * 只调 `doc.close()` 会留下一条「看起来还选中着」的卡片：它继续带选中样式、
   * `aria-pressed` 仍为 true，而且再点它是「取消选中」（第一次点击不会重新打开），
   * 要三次点击才回得来。
   */
  const closeDoc = useCallback(() => {
    doc.close()
    chat.clearSelection()
  }, [doc.close, chat.clearSelection])

  // 选中态**由有转无**（再次点选 / 显示集合切换 / 换会话）时关闭文献卡：
  // 否则最右栏会继续展示一篇屏上已经没有入口的笔记。
  // 判据盯的是「那一次转变」，而不是「现在是 null」—— 后者在**首次挂载**也会成立，
  // 于是每次挂载都白调一次 doc.close()（状态上不可见的空写）。
  const hadSelection = useRef(false)
  useEffect(() => {
    const wasSelected = hadSelection.current
    hadSelection.current = chat.selectedRowid !== null
    if (wasSelected && chat.selectedRowid === null) doc.close()
  }, [chat.selectedRowid, doc.close])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem(THEME_KEY, theme)
  }, [theme])

  /**
   * 全站字号：改**根元素**的 `font-size`，`rem` 与 Tailwind 的字号阶梯一起缩放，
   * 故标题/正文/面板/Markdown 答案按同一比例整体变大变小（见 `lib/fontSize.ts`）。
   */
  useEffect(() => {
    document.documentElement.style.fontSize = `${fontPt}pt`
  }, [fontPt])

  return (
    // 全视口外壳：不使用任何 max-w-* 居中窄容器（spec「桌面全屏布局」/ SC-10）
    <div className="flex h-dvh w-full flex-col">
      {/* 背景两层（虚线网络 + 移动气泡）：装饰层，不吃点击、不阻断任何操作 */}
      <Backdrop />
      <header className="flex items-center justify-between border-b border-[var(--color-border)] px-6 py-3">
        {/* 标题 + 四个栏开关（spec「栏开关」：开关紧随产品名之后）。
            开关**不挂在 `wide` 上**——窄视口下它们是关掉的栏唯一的恢复入口（C-2）。 */}
        <div className="flex items-center gap-4">
          <BrandTitle />
          <ColumnToggles layout={layout} onToggle={toggle} />
        </div>
        <div className="flex items-center gap-3">
          {/* 布局写入失败必须**可见**（spec「布局持久化不可用（边界）」/ 宪法 §4.3 零静默失败）：
              使用者以为被记住的调整其实没被记住，是本条唯一必须告知的情形。
              读取失败退化为默认布局属标准做法，故不提示。 */}
          {storage.lastWriteFailed && (
            <p
              role="status"
              className="flex items-center gap-2 rounded-sm border border-[var(--color-warning)] px-2 py-1 text-xs text-[var(--color-warning)]"
            >
              布局无法保存，本次调整不会被记住
              <button
                type="button"
                aria-label="知道了"
                onClick={ackStorageNotice}
                className="cursor-pointer hover:text-[var(--color-fg)]"
              >
                ×
              </button>
            </p>
          )}
          <select
            aria-label="知识库"
            value={lib}
            onChange={(e) => setLib(e.target.value)}
            disabled={busy}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-sm disabled:opacity-40"
          >
            {LIBS.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            // 可访问名保留「主题」二字（既有断言与读屏都靠它），可见文案改显**当前**态
            aria-label={`主题：当前${theme === 'dark' ? '暗' : '明'}色，点击切换`}
            onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
            className="rounded-md border border-[var(--color-border)] px-3 py-1 text-sm transition-colors duration-[var(--duration-fast)] hover:border-[var(--color-accent)]"
          >
            {theme === 'dark' ? '暗' : '明'}
          </button>
          {/* 字号控件**紧随明/暗开关之后**（使用者指定的位置） */}
          <FontSizeControl pt={fontPt} onChange={setFontPt} />
        </div>
      </header>
      {/* 四栏（`plan.md` §12.4）：功能栏 · 对话栏 · 依据栏 · 文献卡栏。
          四栏由 ≥1280px 驱动；**更窄的宽度不在承诺范围**（spec §6）——那里只保留
          对话栏 + 内联证据，不为窄屏另做一套布局。
          栏宽自 003 起由 state 驱动（`style={{ width }}`），不再写死类名宽：
          `shrink-0` 之下类名宽是「改不动的值」，而每栏的可读下限必须**真的绑得住**
          （见 `lib/layout.ts` 的 `clampWidth`）。 */}
      <main className="flex min-h-0 flex-1">
        {wide && layout.rail.open && (
          <>
            <aside
              data-testid="function-rail"
              style={{ width: layout.rail.width }}
              className="flex h-full shrink-0 flex-col gap-4 overflow-y-auto border-r border-[var(--color-border)] p-4"
            >
              <ParamSliders
                value={qaParams}
                capabilities={capabilities}
                onChange={(next) => {
                  setQaParams(next)
                  saveParams(next)
                }}
              />
              {/* 功能栏上部是生成参数，下部是本库的对话历史（含「＋ 新对话」，plan §12.4）。
                  列表只认当前库的 `conv.list` —— 它是 useConversations 按 lib 分键持有的。 */}
              <HistoryList
                list={conv.list}
                currentId={conv.currentId}
                onSelect={conv.select}
                onCreate={conv.create}
                onRemove={conv.remove}
              />
            </aside>
            <ColumnDivider
              left="rail"
              right="chat"
              onResize={resizePair('rail', 'chat')}
              onReset={() => resetPair('rail', 'chat')}
            />
          </>
        )}
        {/* 对话栏：宽度由 state 驱动（`flex-shrink-0` + 行内宽度），**不再** `flex-1`。
            为什么改（使用者 2026-09-19 实测反馈「分隔线拖不过中线」）：
            `flex-1` 下本栏的实际宽度是**容器剩下的全部空间**，与 `layout.chat.width`
            无关 —— 于是"把空间让给对话栏"这件事在界面上**完全看不出来**（模型改了、
            渲染没变），拖动到某一侧就像撞墙。改成实际宽度后，分隔线才真正跟着指针走。
            「对话栏不被挤没」仍由行内 `minWidth` 兜底（T51 复审 Important #1）：
            它是 flex item 的下限，`shrink-0` 之下依然约束得住。
            剩余空间改由**文献卡栏**吸收（`flex-1`，见下），这样开关栏时布局仍会自适应。 */}
        <div
          data-testid="chat-column"
          style={{ width: `${layout.chat.width}px`, minWidth: `${MIN_WIDTH.chat}px` }}
          className="flex shrink-0 flex-col"
        >
          {/* 思考面板**不再挂在整栏顶部**，而是注入消息流、紧跟最后一个提问
              （见 ChatPanel 的 `thinking` 槽）：使用者要求顺序恒为
              「提问 → 思考 → 回答」，且**每一轮**都要如此 —— 挂在栏顶的话，
              第二轮起它会跑到旧问答之上，顺序就错了。
              没有任何真实数据时**不渲染**（绝不出一个空面板冒充进展）。
              两种数据都算真实：本轮的实时进展，与会话里留存的上一轮摘要/耗时
              （刷新后仍可见，plan §4.4）。 */}
          <div className="min-h-0 flex-1">
            <ChatPanel
              chat={chat}
              showInlineEvidence={!wide}
              onSelectRound={chat.selectRound}
              onCite={selectCitation}
              thinking={
                chat.reasoningText ||
                chat.stages.length > 0 ||
                chat.notices.length > 0 ||
                storedThinking ? (
                  <ThinkingPanel
                    reasoningText={chat.reasoningText}
                    stages={chat.stages}
                    notices={chat.notices}
                    open={chat.thinkingOpen}
                    onToggle={chat.toggleThinking}
                    persisted={storedThinking}
                  />
                ) : undefined
              }
              thinkingText={chat.reasoningText}
            />
          </div>
        </div>
        {/* 依据栏与内联证据判断同一个断点：窄屏不挂载侧栏，由内联承接——否则侧栏会与
            内联的 EvidenceList 渲染出同一个「依据来源」标题，查询与屏幕阅读器都会看到两份。
            宽屏则**始终**挂载侧栏（两栏常在，刷新不塌成一栏）；侧栏内容是四态：
            有证据 → 卡片（新一轮在查时外加「正在检索新一轮…」标记）；
            零命中且本轮问过 → 「未找到依据」；尚未问过 → 中性占位。
            关闭态**不渲染**（宽度为 0 的 `aside` 仍会因 border/padding 占位，
            违反 spec「关闭态不占用空间…不得留下空白占位或残留边框」）。 */}
        {wide && layout.evidence.open && (
          <>
            <ColumnDivider
              left="chat"
              right="evidence"
              onResize={resizePair('chat', 'evidence')}
              onReset={() => resetPair('chat', 'evidence')}
            />
            <EvidencePanel
              hits={chat.evidence}
              searching={searching}
              selectedRowid={chat.selectedRowid}
              onSelect={selectHit}
              emptyLabel={emptyLabel}
              width={layout.evidence.width}
            />
          </>
        )}
        {/* 文献卡栏常驻（同依据栏的理由）：未选中篇目时它显示中性提示，
            选中证据卡即拉取该篇 md 全文。 */}
        {wide && layout.doc.open && (
          <>
            {/* 依据栏被关掉时，这条分隔线两侧就不再是「相邻两栏」——
                渲染它等于给出一条拖不动（或能暗中把栏拖回来）的控件，
                与 spec C-3「恢复入口唯一且显式」相悖，故只在两侧都在场时渲染。 */}
            {layout.evidence.open && (
              <ColumnDivider
                left="evidence"
                right="doc"
                onResize={resizePair('evidence', 'doc')}
                onReset={() => resetPair('evidence', 'doc')}
              />
            )}
            <DocPanel doc={doc} onClose={closeDoc} width={layout.doc.width} />
          </>
        )}
      </main>
    </div>
  )
}
