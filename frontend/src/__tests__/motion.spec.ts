import { describe, expect, it } from 'vitest'
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
  type Bubble,
  type NetNode,
} from '../lib/motion'

const W = 1440
const H = 900

describe('motion.seedBubbles', () => {
  it('同一 seed 可复现，不同 seed 不同', () => {
    const a = seedBubbles(W, H, BUBBLE_COUNT, 11)
    expect(a).toEqual(seedBubbles(W, H, BUBBLE_COUNT, 11))
    expect(a).toHaveLength(BUBBLE_COUNT)
    expect(a).not.toEqual(seedBubbles(W, H, BUBBLE_COUNT, 12))
  })

  it('初始位置与半径都落在视口内，半径在 8–48px 之间（含上下界）', () => {
    const bubbles = seedBubbles(W, H, BUBBLE_COUNT, 5)
    for (const b of bubbles) {
      expect(b.r).toBeGreaterThanOrEqual(BUBBLE_MIN_R)
      expect(b.r).toBeLessThanOrEqual(BUBBLE_MAX_R)
      expect(b.x).toBeGreaterThanOrEqual(b.r)
      expect(b.x).toBeLessThanOrEqual(W - b.r)
      expect(b.y).toBeGreaterThanOrEqual(b.r)
      expect(b.y).toBeLessThanOrEqual(H - b.r)
      // 初速就是标称的缓慢速度（≈12 px/s），不是零也不是随机大小
      expect(Math.hypot(b.vx, b.vy)).toBeCloseTo(12, 6)
    }
  })

  it('视口比气泡直径还小时不产生 NaN（只夹紧，不崩）', () => {
    for (const b of seedBubbles(10, 10, 3, 1)) {
      expect(Number.isFinite(b.x)).toBe(true)
      expect(Number.isFinite(b.y)).toBe(true)
    }
  })
})

describe('motion.stepBubbles', () => {
  const bubble = (over: Partial<ReturnType<typeof seedBubbles>[number]> = {}) => ({
    x: 500,
    y: 400,
    r: 20,
    vx: 12,
    vy: 0,
    ...over,
  })

  it('是纯函数：不修改入参', () => {
    const input = [bubble({ x: 100, y: 100 }), bubble({ x: 900, y: 700, vx: -12 })]
    const snapshot = JSON.parse(JSON.stringify(input))

    const out = stepBubbles(input, W, H, 1)

    expect(input).toEqual(snapshot)
    expect(out).not.toBe(input)
    expect(out[0]).not.toBe(input[0])
  })

  it('按速度推进位置', () => {
    const out = stepBubbles([bubble({ x: 500, y: 400, vx: 12, vy: 0 })], W, H, 0.5)
    expect(out[0].x).toBeCloseTo(506, 6)
    expect(out[0].y).toBeCloseTo(400, 6)
  })

  it('撞左边界：vx 反向且位置夹回视口内', () => {
    const out = stepBubbles([bubble({ x: 21, y: 400, r: 20, vx: -120, vy: 0 })], W, H, 1)
    expect(out[0].vx).toBeGreaterThan(0)
    expect(out[0].x).toBeGreaterThanOrEqual(out[0].r)
  })

  it('撞右边界：vx 反向且位置夹回视口内', () => {
    const out = stepBubbles(
      [bubble({ x: W - 21, y: 400, r: 20, vx: 120, vy: 0 })],
      W,
      H,
      1,
    )
    expect(out[0].vx).toBeLessThan(0)
    expect(out[0].x).toBeLessThanOrEqual(W - out[0].r)
  })

  it('撞上边界：vy 反向且位置夹回视口内', () => {
    const out = stepBubbles([bubble({ x: 400, y: 21, r: 20, vx: 0, vy: -120 })], W, H, 1)
    expect(out[0].vy).toBeGreaterThan(0)
    expect(out[0].y).toBeGreaterThanOrEqual(out[0].r)
  })

  it('撞下边界：vy 反向且位置夹回视口内', () => {
    const out = stepBubbles(
      [bubble({ x: 400, y: H - 21, r: 20, vx: 0, vy: 120 })],
      W,
      H,
      1,
    )
    expect(out[0].vy).toBeLessThan(0)
    expect(out[0].y).toBeLessThanOrEqual(H - out[0].r)
  })

  it('两气泡正面相撞：两者都反向，且碰撞后不重叠', () => {
    const a = bubble({ x: 400, y: 300, r: 20, vx: 60, vy: 0 })
    const b = bubble({ x: 430, y: 300, r: 20, vx: -60, vy: 0 })

    const out = stepBubbles([a, b], W, H, 0.1)

    expect(out[0].vx).toBeLessThan(0) // 向右走的被弹回左边
    expect(out[1].vx).toBeGreaterThan(0) // 向左走的被弹回右边
    const gap = Math.hypot(out[1].x - out[0].x, out[1].y - out[0].y)
    expect(gap).toBeGreaterThanOrEqual(out[0].r + out[1].r - 1e-6)
  })

  it('完全重合也不产生 NaN（不可除以零）', () => {
    const out = stepBubbles(
      [bubble({ x: 400, y: 300, vx: 12, vy: 0 }), bubble({ x: 400, y: 300, vx: -12, vy: 0 })],
      W,
      H,
      0.1,
    )
    for (const b of out) {
      expect(Number.isFinite(b.x)).toBe(true)
      expect(Number.isFinite(b.y)).toBe(true)
      expect(Number.isFinite(b.vx)).toBe(true)
      expect(Number.isFinite(b.vy)).toBe(true)
    }
  })
})

describe('motion 两层互相独立', () => {
  it('stepBubbles 不改入参，也不影响网络层数据', () => {
    const bubbles = seedBubbles(W, H, BUBBLE_COUNT, 22)
    const bubblesSnapshot: Bubble[] = JSON.parse(JSON.stringify(bubbles))
    const net = seedNet(W, H, NET_NODE_COUNT, 23)
    const netSnapshot: NetNode[] = JSON.parse(JSON.stringify(net))

    stepBubbles(bubbles, W, H, 0.016)

    expect(bubbles).toEqual(bubblesSnapshot)      // 纯函数：不改入参
    expect(net).toEqual(netSnapshot)             // 气泡层跑动不触碰网络层
  })
})

describe('motion.edgesWithin 连边规则', () => {
  const at = (x: number, y = 100): NetNode => ({ x, y, vx: 0, vy: 0 })

  it('仅当两节点距离 ≤ 阈值时产生一条边', () => {
    expect(edgesWithin([at(100), at(100 + EDGE_DISTANCE - 1)], EDGE_DISTANCE)).toEqual([[0, 1]])
  })

  it('阈值之外的两个节点之间没有边（含恰好越过阈值）', () => {
    expect(edgesWithin([at(100), at(100 + EDGE_DISTANCE + 1)], EDGE_DISTANCE)).toEqual([])
    expect(edgesWithin([at(0)], EDGE_DISTANCE)).toEqual([])
  })
})

// ---- 003：动态背景网络（层 A 从静态变为会动） --------------------------------
describe('动态背景网络（003）', () => {
  it('节点按速度漂移（位移随时间非零）', () => {
    const nodes = seedNet(800, 600, 10, 1)
    const after = stepNet(nodes, 800, 600, 0.5)
    const moved = after.some((n, i) => n.x !== nodes[i].x || n.y !== nodes[i].y)
    expect(moved).toBe(true)
  })

  it('越界节点环绕到另一侧（自由进出屏幕）', () => {
    const nodes = [{ x: 799, y: 300, vx: 1000, vy: 0 }]
    const after = stepNet(nodes, 800, 600, 1)
    expect(after[0].x).toBeGreaterThanOrEqual(0)
    expect(after[0].x).toBeLessThanOrEqual(800)
  })

  // 环绕必须是**取模**，而不是「越界就减一个屏宽」：后者只对越界不足一屏成立，
  // 一次跨过多屏（标签页切回的时间跳跃、或将来调大速度）会把节点留在界外，
  // 网络于是慢慢空掉 —— 正是 spec「网络不会因为节点流失而变空」要防的事。
  it('一次跨过多屏也仍落回视口内（环绕不是只减一次屏宽）', () => {
    const after = stepNet([{ x: 10, y: 10, vx: -5000, vy: 9000 }], 800, 600, 1)
    for (const n of after) {
      expect(n.x).toBeGreaterThanOrEqual(0)
      expect(n.x).toBeLessThanOrEqual(800)
      expect(n.y).toBeGreaterThanOrEqual(0)
      expect(n.y).toBeLessThanOrEqual(600)
    }
  })

  it('连边随距离出现与消失', () => {
    const near = [{ x: 0, y: 0, vx: 0, vy: 0 }, { x: 10, y: 0, vx: 0, vy: 0 }]
    const far = [{ x: 0, y: 0, vx: 0, vy: 0 }, { x: 5000, y: 0, vx: 0, vy: 0 }]
    expect(edgesWithin(near, 120)).toHaveLength(1)
    expect(edgesWithin(far, 120)).toHaveLength(0)
  })

  it('同一种子产生相同初始分布（可复现）', () => {
    expect(seedNet(800, 600, 5, 42)).toEqual(seedNet(800, 600, 5, 42))
  })

  it('同一种子可复现且数量正确，不同种子分布不同', () => {
    const a = seedNet(W, H, NET_NODE_COUNT, 7)
    expect(a).toHaveLength(NET_NODE_COUNT)
    expect(a).toEqual(seedNet(W, H, NET_NODE_COUNT, 7))
    expect(a).not.toEqual(seedNet(W, H, NET_NODE_COUNT, 8))
  })

  // 承接自原静态层（`seededNodes` 已删）：初始分布必须落在视口内 ——
  // 否则网络一开场就有节点在界外，连边统计与观感都不对。
  it('初始节点落在视口内', () => {
    for (const n of seedNet(W, H, NET_NODE_COUNT, 3)) {
      expect(n.x).toBeGreaterThanOrEqual(0)
      expect(n.x).toBeLessThanOrEqual(W)
      expect(n.y).toBeGreaterThanOrEqual(0)
      expect(n.y).toBeLessThanOrEqual(H)
    }
  })

  it('是纯函数：不修改入参、返回全新数组（与层 B 同一契约）', () => {
    const nodes = seedNet(800, 600, 4, 9)
    const snapshot = JSON.parse(JSON.stringify(nodes))

    const out = stepNet(nodes, 800, 600, 0.2)

    expect(nodes).toEqual(snapshot)
    expect(out).not.toBe(nodes)
    expect(out[0]).not.toBe(nodes[0])
  })
})
