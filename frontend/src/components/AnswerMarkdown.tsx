import { createContext, useContext, useMemo, type ComponentProps } from 'react'
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import type { Hit } from '../lib/events'
import { citationTarget, rehypeCitations } from '../lib/citations'
import { hasReadableOriginal } from './EvidenceCard'
import 'katex/dist/katex.min.css'

/**
 * 答案正文的渲染（Markdown + KaTeX），并**接线引用标记**（T56）。
 *
 * `[编号]` 的定位规则只在 `lib/citations.ts`（`citationTarget`）里写一次：这里只负责
 * 「渲染成控件还是留作文字」。二者合起来才让 spec 001「引用可追溯」的 Scenario
 * 「该编号能在本轮证据集合中找到对应条目」在界面上成立 —— 点编号即选中对应的证据卡
 * （走的是与点卡片同一条选中路径，见 `App.selectCitation`）。
 */

/** 本轮依据的接线。缺省 = 只读渲染（文献卡正文等没有「本轮命中」可指的地方）。 */
interface CitationScope {
  hits?: readonly Hit[]
  onCite?: (hit: Hit) => void
}

/**
 * 走 context 而不是给 react-markdown 的组件传 props：`components` 必须是**模块级稳定**的
 * 对象，否则每次渲染都换一个组件类型，React 会把整棵子树卸载重建（流式追加时每片都重建，
 * 焦点与选中态都会丢）。
 */
const CitationScopeContext = createContext<CitationScope>({})

/**
 * `a` 的渲染：引用标记 → `<button>`；其余 → 普通链接。
 *
 * 用原生 `<button type="button">` 而不是 `div[role=button]` 或 `<a>`：它是可聚焦、
 * 可被 Enter/Space 激活的原生控件，键盘通路不用自己维护（与证据卡、示例问题同一做法）。
 *
 * 不可跳转的标记**都不是控件**（不进 Tab 序、点了没有任何反应 —— 禁用态控件会暗示
 * 「条件满足时就能点」，而越界编号对应的那条证据**永远不存在**）。三种情形分开处理：
 * - **未接线**（文献卡正文等没有「本轮证据」可指的地方）→ 保持纯文字，连告知都不给：
 *   那里根本不存在「本轮没有第 n 条」这个语境；
 * - **编号越界**（模型可能发出，且它违反「引用可追溯」）→ 纯文字 + **如实告知**
 *   （宪法 §4.3 零静默失败：点了没反应时，使用者无从判断是模型错了还是产品坏了）；
 * - **命中存在但没有可读原文**（非 vault 来源）→ 保持纯文字。编号本身是**有效**的，
 *   只是没有可读原文，原因由证据卡上的「该来源没有可读原文」承载。
 */
function CitationLink({ node, children, ...rest }: ComponentProps<'a'> & ExtraProps) {
  const scope = useContext(CitationScopeContext)
  const raw = node?.properties?.dataCite
  if (raw === undefined) return <a {...rest}>{children}</a>

  const index = Number(raw)
  if (scope.onCite === undefined) return <>{children}</>

  const hit = citationTarget(scope.hits, index)
  if (hit === null) {
    /**
     * 告知必须**只说真话**，故分两种情形（`hits` 为 `undefined` = 本轮没有 record 过 evidence
     * 事件，例如那一轮的依据未能留存）：
     * - 有依据可数 → 「没有第 n 条」是事实；
     * - 依据根本不在手上 → 只能说「无法定位」，说「没有这一条」会把「不知道」讲成「不存在」。
     */
    const note =
      scope.hits === undefined
        ? `本轮依据未留存，无法定位第 ${index} 条`
        : `本轮没有第 ${index} 条依据`
    return (
      <span data-testid="citation-missing" title={note}>
        {children}
        {/* 告知用**真实文字**而不是只挂一个属性：`title` 在无障碍树里只是描述、读屏不保证
            念出来，而这句话在阅读顺序里，读屏一定会读到（视觉上不可见）。 */}
        <span className="sr-only">（{note}）</span>
      </span>
    )
  }

  // I2 同源：非 vault 来源的 `ref` 不是 vault 内 `.md` 路径，取文只会得到「不在本库范围内」。
  // 证据卡对这类命中本来就**不给可点入口**，引用标记必须同一判据，否则点它会以错误理由打开失败。
  if (!hasReadableOriginal(hit)) return <>{children}</>

  return (
    <button
      type="button"
      data-testid="citation-link"
      aria-label={`查看第 ${index} 条依据`}
      onClick={() => scope.onCite?.(hit)}
      className="tabular cursor-pointer text-[var(--color-accent)] underline-offset-2 transition-colors duration-[var(--duration-fast)] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
    >
      {children}
    </button>
  )
}

const COMPONENTS: Components = { a: CitationLink }

export function AnswerMarkdown({
  content,
  hits,
  onCite,
}: {
  content: string
  /**
   * **本条答案所属那一轮**的命中（`useChat` 的 `evidenceByRound[round]`，送达顺序），
   * 由调用方按「这条消息属于第几轮」取好 —— 不是依据栏当前显示的那个并集列表。
   */
  hits?: readonly Hit[]
  /** 点击可跳转的引用标记（只有存在且有可读原文的命中才会被回调）。 */
  onCite?: (hit: Hit) => void
}) {
  const scope = useMemo<CitationScope>(() => ({ hits, onCite }), [hits, onCite])
  // 不使用 prose-invert —— @tailwindcss/typography 未安装，该类会静默失效
  return (
    <div className="max-w-none text-sm leading-relaxed">
      <CitationScopeContext.Provider value={scope}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath]}
          // 顺序承重：katex 先跑（见 `rehypeCitations` 的注释），本插件才能整棵跳过公式。
          rehypePlugins={[rehypeKatex, rehypeCitations]}
          components={COMPONENTS}
        >
          {content}
        </ReactMarkdown>
      </CitationScopeContext.Provider>
    </div>
  )
}
