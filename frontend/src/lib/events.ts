export interface Hit {
  rowid: number
  source: string
  ref: string
  title: string
  category: string
  extra: string
  snippet: string
  score: number
  rrf?: number
}

export interface RewriteData {
  query: string
  degraded: boolean
}

export interface EvidenceData {
  lib: string
  query: string
  hits: Hit[]
}

export interface AnswerData {
  delta: string
}

/** 003：模型思考流的一个增量片段（后端旁路转发，见 server/http_server.py）。 */
export interface ReasoningData {
  delta: string
}

/**
 * 003：需要如实告知、但**不是失败**的一件事。
 *
 * 用途有二：正文补救后仍不达标时的篇幅告知（带 `chars` / `target`），
 * 以及思考不可用 / 被上限截断时的可见说明。用 notice 而非 error 是刻意的 ——
 * 这一轮是「成功但有需要说明的事」，标成 error 会把一次成功交付说成失败。
 */
/**
 * 003：notice 的**机器可读**分类（整支审查 I3）。
 *
 * 为什么要这个字段：notice 的 `message` 里会插入服务端原文（`补救生成失败：{exc}`
 * 这类），异常消息不受我们控制。前端若按**文案子串**判定"这是哪一类告知"
 * （原先按「截断」二字），任何恰好含该词的其它告知都会把它误读成思考被截断。
 * 故分类必须走字段，文案只用于展示。
 *
 * 目前只有一种分类；将来新增分类时在此追加，消费方按需分支。
 */
export type NoticeKind = 'reasoning_truncated'

export interface NoticeData {
  message: string
  /** 机器可读分类；省略表示"无特定分类"的普通告知。 */
  kind?: NoticeKind
  /** 实际交付字数（仅篇幅告知带）。 */
  chars?: number
  /** 目标字数（仅篇幅告知带）。 */
  target?: number
}

/**
 * 003：一个阶段**服务端实测**的耗时。
 *
 * 只来自服务端事件，前端不自行计时 —— 自己掐表会凭空造出一个与真实进展无关的数字。
 * `rewrite` 只在**真的发生改写**时才发（单轮请求没有它），故消费方不得假定它存在。
 */
export interface StageData {
  name: 'rewrite' | 'evidence' | 'reasoning' | 'answer' | 'done'
  elapsed_ms: number
}

export interface ErrorData {
  message: string
}

export type SseEvent =
  | { event: 'rewrite'; data: RewriteData }
  | { event: 'evidence'; data: EvidenceData }
  | { event: 'answer'; data: AnswerData }
  | { event: 'reasoning'; data: ReasoningData }
  | { event: 'notice'; data: NoticeData }
  | { event: 'stage'; data: StageData }
  | { event: 'error'; data: ErrorData }
  | { event: 'done'; data: Record<string, never> }

/**
 * 后端可能新增事件类型；未知事件被忽略而不是误判成已知类型。
 *
 * **本数组与后端实际 emit 的事件名必须同步**：`parseSse` 对不在其中的事件名
 * 静默 `continue`，漏加一项就等于把一种真实事件整体丢掉且不报错（T44 专项测试钉住）。
 */
export const KNOWN_EVENTS = [
  'rewrite',
  'evidence',
  'answer',
  'reasoning',
  'notice',
  'stage',
  'error',
  'done',
] as const
