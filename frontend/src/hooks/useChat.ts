import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { params } from '../lib/conversations'
import type { Hit, RewriteData, StageData } from '../lib/events'
import { parseSse } from '../lib/sse'
import { latestSentence } from '../lib/stages'
import type { Message } from '../lib/storage'

export type ChatStatus =
  | 'idle'
  | 'rewriting'
  | 'retrieving'
  | 'streaming'
  | 'error'
  | 'aborted'

export interface ChatController {
  /** 当前库。空态的示例问题按库给（`ChatPanel` 的 `SAMPLE_QUESTIONS`），故必须暴露。 */
  lib: string
  messages: Message[]
  status: ChatStatus
  /** 当前显示的命中（由 `shownRounds` 决定是哪几轮的并集）。 */
  evidence: Hit[]
  /**
   * 轮次序号（`messages` 中第 n 条 user 消息，0 起）→ 该轮命中。
   * **键存在**即该轮已返回过 evidence 事件（哪怕零命中）；消费方据此区分
   * 「问过但没找到」与「还没问 / 还在检索」。
   */
  evidenceByRound: Record<number, Hit[]>
  /**
   * 当前显示的是哪几轮，显示规则（Ruling 66）：
   * 1. 用户筛了某一轮 → 只看那一轮；
   * 2. 否则若在跟随最新一轮 → 最新**已记录**的那一轮（检索期间即上一轮，
   *    本轮命中到达后即本轮）；
   * 3. 否则累积视图（各轮并集，最近一轮置顶）。
   */
  shownRounds: number[]
  /** 用户筛选的轮次；null = 没筛选（此时由 `followLatest` 决定看最新一轮还是累积）。 */
  selectedRound: number | null
  /** 未筛选时是否跟随最新一轮：提问/在飞时为真，用户一旦筛选即转假（Ruling 66）。 */
  followLatest: boolean
  /** 当前选中的单条依据（文献卡选中态）；null = 未选中。 */
  selectedRowid: number | null
  resolvedQuery: RewriteData | null
  error: string | null
  /**
   * 本轮已累计的模型思考文本（003）。取自 `reasoning` 事件流，**不额外调用模型**。
   * 空串表示本轮还没有（或没有）思考内容 —— 缺失由 `notices` 如实告知。
   */
  reasoningText: string
  /**
   * 本轮各阶段**服务端实测**耗时，按到达顺序（003）。只来自 `stage` 事件；
   * 未发生的阶段不在其中（单轮请求没有 `rewrite`，故消费方不得假定它存在）。
   */
  stages: StageData[]
  /** 需要如实告知但非失败的事项（003），如思考不可用 / 篇幅未达标。 */
  notices: string[]
  /** 思考面板是否展开；收到首个思考增量即自动展开，正文首字到达即自动收起。 */
  thinkingOpen: boolean
  toggleThinking: () => void
  submit: (text: string) => void
  abort: () => void
  reset: () => void
  selectRound: (round: number | null) => void
  onSelectHit: (hit: Hit) => void
  /**
   * 从**答案里的引用标记**跳转到某条命中（T56）。
   *
   * 与 `onSelectHit` 共用同一套显示/选中 state，只多一件事：把显示集合切到引用所在的
   * **那一轮**。依据栏默认只显示最新一轮，上一轮答案里的 `[编号]` 指向的卡片往往不在屏上 ——
   * 只「选中」的话用户点下去什么都看不到。
   *
   * **成员守卫按那一轮的命中集判**，并**返回这次调用有没有真的把它选中**：
   * - `true` = 该 rowid 属于本轮，且这次点击把它选中了；
   * - `false` = 被守卫拒绝（不属于该轮），或这一次是**取消选中**（同一条再点一次）。
   *
   * 返回值存在的理由：取文（`doc.open`）是**副作用**，必须由状态层说了算，而不是由
   * 「渲染层传下来的 hit 一定合法」这个假设说了算 —— 否则一旦有越界索引漏到那一层，
   * 就会以「视图没动、却打开了一篇」的形态出现（Ruling 74 要防的正是这种错开）。
   */
  selectCitedHit: (round: number, hit: Hit) => boolean
  /**
   * 清空单条选中态（不改变用户对轮次的筛选）。
   *
   * 由文献卡的关闭按钮调用：面板一关，那条命中就不再「被选中」——否则卡片会继续
   * 带着选中样式（`aria-pressed=true`），而且再点它是**取消选中**而不是重新打开，
   * 使用者要三次点击才回得来（I1）。
   */
  clearSelection: () => void
}

/** 交给外部的会话变更内容：一次变更同时交回消息与按轮依据（二者必须同源落盘）。 */
export interface ChatPersist {
  messages: Message[]
  evidenceByRound: Record<number, Hit[]>
  /**
   * 本轮思考摘要与耗时（003，取自思考流自身与 `stage` 事件）。
   *
   * 三种载荷形态，**不可混用**：
   * - 有值 = 本轮确实有思考（摘要非空串 / 耗时是有限数）；
   * - 键**在场**而值为 `undefined` = 本轮没有思考 / 要**清掉**上一轮的留存。
   *   清除必须显式给 `undefined`：App 侧是 `{ ...会话, ...载荷 }` 合并写回，
   *   缺键等于保留旧值（那正是「reset 后旧摘要留在空会话上」的成因）；
   * - 键**不在场** = 本次变更不涉及思考字段（`finally` 在「本轮没有思考」时用这种形态，
   *   此时上一轮的残留早已被 submit 清掉，不会复活）。
   */
  reasoningSummary?: string
  /** 本轮思考耗时（毫秒）；未收到 reasoning 阶段时缺省，**不写 0**（0 会把缺失说成测量）。 */
  reasoningMs?: number
}

/**
 * 会话真值**由外部注入**（`plan.md` §12.1「会话真值改由外部注入」）。
 *
 * 这样做的直接理由是 spec 的「会话留存与切换」：一条会话的留存内容是
 * 「消息 **加** 逐轮依据」。若 useChat 仍自己按 `ragqa:<lib>` 落盘，刷新后
 * `evidenceByRound` 就没人写、没人读 —— 消息还在、逐轮依据却没了。
 * 交给 `Conversation` 数据模型统一持有，二者才可能同源持久化。
 *
 * `conversationId` 与 `lib` 合成**会话键**：键一变即视为「换了一条会话」，
 * 立刻丢弃在飞请求的写权并把内容换成新注入的初值（见下方渲染期重置）。
 */
export interface UseChatOptions {
  lib: string
  /** 当前会话 id；`null` = 尚无会话（内容按空处理）。 */
  conversationId: string | null
  /** 当前会话已留存的消息。 */
  initialMessages: Message[]
  /** 当前会话已留存的按轮依据。 */
  initialEvidenceByRound: Record<number, Hit[]>
  /** 会话内容变化时的唯一出口（完成一轮 / 中断 / reset）。 */
  onPersist: (update: ChatPersist) => void
}

/**
 * 零静默失败（宪法 §4.3）的收口处：T09 的 `parseSse` 只做 `as SseEvent` 断言、
 * 不做形状校验，因此「畸形但可解析」的 data 会原样抵达这里（如 `{"foo":1}`）。
 * 下面三个函数把 `unknown` 收敛成可用值，避免 undefined / 字面量 "undefined"
 * 流进 UI —— 那正是「有错误却什么都不显示」这一类静默失败。
 */
function readableError(payload: unknown): string {
  const message = (payload as { message?: unknown } | null | undefined)?.message
  return typeof message === 'string' && message.trim() !== ''
    ? message
    : '生成失败（服务端未提供错误信息）'
}

function deltaText(payload: unknown): string {
  const delta = (payload as { delta?: unknown } | null | undefined)?.delta
  return typeof delta === 'string' ? delta : ''
}

/**
 * 篇幅告知附带的字数后缀：服务端实测的「实际交付字数 / 目标字数」。
 *
 * 只认有限数：畸形载荷（字符串 / NaN）不得渲染成「400/abc 字」这种看着像事实的假数字。
 * 两个数字里只有一个可用时只显示那一个 —— 收到即丢同样是静默失败。
 */
function wordCountSuffix(chars: unknown, target: unknown): string {
  const delivered = typeof chars === 'number' && Number.isFinite(chars) ? chars : null
  const goal = typeof target === 'number' && Number.isFinite(target) ? target : null
  if (delivered !== null && goal !== null) return `（${delivered}/${goal} 字）`
  if (delivered !== null) return `（${delivered} 字）`
  if (goal !== null) return `（目标 ${goal} 字）`
  return ''
}

/**
 * notice 是「成功但有需要说明的事」，不是失败 —— 故不能复用 `readableError`：
 * 它的兜底文案写死了「生成失败」，会把一次成功交付说成失败。这里兜底用中性描述，
 * 只保证「有告知就一定能看见」，不替服务端编造内容。
 *
 * 同时把服务端随通知发来的字数（`chars` / `target`，仅篇幅告知带）拼进文案：
 * 它是这条告知里唯一的一手数字事实，此前收到即被丢掉，使用者只看到「未达标」
 * 却看不到差多少（复审 Minor）。
 */
function noticeText(payload: unknown): string {
  const data = (payload ?? {}) as { message?: unknown; chars?: unknown; target?: unknown }
  const message =
    typeof data.message === 'string' && data.message.trim() !== ''
      ? data.message
      : '本轮有需要说明的情况（服务端未提供说明文本）'
  return `${message}${wordCountSuffix(data.chars, data.target)}`
}

function hitList(payload: unknown): Hit[] {
  const hits = (payload as { hits?: unknown } | null | undefined)?.hits
  return Array.isArray(hits) ? (hits as Hit[]) : []
}

/**
 * 把给定轮次的命中并成一份显示集合：最近一轮置顶，同一 `rowid` 只保留最近一次。
 *
 * **同一轮内也按 `rowid` 去重是刻意的**（Ruling 67）：显示集合是集合语义 ——
 * 重复的 `rowid` 会在依据栏里堆成多份，按顺序渲染时也会撞 React key。
 * 这不是 bug，别"顺手"改成拼接。
 */
function unionHits(byRound: Record<number, Hit[]>, rounds: number[]): Hit[] {
  const seen = new Set<number>()
  const out: Hit[] = []
  for (const round of [...rounds].sort((a, b) => b - a)) {
    for (const h of byRound[round] ?? []) {
      if (seen.has(h.rowid)) continue
      seen.add(h.rowid)
      out.push(h)
    }
  }
  return out
}

/**
 * 落盘前的最后一个收口：**尾部空的助手占位不写进存储**。
 *
 * 提交那一刻助手消息必然是空的（内容要等流式 delta 到达），而「提交即留存」必须
 * 在那一刻就把用户提问写进存储，否则中止/刷新就把问题丢了（C1）。可空助手气泡
 * 本身没有任何信息量：写进存储后一旦这一轮被中断，刷新就会渲染出一个空白气泡
 * ——那正是「什么都不显示」的静默失败形态。故：
 *
 * - 提交时落盘 = 用户消息 + 此前已完成的对话（占位被剥掉）；
 * - 流结束时若答案**真的**一个字都没有（例如服务端只发了 error），同样不落空气泡；
 * - 中断时（终于 `finally`，但内容已在提交时落过盘）剥掉半截答案也没有信息损失。
 *
 * 只剥**尾部**：`提交 → 空助手 → 用户又提交` 这种形状不存在（重入守卫只允许
 * 一条在飞请求），即便存在，中间的空助手也由后续轮次的正常内容承载。
 */
function withoutTrailingPlaceholder(messages: Message[]): Message[] {
  const out = [...messages]
  while (out.at(-1)?.role === 'assistant' && out.at(-1)?.content === '') out.pop()
  return out
}

/**
 * 显示控制（Ruling 66）：`selectedRound` 只由**用户操作**改变，
 * `followLatest` 表示未筛选时是否跟随最新一轮。二者与单条选中态放在同一个
 * state 里，异步流用函数式更新一次读齐 —— 分开存就会在事件回调里读到旧闭包。
 */
interface DisplayState {
  selectedRound: number | null
  followLatest: boolean
  selectedRowid: number | null
}

const INITIAL_DISPLAY: DisplayState = {
  selectedRound: null,
  followLatest: false,
  selectedRowid: null,
}

export function useChat({
  lib,
  conversationId,
  initialMessages,
  initialEvidenceByRound,
  onPersist,
}: UseChatOptions): ChatController {
  /**
   * 「这一帧属于哪条会话」的字符串身份。**按值比较**，不比对象引用：App 每次渲染都会
   * 现算 props（`conv.current?.messages ?? []` 之类），按引用比较会每次渲染都重置一次，
   * 甚至陷入 setState 自激。
   */
  const sessionKey = `${lib}\u0000${conversationId ?? ''}`

  const [renderedSession, setRenderedSession] = useState(sessionKey)
  const [messages, setMessages] = useState<Message[]>(initialMessages)
  const [status, setStatus] = useState<ChatStatus>('idle')
  const [evidenceByRound, setEvidenceByRound] =
    useState<Record<number, Hit[]>>(initialEvidenceByRound)
  const [display, setDisplay] = useState<DisplayState>(INITIAL_DISPLAY)
  const [resolvedQuery, setResolvedQuery] = useState<RewriteData | null>(null)
  const [error, setError] = useState<string | null>(null)
  // 003 思考真值：累计文本 / 阶段耗时 / 需告知事项 / 面板展开态。
  const [reasoningText, setReasoningText] = useState('')
  const [stages, setStages] = useState<StageData[]>([])
  const [notices, setNotices] = useState<string[]>([])
  const [thinkingOpen, setThinkingOpen] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  // messages 的同步真值：setState 要到下次渲染才可见，而同一批次里的
  // reset() → submit() 必须读到**重置后**的历史，故用 ref 持有最新值。
  const messagesRef = useRef<Message[]>(messages)
  // 依据的同步真值与 messages 同理：落盘发生在流结束的 finally，那里读不到新的渲染闭包。
  const evidenceRef = useRef<Record<number, Hit[]>>(evidenceByRound)
  /**
   * 显示状态（按轮筛选 / 跟随 / 单条选中）的同步真值。
   *
   * `selectCitedHit` 要**同步返回**「这次选中了没有」——调用方据此决定要不要取文 ——
   * 而 `setDisplay` 的函数式更新拿不到新状态，故用 ref 持有当前值。与 `messagesRef` /
   * `evidenceRef` 同一写法；返回值与新 state 都取自这一个值，二者不会打架。
   */
  const displayRef = useRef<DisplayState>(display)
  /**
   * 思考真值的同步副本：摘要与 reasoning 耗时在 `finally` 里落盘，而那时读到的
   * `reasoningText` / `stages` 仍是**本轮 submit 创建时**的闭包值（永远是初值）。
   * 与 `messagesRef` / `evidenceRef` 同一理由，同一写法。
   */
  const reasoningRef = useRef('')
  const stagesRef = useRef<StageData[]>([])
  // 会话键的同步真值：仍在飞的请求据此判断自己是否还拥有写权。
  const keyRef = useRef(sessionKey)
  // 被「换会话」作废、等待 effect 真正 abort 的请求（渲染期不发起副作用）。
  const doomedRef = useRef<AbortController | null>(null)
  // onPersist 的同步真值：App 传进来的闭包每帧都是新的，而流结束时要拿到最新的那个。
  const persistRef = useRef(onPersist)
  persistRef.current = onPersist
  keyRef.current = sessionKey
  displayRef.current = display

  const { selectedRound, followLatest, selectedRowid } = display

  /**
   * 换会话（切对话 / 切库）：在**渲染期**换掉全部会话内容，React 官方
   * 「props 变化时调整 state」模式 —— 本次渲染结果被丢弃并立即重渲染。
   *
   * 刻意不用 effect：effect 要等提交后才跑，中间那一帧会拿**上一条会话**的消息与
   * 依据渲染，正是「切换对话不得互相污染」要禁止的（`useConversations` 同此理由）。
   *
   * 旧请求的写在**这里**就被夺走（`keyRef` 与 `abortRef` 同时失效）：真正的中断
   * 放到 effect 里做，渲染期只标记，不发起副作用。
   */
  if (renderedSession !== sessionKey) {
    setRenderedSession(sessionKey)
    doomedRef.current = abortRef.current
    abortRef.current = null
    messagesRef.current = initialMessages
    evidenceRef.current = initialEvidenceByRound
    reasoningRef.current = ''
    stagesRef.current = []
    setMessages(initialMessages)
    setEvidenceByRound(initialEvidenceByRound)
    // 思考真值随会话换手：上一会话的思考绝不能显示在新会话的等待期里
    setReasoningText('')
    setStages([])
    setNotices([])
    setThinkingOpen(false)
    setDisplay(INITIAL_DISPLAY)
    // 选中态随会话换手，同步真值也必须一起换：否则新会话里第一次点引用标记会拿
    // 上一会话的 `selectedRowid` 去判「这次是不是取消选中」。
    displayRef.current = INITIAL_DISPLAY
    setResolvedQuery(null)
    setError(null)
    setStatus('idle')
  }

  useEffect(() => {
    const doomed = doomedRef.current
    doomedRef.current = null
    // 切库/切对话即失效在飞请求（宪法 §2.2 双库完全隔离，对话之间同理）。
    // 已生成的部分答案随切换丢弃：隔离优先于一次生成。
    doomed?.abort()
  }, [sessionKey])

  // 显示哪几轮（Ruling 66 的三条规则）——见 ChatController.shownRounds 的注释。
  const shownRounds = useMemo(() => {
    if (selectedRound !== null) return [selectedRound]
    const recorded = Object.keys(evidenceByRound).map(Number)
    if (followLatest && recorded.length > 0) return [Math.max(...recorded)]
    return recorded.sort((a, b) => a - b)
  }, [evidenceByRound, selectedRound, followLatest])

  // 显示列表由「按轮留存 + 显示规则」派生，而不是各自 setState：写入新一轮与
  // 切换显示都不会互相覆盖，异步流里也不需要读渲染闭包里的旧列表。
  const evidence = useMemo(
    () => unionHits(evidenceByRound, shownRounds),
    [evidenceByRound, shownRounds],
  )

  // 当前**显示集合**的同步真值：会员守卫（onSelectHit）要用它，而它必须是这一帧的值。
  const visibleRef = useRef<Hit[]>(evidence)
  visibleRef.current = evidence

  const updateMessages = useCallback((updater: (prev: Message[]) => Message[]) => {
    const next = updater(messagesRef.current)
    messagesRef.current = next
    setMessages(next)
  }, [])

  const submit = useCallback(
    (text: string) => {
      const question = text.trim()
      // 重入守卫必须看「是否已有请求在飞」（ref），而不是渲染闭包里的 status：
      // 同一批次内两次 submit 都会读到旧 status，第二个会覆盖 abortRef，
      // 两个流同时往同一条 assistant 消息里追加，且第一个流再也无法中断。
      if (!question || abortRef.current) return

      // 本次请求所属的会话。事件回调是异步的，届时渲染闭包里的 keyRef 可能已经
      // 指向另一条会话 —— 写权必须钉在**发起时**的那一条上。
      const key = keyRef.current

      const history = [
        ...messagesRef.current,
        { role: 'user' as const, content: question },
      ]
      updateMessages(() => [...history, { role: 'assistant', content: '' }])
      // 依据**不**在这里清空（spec「开新一轮时上一轮依据仍在」，检索期间不得出现
      // 空依据栏）；它按轮留存，检索完成后写入 evidenceByRound[roundIndex]。
      // 需要清空的只有上一轮的错误与改写结果。
      setError(null)
      setResolvedQuery(null)
      /**
       * 上一轮的思考同样必须清空（003）：等待期展示的是**本轮**进展，若把上一轮的
       * 摘要/阶段留给新一轮，界面就会用陈旧数据冒充当前状态 —— 比不显示更具误导性。
       * 清掉后思考面板自然卸载，直到本轮首个增量到达。
       *
       * **随会话留存的那一份也一并清**（复审 Important 2）：它是上一轮的落盘产物，
       * 提交时不清，刷新后残留的那一条就会挂在新一轮的整个检索等待期上；而它对应的
       * 那一轮已经不是「最后一轮」了 —— 界面无法再如实说明它属于谁。
       */
      reasoningRef.current = ''
      stagesRef.current = []
      setReasoningText('')
      setStages([])
      setNotices([])
      setThinkingOpen(false)
      setStatus('rewriting')

      // 新一轮开始：清掉用户的筛选、重新跟随（本轮命中到达时即显示它）。
      // 单条选中态只在**此前已在跟随态**时保留：那种情况下显示集合不变（都跟随最新
      // 已记录轮），选中的那条仍在眼前；否则（在筛某一轮、或看累积并集）显示集合会切回
      // 最新一轮，被选中的 rowid 可能掉出显示集合，必须清掉。
      setDisplay((prev) => ({
        selectedRound: null,
        followLatest: true,
        selectedRowid: prev.followLatest ? prev.selectedRowid : null,
      }))

      // 轮次序号在本轮 user 消息落位时**一次性捕获**：事件到达时再数 messages
      // 已经晚了 —— 那时自己的 assistant 占位已进数组，长度还随流式追加变化
      // （用 `messages.length - 2` 这类位置启发式会记到错误的轮次上）。
      const roundIndex = history.filter((m) => m.role === 'user').length - 1

      /**
       * C1（整支复审 Critical，数据丢失）：**提交那一刻就把问题落盘**。
       *
       * 此前只有流结束的 `finally` 与 `reset` 会落盘，而切会话/刷新会中止在飞请求
       * ——`finally` 那时正确地拒绝写入（写权已随会话键换手），于是用户自己刚发出的
       * 问题一个字都没留下，且不显示任何错误：静默失败 + 违反 SC-14。
       *
       * 写权判据与 `finally` 一致：这里能走到，就说明本次提交持有写权（会话键未变、
       * 且重入守卫已挡掉并发的第二次提交）。落盘内容是**本会话自己的**历史 + 本次提问，
       * 不含任何流式内容；真正的内容变更仍由流结束的 `finally` 交回。
       */
      persistRef.current({
        messages: withoutTrailingPlaceholder(history),
        evidenceByRound: evidenceRef.current,
        // 显式清掉上一轮的思考留存（键在场、值为 undefined）：缺键会被 App 的
        // `{ ...会话, ...载荷 }` 当成「不改这一项」，于是上一轮的摘要继续挂在会话上。
        reasoningSummary: undefined,
        reasoningMs: undefined,
      })

      const controller = new AbortController()
      abortRef.current = controller
      // 写权 = 「本次请求仍是 abortRef 的持有者」**且**「会话键没变」。前者挡 reset()，
      // 后者挡切换对话/切库：被拆掉的流不得再追加文本、翻转状态，也不得把内容写进
      // 另一条会话（那正是「切换对话不得互相污染」的落点）。
      const isCurrent = () => abortRef.current === controller && keyRef.current === key

      void (async () => {
        let sawDone = false
        try {
          // 请求体在**守卫区内**构造（复审 ③）：`params()` 现读一次 localStorage，
          // 与滑杆的落盘值同源（接口冻结的新增字段，T28/plan §12.5）。它今天自己吞异常，
          // 但那是实现细节 —— 将来抛出时也必须变成可见错误，绝不能逃出 submit
          // （宪法 §4.3 零静默失败）。写成具名局部量，守卫关系一眼可见、也不会被
          // 「顺手把请求体提到 try 外面」改坏。
          const body = JSON.stringify({ lib, messages: history, params: params() })
          const res = await fetch('/ask/stream', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
            signal: controller.signal,
          })
          if (!res.ok || !res.body) {
            throw new Error(`HTTP ${res.status}`)
          }

          for await (const ev of parseSse(res.body)) {
            if (!isCurrent()) break
            switch (ev.event) {
              case 'rewrite':
                setResolvedQuery(ev.data)
                setStatus('retrieving')
                break
              case 'evidence':
                // 命中记为**发起本次请求的那一轮**（spec「新命中到达后替换」）。
                // 写 ref 与写 state 用同一份新对象：落盘发生在流结束的 finally，
                // 那里读的是 ref，二者必须一致。
                {
                  const next = { ...evidenceRef.current, [roundIndex]: hitList(ev.data) }
                  evidenceRef.current = next
                  setEvidenceByRound(next)
                }
                // Ruling 66：**只归档，不夺走用户的观看选择**。只有用户当前没有
                // 筛某一轮时才跟随这一轮（跟随 ≠ 筛选）；跟随会让显示集合切换，
                // 于是清掉单条选中态，避免留下不在显示集合里的 rowid。
                setDisplay((prev) =>
                  prev.selectedRound === null
                    ? { ...prev, followLatest: true, selectedRowid: null }
                    : prev,
                )
                setStatus('streaming')
                break
              case 'answer': {
                setStatus('streaming')
                // 正文首字到达即收起思考：面板展开是为了「等待时有东西可看」，
                // 答案开始出现后它的使命已经完成，不该继续把正文挤下去。
                // 放在取 delta 之前 —— 「无 delta 的 answer 帧」也算正文阶段已开始。
                setThinkingOpen(false)
                const delta = deltaText(ev.data)
                if (delta === '') break
                updateMessages((prev) => {
                  const next = [...prev]
                  const last = next.at(-1)
                  if (last?.role === 'assistant') {
                    next[next.length - 1] = {
                      ...last,
                      content: last.content + delta,
                    }
                  }
                  return next
                })
                break
              }
              case 'reasoning': {
                // 累计模型思考流（003），并自动展开面板让等待期有事可看。
                // 同步写 ref：落盘在 finally，那里的闭包读不到新 state。
                const text = reasoningRef.current + deltaText(ev.data)
                reasoningRef.current = text
                setReasoningText(text)
                setThinkingOpen(true)
                break
              }
              case 'stage': {
                const next = [...stagesRef.current, ev.data]
                stagesRef.current = next
                setStages(next)
                break
              }
              case 'notice': {
                // 零静默失败：思考不可用 / 篇幅未达标等**非失败**告知必须留存到界面。
                // 思考已取消转发上限，故不再有「思考被截断」这一类告知。
                const text = noticeText(ev.data)
                setNotices((prev) => [...prev, text])
                break
              }
              case 'error':
                setError(readableError(ev.data))
                setStatus('error')
                break
              case 'done':
                sawDone = true
                break
            }
          }

          // 请求已被 reset() 拆掉：不得再用它写任何状态（宪法 §4.3 零静默失败的另一面：
          // 已作废的流也不能反转用户刚做的重置）。
          if (!isCurrent()) return

          // 零静默失败：流结束却没收到 done，必须显式告知（宪法 §4.3）
          if (!sawDone) {
            setError('连接中断：未收到结束标记')
            setStatus('error')
          } else {
            setStatus((s) => (s === 'error' ? 'error' : 'idle'))
          }
        } catch (e) {
          if (!isCurrent()) return
          if (controller.signal.aborted) {
            setStatus('aborted')
          } else {
            setError(e instanceof Error ? e.message : String(e))
            setStatus('error')
          }
        } finally {
          if (isCurrent()) {
            // 本轮结束（正常 / 报错 / 中断）的落盘点：一次变更同时交回消息与按轮依据
            // （会话真值由外部持有）。若本轮最终没有任何答案，尾部空占位被剥掉，
            // 不会在刷新后留下空白气泡。
            // 被夺走写权的流（reset / 切会话）**不得**走到这里 —— 否则它会把刚清空的、
            // 或另一条会话的内容写回去。用户自己的提问早已在 submit 时落过盘（C1），
            // 不依赖这一支存活。
            abortRef.current = null
            // 思考摘要与耗时随本轮内容一并落盘（003）：摘要在刷新后仍在，
            // 让「等待期看到了什么」成为会话的一部分。两者都在**没有**时缺省，
            // 缺省 ≠ 0 —— 写 0 会把一次「缺失」说成一次「测量」。
            const summary = latestSentence(reasoningRef.current)
            const reasoningMs = stagesRef.current.find((s) => s.name === 'reasoning')?.elapsed_ms
            persistRef.current({
              messages: withoutTrailingPlaceholder(messagesRef.current),
              evidenceByRound: evidenceRef.current,
              ...(summary === '' ? {} : { reasoningSummary: summary }),
              ...(reasoningMs === undefined ? {} : { reasoningMs }),
            })
          }
        }
      })()
    },
    [lib, updateMessages],
  )

  const abort = useCallback(() => {
    // 无在飞请求时不改状态，避免把 idle 无故翻成 aborted。
    if (!abortRef.current) return
    abortRef.current.abort()
    setStatus('aborted')
  }, [])

  const reset = useCallback(() => {
    // 先夺走在飞请求的写权并中断它，再清状态：
    // 否则被拆掉的流会在清空后继续追加，把 idle 翻回 streaming/error，
    // 并把刚清空的会话内容写回去。
    abortRef.current?.abort()
    abortRef.current = null
    messagesRef.current = []
    evidenceRef.current = {}
    reasoningRef.current = ''
    stagesRef.current = []
    setMessages([])
    // reset 同样是真正的重新开始：连同按轮留存的依据一起清掉。
    setEvidenceByRound({})
    // 思考真值一并清空：否则「重新开始」后面板还挂着上一段的思考
    setReasoningText('')
    setStages([])
    setNotices([])
    setThinkingOpen(false)
    setDisplay(INITIAL_DISPLAY)
    // 与「换会话」同理：显示状态的同步真值一起清，别把旧会话的清空前的选中态留给下一次点击。
    displayRef.current = INITIAL_DISPLAY
    setResolvedQuery(null)
    setError(null)
    setStatus('idle')
    // 清空也是内容变更：必须交出，否则外部（会话列表）仍留着旧内容。
    // 留存的思考字段同样**显式清掉**（复审 Important 3）：这是一条被清空的会话，
    // 上面挂着上一轮的思考摘要就是「用不存在的一轮冒充内容」。
    persistRef.current({
      messages: [],
      evidenceByRound: {},
      reasoningSummary: undefined,
      reasoningMs: undefined,
    })
  }, [])

  /**
   * 按轮筛选依据（Ruling 66）：用户一旦点选就**停止跟随最新一轮**，直到他取消筛选。
   *
   * `null`（或再次点选同一轮）= 取消筛选：回到**累积视图**——spec「取消筛选」要求
   * 「恢复显示全部留存的命中」，故这里不回到「跟随最新一轮」。
   * 显示集合随之切换，单条选中态一并清空（否则会留下不在显示集合里的 rowid）。
   */
  const selectRound = useCallback((round: number | null) => {
    setDisplay((prev) => ({
      selectedRound: round !== null && prev.selectedRound === round ? null : round,
      followLatest: false,
      selectedRowid: null,
    }))
  }, [])

  /**
   * 单条依据的选中态；再次点选同一条即取消选中（文献卡侧栏的入口）。
   *
   * **会员守卫**：只接受**当前显示集合**里的那一条。本回调不只被依据栏（它只渲染显示
   * 集合）调用，也被文献卡的入口调用；而显示集合会随「按轮筛选 / 新一轮命中到达」切换。
   * 不守卫就可能选中一条屏上根本没有的 rowid —— 文献卡会据此去取一篇用户看不见的笔记。
   */
  const onSelectHit = useCallback((hit: Hit) => {
    if (!visibleRef.current.some((h) => h.rowid === hit.rowid)) return
    setDisplay((prev) => ({
      ...prev,
      selectedRowid: prev.selectedRowid === hit.rowid ? null : hit.rowid,
    }))
  }, [])

  /** 清空单条选中态：只动 `selectedRowid`，用户的按轮筛选原样保留。 */
  const clearSelection = useCallback(() => {
    setDisplay((prev) => (prev.selectedRowid === null ? prev : { ...prev, selectedRowid: null }))
  }, [])

  /**
   * 答案里的引用标记 → 那一条命中（T56）。与 `onSelectHit` 同一套 state，不另开通道。
   *
   * 三件事必须在**同一次** state 更新里做完（写成 `selectRound()` + `onSelectHit()` 两步
   * 会在同一个批次里两次读到切换**前**的显示集合：后者会被自己的会员守卫挡下，
   * 于是「跨轮跳转」这条路径整个不生效）：
   * ① 显示切到引用所属的那一轮；② 选中那一条；③ 再点一次同一条即取消选中（与点卡片同语义）。
   *
   * **为什么总是切到那一轮**（哪怕那一条本来就在屏上）：依据栏在累积视图下把各轮并集
   * **按最近一轮置顶**显示，卡片上的编号是**显示序**；切到那一轮之后，屏上编号才与答案里的
   * 编号是同一套（卡片上的 `[n]` 正是答案里 `[n]` 指的那一条）。
   *
   * 守卫用**那一轮的命中集**而不是当前显示集合：切显示本来就是这次跳转的一部分。
   * 切过去之后那一条必然在显示集合里 —— `unionHits` 对单轮只按 rowid 去重，不丢条目。
   *
   * 返回值 = **这次有没有真的把它选中**（供调用方决定要不要取文）。它必须与新落下的
   * state 出自**同一个值**，故两步都用 `displayRef` 的当前选中态：返回的布尔值才不会与
   * 状态打架（否则调用方可能按一个与状态不符的结果去取文）。
   */
  const selectCitedHit = useCallback((round: number, hit: Hit): boolean => {
    const inRound = (evidenceRef.current[round] ?? []).some((h) => h.rowid === hit.rowid)
    if (!inRound) return false
    const already = displayRef.current.selectedRowid === hit.rowid
    setDisplay({
      selectedRound: round,
      followLatest: false,
      selectedRowid: already ? null : hit.rowid,
    })
    return !already
  }, [])

  /** 手动开合思考面板（自动收起只是默认行为，使用者始终能再展开回看）。 */
  const toggleThinking = useCallback(() => setThinkingOpen((v) => !v), [])

  return {
    lib,
    messages,
    status,
    evidence,
    evidenceByRound,
    shownRounds,
    selectedRound,
    followLatest,
    selectedRowid,
    resolvedQuery,
    error,
    reasoningText,
    stages,
    notices,
    thinkingOpen,
    toggleThinking,
    submit,
    abort,
    reset,
    selectRound,
    onSelectHit,
    selectCitedHit,
    clearSelection,
  }
}
