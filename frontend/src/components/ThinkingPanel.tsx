import type { StageData } from '../lib/events'
import { stageLabel, summarizeLatest } from '../lib/stages'

/** 展开区容器的 id：开合按钮的 `aria-controls` 指向它（容器始终在 DOM 里）。 */
const DETAILS_ID = 'thinking-details'

/** 随会话留存的上一轮思考（plan §4.4）：只存摘要与耗时，全文不落盘。 */
export interface PersistedThinking {
  summary: string
  ms?: number
}

interface Props {
  reasoningText: string
  stages: StageData[]
  notices: string[]
  open: boolean
  onToggle: () => void
  /** 会话里留存的思考摘要与耗时；刷新后本轮实时思考已不在内存里，靠它仍可见。 */
  persisted?: PersistedThinking
}

/**
 * 毫秒人性化：1s 以下给整数毫秒，以上给一位小数的秒。
 *
 * 非有限数与负数（NaN / Infinity / -1，或畸形载荷里的字符串）**不是一次测量**：
 * 原样端出去会渲染成「NaNms」「-1ms」，把一个坏载荷说成实测值。此时回退为可见的
 * 「耗时未知」——既不编造数字，也不留白（零静默失败的两个方向都要守）。
 */
function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '耗时未知'
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
}

/**
 * 留存行文案：有摘要说摘要，只有耗时说耗时，两者都没有则整行不渲染（不写空话）。
 * 摘要为空串时**不得**渲染成「摘要：」——那是一个没有内容的断言。
 */
function persistedText(persisted: PersistedThinking): string {
  const ms = persisted.ms === undefined ? '' : formatMs(persisted.ms)
  if (persisted.summary !== '' && ms !== '') {
    return `随会话留存的思考摘要：${persisted.summary} · ${ms}`
  }
  if (persisted.summary !== '') return `随会话留存的思考摘要：${persisted.summary}`
  if (ms !== '') return `随会话留存的思考耗时：${ms}`
  return ''
}

/**
 * 等待期的真实进展面板（003 第 9 条）。
 *
 * 三条硬约束：
 * 1. **只用真实数据** —— 阶段名与耗时全部来自服务端 `stage` 事件，未发生即不渲染
 *    （单轮请求没有 `rewrite`，故这里绝不补一个「理解问题 · 0ms」）；
 * 2. **零静默失败** —— 思考不可用时显示 notice，绝不静默留白。
 *    （思考已**取消转发上限**，故面板里不再有「被截断」这一类标注与文案。）
 * 3. **刷新后仍可见** —— 实时思考不在内存里时，显示随会话留存的摘要与耗时，并说明
 *    全文仅当次可见（plan §4.4）。
 *
 * 样式只消费既有令牌（`index.css` 的 `@theme`）与既有组件的 arbitrary value 写法；
 * 唯一的过渡动效由 `index.css` 的 `prefers-reduced-motion` 全局块关闭，且**不影响信息可达**。
 */
export default function ThinkingPanel({
  reasoningText,
  stages,
  notices,
  open,
  onToggle,
  persisted,
}: Props) {
  const summary = summarizeLatest(reasoningText)
  const live = reasoningText !== '' || stages.length > 0 || notices.length > 0
  /**
   * 留存行只在**没有本轮实时思考**时出现：本轮实时思考在时它才是这一轮的真值，
   * 而留存记录是同一轮结束时的落盘产物 —— 同时出现就是把同一件事说两遍。
   */
  const stored = live ? undefined : persisted
  const storedLine = stored ? persistedText(stored) : ''

  /**
   * 收起态那一行的补充说明。两种情形**都只说事实**：
   * - 只取到最后一个完整句 ⇒「仅显示最后一句」（其后还有没写完的尾巴）；
   * - 还没有完整句、只取到末尾片段 ⇒「仅显示末尾片段」。
   * 两者都不是截断 —— 只是「收起态只取最后一句」这一取法的正常表现。
   */
  const condensation =
    summary.text === '' || summary.text === reasoningText.trim()
      ? ''
      : summary.kind === 'sentence'
        ? '仅显示最后一句'
        : '仅显示末尾片段'

  return (
    <section
      aria-label="思考"
      className="mb-3 rounded-md border border-[var(--color-panel-border)] bg-[var(--color-surface)] p-3 text-sm"
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          // 只说「展开没展开」不够：读屏还需要知道展开的是**哪一块**内容。
          aria-controls={DETAILS_ID}
          className="cursor-pointer rounded-sm text-xs text-[var(--color-muted)] transition-colors duration-[var(--duration-fast)] hover:text-[var(--color-fg)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
        >
          {open ? '收起思考' : '展开思考'}
        </button>
        {/* 收起时也必须留一行实时摘要：这是「等待有事可看」的主要载体。
            补充说明用普通文本 token，**不用 title / aria-label**——
            读屏能读到它才算真的说了。 */}
        {!open && summary.text ? (
          <span className="truncate text-xs text-[var(--color-muted)]">
            {summary.text}
            {condensation ? ` · ${condensation}` : ''}
            </span>
        ) : null}
      </div>

      {/* 刷新后本轮实时思考已不在内存里，但留存下来的摘要与耗时仍在（plan §4.4）。
          两个状态都显示：收起态它是唯一能看到的东西，展开态它是全文缺失的替代。 */}
      {storedLine ? (
        <p className="mt-2 text-xs text-[var(--color-muted)]">{storedLine}</p>
      ) : null}

      {stages.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--color-muted)]">
          {stages.map((s) => (
            <li key={`${s.name}-${s.elapsed_ms}`}>
              {stageLabel(s.name)} · {formatMs(s.elapsed_ms)}
            </li>
          ))}
        </ul>
      ) : null}

      {/* 展开区容器**始终**在 DOM 里（`aria-controls` 必须指向一个真实存在的元素），
          内容才是按需渲染的。 */}
      <div id={DETAILS_ID}>
        {/* 全文只在展开时渲染，且是**真实文本节点**（读屏可达）；
            收起态下它与摘要不会同时出现，故「展开显示全文」不可能被摘要语义混淆。 */}
        {open && reasoningText ? (
          <p className="mt-2 whitespace-pre-wrap text-[var(--color-muted)]">{reasoningText}</p>
        ) : null}

        {/* plan §4.4 的原话：全文不落盘，刷新后必须说清「你看到的不是全文」。 */}
        {open && storedLine ? (
          <p className="mt-2 text-xs text-[var(--color-muted)]">
            全文已不在本轮记录中（仅当次可见）。
          </p>
        ) : null}
      </div>

      {notices.map((n) => (
        <p key={n} role="status" className="mt-2 text-xs text-[var(--color-warning)]">
          {n}
        </p>
      ))}
    </section>
  )
}
