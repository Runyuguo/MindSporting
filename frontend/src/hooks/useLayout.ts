import { useCallback, useState } from 'react'
import {
  DEFAULT_LAYOUT,
  DEFAULT_STORAGE_STATE,
  applyPairResize,
  clampWidth,
  loadLayout,
  saveLayout,
  type ColumnKey,
  type Layout,
  type StorageState,
} from '../lib/layout'

/** 布局状态与持久化。任何变更都立即落盘（布局跨浏览器重开必须保持）。 */
export function useLayout() {
  const [layout, setLayout] = useState<Layout>(() => loadLayout())
  const [storage, setStorage] = useState<StorageState>(DEFAULT_STORAGE_STATE)

  /** 写盘并把结果变成可见状态（宪法 §3.3：不得静默吞掉失败）。 */
  const persist = useCallback((next: Layout) => {
    const ok = saveLayout(next)
    setStorage({ ok, lastWriteFailed: !ok })
  }, [])

  const setWidth = useCallback((key: ColumnKey, width: number) => {
    setLayout((prev) => {
      const next = { ...prev, [key]: clampWidth(key, width) }
      persist(next)
      return next
    })
  }, [persist])

  /**
   * 相邻两栏此消彼长（分隔线拖动 / 键盘 / 双击复位）。
   *
   * 与「连续两次 `setWidth`」的区别（T51 复审 Important #1）：后者第二个调用读的是**渲染闭包**
   * 里的旧 `layout`，同一批次内的两条位移会互相覆盖。
   * 这里改用纯函数 `applyPairResize(prev, …)`，在**最新**状态上一次算完
   * （可读下限 / 越过即折叠 / 每栏上限一律由 `clampWidth` 提供）。
   */
  const resizePair = useCallback((a: ColumnKey, b: ColumnKey) => (delta: number) => {
    setLayout((prev) => {
      const next = applyPairResize(prev, a, b, delta)
      persist(next)
      return next
    })
  }, [persist])

  const toggle = useCallback((key: ColumnKey) => {
    setLayout((prev) => {
      const cur = prev[key]
      // 对话栏不可关闭：开关对它无效（按钮在 UI 层也会被禁用）
      if (key === 'chat') return prev
      const next = {
        ...prev,
        [key]: cur.open
          ? { width: 0, open: false }
          : { ...cur, width: cur.width || DEFAULT_LAYOUT[key].width, open: true },
      }
      persist(next)
      return next
    })
  }, [persist])

  /** 双击分隔线：相邻两栏回到默认宽度（spec C-3）。 */
  const resetPair = useCallback((a: ColumnKey, b: ColumnKey) => {
    setLayout((prev) => {
      const next = {
        ...prev,
        [a]: { ...DEFAULT_LAYOUT[a], open: true },
        [b]: { ...DEFAULT_LAYOUT[b], open: true },
      }
      persist(next)
      return next
    })
  }, [persist])

  /** 提示已被使用者看到后清除（一次性提示）。 */
  const ackStorageNotice = useCallback(() => {
    setStorage((s) => ({ ...s, lastWriteFailed: false }))
  }, [])

  return { layout, storage, setWidth, resizePair, toggle, resetPair, ackStorageNotice }
}
