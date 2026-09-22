import type { Message } from '../lib/storage'
import type { Hit } from '../lib/events'
import { formatElapsed } from '../lib/liveStatus'
import { AnswerMarkdown } from './AnswerMarkdown'

export function MessageBubble({
  message,
  streaming = false,
  /**
   * 提问进行中的**真实状态文案**（由 ChatPanel 从服务端阶段事件推出）。
   * 空串表示"无话可说"，此时不渲染状态行。缺省值让既有调用方（消息列表里
   * 已完成的历史气泡）无需关心它。
   */
  liveLabel = '',
  /** 服务端实测的当前阶段耗时（ms）。0 表示没有可报的数字。 */
  liveElapsedMs = 0,
  /**
   * 本条答案**所属那一轮**的命中（T56），用于把正文里的 `[编号]` 接成可跳转的引用标记。
   * 缺省（如只读渲染、非助手消息）= 正文里的编号只是文字。
   */
  hits,
  /** 点击可跳转的引用标记（见 `AnswerMarkdown`）。 */
  onCite,
}: {
  message: Message
  streaming?: boolean
  liveLabel?: string
  liveElapsedMs?: number
  hits?: readonly Hit[]
  onCite?: (hit: Hit) => void
}) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[46rem] rounded-md border border-[var(--color-panel-border)] bg-[var(--color-panel)] px-4 py-3 text-sm">
          {message.content}
        </div>
      </div>
    )
  }
  const elapsed = formatElapsed(liveElapsedMs)
  /**
   * 状态行：这一轮还在进行时显示。
   * 文案优先用调用方给的**真实状态**（`liveLabel`，由 `ChatPanel` 从服务端阶段事件推出）；
   * 没给时退回一句中性文案 —— 组件本身不该在"进行中"却什么都不说。
   */
  const showLive = streaming
  const label = liveLabel !== '' ? liveLabel : '正在生成…'
  return (
    <div className="flex justify-start">
      <div className="max-w-[52rem] rounded-md border border-[var(--color-panel-border)] bg-[var(--color-panel)] px-4 py-3">
        {showLive && (
          <span
            role="status"
            aria-live="polite"
            className="flex items-center gap-2 text-xs text-[var(--color-muted)]"
          >
            {/* 指示点是纯装饰：状态本身由文字承载，故 aria-hidden */}
            <span
              aria-hidden="true"
              className="inline-block size-2 shrink-0 animate-pulse rounded-full bg-[var(--color-accent)]"
            />
            <span>{label}</span>
            {elapsed ? <span className="tabular">· {elapsed}</span> : null}
          </span>
        )}
        {message.content ? (
          <AnswerMarkdown content={message.content} hits={hits} onCite={onCite} />
        ) : showLive ? null : (
          // 既没有正文、又不是进行中：此时才说这句中性的等待文案。
          // （原先这里是写死的「正在检索证据…」，无论检索是否早已结束都一直挂着。）
          <span className="text-sm text-[var(--color-muted)]">正在准备…</span>
        )}
      </div>
    </div>
  )
}
