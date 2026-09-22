import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_LAYOUT, MAX_WIDTH, MIN_WIDTH,
  applyPairResize, clampWidth, loadLayout, saveLayout,
} from '../lib/layout'
import { useLayout } from '../hooks/useLayout'

describe('clampWidth', () => {
  it('正常宽度原样返回且保持打开', () => {
    expect(clampWidth('evidence', 400)).toEqual({ width: 400, open: true })
  })

  it('低于可读下限即折叠为 0 并置关闭态', () => {
    expect(clampWidth('evidence', 100)).toEqual({ width: 0, open: false })
  })

  it('恰好等于下限时保持打开', () => {
    expect(clampWidth('evidence', MIN_WIDTH.evidence)).toEqual({
      width: MIN_WIDTH.evidence, open: true,
    })
  })

  it('对话栏不可关闭：低于下限时停在下限而非折叠', () => {
    expect(clampWidth('chat', 10)).toEqual({ width: MIN_WIDTH.chat, open: true })
  })

  it('宽度按 4px 阶梯取整', () => {
    expect(clampWidth('doc', 321.7).width % 4).toBe(0)
  })
})

describe('loadLayout / saveLayout', () => {
  beforeEach(() => localStorage.clear())

  it('无持久化数据时回落默认布局', () => {
    expect(loadLayout()).toEqual(DEFAULT_LAYOUT)
  })

  it('存取往返一致', () => {
    const l = { ...DEFAULT_LAYOUT, doc: { width: 512, open: true } }
    saveLayout(l)
    expect(loadLayout().doc.width).toBe(512)
  })

  it('数据损坏时回落默认且不抛错', () => {
    localStorage.setItem('ragqa:layout', '{ not json')
    expect(loadLayout()).toEqual(DEFAULT_LAYOUT)
  })

  it('字段缺失的旧数据被补齐为默认值', () => {
    localStorage.setItem('ragqa:layout', JSON.stringify({ rail: { width: 300, open: true } }))
    const l = loadLayout()
    expect(l.rail.width).toBe(300)
    expect(l.doc).toEqual(DEFAULT_LAYOUT.doc)
  })
})

describe('持久化不可用时的降级（spec「布局持久化不可用（边界）」）', () => {
  beforeEach(() => localStorage.clear())

  it('写入失败不抛错，且**明确返回 false**（供调用方给出可见反馈）', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError')
    })
    expect(() => saveLayout(DEFAULT_LAYOUT)).not.toThrow()
    expect(saveLayout(DEFAULT_LAYOUT)).toBe(false)   // 失败必须可被调用方察觉
    setItem.mockRestore()
  })

  it('写入成功返回 true', () => {
    expect(saveLayout(DEFAULT_LAYOUT)).toBe(true)
  })

  it('读取抛异常时退化为默认布局（回退即标准做法，不必告知）', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('SecurityError')
    })
    expect(loadLayout()).toEqual(DEFAULT_LAYOUT)
    getItem.mockRestore()
  })
})

describe('useLayout 把写失败变成可见状态', () => {
  it('写入失败时 storage.ok=false 且 lastWriteFailed=true；ack 后提示清除', async () => {
    const { renderHook, act } = await import('@testing-library/react')
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError')
    })
    const { result } = renderHook(() => useLayout())
    act(() => result.current.setWidth('doc', 400))
    expect(result.current.storage.ok).toBe(false)
    expect(result.current.storage.lastWriteFailed).toBe(true)
    act(() => result.current.ackStorageNotice())
    expect(result.current.storage.lastWriteFailed).toBe(false)
    setItem.mockRestore()
  })
})

// T51 复审 Important #1 的另一半：无上限时一次大幅拖动就能把某栏推到几千像素（实测 4320px），
// 而对话栏是唯一可被压缩的一栏（`flex-1`）⇒ 被挤到 0 宽。
// 修这一条的着力点有两处，本组用例分别钉住：
// ① **每栏上限**（`MAX_WIDTH`）拦住病态增长；
// ② 「对话栏不被挤没」由它**绑在 DOM 上的 `min-width`** 保证（App 级用例），
//    而**不是**在模型层做静态预算 —— 试过后者，它会把正常拖动也截断（见 MAX_WIDTH 的注释）。
describe('applyPairResize（相邻两栏此消彼长 + 每栏上限）', () => {
  // ⚠️ `delta` 是**分隔线自身的位移**：`delta > 0` = 分隔线右移 = **左栏（第一个参数）变宽**。
  // 本组断言曾整批写成反向（把 `delta > 0` 当成"把空间让给右栏"）而与
  // `ColumnDivider`（`clientX - 起始x`）及 `ArrowRight = +STEP` 相反，
  // 于是把"分隔线与指针反向移动"这个缺陷钉成了正确值 —— 已按正确方向重写。
  // ⚠️ `DEFAULT_LAYOUT.rail/evidence/doc` 的宽度**恰好等于各自的下限**，所以"缩小"方向
  // 在默认布局下无空间可让（`clampWidth` 会把它们抬回下限）。凡要断言"变窄多少"的用例，
  // 都先给足余量（`roomy()`），否则测到的是下限而不是方向。
  const roomy = () => ({
    rail: { width: 400, open: true },
    chat: { width: 400, open: true },
    evidence: { width: 400, open: true },
    doc: { width: 400, open: true },
  })

  it('右移（delta>0）：左栏变宽、右栏变窄，且二者此消彼长', () => {
    const base = roomy()
    const next = applyPairResize(base, 'evidence', 'doc', 64)
    expect(next.evidence.width).toBe(base.evidence.width + 64)
    expect(next.doc.width).toBe(base.doc.width - 64)
    expect(next.rail).toEqual(base.rail)   // 不相邻的栏不动
    expect(next.chat).toEqual(base.chat)
  })

  it('左移（delta<0）：左栏变窄、右栏变宽（与右移互为镜像）', () => {
    const base = roomy()
    const next = applyPairResize(base, 'evidence', 'doc', -64)
    expect(next.evidence.width).toBe(base.evidence.width - 64)
    expect(next.doc.width).toBe(base.doc.width + 64)
  })

  it('大幅右拖：左栏停在上限，不再无限增长', () => {
    let l = roomy()
    for (let i = 0; i < 20; i++) l = applyPairResize(l, 'rail', 'chat', 400)
    expect(l.rail.width).toBe(MAX_WIDTH)
    // 上限生效后继续拖是空操作
    const again = applyPairResize(l, 'rail', 'chat', 400)
    expect(again).toEqual(l)
  })

  // 回归钉（复审 Important #1）：早先的实现把受益者是**对话栏**的那一对（`rail|chat` 向右拖）
  // 完全漏掉，复审实测把 rail 推到 4288。两个方向都必须被上限收住。
  it('rail|chat 左拖（分隔线左移，让位给右边的 chat）：chat 停在上限，rail 让到底即折叠', () => {
    const base = { ...DEFAULT_LAYOUT, chat: { width: 400, open: true } }
    const next = applyPairResize(base, 'rail', 'chat', -10000)
    expect(next.chat.width).toBe(MAX_WIDTH)   // 右栏受益，停在上限
    expect(next.rail.open).toBe(false)        // 左栏让到底：越过下限即折叠（spec C-3）
    expect(next.rail.width).toBe(0)
  })

  it('rail|chat 右拖（分隔线右移，让位给左边的 rail）：rail 停在上限，chat 让到底但保持打开', () => {
    const base = { ...DEFAULT_LAYOUT, chat: { width: 400, open: true } }
    const next = applyPairResize(base, 'rail', 'chat', 10000)
    expect(next.rail.width).toBe(MAX_WIDTH)   // 左栏受益，停在上限
    expect(next.chat.open).toBe(true)         // 对话栏永不关闭（spec C-4）
    expect(next.chat.width).toBe(MIN_WIDTH.chat)  // 让到底停在下限，不折叠
  })

  it('对侧（doc）同样受上限约束：受益方停在上限，且继续拖是空操作', () => {
    // ⚠️ 这条原先写成 `delta = +400`：修正方向后，右移会让**左**栏受益、doc 在**首轮**就被折叠成
    // `{0,false}`，于是 `expect(0).toBeLessThanOrEqual(MAX_WIDTH)` 恒真——两个实现都能过，
    // 等于没测。要测 doc 的上限，必须让 doc 是**受益方**（左栏让位），即 `delta < 0`。
    let l = DEFAULT_LAYOUT
    for (let i = 0; i < 20; i++) l = applyPairResize(l, 'evidence', 'doc', -400)
    expect(l.doc.width).toBe(MAX_WIDTH)              // 恰好停在上限，不是"≤ 上限"这种恒真式
    expect(l.evidence.open).toBe(false)              // 让位方越过下限即折叠
    const again = applyPairResize(l, 'evidence', 'doc', -400)
    expect(again).toEqual(l)                         // 上限生效后继续拖是空操作
  })

  it('让位到底即可折叠为关闭态（不是压成无法阅读的细缝）', () => {
    const next = applyPairResize(roomy(), 'chat', 'evidence', 10000)
    expect(next.evidence.open).toBe(false)
    expect(next.evidence.width).toBe(0)
    expect(next.rail.open).toBe(true)   // 不相邻的栏不受影响
    expect(next.chat.open).toBe(true)
  })
  // 复审 O1/O2：上限放进 `clampWidth` 之后，**所有写入路径**都被同一约束覆盖，
  // 不只是拖动——下面两条分别钉「夹紧层」与「从 localStorage 读入」。
  it('clampWidth 自身带每栏上限（上限对任何调用方都生效，不只拖动）', () => {
    expect(clampWidth('rail', 50000).width).toBe(MAX_WIDTH)
    expect(clampWidth('chat', 50000).width).toBe(MAX_WIDTH)
    expect(clampWidth('doc', 16000).width).toBe(MAX_WIDTH)
  })

  it('从 localStorage 读入的越界宽度会被夹回（手工改过/旧版本的存档不撑坏界面）', () => {
    localStorage.setItem(
      'ragqa:layout',
      JSON.stringify({
        rail: { width: 50000, open: true },
        chat: { width: 50000, open: true },
        evidence: { width: 50000, open: true },
        doc: { width: 50000, open: true },
      }),
    )
    const l = loadLayout()
    expect(l.rail.width).toBe(MAX_WIDTH)
    expect(l.chat.width).toBe(MAX_WIDTH)
    expect(l.evidence.width).toBe(MAX_WIDTH)
    expect(l.doc.width).toBe(MAX_WIDTH)
  })
})
