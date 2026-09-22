/**
 * 提问进行中的**真实状态文案**（使用者 2026-09-19）。
 *
 * 为什么要有这个模块：等待期原先写死两句「生成中…」/「正在检索证据…」，
 * 全程一个字都不变 —— 使用者看不出到底卡在哪一步、还要等多久，那句"状态"其实是装饰。
 *
 * 判据一律取**已经真实发生的事**，顺序与后端 `stage` 事件一一对应：
 * `rewrite → evidence → reasoning → answer → done`（见 `server/http_server.py`）。
 * 后端**未发生**的阶段不编造（spec 边界 Scenario 明确禁止"补全一个没发生的阶段"），
 * 故这里只报已观测到的最新阶段，绝不用"应该快到某步了"去猜。
 */
import type { StageData } from './events'

/** 与 `useChat` 的状态机同源；这里只取判断文案需要的部分。 */
export type LiveStatus = 'idle' | 'rewriting' | 'retrieving' | 'streaming' | 'error' | 'aborted'

export interface LiveInput {
  status: LiveStatus
  stages: StageData[]
  /** 本轮已收下的依据条数。 */
  evidenceCount: number
  /** 已有多少思考字（用于判断"在思考"还是"在写正文"）。 */
  reasoningChars: number
  /** 是否已经收到正文（首个 answer delta）。 */
  hasAnswer: boolean
}

/** 服务端给过的阶段名里，我们认识哪些。 */
const KNOWN = new Set(['rewrite', 'evidence', 'reasoning', 'answer', 'done'])

/**
 * 最新一个**已观测到**的已知阶段。`stages` 是按到达顺序累积的，
 * 故取最后一个认识的名字 —— 不认识的（未来后端新增的）跳过而不是当成最新。
 */
function latestStage(stages: StageData[]): string | null {
  for (let i = stages.length - 1; i >= 0; i--) {
    const name = String(stages[i]?.name ?? '')
    if (KNOWN.has(name)) return name
  }
  return null
}

/**
 * 当前该显示什么。返回空串表示"没有什么可说的"（调用方据此不渲染状态行）。
 *
 * 分工刻意如此：**有服务端阶段事件时以它为准**（那是实测事实），
 * 阶段事件还没到时退回到本地状态机（否则首字之前会是一片空白）。
 */
export function liveStatusLabel(input: LiveInput): string {
  const { status, stages, evidenceCount, reasoningChars, hasAnswer } = input
  const n = evidenceCount

  if (status === 'error') return '出错了'
  if (status === 'aborted') return '已中断'

  // ⚠️ 改写阶段看 **status**，而不是"`stages` 里有没有 `rewrite`"：
  // `rewrite` 事件在**检索之前**就发出（多轮才发生），而 `stages` 是累积列表 ——
  // 它一旦进去就永远留在里面。若拿它当"当前进行到改写"，整轮余下的时间界面都会
  // 停在"正在改写问句"上，正好又是本条要修的那种"状态不变"。
  if (status === 'rewriting') return '正在结合上下文改写问句…'

  const stage = latestStage(stages)
  if (stage === 'done') return '已完成'
  if (stage === 'answer') return '分析完成，正在组织回答…'
  if (stage === 'reasoning') {
    // 思考阶段在服务端的定义是"生成开始 → 首个正文字"，故这里区分
    // "正在分析"（还在思考）与"正在作答"（正文已在路上）两件不同的事。
    return hasAnswer ? '正在作答…' : `已检索到 ${n} 条依据，正在分析…`
  }
  if (stage === 'evidence') {
    // ⚠️ 这里不能一律说「准备分析」：服务端的 `reasoning` **阶段事件**要等
    // **首个正文字**到达才发（`http_server.py` 把它放在 else 分支里），
    // 而思考本身早就开始了。若只看阶段名，真实的思考期间（实测可达 80 秒以上）
    // 界面会一直显示"准备分析"，与事实不符。
    // 故以**已收到的思考正文**为准——那是比阶段名更早、更直接的信号。
    return reasoningChars > 0
      ? `已检索到 ${n} 条依据，正在分析…`
      : `已检索到 ${n} 条依据，准备分析…`
  }

  // 阶段事件尚未到达（或只有 rewrite 这一个前缀阶段）：用本地状态机
  if (status === 'retrieving') return '正在检索证据…'
  if (status === 'streaming') {
    return reasoningChars > 0 ? `已检索到 ${n} 条依据，正在分析…` : '正在生成回答…'
  }
  return ''
}

/**
 * 当前阶段"已走过的毫秒数"的基准点：**服务端实测值 + 它到达的本地时刻**。
 *
 * 只报 `stage.elapsed_ms` 的话，一个长阶段（实测思考可达 80 秒以上）期间数字会**冻住**，
 * 看上去又是静止的 —— 那正是本条要修的问题。故记下它到达的时刻，之后按本地时钟往前推：
 * 显示的仍是"服务端报了多少 + 此后真实经过了多久"。
 */
export interface StageBase {
  name: string
  /** 服务端在该阶段结束时实测的毫秒数。 */
  ms: number
  /** 该事件到达浏览器时的本地时间戳。 */
  at: number
}

/** 阶段名或数值一变就重算基准点；没变则原样返回（避免每渲染都重置起点）。 */
export function stageBase(
  prev: StageBase | null,
  stage: StageData | undefined,
  now: number,
): StageBase | null {
  if (!stage) return null
  const ms = Number(stage.elapsed_ms)
  if (!Number.isFinite(ms) || ms < 0) return prev
  const name = String(stage.name)
  if (prev && prev.name === name && prev.ms === ms) return prev
  return { name, ms, at: now }
}

/** 已走过的毫秒数。返回 0 表示没有可报的数字（调用方据此不画耗时）。 */
export function elapsedMs(base: StageBase | null, now: number): number {
  if (!base) return 0
  const extra = now - base.at
  return base.ms + (extra > 0 ? extra : 0)
}

/** 毫秒 → 「12s」「1m05s」；不足一秒给「不到 1s」（不假装精确到毫秒）。 */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  const s = Math.floor(ms / 1000)
  if (s < 1) return '不到 1s'
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}
