/**
 * 品牌标题「思维游乐场」（spec「品牌标题」）。
 *
 * spec 要求它被**艺术化**呈现 —— 「至少包含**颜色渐变**与**背板纹理**，
 * 而非单色平涂」（`spec.md` Requirement 与「艺术化呈现」Scenario，
 * 且明写是「**文字**呈现颜色渐变」）。故本组件的结构是三层：
 *
 * 1. `<h1>` 带令牌单色 —— 这是**保底**：渐变只作装饰，文字颜色始终有一个
 *    主题令牌兜着，两种主题下都保持正文级对比度。
 * 2. 承载文字的 `<span>` 才有渐变，且 `text-transparent` **只写在 `@supports` 里**。
 *    这点是本文件的要害：若把 `text-transparent` 无条件写上去，不支持
 *    `background-clip: text` 的浏览器会得到**完全看不见**的标题
 *    （透明字 + 背景不被裁剪到文字上）。故不支持时它退回第 1 层的单色。
 * 3. 背板细网格用 `::before` 伪元素 —— 纯装饰、`aria-hidden`、不占文本节点，
 *    故 `textContent` 仍严格等于「思维游乐场」，读屏拿到的也仍是这四个字。
 *
 * 渐变 60% 处即停在 `--color-fg`，只在左端掺入 `--color-accent`：主要目的是
 * 不牺牲对比度（accent 在暗色的亮度低于 fg，掺多了会跌出 AA）。
 */
export default function BrandTitle() {
  return (
    <h1 className="relative isolate text-lg font-medium text-[var(--color-fg)]">
      {/* 背板细网格：纯装饰 —— 空节点 + aria-hidden + pointer-events:none，
          故既不进可访问性树，也不改变 h1 的 textContent。
          掩膜让两端淡出，避免在标题左右留下一条硬边。 */}
      <span
        aria-hidden="true"
        data-testid="brand-texture"
        className="pointer-events-none absolute -inset-x-2 -inset-y-1 -z-10 rounded-sm opacity-60
                   [background-image:linear-gradient(to_right,var(--color-border)_1px,transparent_1px),linear-gradient(to_bottom,var(--color-border)_1px,transparent_1px)]
                   [background-size:6px_6px]
                   [mask-image:linear-gradient(to_right,transparent,black_30%,black_70%,transparent)]"
      />
      <span
        className="[background-image:linear-gradient(to_right,var(--color-brand-start),var(--color-fg)_60%)] bg-clip-text
                   supports-[(-webkit-background-clip:text)]:text-transparent"
      >
        思维游乐场
      </span>
      <span
        aria-hidden="true"
        className="absolute inset-x-0 -bottom-1 h-px bg-gradient-to-r from-transparent via-[var(--color-accent)] to-transparent"
      />
    </h1>
  )
}
