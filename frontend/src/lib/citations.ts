import type { Element, ElementContent, Root, RootContent, Text } from 'hast'
import type { Hit } from './events'

/**
 * 答案里的 `[编号]` 引用（T56）。
 *
 * ## 映射规则（**前端的唯一落地处**，别在别处再定一套）
 *
 * **答案里第 n 个编号 `[n]` = 该答案所属那一轮的 `evidence` 事件里第 n 条命中（1 起）。**
 *
 * 为什么就是这个对应关系 —— 后端就是这么编号的，且两处用的是**同一个数组**：
 * `server/http_server.py` 把本轮的 `hits` 逐条渲染成 `[{i + 1}] {title}\n{snippet}`
 * 塞进提示词，紧接着把**同一个 `hits`** 原样发在 `evidence` 事件里：
 *
 * ```python
 * evidence_text = "\n".join(f"[{i + 1}] {h.get('title', '')}\n{h.get('snippet', '')}"
 *                           for i, h in enumerate(hits))
 * yield _sse({"lib": lib, "query": resolved, "hits": hits}, event="evidence")
 * ```
 *
 * 所以编号 = **该轮命中数组的下标 + 1**，与依据栏显示顺序同源：`useChat` 把
 * `hits` 原样存进 `evidenceByRound[round]`（送达顺序，不排序、不筛选），正文里的
 * 编号就是在这个数组里的位置。
 *
 * ⚠️ 注意编号**只在轮内**有意义。依据栏的累积视图（`unionHits`）会把各轮并集后
 * **最近一轮置顶**并按 `rowid` 去重 —— 那是**显示顺序**，不是编号；把它当编号会指错卡。
 * 这也是调用方（`ChatPanel`）必须按「这条答案属于哪一轮」取 `evidenceByRound[round]`
 * 再交给本函数的原因，而不是拿依据栏当前显示的列表来定位。
 *
 * 越界（n 大于命中条数、n ≤ 0、非整数）一律返回 `null`：**不选中任何卡片、不打开
 * 任何文献**。模型确实可能发出这种编号（提示词只说了「用 [编号] 标注」，没有约束取值范围），
 * 而「按越界编号去点开一篇」会造成错误的跳转 —— 宁可什么都不做。
 */
export function citationTarget(
  hits: readonly Hit[] | undefined,
  index: number,
): Hit | null {
  if (!Number.isInteger(index) || index < 1) return null
  return hits?.[index - 1] ?? null
}

/**
 * 引用标记的**候选**形态：半角 `[n]` 与全角 `【n】`，n 为 1–3 位数字。
 *
 * 三处刻意的收窄：
 * - 上限 3 位：本轮命中数由「证据数」参数决定（上限 50），四位以上的方括号数字
 *   （`[2024]` 这类年份/编号）不是引用，留在正文里；
 * - 下限从 1 起（`[0]` 不匹配编号语义，见 `citationTarget`）；
 * - 只认数字：提示词里的 `[推测]` 与其它方括号词（`[摘要]`）不得被当成引用。
 *
 * 全角一并支持：提示词写的是半角，而中文语境下模型经常输出全角 —— 两套都认，
 * 免得同一段答案里一半编号能点、一半点不动。
 */
const MARKER_PATTERN = '\\[(\\d{1,3})\\]|【(\\d{1,3})】'

/**
 * 不进入的子树：
 * - `code` / `pre`：代码里的 `[1]` 是字面量（数组下标之类），改写成控件等于改写代码；
 * - `a`：链接内部再放一个可点控件是无效嵌套（读屏与键盘顺序都会乱）。
 *
 * 公式另判（见 `isMath`）：`rehype-katex` 会把**原始 TeX** 原样放进 MathML 的
 * `<annotation encoding="application/x-tex">`，`$a[1]$` 的源码里就含 `[1]` ——
 * 不跳过就会在公式里长出引用控件。
 */
const SKIP_TAGS = new Set(['code', 'pre', 'a'])

/** 公式子树（remark-math 的包装元素与 katex 自己的输出、含 katex-error 回退）。 */
function isMath(el: Element): boolean {
  const cls = el.properties?.className
  const list = Array.isArray(cls) ? cls : typeof cls === 'string' ? [cls] : []
  return list.some(
    (c) =>
      typeof c === 'string' &&
      (c === 'math' || c.startsWith('math-') || c.startsWith('katex')),
  )
}

/**
 * 把一个文本节点按引用标记切开；没有标记时返回 `null`（调用方据此跳过，
 * 不新建数组 —— 流式追加时这条路径每片都要走一遍）。
 *
 * 切出来的标记元素是 `<a data-cite="n">`：
 * - 用 `a` 是因为它是唯一能承载「标记」语义又不与既有 Markdown 元素冲突的标签，
 *   且 `components` 映射里有它的位置（自定义标签名不在 `Components` 的类型内）；
 * - `href="#cite-n"` 只是给 HAST 一个合法形态，真正的渲染由
 *   `components/a` 覆盖成 `<button>`（见 `AnswerMarkdown`）；
 * - 子节点保留**原文**（`[1]` 或 `【1】`）：不可点时原样留作文字，不改写模型写的字。
 */
function splitMarker(value: string): Array<Text | Element> | null {
  const re = new RegExp(MARKER_PATTERN, 'g')
  const out: Array<Text | Element> = []
  let last = 0
  for (let m = re.exec(value); m !== null; m = re.exec(value)) {
    if (m.index > last) out.push({ type: 'text', value: value.slice(last, m.index) })
    const index = Number(m[1] ?? m[2])
    out.push({
      type: 'element',
      tagName: 'a',
      properties: { href: `#cite-${index}`, dataCite: String(index) },
      children: [{ type: 'text', value: m[0] }],
    })
    last = m.index + m[0].length
  }
  if (out.length === 0) return null
  if (last < value.length) out.push({ type: 'text', value: value.slice(last) })
  return out
}

function splitIn(children: Array<RootContent | ElementContent>): void {
  for (let i = 0; i < children.length; i++) {
    const node = children[i]
    if (node.type === 'text') {
      const parts = splitMarker(node.value)
      if (parts === null) continue
      children.splice(i, 1, ...parts)
      i += parts.length - 1
      continue
    }
    if (node.type !== 'element') continue
    if (SKIP_TAGS.has(node.tagName) || isMath(node)) continue
    splitIn(node.children)
  }
}

/**
 * rehype 插件：把答案正文里的 `[n]` / 【n】 标记成**候选**引用元素。
 *
 * 它只负责「哪里是标记、编号是几」；**能不能点**由渲染层判定
 * （`AnswerMarkdown` 用 `citationTarget` + `hasReadableOriginal`）—— 于是本插件与
 * 「本轮有哪些命中」无关，`content` 不变时产物就稳定，不必随依据变化重解析。
 *
 * 必须排在 `rehype-katex` **之后**：公式先落成 katex 子树，这里才能按类名整棵跳过；
 * 反过来（先跑本插件）会把 `$a[1]$` 的 TeX 源码当正文切开，公式随之报废。
 */
export function rehypeCitations() {
  return (tree: Root): void => {
    splitIn(tree.children)
  }
}
