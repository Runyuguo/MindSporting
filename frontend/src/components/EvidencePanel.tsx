import type { Hit } from '../lib/events'
import { EvidenceCard } from './EvidenceCard'

/**
 * 宽屏常驻证据侧栏。与内联的 EvidenceList 共用 EvidenceCard，不复制渲染逻辑。
 *
 * 常驻性由调用方（`wide`）决定，本组件**始终**渲染 `<aside>`：侧栏不能因为「本轮
 * 还没有证据」而消失，否则刷新后两栏会塌成一栏（spec「桌面全屏布局」/ SC-10）。
 * 内容分三态：有证据 → 卡片列表；零命中且本轮问过 → `emptyLabel`；
 * 尚未问过（首屏）→ 调用方传的中性占位文案。
 *
 * 证据**是**按会话留存的（`Conversation.evidenceByRound`，plan §12.2）：刷新后从历史
 * 恢复的对话，其早前轮次的命中会与本轮的并集一起重新出现在这里（`shownRounds` 决定
 * 显示哪几轮），所以「尚未问过」只对真正没问过的会话成立。
 *
 * `selectedRowid` / `onSelect` 只负责选中态与回调（文献卡侧栏的入口）；不传即只读。
 * 可点选与否由 EvidenceCard 按 `source` 判定 —— 非 `vault:*` 没有可读原文，不给入口（I2）。
 *
 * `searching` = 显示「正在检索新一轮」标记：调用方按「并存而非互斥」算好 —— 有上一轮命中时
 * 标记说明它们在为哪一轮让位；空态要宣告「上一轮零命中」时，标记说明结论来自上一轮、新一轮
 * 还在查。第一轮在飞时调用方会把它置假（那里 emptyLabel 本身就写着「正在检索依据…」）。
 */
export function EvidencePanel({
  hits,
  emptyLabel,
  searching = false,
  selectedRowid = null,
  onSelect,
  width,
}: {
  hits: Hit[]
  emptyLabel: string
  searching?: boolean
  selectedRowid?: number | null
  onSelect?: (hit: Hit) => void
  /**
   * 生效宽度（px），由调用方的 `useLayout` state 给出（T50/T51）。
   * 不传则不给宽度声明（组件在测试里可独立挂载）。
   */
  width?: number
}) {
  return (
    <aside
      data-testid="evidence-panel"
      // 宽度改由 state 驱动（`style`）：003 起栏宽可拖、可折叠，下限由 `clampWidth`
      // 在**状态层**保证（低于可读下限即折叠为关闭态），不再靠绑不住的 `min-w-[…]`。
      // `shrink-0` 仍要在场：inline 宽是 flex base size，允许收缩就会把下限吃掉。
      style={{ width }}
      className="h-full shrink-0 overflow-y-auto border-l border-[var(--color-border)] p-4"
    >
      <h2 className="mb-3 text-xs tracking-wide text-[var(--color-muted)]">
        依据来源
      </h2>
      {/* 与空态**并存**：空态说的是上一轮的结论（「未找到依据」），标记说的是新一轮还在查。
          标记是否显示由调用方的 `searching` 决定（见上方注释）。role=status 让读屏也能获知。 */}
      {searching && (
        <p
          role="status"
          aria-live="polite"
          className="mb-2 text-xs text-[var(--color-muted)]"
        >
          正在检索新一轮…
        </p>
      )}
      {hits.length === 0 ? (
        <p className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-muted)]">
          {emptyLabel}
        </p>
      ) : (
        <ol className="flex flex-col gap-2">
          {hits.map((h, i) => (
            <EvidenceCard
              key={h.rowid}
              index={i + 1}
              hit={h}
              selected={h.rowid === selectedRowid}
              onSelect={onSelect}
            />
          ))}
        </ol>
      )}
    </aside>
  )
}
