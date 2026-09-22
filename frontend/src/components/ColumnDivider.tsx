import { useCallback, useRef } from 'react'
import { COLUMN_LABEL, STEP, STEP_FAST, type ColumnKey } from '../lib/layout'

interface Props {
  left: ColumnKey
  right: ColumnKey
  /** 分隔线**自身**的位移（`clientX - 起始x`）：正数=右移，负数=左移。
   *  ⚠️ 别把它读成"让给哪一栏"——右移是让左栏变宽（`applyPairResize` 的 `a` 是左栏）。 */
  onResize: (delta: number) => void
  onReset: () => void
}

/**
 * 可拖动的栏分隔线（spec「栏宽可调」/「分隔线可用键盘操作」）。
 *
 * 用 Pointer Events 而非 Mouse Events：一并覆盖触控与笔。
 * 键盘：方向键按 STEP，Shift + 方向键按 STEP_FAST（spec 所称「加速键」）。
 *
 * 可访问名用**中文栏名**（`COLUMN_LABEL`，与栏开关同一份映射）：分隔线是
 * 「不得只能由指针完成」的等价入口，裸 key（`调整 rail 与 chat 的宽度`）不是
 * 面向人的名称。
 */
export default function ColumnDivider({ left, right, onResize, onReset }: Props) {
  const dragging = useRef<{ x: number } | null>(null)

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = { x: e.clientX }
    e.currentTarget.setPointerCapture(e.pointerId)
  }, [])

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return
    const delta = e.clientX - dragging.current.x
    if (delta === 0) return
    dragging.current.x = e.clientX
    onResize(delta)
  }, [onResize])

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }, [])

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? STEP_FAST : STEP
    if (e.key === 'ArrowLeft') { onResize(-step); e.preventDefault() }
    else if (e.key === 'ArrowRight') { onResize(step); e.preventDefault() }
  }, [onResize])

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`调整${COLUMN_LABEL[left]}与${COLUMN_LABEL[right]}的宽度`}
      tabIndex={0}
      data-testid={`divider-${left}-${right}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
      className="w-1 shrink-0 cursor-col-resize bg-transparent transition-colors duration-[var(--duration-fast)] hover:bg-[var(--color-border)] focus-visible:bg-[var(--color-accent)]"
    />
  )
}
