/**
 * 全站字号（使用者 2026-09-19 要求：在明/暗开关右边加一个可调字号的控件）。
 *
 * 实现方式是**改根元素的 `font-size`**：全站尺寸都用 `rem` / Tailwind 的字号阶梯
 * （`text-xs`…`text-2xl` 都定义为 `rem`），故根字号一动，标题、正文、面板、
 * Markdown 答案**按同一比例**整体缩放。逐处改字号既改不全，也会让相对层级失衡。
 *
 * 单位用 `pt`（使用者以 pt 表述）：**1pt = 4/3 px**，故默认 16pt ≈ 21.3px。
 *
 * **区间 12–18pt、默认 16pt（使用者在 003 的实测反馈中把上限由 30 收窄到 18；
 * 该区间此前无处可查，T56 已回写为 001 §8 的 C-21）。** 收窄的代价是**存量值**：
 * 存储里可能躺着上限还是 30 时存下的 25 / 30，故 `loadFontPt` → `clampFontPt` 这条
 * 读取路径必须在载入时就把它夹进新区间 —— 否则根字号会按 30pt 渲染，而控件
 * （`max=18`）既显示不出这个值也拖不回去，使用者看到的是「字比最大档还大、
 * 滑杆却拖不动」这种自相矛盾的状态。
 */
export const FONT_PT_KEY = 'ragqa:font-pt'

/** 可调范围与默认值。默认 16pt 约等于浏览器 1rem，即改动前的观感。 */
export const FONT_PT_MIN = 12
export const FONT_PT_MAX = 18
export const FONT_PT_DEFAULT = 16

/**
 * 夹紧到合法区间；非有限数回落默认值（NaN 会被写成 `font-size: NaNpt` 而整站失效）。
 *
 * 它同时是**存量值的迁移点**：越界的旧值（30 / 25）在这里落到边界值，而不是
 * 被拒绝或原样透传 —— 使用者的字号偏好仍被尊重（贴到最接近的合法档），
 * 只是不再越出新区间。
 */
export function clampFontPt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return FONT_PT_DEFAULT
  return Math.min(FONT_PT_MAX, Math.max(FONT_PT_MIN, value))
}

export function loadFontPt(): number {
  try {
    const raw = localStorage.getItem(FONT_PT_KEY)
    if (raw === null) return FONT_PT_DEFAULT
    return clampFontPt(Number(raw))
  } catch {
    // 存储不可用（隐私模式/配额）：回落默认值，本次会话仍可调
    return FONT_PT_DEFAULT
  }
}

/** 写入侧同样夹紧：存储里不会出现越界值。失败静默（与主题键同一约定）。 */
export function saveFontPt(pt: number): void {
  try {
    localStorage.setItem(FONT_PT_KEY, String(clampFontPt(pt)))
  } catch {
    /* 同 saveConversations */
  }
}
