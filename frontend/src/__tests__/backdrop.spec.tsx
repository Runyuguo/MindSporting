import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Backdrop } from '../components/Backdrop'

type Calls = Record<string, number>

/**
 * jsdom 没有 canvas 2D（`getContext('2d')` 返回 null），故这里是**测试边界**：
 * 给一个只记录调用的假 context，用来统计「画了什么」，而不是断言颜色像素。
 * `moves` 额外记下每次 `moveTo` 的坐标 —— 网络层的「节点真的在动」只能靠坐标证明
 * （调用次数在静态重绘与动态推进下是一样的）。
 */
function makeContext(calls: Calls, moves: Array<[number, number]>) {
  const hit = (name: string) => {
    calls[name] = (calls[name] ?? 0) + 1
  }
  return {
    globalAlpha: 1,
    lineWidth: 1,
    strokeStyle: '',
    fillStyle: '',
    clearRect: () => hit('clearRect'),
    save: () => hit('save'),
    restore: () => hit('restore'),
    beginPath: () => hit('beginPath'),
    moveTo: (x: number, y: number) => {
      hit('moveTo')
      moves.push([x, y])
    },
    lineTo: () => hit('lineTo'),
    stroke: () => hit('stroke'),
    arc: () => hit('arc'),
    fill: () => hit('fill'),
    closePath: () => hit('closePath'),
    setLineDash: () => hit('setLineDash'),
    setTransform: () => hit('setTransform'),
  }
}

/** rAF 桩：不自动执行回调，由用例手动 flush —— 帧数因此完全可控。 */
function stubAnimationFrame() {
  const pending: FrameRequestCallback[] = []
  const raf = vi.fn((cb: FrameRequestCallback) => {
    pending.push(cb)
    return pending.length
  })
  const cancel = vi.fn()
  vi.stubGlobal('requestAnimationFrame', raf)
  vi.stubGlobal('cancelAnimationFrame', cancel)
  return {
    raf,
    cancel,
    /** 执行最早排入的一帧。 */
    flush: (time: number) => pending.shift()?.(time),
  }
}

/**
 * `prefers-reduced-motion` 桩。`reduce: true` 表示系统要求「减少动态」。
 * 其余媒体查询一律不匹配（宽屏相关断言不归本文件管）。
 */
function stubReducedMotion(reduce: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: reduce && q.includes('prefers-reduced-motion'),
    media: q,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }))
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden })
}

describe('Backdrop', () => {
  let calls: Calls
  let moves: Array<[number, number]>
  let originalGetContext: typeof HTMLCanvasElement.prototype.getContext
  let originalWidth: PropertyDescriptor | undefined
  let originalHeight: PropertyDescriptor | undefined

  beforeEach(() => {
    calls = {}
    moves = []
    const ctx = makeContext(calls, moves)
    originalGetContext = HTMLCanvasElement.prototype.getContext
    // jsdom 的 getContext 一律返回 null 并打印「Not implemented」；这里换成记录器
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ctx) as never
    // jsdom 没有布局引擎：clientWidth/clientHeight 恒为 0，而组件会据此判定「还没布局」
    originalWidth = Object.getOwnPropertyDescriptor(
      HTMLCanvasElement.prototype,
      'clientWidth',
    )
    originalHeight = Object.getOwnPropertyDescriptor(
      HTMLCanvasElement.prototype,
      'clientHeight',
    )
    Object.defineProperty(HTMLCanvasElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => 1440,
    })
    Object.defineProperty(HTMLCanvasElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => 900,
    })
  })

  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext
    if (originalWidth) {
      Object.defineProperty(HTMLCanvasElement.prototype, 'clientWidth', originalWidth)
    } else {
      delete (HTMLCanvasElement.prototype as unknown as { clientWidth?: number }).clientWidth
    }
    if (originalHeight) {
      Object.defineProperty(HTMLCanvasElement.prototype, 'clientHeight', originalHeight)
    } else {
      delete (HTMLCanvasElement.prototype as unknown as { clientHeight?: number }).clientHeight
    }
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    // `document.hidden` 是原型上的 getter，用例覆写后必须清掉自己的影子属性
    delete (document as unknown as { hidden?: boolean }).hidden
    // 主题属性是全局的：换主题用例写过之后必须清掉，免得渗进同文件后续用例
    document.documentElement.removeAttribute('data-theme')
  })

  it('渲染一个不吃点击的背景画布：pointer-events: none + aria-hidden', () => {
    stubReducedMotion(true)
    stubAnimationFrame()
    const { container } = render(<Backdrop />)

    const canvas = container.querySelector('canvas')
    expect(canvas).not.toBeNull()
    expect(canvas).toHaveAttribute('aria-hidden', 'true')
    expect(canvas?.className).toContain('pointer-events-none')
    // 视口铺满 + 置于内容之下
    expect(canvas?.className).toContain('fixed')
    expect(canvas?.className).toContain('inset-0')
    expect(canvas?.className).toContain('-z-10')
    // 只有一张 canvas（两层画在同一张上，但数据与生命周期各自独立）
    expect(container.querySelectorAll('canvas')).toHaveLength(1)
  })

  it('prefers-reduced-motion: reduce 时不启动动画，但仍画出**一帧**（两层都在）', () => {
    stubReducedMotion(true)
    const { raf } = stubAnimationFrame()
    render(<Backdrop />)

    // SC-16：降级 = 不排帧
    expect(raf).not.toHaveBeenCalled()
    // 但两层都画了：虚线网络（setLineDash）与气泡（arc）
    expect(calls.setLineDash ?? 0).toBeGreaterThan(0)
    expect(calls.arc ?? 0).toBeGreaterThan(0)
    expect(calls.clearRect ?? 0).toBeGreaterThan(0)
  })

  it('reduce 下换主题仍重画一帧（否则背景停在旧主题的墨色），且始终不排帧', async () => {
    stubReducedMotion(true)
    const { raf } = stubAnimationFrame()
    render(<Backdrop />)

    const clearsBefore = calls.clearRect ?? 0
    const arcsBefore = calls.arc ?? 0
    const dashesBefore = calls.setLineDash ?? 0
    expect(clearsBefore).toBeGreaterThan(0)

    // 明/暗切换只改令牌值、不改组件状态，而取色是运行时读 `--color-fg` 的：
    // 背景必须自己重画，否则 reduce 下会一直用旧主题的墨色 —— 浅色主题里那超出
    // spec §4「背景不干扰阅读」（同一语义色 < 0.15），「只画一帧」也就成了假话。
    await act(async () => {
      document.documentElement.setAttribute('data-theme', 'light')
    })

    // 一个完整的重画周期：clearRect 与两层绘制各多一次
    expect(calls.clearRect ?? 0).toBe(clearsBefore + 1)
    expect(calls.setLineDash ?? 0).toBe(dashesBefore + 1)
    expect(calls.arc ?? 0).toBeGreaterThan(arcsBefore)
    // 降级模式不得因换主题而开始排帧（SC-16：只画静态帧，绝不进入动画）
    expect(raf).not.toHaveBeenCalled()
  })

  it('prefers-reduced-motion 不为 reduce 时启动动画', () => {
    stubReducedMotion(false)
    const { raf } = stubAnimationFrame()
    render(<Backdrop />)

    expect(raf).toHaveBeenCalled()
  })

  it('document.hidden 为真时暂停排帧，复原后继续', () => {
    stubReducedMotion(false)
    const { raf } = stubAnimationFrame()
    render(<Backdrop />)

    const scheduledBefore = raf.mock.calls.length
    expect(scheduledBefore).toBeGreaterThan(0)

    setHidden(true)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(raf.mock.calls.length).toBe(scheduledBefore) // 不再继续排

    setHidden(false)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(raf.mock.calls.length).toBeGreaterThan(scheduledBefore) // 恢复
  })

  it('卸载时取消动画帧（无泄漏）', () => {
    stubReducedMotion(false)
    const { cancel } = stubAnimationFrame()
    const { unmount } = render(<Backdrop />)

    unmount()

    expect(cancel).toHaveBeenCalled()
  })

  it('持续动画时每帧重绘，且两层始终同时在场', () => {
    stubReducedMotion(false)
    const { flush, raf } = stubAnimationFrame()
    render(<Backdrop />)

    const arcsAfterFirstFrame = calls.arc ?? 0
    expect(arcsAfterFirstFrame).toBeGreaterThan(0)
    expect(calls.setLineDash ?? 0).toBeGreaterThan(0)

    flush(16)
    flush(32)
    flush(48)

    // 每帧都在画（气泡位置推进 ⇒ 重绘），而不是画一次就停
    expect(calls.arc ?? 0).toBeGreaterThan(arcsAfterFirstFrame)
    expect(calls.setLineDash ?? 0).toBeGreaterThan(1)
    expect(raf.mock.calls.length).toBeGreaterThan(1)
  })

  // ---- 003：动态背景网络（spec「尊重减少动态」/「不干扰阅读与交互」/「节点在动」）--
  // 前两条是简报 Step 6 指定的边界；第三条把「网络层真的在动」变成可机检的（否则
  // 把 `stepNet` 从 tick 里删掉，本文件其余用例全绿 —— 调用次数在静态与动态下一样）。

  it('减少动态下不启动动画帧（帧数 0），但静态两层仍在', () => {
    stubReducedMotion(true)
    const { raf } = stubAnimationFrame()
    render(<Backdrop />)

    // SC-21：减少动态 ⇒ 动画帧数 = 0（不是「把速度调小」，是根本不进动画循环）
    expect(raf).not.toHaveBeenCalled()
    // 降级 ≠ 不画：虚线网络层与气泡层都仍画了一帧
    expect(calls.setLineDash ?? 0).toBeGreaterThan(0)
    expect(calls.moveTo ?? 0).toBeGreaterThan(0)
    expect(calls.arc ?? 0).toBeGreaterThan(0)
  })

  it('背景层不拦截点击（pointer-events: none 是生效值，不只是类名）', () => {
    // 本条只关心装饰层的指针语义：固定为降级模式并替换 rAF，免得帧循环在后台空转
    stubReducedMotion(true)
    stubAnimationFrame()
    render(<Backdrop />)

    const layer = screen.getByTestId('backdrop')
    // 读**计算值**：jsdom 没有 CSS 引擎，故 SC-21 的这条硬约束由行内 style 兜底，
    // 否则「不吃点击」就只是样式表里的一句承诺。
    expect(getComputedStyle(layer).pointerEvents).toBe('none')
    expect(layer).toHaveAttribute('aria-hidden', 'true')
  })

  it('网络层真的在动：节点坐标随时间变化（不是静止纹理）', () => {
    stubReducedMotion(false)
    const { flush } = stubAnimationFrame()
    render(<Backdrop />)

    // 首帧是挂载时同步画的。按**帧**比较（而不是「取前 N 个坐标」——边数不是 N 的整数倍时，
    // 错位的切片会自己和自己不等，测出个假绿）。
    const firstFrame = [...moves]
    expect(firstFrame.length).toBeGreaterThan(0)

    moves.length = 0
    flush(16) // 只是排帧（start），不推进
    flush(32) // 真正推进一帧并重绘
    const secondFrame = [...moves]

    expect(secondFrame.length).toBeGreaterThan(0)
    expect(secondFrame).not.toEqual(firstFrame)
  })
})
