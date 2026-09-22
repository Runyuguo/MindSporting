import { FONT_PT_MAX, FONT_PT_MIN } from '../lib/fontSize'

/**
 * 全站字号控件（使用者 2026-09-19：加在明/暗开关右边）。
 *
 * 用原生 `<input type="range">`：可键盘操作（方向键微调、Tab 可达），
 * 读屏会念出 role=slider 与当前值 —— 与三条生成参数滑杆同一套做法。
 *
 * 可见文案给出当前值（`16pt`），可访问名也带上它：只报「字体大小」而不报当前值，
 * 读屏使用者无法知道自己在哪一档。
 */
export function FontSizeControl({
  pt,
  onChange,
}: {
  pt: number
  onChange: (next: number) => void
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-[var(--color-muted)]">
      <span aria-hidden="true">字号</span>
      <input
        type="range"
        aria-label={`字号：当前 ${pt}pt`}
        min={FONT_PT_MIN}
        max={FONT_PT_MAX}
        step={1}
        value={pt}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-24 accent-[var(--color-accent)]"
      />
      <span className="tabular w-10 text-right text-xs">{pt}pt</span>
    </label>
  )
}
