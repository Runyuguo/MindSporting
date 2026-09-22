import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ChatPanel } from '../components/ChatPanel'
import type { ChatController } from '../hooks/useChat'

/**
 * 思考面板在消息流里的**位置**（使用者 2026-09-19）。
 *
 * 要求：顺序恒为「提问 → 思考 → 回答」，且**每一轮**都要如此。
 *
 * 为什么在这里钉而不是在 App 级：面板的插入点由 ChatPanel 的 `thinking` 槽决定，
 * 在组件级可以用受控的 messages 直接构造"第二轮进行中"这一形态；
 * 放在 App 级则要驱动两轮流式响应，脆弱且测到的是别的东西。
 */
function controller(
  messages: ChatController['messages'],
  lib = 'ai4s',
): ChatController {
  return {
    lib,
    messages,
    status: 'streaming',
    evidence: [],
    evidenceByRound: {},
    shownRounds: [],
    selectedRound: null,
    resolvedQuery: null,
    error: null,
    reasoningText: '',
    stages: [],
    notices: [],
    thinkingOpen: true,
    toggleThinking: () => {},
    submit: () => {},
    abort: () => {},
    reset: () => {},
    selectRound: () => {},
    onSelectHit: () => {},
    clearSelection: () => {},
  } as unknown as ChatController
}

const panel = () => screen.getByTestId('thinking-slot')

/** a 是否在文档序里早于 b。 */
const before = (a: Element, b: Element) =>
  Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)

describe('ChatPanel — 思考面板的位置', () => {
  it('第一轮：提问 → 思考 → （尚无回答）', () => {
    const { container } = render(
      <ChatPanel
        chat={controller([{ role: 'user', content: '第一问' }])}
        showInlineEvidence={false}
        onSelectRound={() => {}}
        onCite={() => {}}
        thinking={<p data-testid="thinking-slot">思考中</p>}
      />,
    )
    const q = screen.getByText('第一问')
    expect(before(q, panel()), '思考必须在提问之后').toBe(true)
    expect(container.querySelector('[data-testid="thinking-slot"]')).not.toBeNull()
  })

  it('回答到场后：提问 → 思考 → 回答', () => {
    render(
      <ChatPanel
        chat={controller([
          { role: 'user', content: '第一问' },
          { role: 'assistant', content: '第一轮回答' },
        ])}
        showInlineEvidence={false}
        onSelectRound={() => {}}
        onCite={() => {}}
        thinking={<p data-testid="thinking-slot">思考中</p>}
      />,
    )
    const q = screen.getByText('第一问')
    const a = screen.getByText('第一轮回答')
    expect(before(q, panel())).toBe(true)
    expect(before(panel(), a), '回答必须在思考之后').toBe(true)
  })

  // 这条是关键回归钉：旧实现把面板挂在对话栏**顶部**，于是第二轮提问时，
  // 面板（"绝对最新"）会落在**第一轮问答之上** —— 顺序变成 思考→问→答→问。
  it('第二轮进行中：面板落在**第二个提问之后**，而不是整栏顶部', () => {
    render(
      <ChatPanel
        chat={controller([
          { role: 'user', content: '第一问' },
          { role: 'assistant', content: '第一轮回答' },
          { role: 'user', content: '第二问' },
        ])}
        showInlineEvidence={false}
        onSelectRound={() => {}}
        onCite={() => {}}
        thinking={<p data-testid="thinking-slot">第二轮思考中</p>}
      />,
    )
    const q1 = screen.getByText('第一问')
    const a1 = screen.getByText('第一轮回答')
    const q2 = screen.getByText('第二问')
    // 面板必须晚于**本轮**的提问（也就是晚于第一轮的全部内容）
    expect(before(q1, panel())).toBe(true)
    expect(before(a1, panel())).toBe(true)
    expect(before(q2, panel()), '面板必须在本轮提问之后').toBe(true)
  })

  it('第二轮回答到场后：第二个提问 → 面板 → 第二个回答', () => {
    render(
      <ChatPanel
        chat={controller([
          { role: 'user', content: '第一问' },
          { role: 'assistant', content: '第一轮回答' },
          { role: 'user', content: '第二问' },
          { role: 'assistant', content: '第二轮回答' },
        ])}
        showInlineEvidence={false}
        onSelectRound={() => {}}
        onCite={() => {}}
        thinking={<p data-testid="thinking-slot">第二轮思考中</p>}
      />,
    )
    const q2 = screen.getByText('第二问')
    const a2 = screen.getByText('第二轮回答')
    expect(before(q2, panel())).toBe(true)
    expect(before(panel(), a2), '回答必须在思考之后').toBe(true)
  })

  it('没有提问时不渲染面板槽（绝不出一个空面板）', () => {
    render(
      <ChatPanel
        chat={controller([])}
        showInlineEvidence={false}
        onSelectRound={() => {}}
        onCite={() => {}}
        thinking={<p data-testid="thinking-slot">思考中</p>}
      />,
    )
    expect(screen.queryByTestId('thinking-slot')).toBeNull()
  })
})

/**
 * 空态示例问题（使用者 2026-09-19）：
 * ① **按库给**（切库即换）；② 点一下**填进输入框**（不直接发送）。
 */
describe('ChatPanel — 空态示例问题', () => {
  const empty = (lib: string) =>
    render(
      <ChatPanel
        chat={controller([], lib)}
        showInlineEvidence={false}
        onSelectRound={() => {}}
        onCite={() => {}}
      />,
    )

  it('AI4S 库给 AI4S 领域的问题', () => {
    empty('ai4s')
    const labels = screen.getAllByTestId('sample-question').map((b) => b.textContent)
    expect(labels.join()).toContain('虚拟细胞与 AI 建模')
    expect(labels.join()).not.toContain('线粒体与心血管疾病')
  })

  it('切到 mito 库即换成 mito 领域的问题（同一条也不留）', () => {
    empty('mito')
    const labels = screen.getAllByTestId('sample-question').map((b) => b.textContent)
    expect(labels.join()).toContain('线粒体与心血管疾病')
    // 关键：不能同时留着另一库的问题，否则使用者仍分不清自己在问哪个库
    expect(labels.join()).not.toContain('虚拟细胞与 AI 建模')
  })

  it('未知库不显示示例问题（宁可不给，也不给错库的）', () => {
    empty('nope')
    expect(screen.queryAllByTestId('sample-question')).toHaveLength(0)
  })

  it('点示例问题只填进输入框，不直接发送', () => {
    const submit = vi.fn()
    const chat = { ...controller([]), submit }
    render(
      <ChatPanel
        chat={chat}
        showInlineEvidence={false}
        onSelectRound={() => {}}
        onCite={() => {}}
      />,
    )
    fireEvent.click(screen.getAllByTestId('sample-question')[0])
    // 填进去了（使用者还可能要改几个字，故不代他按下发送）
    expect(screen.getByRole('textbox')).toHaveValue('虚拟细胞与 AI 建模')
    expect(submit).not.toHaveBeenCalled()
  })

  it('填进去之后可以直接回车发送', () => {
    const submit = vi.fn()
    const chat = { ...controller([]), submit }
    render(
      <ChatPanel
        chat={chat}
        showInlineEvidence={false}
        onSelectRound={() => {}}
        onCite={() => {}}
      />,
    )
    fireEvent.click(screen.getAllByTestId('sample-question')[0])
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    expect(submit).toHaveBeenCalledWith('虚拟细胞与 AI 建模')
  })
})

/**
 * 思考流式期间的**跟随滚动**（使用者 2026-09-19）：
 * 思考增量不进 `messages`，故消息区那条 effect 不会触发 —— 没有这条的话，
 * 思考越长视口越不动，最新生成的内容被推到屏幕外。
 *
 * ⚠️ 判据是**使用者的滚动意图**，不是「离底部多远」。第一版用 48px 阈值，
 * 而思考面板一次能长 260px 以上（实测 311→578），于是 gap 一起步就超过阈值，
 * 跟随**自己把自己关掉**（实测 gap 锁在 108px）。故这里**特意**用一个大 gap
 * 来验证「只要没主动上翻，就该继续跟随」。
 */
describe('ChatPanel — 思考流式跟随滚动', () => {
  /** jsdom 不做布局：滚动尺寸恒为 0，故用 defineProperty 造出「贴底 / 已上翻」两种形态。 */
  const stubScroll = (
    el: Element,
    v: { scrollTop: number; scrollHeight: number; clientHeight: number },
  ) => {
    for (const [k, val] of Object.entries(v)) {
      Object.defineProperty(el, k, { value: val, configurable: true, writable: true })
    }
  }

  function setup(text: string) {
    // 同一个 controller 对象贯穿两次渲染：否则 `chat.messages` 每次都是新数组，
    // 消息区那条 effect 也会滚一次，把"思考跟随"的断言污染成假阳性。
    const chat = controller([{ role: 'user', content: '问' }])
    const view = (t: string) => (
      <ChatPanel
        chat={chat}
        showInlineEvidence={false}
        onSelectRound={() => {}}
        onCite={() => {}}
        thinking={<p data-testid="thinking-slot">{t}</p>}
        thinkingText={t}
      />
    )
    const { container, rerender } = render(view(text))
    const scroller = container.querySelector('.overflow-y-auto') as HTMLElement
    const anchor = screen.getByTestId('chat-end-anchor')
    const spy = vi.fn()
    anchor.scrollIntoView = spy
    return { rerender, scroller, spy, view }
  }

  /** 模拟使用者的滚动动作：先设位置，再派发 scroll 事件（组件据此判断方向）。 */
  const userScrollTo = (scroller: HTMLElement, top: number) => {
    stubScroll(scroller, {
      scrollTop: top,
      scrollHeight: 2000,
      clientHeight: 400,
    })
    fireEvent.scroll(scroller)
  }

  it('没有任何主动滚动时，思考每来一片就把视口带到底部（哪怕 gap 很大）', () => {
    const { rerender, scroller, spy, view } = setup('第一片')
    // gap = 2000 - 800 - 400 = 800px：远大于任何阈值，但使用者并未上翻
    //
    // ⚠️ 这里**必须先记录一次位置**再让"使用者"滚动，否则 `lastTopRef` 还停在挂载时的 0，
    // 一次真正的上翻会被判成"向下滚"。这正是实现里那条挂载期初始化的由来
    // （诊断时实测到 `{top:400, prev:0, gap:1200}` 被误判）。
    userScrollTo(scroller, 800)
    spy.mockClear()

    rerender(view('第一片第二片'))
    expect(spy).toHaveBeenCalled()
  })

  // 关键：无条件拉回底部会把正在上翻阅读的人拽走 —— 那比不跟随更糟。
  it('使用者主动上翻后不再抢滚动条', () => {
    const { rerender, scroller, spy, view } = setup('第一片')
    userScrollTo(scroller, 800) // 先记录一个位置
    userScrollTo(scroller, 400) // 再向上翻（scrollTop 变小）
    spy.mockClear()

    rerender(view('第一片第二片'))
    expect(spy).not.toHaveBeenCalled()
  })

  it('使用者滚回底部后恢复跟随', () => {
    const { rerender, scroller, spy, view } = setup('第一片')
    userScrollTo(scroller, 800)
    userScrollTo(scroller, 400) // 上翻 ⇒ 停手
    rerender(view('第一片第二片'))
    expect(spy).not.toHaveBeenCalled()

    // 他自己滚回底部（gap ≈ 0）⇒ 恢复跟随
    userScrollTo(scroller, 1600)
    spy.mockClear()
    rerender(view('第一片第二片第三片'))
    expect(spy).toHaveBeenCalled()
  })

  // 反空转：若 `thinkingText` 没被当依赖，上面第一条会恒绿。
  it('思考文本没变时不重复滚动（effect 真的挂在 thinkingText 上）', () => {
    const { rerender, scroller, spy, view } = setup('同一片')
    userScrollTo(scroller, 800)
    spy.mockClear()

    rerender(view('同一片')) // 文本相同 ⇒ 依赖未变 ⇒ 不得再滚
    expect(spy).not.toHaveBeenCalled()
  })

  /**
   * 回归钉：**两条 effect 必须共用同一个"是否跟随"的意图**。
   *
   * 实测踩到的坑：思考那条已经会尊重"使用者上翻"，但 `messages` 那条仍在无条件
   * `scrollIntoView` —— 而流式期间每个 token 都会让 `messages` 变成新数组，
   * 于是刚上翻 300px 就被拽回底部（实测 gap 321 → 21）。单测若只覆盖思考那条，
   * 这个缺陷会完全漏掉，故这里**只动 messages**来钉它。
   */
  it('使用者上翻后，消息变化也不得把视口拽回底部（两条 effect 共用同一意图）', () => {
    const chat = controller([{ role: 'user', content: '问' }])
    const view = (msgs: ChatController['messages'], t: string) => (
      <ChatPanel
        chat={{ ...chat, messages: msgs }}
        showInlineEvidence={false}
        onSelectRound={() => {}}
        onCite={() => {}}
        thinking={<p data-testid="thinking-slot">{t}</p>}
        thinkingText={t}
      />
    )
    const { container, rerender } = render(view([{ role: 'user', content: '问' }], '片'))
    const scroller = container.querySelector('.overflow-y-auto') as HTMLElement
    const anchor = screen.getByTestId('chat-end-anchor')
    const spy = vi.fn()
    anchor.scrollIntoView = spy

    // 使用者上翻
    stubScroll(scroller, { scrollTop: 800, scrollHeight: 2000, clientHeight: 400 })
    fireEvent.scroll(scroller)
    stubScroll(scroller, { scrollTop: 500, scrollHeight: 2000, clientHeight: 400 })
    fireEvent.scroll(scroller)
    spy.mockClear()

    // 只让 messages 变化（模拟流式 token 追加），thinkingText 不变
    rerender(view([{ role: 'user', content: '问' }, { role: 'assistant', content: '答' }], '片'))
    expect(spy).not.toHaveBeenCalled()
  })
})
