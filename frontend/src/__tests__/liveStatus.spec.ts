import { describe, expect, it } from 'vitest'
import {
  elapsedMs,
  formatElapsed,
  liveStatusLabel,
  stageBase,
  type LiveInput,
} from '../lib/liveStatus'
import type { StageData } from '../lib/events'

const stage = (name: StageData['name'], ms: number): StageData => ({ name, elapsed_ms: ms })

const input = (over: Partial<LiveInput> = {}): LiveInput => ({
  status: 'streaming',
  stages: [],
  evidenceCount: 0,
  reasoningChars: 0,
  hasAnswer: false,
  ...over,
})

/**
 * 使用者 2026-09-19：「生成中…正在检索证据…」全程不变，太呆了。
 * 故这里的核心断言是**文案真的随阶段变**，而不是某一句特定的话。
 */
describe('liveStatusLabel', () => {
  it('随服务端阶段推进而改变（这是本条的全部要点）', () => {
    const seen = [
      liveStatusLabel(input({ status: 'rewriting' })),
      liveStatusLabel(input({ status: 'retrieving' })),
      liveStatusLabel(input({ status: 'streaming', stages: [stage('rewrite', 120)], evidenceCount: 0 })),
      liveStatusLabel(input({ status: 'streaming', stages: [stage('evidence', 400)], evidenceCount: 12 })),
      liveStatusLabel(input({ status: 'streaming', stages: [stage('reasoning', 900)] , evidenceCount: 12 })),
      liveStatusLabel(input({ status: 'streaming', stages: [stage('answer', 1200)], hasAnswer: true })),
    ]
    // 每一条都不为空，且**互不相同**（若退化成"全程一句话"，这里立刻红）
    expect(new Set(seen).size).toBe(seen.length)
    for (const s of seen) expect(s).not.toBe('')
  })

  it('阶段事件未到时退回本地状态机，而不是空着', () => {
    expect(liveStatusLabel(input({ status: 'retrieving' }))).toBe('正在检索证据…')
    expect(liveStatusLabel(input({ status: 'rewriting' }))).toContain('改写')
    expect(liveStatusLabel(input({ status: 'streaming' }))).not.toBe('')
  })

  it('依据条数来自真实数据（不编造数字）', () => {
    const withCount = liveStatusLabel(
      input({ stages: [stage('evidence', 300)], evidenceCount: 7 }),
    )
    expect(withCount).toContain('7')
    // 条数没到（还没收到 evidence）时不得凭空说一个数
    const noCount = liveStatusLabel(input({ stages: [stage('rewrite', 100)] }))
    expect(noCount).not.toMatch(/\d+\s*条/)
  })

  it('思考阶段区分"正在分析"与"正在作答"', () => {
    const thinking = liveStatusLabel(input({ stages: [stage('reasoning', 100)], evidenceCount: 3 }))
    const answering = liveStatusLabel(
      input({ stages: [stage('reasoning', 100)], evidenceCount: 3, hasAnswer: true }),
    )
    expect(thinking).toContain('分析')
    expect(answering).not.toBe(thinking)
  })

  // 实测踩到的坑：服务端的 `reasoning` **阶段事件**要等首个正文字才发，
  // 而思考早就开始了 ⇒ 真实思考期间最新阶段还是 `evidence`。
  // 若只看阶段名，界面会在长达 80 秒的思考里一直说"准备分析"。
  it('思考正文已到但 reasoning 阶段事件还没到时，不得停在「准备分析」', () => {
    const stillPreparing = liveStatusLabel(
      input({ stages: [stage('evidence', 300)], evidenceCount: 20, reasoningChars: 0 }),
    )
    const analysing = liveStatusLabel(
      input({ stages: [stage('evidence', 300)], evidenceCount: 20, reasoningChars: 577 }),
    )
    expect(stillPreparing).toContain('准备分析')
    expect(analysing).toContain('正在分析')
    expect(analysing).not.toBe(stillPreparing)
  })

  it('出错与中断各有自己的说法', () => {
    expect(liveStatusLabel(input({ status: 'error' }))).toContain('错')
    expect(liveStatusLabel(input({ status: 'aborted' }))).toContain('中断')
  })

  it('空闲时无话可说（返回空串，调用方据此不渲染状态行）', () => {
    expect(liveStatusLabel(input({ status: 'idle' }))).toBe('')
  })

  it('不认识的后端阶段名不冒充"最新阶段"', () => {
    // 未来后端加了新阶段：类型上说不出，只有运行时载荷能带来（与 thinkingPanel.spec 同一手法）
    const future = { name: 'future_thing', elapsed_ms: 999 } as unknown as StageData
    const evs = [stage('evidence', 200), future]
    const label = liveStatusLabel(input({ stages: evs, evidenceCount: 5 }))
    expect(label).toContain('5')
  })
})

describe('阶段耗时', () => {
  const now = 1_000_000

  it('基准点只在阶段切换时重算，长阶段期间数字继续往前走', () => {
    const s = stage('reasoning', 5000)
    const b1 = stageBase(null, s, now)
    expect(b1).not.toBeNull()
    // 同一阶段再来一次（ms 未变）⇒ 返回同一个基准点，起点不被重置
    expect(stageBase(b1, s, now + 3000)).toBe(b1)
    // 故已耗时 = 服务端 5000 + 本地又过了 3000
    expect(elapsedMs(b1, now + 3000)).toBe(8000)
  })

  it('阶段换名即重算基准点（否则会把上一阶段的耗时累加到新阶段上）', () => {
    const b1 = stageBase(null, stage('reasoning', 5000), now)
    const b2 = stageBase(b1, stage('answer', 100), now + 10_000)
    expect(b2?.name).toBe('answer')
    expect(elapsedMs(b2, now + 10_000)).toBe(100)
  })

  it('没有阶段时不报数字（返回 0 ⇒ 界面不画耗时）', () => {
    expect(stageBase(null, undefined, now)).toBeNull()
    expect(elapsedMs(null, now)).toBe(0)
  })

  it('畸形耗时不被当成测量值', () => {
    const bad = { name: 'evidence', elapsed_ms: Number.NaN } as StageData
    expect(stageBase(null, bad, now)).toBeNull()
    expect(formatElapsed(Number.NaN)).toBe('')
    expect(formatElapsed(-1)).toBe('')
  })

  it('耗时文案：不足一秒不假装精确，超过一分钟给 m/s', () => {
    expect(formatElapsed(0)).toBe('不到 1s')
    expect(formatElapsed(999)).toBe('不到 1s')
    expect(formatElapsed(12_400)).toBe('12s')
    expect(formatElapsed(65_000)).toBe('1m05s')
  })
})
