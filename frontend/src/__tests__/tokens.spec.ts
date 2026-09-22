import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(resolve(__dirname, '../index.css'), 'utf8')

describe('design tokens', () => {
  it('declares a @theme block', () => {
    // `@theme` 上的 `static` 是承重结构，不是可选写法：一旦省掉它，Tailwind v4 会裁剪掉
    // 所有未被生成工具类引用的令牌；而组件是通过 var() arbitrary value 消费令牌的，
    // Tailwind 追踪不到这类引用，令牌定义便在构建产物中静默消失，组件拿到无效声明。
    // 在断言中要求 `static`，等于把本次修复钉死，而不只是允许它存在。
    // 这是对简报逐字文本的一次有意偏离，方向为「增强」。
    expect(css).toMatch(/@theme\s+static\s*\{/)
  })

  it('declares the required token names', () => {
    for (const name of [
      '--color-bg',
      '--color-surface',
      '--color-fg',
      '--color-muted',
      '--color-accent',
      '--color-border',
      '--color-success',
      '--color-warning',
      '--color-danger',
      // T31：文字底板令牌（块级施加；plan §12.6）
      '--color-panel',
      '--color-panel-border',
    ]) {
      expect(css).toContain(name)
    }
  })

  it('uses no hex literal outside the @theme block', () => {
    const outside = css.replace(/@theme\s*\{[\s\S]*?\n\}/, '')
    expect(outside).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })

  // ---- 品牌标题渐变的对比度（整支审查 I5 实施时**实测发现**的缺陷） -------------
  //
  // spec 要求标题「文字呈现颜色渐变」。渐变起点也是**文字颜色**，故必须过 AA ——
  // 而 `--color-accent` 在浅色主题下是 `oklch(0.68 …)`，与浅底只有 **2.57:1**
  // （远低于 4.5:1）。当时的实现直接拿 accent 当起点，等于让标题左边一截不可读。
  // 单测此前查不出来：jsdom 不做布局、也不解析 oklch 的对比度。
  // 故这里把换算写进测试，让"起点色够不够黑/够不够亮"成为可回归的判据。
  describe('品牌渐变起点色的对比度', () => {
    // oklch -> sRGB -> WCAG 相对亮度 -> 对比度（与规划阶段手算同一套公式；
    // 用既有令牌校准过：暗色标题得 17.28、浅色 17.59，与 spec 记录的 17.34/17.65 同量级）
    const srgb = (L: number, C: number, H: number) => {
      const h = (H * Math.PI) / 180
      const a = C * Math.cos(h), b = C * Math.sin(h)
      const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
      const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
      const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
      const lin = [
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
      ]
      return lin.map((u) => {
        const v = Math.max(0, Math.min(1, u))
        return v > 0.0031308 ? 1.055 * v ** (1 / 2.4) - 0.055 : 12.92 * v
      })
    }
    const luminance = (rgb: number[]) =>
      rgb
        .map((u) => (u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4))
        .reduce((acc, v, i) => acc + v * [0.2126, 0.7152, 0.0722][i], 0)
    const contrast = (a: number[], b: number[]) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
      return (hi + 0.05) / (lo + 0.05)
    }
    const token = (name: string, block: string) => {
      const m = block.match(new RegExp(`${name}:\\s*oklch\\(([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)`))
      if (!m) throw new Error(`令牌 ${name} 未在该主题块中声明`)
      return [+m[1], +m[2], +m[3]] as [number, number, number]
    }

    const darkBlock = css.slice(0, css.indexOf("html[data-theme='light']"))
    const lightBlock = css.slice(css.indexOf("html[data-theme='light']"))

    it.each([
      ['暗色', darkBlock],
      ['浅色', lightBlock],
    ])('%s主题：渐变起点与页面底色至少 4.5:1（AA 正文级）', (_theme, block) => {
      const start = token('--color-brand-start', block)
      const bg = token('--color-bg', block)
      expect(contrast(srgb(...start), srgb(...bg))).toBeGreaterThanOrEqual(4.5)
    })
  })

  // 复审 Minor（SC-24「动效 = 0」/ spec §4「尊重减少动态」）：全站唯一的一处过渡
  // （思考面板的开合按钮 `transition-colors`）此前没有任何退出通道。断言的是**规则真的在**
  // 且关的是时长，而不只是「文件里出现过这几个字」——减少动态**不得删除信息**，
  // 故这里只许关动效，不许出现 display/visibility/content 这类会藏内容的声明。
  it('declares a reduced-motion block that neutralises durations without hiding content', () => {
    const block = css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\n\}/)
    expect(block).not.toBeNull()
    const body = block?.[0] ?? ''
    expect(body).toMatch(/animation-duration:\s*0/)
    expect(body).toMatch(/transition-duration:\s*0/)
    expect(body).not.toMatch(/display:\s*none|visibility:\s*hidden|content:\s*none/)
  })
})
