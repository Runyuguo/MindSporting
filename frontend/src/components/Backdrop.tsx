import { useEffect, useRef } from 'react'
import {
  BUBBLE_COUNT,
  BUBBLE_MAX_R,
  BUBBLE_MIN_R,
  EDGE_DISTANCE,
  NET_NODE_COUNT,
  edgesWithin,
  seedBubbles,
  seedNet,
  stepBubbles,
  stepNet,
} from '../lib/motion'

/** 固定种子：渲染可复现（`Math.random` 会让两次加载长得不一样，测试也无从断言）。 */
const SEED_NODES = 0x5eed01
const SEED_BUBBLES = 0x5eed02

/** 层 A（虚线网络）：plan §12.6 的 ≈0.12 透明度。 */
const NETWORK_ALPHA = 0.12
/** 层 B（气泡）：0.06–0.1，半径越大越实。 */
const BUBBLE_ALPHA_MIN = 0.06
const BUBBLE_ALPHA_MAX = 0.1
const DASH = [2, 6]

/**
 * 取设计令牌的**计算值**——背景取色一律走令牌，不新增裸 hex/rgb
 * （宪法 §4.1；也让明/暗主题切换只需重绘，不必改代码）。
 * 取不到时返回空串：背景是装饰，宁可少画一笔，也不硬编码一个颜色。
 */
function token(el: Element, name: string): string {
  try {
    return getComputedStyle(el).getPropertyValue(name).trim()
  } catch {
    return ''
  }
}

/**
 * 背景容器：**两层各自独立**的视觉同时存在（`plan.md` §12.6，使用者已确认）。
 *
 * - 层 A：约 48 个节点的虚线网络的**缓慢漂移**（`setLineDash`、lineWidth 1、α≈0.12）。
 *   003 起它不再静止：每帧 `stepNet` 推进、越界环绕、`edgesWithin` 重算连边，
 *   故网络形状随时间改变（spec「动态背景网络」）。
 * - 层 B：约 14 个缓慢移动的气泡（半径 8–48px、≈12 px/s、α 0.06–0.1），
 *   与边界及彼此做弹性碰撞；气泡**不参与**连边。
 *
 * 两者画在同一张 `<canvas>` 上，但数据与生命周期各自独立：网络层由 `seedNet` 播种
 * （视口尺寸变化时按新尺寸重排），气泡每帧 `stepBubbles`。装饰层不得吃点击，故
 * `pointer-events-none`（并在行内**再声明一次**：装饰层的「不拦截交互」是硬约束，
 * 不该依赖样式表是否加载成功）+ `aria-hidden`。
 *
 * 降级（SC-16）：`prefers-reduced-motion: reduce` ⇒ 两层都只画**一帧静态**、
 * 不启动 `requestAnimationFrame`（网络层停在 `seedNet` 的初始分布上）；
 * `document.hidden` ⇒ 暂停排帧；卸载 ⇒ `cancelAnimationFrame`。
 * 降级模式下**尺寸变化与明/暗切换仍各重画一次**（不是动画：每次变化一个同步帧，
 * 帧间不排帧）—— 否则换主题后背景会停在旧主题的墨色上。
 */
export function Backdrop() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    // 还没布局（尺寸为 0）就不必画：铺满视口的 canvas 在真实浏览器里挂载时必有尺寸，
    // 而 jsdom 没有布局引擎 —— 这条守卫让非浏览器环境连 getContext 都不必调用。
    if (canvas.clientWidth === 0 || canvas.clientHeight === 0) return
    const ctx = canvas.getContext('2d')
    // 环境不支持 canvas：背景是纯装饰，静默降级，绝不阻断界面
    if (ctx === null) return

    let w = canvas.clientWidth
    let h = canvas.clientHeight
    let nodes = seedNet(w, h, NET_NODE_COUNT, SEED_NODES)
    let edges = edgesWithin(nodes, EDGE_DISTANCE)
    let bubbles = seedBubbles(w, h, BUBBLE_COUNT, SEED_BUBBLES)

    const resize = () => {
      const dpr = window.devicePixelRatio || 1
      w = canvas.clientWidth
      h = canvas.clientHeight
      canvas.width = Math.max(Math.round(w * dpr), 1)
      canvas.height = Math.max(Math.round(h * dpr), 1)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      // 层 A 随视口重排：按新尺寸重新播种（spec「视口改变」——不聚集一角、不留大片空白），
      // 连边随之重算。层 B 同样重新播种，避免留下界外气泡。
      nodes = seedNet(w, h, NET_NODE_COUNT, SEED_NODES)
      edges = edgesWithin(nodes, EDGE_DISTANCE)
      bubbles = seedBubbles(w, h, BUBBLE_COUNT, SEED_BUBBLES)
    }

    const drawNetwork = (stroke: string) => {
      ctx.save()
      ctx.globalAlpha = NETWORK_ALPHA
      ctx.lineWidth = 1
      ctx.setLineDash(DASH)
      if (stroke !== '') ctx.strokeStyle = stroke
      ctx.beginPath()
      for (const [i, j] of edges) {
        ctx.moveTo(nodes[i].x, nodes[i].y)
        ctx.lineTo(nodes[j].x, nodes[j].y)
      }
      ctx.stroke()
      ctx.restore()
    }

    const drawBubbles = (fill: string) => {
      ctx.save()
      if (fill !== '') ctx.fillStyle = fill
      const span = BUBBLE_MAX_R - BUBBLE_MIN_R
      for (const b of bubbles) {
        ctx.globalAlpha =
          BUBBLE_ALPHA_MIN + ((b.r - BUBBLE_MIN_R) / span) * (BUBBLE_ALPHA_MAX - BUBBLE_ALPHA_MIN)
        ctx.beginPath()
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.restore()
    }

    const draw = () => {
      const ink = token(canvas, '--color-fg')
      ctx.clearRect(0, 0, w, h)
      drawNetwork(ink)
      drawBubbles(ink)
    }

    resize()
    // 首帧同步画一次：否则挂载后到第一帧之间背景是空白的
    draw()

    const reduced =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

    let frame = 0
    let last = 0

    const tick = (time: number) => {
      // dt 上限 0.1s：标签页切回来时 time 会跳一大截，不夹住会让气泡瞬移穿墙
      // （网络层有取模环绕，本不怕大 dt，但两层共用同一个时钟，一并对齐）
      const dt = last === 0 ? 0 : Math.min((time - last) / 1000, 0.1)
      last = time
      // 层 A：漂移 + 环绕，连边按新位置重算（⇒ 边随距离出现与消失）
      nodes = stepNet(nodes, w, h, dt)
      edges = edgesWithin(nodes, EDGE_DISTANCE)
      bubbles = stepBubbles(bubbles, w, h, dt)
      draw()
      frame = requestAnimationFrame(tick)
    }

    const start = (time: number) => {
      last = time
      frame = requestAnimationFrame(tick)
    }

    const stop = () => {
      cancelAnimationFrame(frame)
      frame = 0
      last = 0
    }

    const onVisibility = () => {
      if (document.hidden) stop()
      else if (frame === 0) start(0)
    }

    const onResize = () => {
      resize()
      draw()
    }

    let observer: MutationObserver | null = null

    // 排帧只属于「允许动画」这一支：降级模式下这里绝不能被启动。
    // `visibilitychange` 会 start(0)，故它也只能挂在这一支。
    if (!reduced) {
      frame = requestAnimationFrame(start)
      document.addEventListener('visibilitychange', onVisibility)
    }

    // 下面两项**两种模式都要**：重画只与「尺寸 / 主题变了」有关，与是否动画无关。
    // 降级模式此前漏了它们，于是换主题后背景仍用旧主题的墨色（浅色主题下超出
    // spec §4「背景不干扰阅读」的 < 0.15），所谓「只画一帧」也成了假话。
    window.addEventListener('resize', onResize)
    // 明/暗切换只换令牌值：监听 data-theme 重画**一次**，取色仍走令牌。
    // 回调里不做任何排帧，故降级模式仍严格保持「静态帧」（SC-16）。
    if (typeof MutationObserver === 'function') {
      observer = new MutationObserver(() => draw())
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme'],
      })
    }

    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('resize', onResize)
      observer?.disconnect()
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      data-testid="backdrop"
      aria-hidden="true"
      // 装饰层：不吃点击、不参与可访问性树；固定在内容之下（body 背景之上）。
      // `pointer-events` 在**行内**再声明一次：SC-21 要求「拦截的交互次数 = 0」，
      // 这条硬约束不该取决于样式表是否加载成功（也让无 CSS 引擎的 jsdom 能验证它）。
      style={{ pointerEvents: 'none' }}
      className="pointer-events-none fixed inset-0 -z-10 h-full w-full"
    />
  )
}
