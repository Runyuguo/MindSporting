import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AnswerMarkdown } from '../components/AnswerMarkdown'
import type { Hit } from '../lib/events'

/**
 * T56：答案里的引用标记**渲染成什么**。
 *
 * 后端从 T07 起就要求模型用 `[编号]` 标注（`server/http_server.py` 的 system 提示词），
 * 而前端一直把 `[1]` 当死文字渲染 —— 于是 spec 001「引用可追溯」的 Scenario
 * 「该编号能在本轮证据集合中找到对应条目」在界面上无从兑现：看得见编号，点不动。
 *
 * 本文件钉组件级行为（可点 / 不可点 / 代码里的不算 / KaTeX 不受影响）；
 * 「编号 → 哪一条」的定位规则在 `citations.spec.ts`，整机跳转在 `app-citations.spec.tsx`。
 */

function hit(rowid: number, title = `依据 ${rowid}`, source = 'vault:note'): Hit {
  return {
    rowid,
    source,
    ref: `01-Literature/${rowid}.md`,
    title,
    category: '',
    extra: '',
    snippet: '…',
    score: 0.8,
  }
}

/** 可点的引用标记。用 testid 定位：它的可见文字（`[1]`）与证据卡的编号**故意同名**。 */
const links = () => screen.queryAllByTestId('citation-link')

describe('AnswerMarkdown —— 引用标记（T56）', () => {
  it('可解析的编号渲染成可点控件，点它回调**本轮第 n 条**命中', () => {
    const hits = [hit(11, '第一条'), hit(22, '第二条')]
    const onCite = vi.fn()
    render(<AnswerMarkdown content="结论 A[2]，结论 B[1]。" hits={hits} onCite={onCite} />)

    const [a, b] = links()
    expect(a).toHaveTextContent('[2]')
    expect(b).toHaveTextContent('[1]')

    fireEvent.click(a)
    expect(onCite).toHaveBeenLastCalledWith(hits[1])
    fireEvent.click(b)
    expect(onCite).toHaveBeenLastCalledWith(hits[0])
  })

  it('引用标记是真正的 button：Tab 可达、Enter/Space 由原生激活', () => {
    render(<AnswerMarkdown content="结论[1]" hits={[hit(11)]} onCite={() => {}} />)
    const link = links()[0]
    // 用原生 button 而不是 div[role=button]：后者要自己补键盘处理，漏一次就断了键盘通路。
    expect(link.tagName).toBe('BUTTON')
    expect(link).toHaveAttribute('type', 'button')
    link.focus()
    expect(link).toHaveFocus()
  })

  it('引用标记带可访问名（只念「[1]」等于没说是干什么的）', () => {
    render(<AnswerMarkdown content="结论[2]" hits={[hit(11), hit(22)]} onCite={() => {}} />)
    expect(screen.getByRole('button', { name: '查看第 2 条依据' })).toBe(links()[0])
  })

  // 越界编号：仍是**纯文字**（不是控件 —— 禁用态控件暗示"条件满足即可点"，而这一条
  // 对应的证据永远不存在），但**不得静默**（宪法 §4.3 零静默失败）：使用者点了没反应时
  // 无法判断是模型错了还是产品坏了；读屏使用者更需要这句话。
  // 故：可见的 tooltip + 无障碍树里的真实文字（按阅读顺序念得到），且仍不进 Tab 序。
  it('越界编号留作文字但如实告知「没有这一条」，且仍不是控件', () => {
    const onCite = vi.fn()
    render(<AnswerMarkdown content="结论[9]。" hits={[hit(11), hit(22)]} onCite={onCite} />)
    expect(links()).toHaveLength(0)
    expect(document.body.textContent).toContain('[9]')

    const el = screen.getByTestId('citation-missing')
    expect(el.tagName).toBe('SPAN')
    expect(el).not.toHaveAttribute('tabindex')
    expect(el).toHaveAttribute('title', '本轮没有第 9 条依据')
    // 告知必须是**真实文字**而不是只有一个属性：读屏对真实文字才有确定行为
    expect(el.querySelector('.sr-only')).toHaveTextContent('（本轮没有第 9 条依据）')
    expect(onCite).not.toHaveBeenCalled()
  })

  // 未接线（文献卡正文 `DocPanel`）时**连告知都不给**：那里根本没有「本轮证据」这回事，
  // 笔记正文里的 [1] 只是文字；给它挂「本轮没有第 1 条依据」是凭空造出一个语境。
  it('未接线时既不可点也不加「没有这一条」的告知', () => {
    render(<AnswerMarkdown content="笔记正文里的 [1] 只是文字" />)
    expect(links()).toHaveLength(0)
    expect(screen.queryByTestId('citation-missing')).toBeNull()
    expect(document.body.textContent).toContain('[1]')
  })

  // 接线了、但那一轮的 evidence 事件从未记录（依据没留存）：**不能说「没有这一条」** ——
  // 那是把「不知道」讲成「不存在」。告知只说能确定的那件事。
  it('本轮依据未留存时，告知是「无法定位」而不是「没有这一条」', () => {
    render(<AnswerMarkdown content="结论[1]" onCite={() => {}} />)
    expect(links()).toHaveLength(0)
    expect(screen.getByTestId('citation-missing')).toHaveAttribute(
      'title',
      '本轮依据未留存，无法定位第 1 条',
    )
  })

  it('0 与四位数字不是引用编号（编号从 1 起，且本轮至多几十条）', () => {
    render(
      <AnswerMarkdown content="[0] 与 [2024] 都不是引用。" hits={[hit(11)]} onCite={() => {}} />,
    )
    expect(links()).toHaveLength(0)
    expect(document.body.textContent).toContain('[0]')
    expect(document.body.textContent).toContain('[2024]')
  })

  // I2 同源：非 vault 来源没有可读原文（`ref` 是 PMID / txt 文件名），证据卡不给入口。
  // 引用标记若给入口，点下去会把 PMID 当 vault 路径去取文，得到 400 —— 那是**错误归因**。
  it('没有可读原文的来源不给入口（与证据卡同一判据）', () => {
    const onCite = vi.fn()
    render(
      <AnswerMarkdown
        content="摘要命中[1]"
        hits={[hit(11, '摘要命中', 'metadata')]}
        onCite={onCite}
      />,
    )
    expect(links()).toHaveLength(0)
    expect(document.body.textContent).toContain('[1]')
    expect(onCite).not.toHaveBeenCalled()
  })

  it('全角【1】同样认作引用（模型两套括号都会用）', () => {
    const onCite = vi.fn()
    render(<AnswerMarkdown content="结论【1】。" hits={[hit(11)]} onCite={onCite} />)
    expect(links()).toHaveLength(1)
    fireEvent.click(links()[0])
    expect(onCite).toHaveBeenCalledWith(hit(11))
  })

  // 代码里的 [1] 是**字面量**（数组下标之类），把它变成跳转控件等于改写了代码。
  it('行内代码与代码块里的 [1] 保持字面量', () => {
    render(
      <AnswerMarkdown
        content={'行内 `arr[1]` 与代码块：\n\n```py\nb = c[1]\n```\n'}
        hits={[hit(11)]}
        onCite={() => {}}
      />,
    )
    expect(links()).toHaveLength(0)
    expect(screen.getByText('arr[1]')).toBeInTheDocument()
    expect(screen.getByText(/b = c\[1\]/)).toBeInTheDocument()
  })

  // KaTeX 的 MathML 会把**原始 TeX 原样**放进 <annotation>（例如 `a[1]` 的源码），
  // 故「跳过公式子树」是一条承重规则而不是保险。下面这条先确认该形态真的存在，
  // 再要求它不被当成引用 —— 形态变了（katex 换输出）就会在这里红，而不是悄悄失效。
  it('公式照常渲染，且公式源码里的 [1] 不算引用', () => {
    const { container } = render(
      <AnswerMarkdown
        content={'能量 $\\Delta G$ 下降[1]，而公式 $a[1]$ 内部不是引用。'}
        hits={[hit(11)]}
        onCite={() => {}}
      />,
    )
    expect(container.querySelectorAll('.katex').length).toBeGreaterThan(0)
    const tex = Array.from(
      container.querySelectorAll('annotation[encoding="application/x-tex"]'),
    ).map((a) => a.textContent ?? '')
    expect(tex.some((t) => t.includes('[1]'))).toBe(true)
    // 只有正文里那一个引用是可点的
    expect(links()).toHaveLength(1)
    expect(links()[0]).toHaveTextContent('[1]')
  })

  // 链接标签里再放一个可点控件是无效嵌套（读屏与 Tab 序都会乱）——链接内部一律不切。
  it('链接标签里的 [1] 不变成嵌套控件', () => {
    render(
      <AnswerMarkdown content="[见[1]](https://example.com)" hits={[hit(11)]} onCite={() => {}} />,
    )
    expect(links()).toHaveLength(0)
    expect(screen.getByRole('link', { name: '见[1]' })).toHaveAttribute(
      'href',
      'https://example.com',
    )
  })

  it('嵌套方括号不抛错，且仍指向所写的那个编号', () => {
    const onCite = vi.fn()
    render(<AnswerMarkdown content="笔误 [[1]] 也能点。" hits={[hit(11)]} onCite={onCite} />)
    expect(links()).toHaveLength(1)
    fireEvent.click(links()[0])
    expect(onCite).toHaveBeenCalledWith(hit(11))
  })

  // 未接线（如文献卡正文 `DocPanel` 里的 AnswerMarkdown）：没有本轮依据可指，一律只读。
  it('没有依据可指时，标记保持为文字（不出现点不动的控件）', () => {
    render(<AnswerMarkdown content="结论[1]" />)
    expect(links()).toHaveLength(0)
    expect(document.body.textContent).toContain('[1]')
  })

  it('Markdown 与链接照常渲染（引用接线不得干扰既有渲染）', () => {
    render(
      <AnswerMarkdown
        content={'**重点**[1]\n\n- 条目一\n- 条目二\n\n[官网](https://example.com)\n'}
        hits={[hit(11)]}
        onCite={() => {}}
      />,
    )
    expect(screen.getByText('重点').tagName).toBe('STRONG')
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByRole('link', { name: '官网' })).toHaveAttribute(
      'href',
      'https://example.com',
    )
    expect(links()).toHaveLength(1)
  })
})
