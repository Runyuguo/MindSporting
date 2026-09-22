import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import ThinkingPanel from '../components/ThinkingPanel'
import type { StageData } from '../lib/events'

const base = {
  reasoningText: '',
  stages: [],
  notices: [],
  open: true,
  onToggle: () => {},
}

/** 未知阶段名只可能来自**未来**的后端：类型上说不出，只有运行时载荷能带来。 */
const unknownStage = (name: string, elapsed_ms: number) =>
  ({ name, elapsed_ms }) as unknown as StageData

describe('ThinkingPanel', () => {
  it('显示阶段名与耗时', () => {
    render(<ThinkingPanel {...base} stages={[{ name: 'evidence', elapsed_ms: 400 }]} />)
    expect(screen.getByText(/检索证据/)).toBeTruthy()
    expect(screen.getByText(/0\.4s|400ms/)).toBeTruthy()
  })

  it('收起时仍显示一行实时摘要', () => {
    render(<ThinkingPanel {...base} open={false} reasoningText="先核对证据是否足够。" />)
    expect(screen.getByText(/先核对证据是否足够/)).toBeTruthy()
  })

  it('展开时显示完整思考文本', () => {
    render(<ThinkingPanel {...base} open reasoningText="第一句。第二句。" />)
    expect(screen.getByText(/第一句。第二句。/)).toBeTruthy()
  })

  it('不可用时如实告知而不是留白', () => {
    render(<ThinkingPanel {...base} notices={['本轮未能获取模型思考内容（上游未提供）']} />)
    expect(screen.getByText(/未能获取模型思考内容/)).toBeTruthy()
  })

  // 简报的 `userEvent.click` 在本仓库不可用（未安装 `@testing-library/user-event`），
  // 故用 `fireEvent` —— 与仓库既有测试一致，不新增依赖。
  it('折叠条可键盘操作', async () => {
    const onToggle = vi.fn()
    render(<ThinkingPanel {...base} open={false} onToggle={onToggle} />)
    fireEvent.click(screen.getByRole('button'))
    expect(onToggle).toHaveBeenCalled()
  })

  // ---- 思考不设转发上限（使用者 2026-09-19）⇒ 面板里不得再出现任何"截断"字样 ----
  //
  // 历史：老实现的判据是 `reasoningText.length > summary.length`，而 `latestSentence`
  // 刻意只取**最后一句完整句**，尾句还在写时摘要必然短于全文 ⇒ 每一次流式思考的中途都会
  // 谎报「思考已截断」。后来改成由后端 notice 驱动；现在**上限本身被取消**，
  // 于是"被截断"这一状态在整条链路上都不存在了 —— 面板必须一个字都不提。
  it('思考文本未以句末标点收尾时，绝不出现「已截断」一类字样', () => {
    render(<ThinkingPanel {...base} open={false} reasoningText="先核对证据。第二句还在写" />)
    // 摘要本身照常显示（那是真实收到的内容）
    expect(screen.getByText(/先核对证据/)).toBeTruthy()
    expect(screen.queryByText(/已截断/)).toBeNull()
    expect(screen.queryByText(/思考内容过长/)).toBeNull()
  })

  it('展开态显示**完整**思考全文，不截断、不加"仅收到部分"的说明', () => {
    // 远超原先 12000 字上限的思考，现在必须原样整段呈现
    const long = '甲'.repeat(30000)
    render(<ThinkingPanel {...base} open reasoningText={long} />)
    expect(screen.getByText(long)).toBeTruthy()
    expect(screen.queryByText(/已截断/)).toBeNull()
    expect(screen.queryByText(/仅收到/)).toBeNull()
  })


  // ---- 复审 Minor：收起态只显示一句时，要说清「只显示了一句」 ------------------------
  it('收起态只显示最后一句时如实说明，显示的就是全文时不多说一个字', () => {
    const { rerender } = render(
      <ThinkingPanel {...base} open={false} reasoningText="第一句。第二句。" />,
    )
    expect(screen.getByText(/仅显示最后一句/)).toBeTruthy()

    rerender(<ThinkingPanel {...base} open={false} reasoningText="只有一句。" />)
    expect(screen.queryByText(/仅显示/)).toBeNull()
  })

  // 零静默失败：思考被服务端上限截断时，界面必须说清「看到的是半截」，
  // 而不能把一段残缺文本当成完整思考端出去。
  //
  // 复审 Minor：老用例用 `'啊'.repeat(500)`（**只**含句末偏旁、无标点）断言「截断」，
  // 它实际走的是 `latestSentence` 的 **>80 字回退**，与截断无关 —— 断言在同义反复。
  // 这里把它改成回退路径自己的用例：取的是**末尾**，且不得声称截断。
  it('未成句的超长思考走回退路径：只取末尾片段，并如实说明这是片段', () => {
    const text = `起头标记${'啊'.repeat(90)}尾巴标记`
    render(<ThinkingPanel {...base} open={false} reasoningText={text} />)
    expect(screen.getByText(/尾巴标记/)).toBeTruthy() // 取的是末尾（流式下最新的才有信息）
    expect(screen.queryByText(/起头标记/)).toBeNull() // 不是开头
    expect(screen.getByText(/仅显示末尾片段/)).toBeTruthy()
    expect(screen.queryByText(/已截断/)).toBeNull()
  })

  // 可访问性的底线（spec 边界场景）：思考内容必须是**真实文本节点**，
  // 读屏可达；不得为了「好看」改成 tooltip / aria-label / 伪元素。
  it('思考全文是读屏可达的真实文本节点', () => {
    render(<ThinkingPanel {...base} open reasoningText="完整思考正文" />)
    const node = screen.getByText('完整思考正文')
    expect(node.tagName).toBe('P')
    expect(node.childNodes).toHaveLength(1)
    expect(node.childNodes[0].nodeType).toBe(Node.TEXT_NODE)
  })

  it('展开态与收起态都给按钮正确的 aria-expanded', () => {
    const { rerender } = render(<ThinkingPanel {...base} open />)
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true')
    rerender(<ThinkingPanel {...base} open={false} />)
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false')
  })

  // 复审 Minor：`aria-expanded` 只说「展开没展开」，不说展开的是**哪一块**。
  // 断言 `aria-controls` 指向的 id **真的存在**（只写个属性名不算接线）。
  it('开合按钮用 aria-controls 指向详情容器，且该容器真的存在', () => {
    const { rerender } = render(<ThinkingPanel {...base} open={false} reasoningText="想法。" />)
    const id = screen.getByRole('button').getAttribute('aria-controls')
    expect(id).toBeTruthy()
    expect(document.getElementById(id as string)).not.toBeNull()

    // 展开态下同样的指向必须仍然有效（折叠不该把容器从 DOM 里摘掉）
    rerender(<ThinkingPanel {...base} open reasoningText="想法。" />)
    expect(document.getElementById(id as string)).not.toBeNull()
  })

  // 未发生的阶段不得凭空出现（时间只来自服务端事件）
  it('没有阶段时不渲染阶段行', () => {
    render(<ThinkingPanel {...base} stages={[]} />)
    expect(screen.queryByText(/检索证据|理解问题|组织回答/)).toBeNull()
  })

  it('未收到 rewrite 阶段时不显示「理解问题」', () => {
    render(
      <ThinkingPanel
        {...base}
        stages={[
          { name: 'evidence', elapsed_ms: 10 },
          { name: 'reasoning', elapsed_ms: 900 },
        ]}
      />,
    )
    expect(screen.queryByText(/理解问题/)).toBeNull()
    expect(screen.getByText(/检索证据/)).toBeTruthy()
  })

  // ---- 复审 Important 4：未校验的 stage 载荷 --------------------------------------
  it('未知阶段名不得渲染成一行没有名字的耗时', () => {
    render(<ThinkingPanel {...base} stages={[unknownStage('retrieval', 400)]} />)
    // 服务端原样给出的名字与「未知」标注都要可见；绝不能只剩「 · 400ms」
    expect(screen.getByText(/未知阶段（retrieval）/)).toBeTruthy()
    expect(screen.queryByText(/^\s*·\s*400ms/)).toBeNull()
  })

  it('非有限/负耗时不是一次测量，不得当数字端出去', () => {
    render(
      <ThinkingPanel
        {...base}
        stages={[
          { name: 'evidence', elapsed_ms: Number.NaN },
          { name: 'answer', elapsed_ms: -1 },
        ]}
      />,
    )
    expect(screen.queryByText(/NaN/)).toBeNull()
    expect(screen.queryByText(/-1ms/)).toBeNull()
    // 但这两行仍要可见（阶段确实发生过），只是耗时如实标为未知
    expect(screen.getAllByText(/耗时未知/)).toHaveLength(2)
    expect(screen.getByText(/检索证据/)).toBeTruthy()
  })

  // ---- 复审 Important 2(a)：刷新后的读取路径 --------------------------------------
  // plan §4.4：摘要与耗时随会话持久化，刷新后仍可见；全文只当次可见。
  it('刷新后显示随会话留存的摘要与耗时，展开时说明全文仅当次可见', () => {
    const persisted = { summary: '先核对证据。', ms: 1200 }
    const { rerender } = render(<ThinkingPanel {...base} open={false} persisted={persisted} />)
    expect(screen.getByText(/先核对证据/)).toBeTruthy()
    expect(screen.getByText(/1\.2s/)).toBeTruthy()
    // 收起态不解释「全文在哪」——那句话是展开后的补充说明（plan §4.4）
    expect(screen.queryByText(/仅当次可见/)).toBeNull()

    rerender(<ThinkingPanel {...base} open persisted={persisted} />)
    expect(screen.getByText(/仅当次可见/)).toBeTruthy()
  })

  it('留存记录只有耗时时也如实显示（不编造摘要）', () => {
    render(<ThinkingPanel {...base} persisted={{ summary: '', ms: 1200 }} />)
    expect(screen.getByText(/1\.2s/)).toBeTruthy()
    expect(screen.queryByText(/摘要/)).toBeNull()
  })

  it('本轮有实时思考时不重复显示留存摘要（同一轮的记录，不说两遍）', () => {
    render(
      <ThinkingPanel
        {...base}
        open
        persisted={{ summary: '上一轮留存摘要。', ms: 1200 }}
        reasoningText="本轮实时思考。"
      />,
    )
    expect(screen.queryByText(/上一轮留存摘要/)).toBeNull()
    expect(screen.getByText(/本轮实时思考/)).toBeTruthy()
  })

  it('没有任何留存数据时不渲染留存行', () => {
    render(<ThinkingPanel {...base} open />)
    expect(screen.queryByText(/随会话留存/)).toBeNull()
  })
})
