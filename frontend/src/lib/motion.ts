/**
 * 背景两层的**纯数学**（`plan.md` §12.6）。无 DOM、无 React、无副作用 ——
 * 位置、连边与碰撞都在这里算，`Backdrop` 只负责把它们画出来。
 *
 * 为什么必须纯：背景动画要可复现、可测试。`Math.random` 会让「同一份代码两次渲染
 * 不同」，测试也就无从断言。这里用固定种子的 LCG，同一 seed 永远得到同一组数据。
 *
 * 两层是**并列**关系：
 * - **网络层**：`seedNet`/`stepNet`/`edgesWithin` —— 会缓慢漂移的节点与连边（层 A）。
 * - **气泡层**：`seedBubbles`/`stepBubbles` —— 缓慢移动的气泡（层 B），**不参与**连边。
 * 两者的数据与生命周期各自独立。
 *
 * ⚠️ 层 A **原先**是一组静态的 `seededNodes`/`networkEdges`（配 `Node` 与 `NODE_COUNT`）。
 * 003 把层 A 改成会动之后，那组实现已由上面的 `seedNet`/`stepNet`/`edgesWithin` 取代，
 * 却留在了模块里无人调用（只有测试还在调它）—— 触宪法 §3.1「写了不接线」，已删除。
 * 若要恢复静态网络，请从 git 历史取回，而不是重新留一份死代码。
 */

export interface Bubble {
  x: number
  y: number
  r: number
  vx: number
  vy: number
}

/** 层 B：约 14 个气泡。 */
export const BUBBLE_COUNT = 14
export const BUBBLE_MIN_R = 8
export const BUBBLE_MAX_R = 48
/** 气泡速度 ≈12 px/s。 */
export const BUBBLE_SPEED = 12
/** 连边阈值：仅连接距离内的两点。 */
export const EDGE_DISTANCE = 140

/** 分离时多退一点点，避免浮点误差让下一帧仍判为「重叠」。 */
const SEPARATION_EPSILON = 0.01

/**
 * 线性同余伪随机：种子固定 ⇒ 序列固定（`Math.random` 不可复现，故不用）。
 * 全程 32 位整数运算，返回值落在 `[0, 1)`。
 */
function lcg(seed: number): () => number {
  let state = seed >>> 0
  if (state === 0) state = 0x9e3779b9 // 种子 0 会让 LCG 退化成常量序列
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

/** 在 `[0, span]` 内取一点；`span` 为 0（视口比元素还小）时退化为 0，不产生 NaN。 */
function offset(rnd: () => number, span: number): number {
  return rnd() * Math.max(span, 0)
}

/** 层 B 的气泡：半径 8–48px，整圆落在视口内，初速 12 px/s、方向随机。 */
export function seedBubbles(w: number, h: number, n: number, seed: number): Bubble[] {
  const rnd = lcg(seed)
  const out: Bubble[] = []
  for (let i = 0; i < n; i++) {
    const r = BUBBLE_MIN_R + rnd() * (BUBBLE_MAX_R - BUBBLE_MIN_R)
    const angle = rnd() * Math.PI * 2
    out.push({
      r,
      x: r + offset(rnd, w - 2 * r),
      y: r + offset(rnd, h - 2 * r),
      vx: Math.cos(angle) * BUBBLE_SPEED,
      vy: Math.sin(angle) * BUBBLE_SPEED,
    })
  }
  return out
}

/**
 * 推进一帧：先按 `dt`（秒）位移，再解边界，最后解两两弹性碰撞。
 *
 * 等质量弹性碰撞的实现是「沿法线交换速度分量」，位置则各退一半到刚好相切 ——
 * 只交换速度不分离位置的话，两气泡会黏在一起反复触发碰撞。
 *
 * **纯函数**：入参数组与其中每个对象都不会被改动（返回全新对象）。
 */
export function stepBubbles(
  bubbles: readonly Bubble[],
  w: number,
  h: number,
  dt: number,
): Bubble[] {
  const next = bubbles.map((b) => ({ ...b, x: b.x + b.vx * dt, y: b.y + b.vy * dt }))

  for (const b of next) {
    // 只在**正朝墙里走**时反向：否则一次贴边的漂移会把速度反复翻号
    if (b.x - b.r < 0) {
      b.x = b.r
      if (b.vx < 0) b.vx = -b.vx
    } else if (b.x + b.r > w) {
      b.x = w - b.r
      if (b.vx > 0) b.vx = -b.vx
    }
    if (b.y - b.r < 0) {
      b.y = b.r
      if (b.vy < 0) b.vy = -b.vy
    } else if (b.y + b.r > h) {
      b.y = h - b.r
      if (b.vy > 0) b.vy = -b.vy
    }
  }

  for (let i = 0; i < next.length; i++) {
    for (let j = i + 1; j < next.length; j++) {
      const a = next[i]
      const b = next[j]
      let dx = b.x - a.x
      let dy = b.y - a.y
      let dist = Math.hypot(dx, dy)
      const min = a.r + b.r
      if (dist >= min) continue
      if (dist === 0) {
        // 圆心完全重合：给一个确定方向，别除以零（取 x 轴正向）
        dx = 1
        dy = 0
        dist = 1
      }
      const nx = dx / dist
      const ny = dy / dist

      const push = (min - dist + SEPARATION_EPSILON) / 2
      a.x -= nx * push
      a.y -= ny * push
      b.x += nx * push
      b.y += ny * push

      // 沿法线的速度分量：相等质量、完全弹性 ⇒ 交换
      const an = a.vx * nx + a.vy * ny
      const bn = b.vx * nx + b.vy * ny
      // 已在分离（法线分量不再相向）就不动速度，避免把擦身而过的一对硬拽回来
      if (an - bn <= 0) continue
      a.vx += (bn - an) * nx
      a.vy += (bn - an) * ny
      b.vx += (an - bn) * nx
      b.vy += (an - bn) * ny
    }
  }

  return next
}

// ---- 003 动态背景网络 ------------------------------------------------------
// 层 A 从「静态虚线网络」变为**会动的**网络（spec「动态背景网络」）：节点缓慢漂移、
// 越界环绕、连边随距离出现与消失。层 B（气泡）原样不动 —— 两层的纯函数并列存在，
// `stepBubbles` / `seedBubbles` 不因 003 改变。
//
// 取代关系（003）：原先层 A 的静态实现 `seededNodes`/`networkEdges`（配 `Node`、`NODE_COUNT`）
// 已由下面的 `seedNet`/`stepNet`/`edgesWithin` 取代，故那组实现连同测试一并删除；
// 连边阈值 `EDGE_DISTANCE` 仍由 `edgesWithin` 的默认参数使用，保留。

export interface NetNode { x: number; y: number; vx: number; vy: number }

/** 网络层节点速度（px/s）——比气泡更慢，作为背景纹理不应抢注意力。 */
const NET_SPEED = 6
/** 网络层节点数（沿用静态层当年的 48，保持观感密度不变）。 */
export const NET_NODE_COUNT = 48

/** 网络层节点：视口内均匀分布，初速 6 px/s、方向随机，同一 seed 完全可复现。 */
export function seedNet(width: number, height: number, n: number, seed: number): NetNode[] {
  // 复用模块内同一套 LCG：种子固定 ⇒ 序列固定（`Math.random` 不可复现，故不用）
  const rnd = lcg(seed)
  const out: NetNode[] = []
  for (let i = 0; i < n; i++) {
    const angle = rnd() * Math.PI * 2
    out.push({
      x: rnd() * width,
      y: rnd() * height,
      vx: Math.cos(angle) * NET_SPEED,
      vy: Math.sin(angle) * NET_SPEED,
    })
  }
  return out
}

/**
 * 环绕到 `[0, span)`。
 *
 * 取模而**不是**「越界就减一个 span」：后者只对「越界不足一屏」成立——标签页切回来后的
 * 时间跳跃、或将来调大速度时会一次跨过整屏，节点就留在界外，网络会慢慢空掉，正是
 * spec「自由进出屏幕…网络不会因为节点流失而变空」要防的事。
 */
function wrap(value: number, span: number): number {
  if (!(span > 0)) return 0
  const m = value % span
  return m < 0 ? m + span : m
}

/** 漂移一步；越界**环绕**到另一侧（spec「自由进出屏幕」）。纯函数：不改入参。 */
export function stepNet(
  nodes: readonly NetNode[],
  width: number,
  height: number,
  dt: number,
): NetNode[] {
  return nodes.map((n) => ({
    ...n,
    x: wrap(n.x + n.vx * dt, width),
    y: wrap(n.y + n.vy * dt, height),
  }))
}

/** 距离阈值内的连边（每帧重算 ⇒ 边随距离出现与消失）。无向，`[i, j]` 且 `i < j`。 */
export function edgesWithin(
  nodes: readonly NetNode[],
  threshold: number,
): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const dx = nodes[i].x - nodes[j].x
      const dy = nodes[i].y - nodes[j].y
      if (dx * dx + dy * dy <= threshold * threshold) out.push([i, j])
    }
  }
  return out
}
