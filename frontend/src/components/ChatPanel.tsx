import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ChatController } from '../hooks/useChat'
import type { Hit } from '../lib/events'
import { Composer } from './Composer'
import { elapsedMs, liveStatusLabel, stageBase, type StageBase } from '../lib/liveStatus'
import { EvidenceList } from './EvidenceList'
import { MessageBubble } from './MessageBubble'

/**
 * 空态示例问题：**按库给**（使用者 2026-09-19 要求，切库时一并更换）。
 *
 * 为什么不能只给一套：AI4S 库里本就有一整套「**AI-虚拟线粒体**」周报，若在 AI4S 下
 * 示例线粒体问题，使用者会看到"很相关"的结果，从而分不清自己在问哪个库。
 * 两个库各给自己的领域问题后，**同一个问题切库再问**即可看出差别。
 *
 * 每条都实测过判别力（`/search` 首条相关度，同题在两库的对比）：
 * - 虚拟细胞与 AI 建模：ai4s −21.77 / mito −8.53
 * - 图神经网络在分子性质预测中的应用：ai4s −24.90 / mito −8.07
 * - 线粒体自噬的调控机制：mito −12.90 / ai4s −13.59
 * - 线粒体与衰老：mito **−8.77** / ai4s −5.57
 * - 线粒体与心血管疾病：mito **−19.83** / ai4s −11.65
 *
 * 注：**判据是相关度，不是命中条数** —— RRF 只按 `min_bm25` 过滤，两库恒返回 topn 条。
 */
const SAMPLE_QUESTIONS: Record<string, string[]> = {
  ai4s: ['虚拟细胞与 AI 建模', '图神经网络在分子性质预测中的应用'],
  mito: ['线粒体与心血管疾病', '线粒体自噬的调控机制'],
}

export function ChatPanel({
  chat,
  showInlineEvidence,
  onSelectRound,
  onCite,
  thinking,
  thinkingText,
}: {
  chat: ChatController
  showInlineEvidence: boolean
  onSelectRound: (round: number | null) => void
  /**
   * 点答案里的引用标记（T56）：交给调用方处理（它同时要做「切到那一轮 + 选中那一条 +
   * 打开原文」）。本轮组件把**这条消息属于哪一轮**算好再回调 —— 只有它知道消息与轮次的
   * 对应关系，而 `[编号]` 的定位依据正是「那一轮的命中」。
   */
  onCite: (round: number, hit: Hit) => void
  /**
   * 思考面板（003 第 9 条）。作为**消息流里的一块**注入，而不是挂在整栏顶部：
   * 使用者要求顺序恒为「提问 → 思考 → 回答」，且**每一轮都要如此**。
   * 挂在整栏顶部时，它是"绝对最新"的，第二轮之后就会跑到旧问答之上；
   * 注入到最后一个提问之后，则无论第几轮都恰好落在该轮的提问与回答之间。
   */
  thinking?: ReactNode
  /**
   * 思考正文（用于**跟随滚动**）。传它而不是拿 `thinking` 节点的引用做依赖：
   * 每次渲染都是新的 React 元素，引用比对无意义；而思考增量会让这个字符串**每片都变**。
   */
  thinkingText?: string
}) {
  const endRef = useRef<HTMLDivElement>(null)
  /** 消息区的滚动容器（跟随思考增量时读它的贴底状态）。 */
  const scrollerRef = useRef<HTMLDivElement>(null)
  /** 是否跟随最新内容。只有**使用者主动上翻**才会置假（见下方 onScroll）。 */
  const followRef = useRef(true)
  /** 上一次的 scrollTop，用来判断滚动方向（区分"他上翻"与"我们跟随"）。 */
  const lastTopRef = useRef(0)
  /**
   * 输入框的草稿提升到本组件：空态的示例问题要能**写进**输入框（使用者 2026-09-19）。
   * 放在 `Composer` 内部的话，外部无法填值，只能另造一条"预填"通道 ——
   * 那会多出一份状态与它的同步问题，不如直接由本组件持有。
   */
  const [draft, setDraft] = useState('')
  /** 贴底判定阈值：回到这个距离内就算「他滚回底部了」⇒ 恢复跟随。 */
  const NEAR_BOTTOM_PX = 48

  /**
   * 思考流式期间**跟随滚动**（使用者 2026-09-19）。
   *
   * 为什么需要：消息区的滚动只在 `chat.messages` 变化时发生，而思考增量**不进**
   * `messages` —— 于是思考越长、面板越高，视口却原地不动，最新生成的内容被推到屏幕外，
   * 正好把「等待期有事可看」这条价值抵消掉。
   *
   * ⚠️ 这里曾被写坏过一次，值得记下来：第一版用「离底部是否 < 48px」当判据，
   * 而思考面板**一次能长 260px 以上**（实测 311 → 578），于是每次 effect 跑起来时
   * gap 早已超过阈值 ⇒ 跟随**自己把自己关掉了**，实测 gap 稳定在 108px 永远不回底。
   *
   * 现在的判据是**使用者的滚动意图**，不是距离：
   * - `followRef` 初始为真（新消息本就该看最新）；
   * - 只有**使用者自己向上滚**才置假（读旧内容时别拽他）——由 `onScroll` 判断方向；
   * - 一旦他自己滚回底部，或我们主动跟随到底，就恢复为真。
   *
   * 用 `endRef`（消息流末尾的锚点）而不是试算 `scrollTop`：锚点已存在且已被
   * `messages` 那条 effect 使用，两处共用同一个滚动语义。
   */
  useEffect(() => {
    if (!followRef.current) return
    endRef.current?.scrollIntoView?.({ block: 'end' })
  }, [thinkingText])

  /**
   * 挂载时按**当前位置**初始化跟随状态与「上一次位置」。
   *
   * 为什么必须有：`lastTopRef` 从 0 起步，而挂载后可能已经滚下去了（刷新后恢复的
   * 会话、或容器本来就比内容高）。此时使用者第一次向上滚，`top < prev` 会拿一个
   * **陈旧的 0** 去比，判定成"向下滚"，于是跟随没被关掉——他一边上翻、一边被拽回底部。
   * 实测诊断：`{top:400, prev:0, gap:1200, follow:true}` ⇒ 误判。
   */
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    lastTopRef.current = el.scrollTop
    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX
    // 仅挂载时跑一次：之后由 onScroll 维护
  }, [])

  /**
   * 区分「使用者向上翻」与「我们自己滚到底」：后者也会触发 scroll 事件，
   * 若不记录上一步位置，跟随产生的滚动会被误读成使用者的意图。
   */
  const onScroll = () => {
    const el = scrollerRef.current
    if (!el) return
    const top = el.scrollTop
    const prev = lastTopRef.current
    lastTopRef.current = top
    const gap = el.scrollHeight - top - el.clientHeight
    if (gap <= NEAR_BOTTOM_PX) {
      followRef.current = true // 他滚回底部了 ⇒ 恢复跟随
    } else if (top < prev) {
      followRef.current = false // 主动上翻 ⇒ 停手
    }
  }

  useEffect(() => {
    // 与思考那条 effect 同一判据：**使用者主动上翻后就不得再抢滚动条**。
    // 少了这一句，本 effect 会在每个流式 token 上把视口拉回底部
    // （`chat.messages` 每个增量都是新数组）—— 实测：上翻 300px 后立刻被拽回，gap 从 321 变回 21。
    if (!followRef.current) return
    // jsdom 未实现 scrollIntoView（浏览器里必然存在）。可选调用让非浏览器环境
    // 退化成 no-op，否则挂载期整个界面都会因 TypeError 渲染失败。
    endRef.current?.scrollIntoView?.({ block: 'end' })
  }, [chat.messages])

  const busy = chat.status === 'rewriting' || chat.status === 'retrieving' || chat.status === 'streaming'
  /**
   * 提问进行中的**真实状态文案**与阶段耗时（使用者 2026-09-19）。
   * 都取自已真实发生的信号：服务端 `stage` 事件、已收下的依据条数、已到的思考字数。
   *
   * 基准点只在阶段切换时重算（`stageBase` 内部按 name+ms 判等），故长阶段期间
   * 耗时数字会一直往前走，而不是冻在事件到达那一刻。
   */
  const now = Date.now()
  const stageBaseRef = useRef<StageBase | null>(null)
  stageBaseRef.current = stageBase(stageBaseRef.current, chat.stages[chat.stages.length - 1], now)
  const liveLabel = busy
    ? liveStatusLabel({
        status: chat.status,
        stages: chat.stages,
        evidenceCount: chat.evidence.length,
        reasoningChars: chat.reasoningText.length,
        hasAnswer: (chat.messages[chat.messages.length - 1]?.content ?? '') !== '',
      })
    : ''
  const liveElapsedMs = busy ? elapsedMs(stageBaseRef.current, now) : 0

  // 轮次序号 = 该 user 消息是第几条 user 消息（0 起），与 useChat 的按轮归档同一规则。
  const userIndexes = chat.messages.reduce<number[]>(
    (acc, m, i) => (m.role === 'user' ? [...acc, i] : acc),
    [],
  )
  /**
   * 消息 → 轮次：**到这条消息为止**（含它自己）有几条 user 消息，减一。
   *
   * 用 `u <= i` 而不是 `u < i`：user 消息要把它自己算进去（`u < i` 会给第一条提问
   * 算出 −1，把整轮标记成"不属于任何轮"）。助手消息后面没有 user 消息，两种写法同值 ——
   * 于是**助手消息与它那一轮的提问同号**，这正是 `[编号]` 定位要用的那一半信息
   * （编号只在该轮内解释，见 `lib/citations.ts`）。
   */
  const roundOf = (i: number) => userIndexes.filter((u) => u <= i).length - 1
  // 内联证据挂在**正在显示的那一轮**的提问下（useChat 的显示规则给出 shownRounds）；
  // 累积视图（多轮并集 / 什么都还没问）时挂最后一个提问。
  const anchorRound =
    chat.shownRounds.length === 1 ? chat.shownRounds[0] : userIndexes.length - 1
  const anchorIndex = userIndexes[anchorRound] ?? null
  /** 最后一个提问在 `messages` 里的下标 —— 思考面板就挂在它后面（顺序：提问→思考→回答）。 */
  const lastUserIndex = userIndexes.length > 0 ? userIndexes[userIndexes.length - 1] : -1
  // 与 App 侧栏同一判据：该轮是否已返回过 evidence 事件（哪怕零命中）。
  // 还在检索时不得谎报「未找到依据」；未留存（刷新后恢复的历史）时什么都不说。
  const anchorRecorded = Object.prototype.hasOwnProperty.call(
    chat.evidenceByRound,
    anchorRound,
  )
  // 「正在检索新一轮」≠ busy：流式生成答案期间不该再说「正在检索」。
  // 与 App 侧栏同一套并存规则（复审 Minor ②）：有命中、或空态要宣告「上一轮零命中」时都显示；
  // 第一轮在飞时列表本身已写着「正在检索依据…」，不再叠加标记。
  const searching =
    (chat.status === 'rewriting' || chat.status === 'retrieving') &&
    (chat.evidence.length > 0 || anchorRecorded)

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollerRef} onScroll={onScroll} className="flex-1 overflow-y-auto p-4">
        {chat.messages.length === 0 && (
          <div className="mx-auto max-w-xl py-12 text-center text-sm text-[var(--color-muted)]">
            <p className="mb-2">向本地知识库提问，答案会附带可追溯的出处。</p>
            <p className="mb-1">试试：</p>
            {/* 示例问题取**当前库自己的领域**（切库即换），且**点一下就填进输入框**
                （不直接发送：使用者还可能要改几个字）。用真正的 <button> 而不是
                带 onClick 的 <span>：键盘可聚焦、读屏会念成按钮。 */}
            <ul className="flex flex-col gap-1">
              {(SAMPLE_QUESTIONS[chat.lib] ?? []).map((q) => (
                <li key={q}>
                  <button
                    type="button"
                    data-testid="sample-question"
                    onClick={() => setDraft(q)}
                    className="rounded-sm px-2 py-0.5 text-[var(--color-accent)] underline-offset-2 transition-colors duration-[var(--duration-fast)] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
                  >
                    「{q}」
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="mx-auto flex max-w-4xl flex-col gap-4">
          {chat.messages.map((m, i) => {
            const streaming = busy && i === chat.messages.length - 1
            const round = roundOf(i)
            const isUser = m.role === 'user'
            const filtered = isUser && chat.selectedRound === round
            // 引用标记只接在**助手**消息上，且依据取「这条消息所属那一轮」的命中
            // （`evidenceByRound[round]`，送达顺序）—— **不是**依据栏当前显示的并集列表：
            // 并集按最近一轮置顶重排过，拿它定位会指错卡（见 `lib/citations.ts`）。
            const bubble = (
              <MessageBubble
                message={m}
                streaming={streaming}
                liveLabel={liveLabel}
                liveElapsedMs={liveElapsedMs}
                hits={isUser ? undefined : chat.evidenceByRound[round]}
                onCite={isUser ? undefined : (hit: Hit) => onCite(round, hit)}
              />
            )
            return (
              <div key={i} className="flex flex-col gap-2">
                {isUser ? (
                  // 整条提问可点选：点它只看该轮留存命中，再点一次回到全部
                  // （spec「点选某一轮筛选依据」/「取消筛选」）。用 div + role 而不是
                  // <button>：按钮的内容模型只允许短语内容，而气泡根元素是 <div>。
                  <div
                    role="button"
                    tabIndex={0}
                    data-round={round}
                    aria-pressed={filtered}
                    title={filtered ? '再次点击查看全部依据' : '点击只查看该轮依据'}
                    onClick={() => onSelectRound(round)}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter' && e.key !== ' ') return
                      e.preventDefault()
                      onSelectRound(round)
                    }}
                    className="flex cursor-pointer flex-col items-end gap-1 rounded-md transition-colors duration-[var(--duration-fast)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
                  >
                    <span
                      className={`text-xs ${
                        filtered
                          ? 'text-[var(--color-accent)]'
                          : 'text-[var(--color-muted)]'
                      }`}
                    >
                      第 {round + 1} 轮{filtered ? ' · 已筛选依据' : ''}
                    </span>
                    {bubble}
                  </div>
                ) : (
                  bubble
                )}
                {showInlineEvidence && i === anchorIndex && (
                  <div className="flex flex-col gap-2">
                    {/* 与宽屏侧栏同一标记（见 EvidencePanel）：必须能让使用者看出新一轮
                        正在检索。与空态**并存**——空态说的是上一轮的结论，标记说的是新一轮
                        还在查（`searching` 已按该规则算好）。role=status 供读屏获知。 */}
                    {searching && (
                      <p
                        role="status"
                        aria-live="polite"
                        className="text-xs text-[var(--color-muted)]"
                      >
                        正在检索新一轮…
                      </p>
                    )}
                    <EvidenceList
                      hits={chat.evidence}
                      emptyLabel={
                        anchorRecorded
                          ? '未找到依据'
                          : busy
                            ? '正在检索依据…'
                            : undefined
                      }
                    />
                  </div>
                )}
                {/* 思考面板**紧跟最后一个提问**：于是顺序恒为「提问 → 思考 → 回答」，
                    且对每一轮都成立（回答到达后它就在回答上方）。 */}
                {round >= 0 && i === lastUserIndex && thinking ? <div>{thinking}</div> : null}
              </div>
            )
          })}
          {chat.error && (
            <p
              role="alert"
              className="rounded-md border border-[var(--color-danger)] px-3 py-2 text-sm"
            >
              {chat.error}
            </p>
          )}
          {/* T11 的 payload 守卫故意不做 rewrite 事件的形状校验，故这里按运行时真值比较：
              畸形 payload（例如 degraded 是字符串）不会因 truthy 而误报「已降级」。 */}
          {chat.resolvedQuery?.degraded === true && (
            <p className="text-xs text-[var(--color-muted)]">
              本轮未使用上下文改写，已按原问题检索。
            </p>
          )}
          <div ref={endRef} data-testid="chat-end-anchor" />
        </div>
      </div>
      <Composer
        value={draft}
        onChange={setDraft}
        onSubmit={chat.submit}
        onAbort={chat.abort}
        busy={busy}
      />
    </div>
  )
}
