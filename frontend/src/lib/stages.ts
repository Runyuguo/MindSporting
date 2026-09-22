import type { StageData } from './events'

/** 阶段中文名。只用于展示，不参与判定。 */
export const STAGE_LABEL: Record<StageData['name'], string> = {
  rewrite: '理解问题',
  evidence: '检索证据',
  reasoning: '思考',
  answer: '组织回答',
  done: '完成',
}

/**
 * 阶段名的展示文案（**唯一入口**，组件不得直接查 `STAGE_LABEL`）。
 *
 * 事件名 `stage` 是已知的，故 `parseSse` 的未知事件闸门**挡不住一个未来新增的阶段名**；
 * 那时查表得到 `undefined`，`{STAGE_LABEL[s.name]} · {formatMs(...)}` 就渲染成一行
 * 「 · 400ms」——一个没有名字的阶段被当成事实端了出去（零静默失败的反面）。
 *
 * 未知名回退为「未知阶段（服务端原样给出的名字）」：既不编造中文名，也不留白，
 * 而且保留了排查线索（服务端到底发了什么）。
 */
export function stageLabel(name: unknown): string {
  if (typeof name !== 'string') return '未知阶段'
  const known = (STAGE_LABEL as Record<string, string | undefined>)[name]
  if (known) return known
  return name.trim() === '' ? '未知阶段' : `未知阶段（${name}）`
}

/** 句末标点：中英文都要认（思考流中英混排是常态）。 */
const SENTENCE_END = '。！？!?；;'

/**
 * 「某个句末标点之前的一段非标点文本 + 该标点」。`matchAll` 会把**所有**完整句
 * 依次捕出，最后一个就是「最后完成的那个句子」。
 *
 * 刻意不用 `split(标点)` 再回头 `indexOf` 找分隔符的写法：那样必须靠「子串在原文中
 * 首次出现的位置」猜回标点，而模型复述自己时（『第二句。第二句。』）第一次出现的位置
 * 会给出错误的字符，摘要就会丢掉句号或取错标点。捕获组直接把标点一起带出来，无此歧义。
 */
const SENTENCE_RE = new RegExp(`([^${SENTENCE_END}]+[${SENTENCE_END}])`, 'g')

const MAX_FALLBACK = 80

/**
 * 摘要的取法：
 * - `sentence` —— 取到了**最后一个完整句**（其后可能还有尚未写完的尾巴）；
 * - `tail` —— 还没有任何完整句（或整段没有标点），取的是已收到文本的**末尾片段**。
 *
 * 这个「取法」是给界面用来**如实说明**它正显示什么的。它**不是**「是否被截断」的判据：
 * 摘要短于全文是上面两种取法的常态，据此标注截断会在每一次流式思考的中途谎报
 * （截断只有在服务端 emit 了那条 notice 时才算事实）。
 */
export type SummaryKind = 'sentence' | 'tail'

export interface LatestSummary {
  text: string
  kind: SummaryKind
}

/**
 * 取思考流的实时摘要，并说明取法。
 *
 * 无完整句时（思考刚开始、或长句尚未结束）回退为**末尾**裁剪的前缀 —— 取末尾而非开头，
 * 因为流式输出里最新吐出的那段才是「现在在想什么」。两条路径都不超过一行，
 * 且**不额外调用模型**，故不增加任何延迟（spec C-12 的 A 案：摘要取自思考流自身）。
 */
export function summarizeLatest(text: string): LatestSummary {
  const t = text.trim()
  if (!t) return { text: '', kind: 'tail' }
  const matches = [...t.matchAll(SENTENCE_RE)]
  const last = matches.at(-1)
  if (last) return { text: last[1], kind: 'sentence' }
  return { text: t.length > MAX_FALLBACK ? t.slice(-MAX_FALLBACK) : t, kind: 'tail' }
}

/** 只要摘要文本时的薄封装（`latestSentence` 的语义与既有调用方都不变）。 */
export function latestSentence(text: string): string {
  return summarizeLatest(text).text
}
