import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { EvidenceList } from '../components/EvidenceList'
import { EvidencePanel } from '../components/EvidencePanel'
import type { Hit } from '../lib/events'

const hit = (over: Partial<Hit> = {}): Hit => ({
  rowid: 1,
  source: 'vault:note',
  ref: '01-Literature/自噬.md',
  title: '线粒体自噬',
  category: '',
  extra: 'obsidian://01-Literature/自噬.md',
  snippet: '线粒体自噬受 PINK1/Parkin 调控…',
  score: 0.82,
  ...over,
})

describe('EvidenceList', () => {
  it('renders nothing when there are no hits', () => {
    const { container } = render(<EvidenceList hits={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders one numbered card per hit', () => {
    render(<EvidenceList hits={[hit(), hit({ rowid: 2, title: '第二条' })]} />)
    expect(screen.getByText('[1]')).toBeInTheDocument()
    expect(screen.getByText('[2]')).toBeInTheDocument()
    expect(screen.getByText('线粒体自噬')).toBeInTheDocument()
    expect(screen.getByText('第二条')).toBeInTheDocument()
  })

  it('shows a human-readable source label rather than the raw token', () => {
    render(<EvidenceList hits={[hit()]} />)
    expect(screen.getByText('文献笔记')).toBeInTheDocument()
    expect(screen.queryByText('vault:note')).toBeNull()
  })

  // T31：证据卡的底板同样加在**整张卡**上（块级），不逐词加底。
  it('给整张证据卡加文字底板', () => {
    render(<EvidenceList hits={[hit()]} />)
    const text = screen.getByText('线粒体自噬')

    let panel: HTMLElement | null = text
    while (panel !== null && !panel.className.includes('bg-[var(--color-panel)]')) {
      panel = panel.parentElement
    }
    expect(panel).not.toBeNull()
    expect(panel?.className).toContain('border-[var(--color-panel-border)]')
    // 整张卡片（含标题、片段、出处）同处一块底板下
    expect(panel?.textContent).toContain('线粒体自噬受 PINK1/Parkin 调控')
  })

  it('renders an empty state when the search found nothing', () => {
    render(<EvidenceList hits={[]} emptyLabel="未找到依据" />)
    expect(screen.getByText('未找到依据')).toBeInTheDocument()
  })

  // 只读上下文（内联列表里没有选择器）**同样**点不开任何一张卡——vault 卡在这里也不可点。
  // 此时只给非 vault 卡挂一句「没有可读原文」，读起来就成了「这张不能点、那张能点」的入口
  // 差异，而差异并不存在。故：提示只在有选择器、确实存在入口差异时才出现。
  it('只读内联列表里不给非 vault 卡挂「没有可读原文」（无选择器即无入口差异）', () => {
    render(
      <EvidenceList
        hits={[
          hit({ source: 'metadata', ref: '12345678', extra: '', title: '一条摘要命中' }),
        ]}
      />,
    )
    // 卡片本身仍在（命中与出处不得被藏起来）
    expect(screen.getByText('一条摘要命中')).toBeInTheDocument()
    expect(screen.getByText('12345678')).toBeInTheDocument()
    expect(screen.queryByText(/没有可读原文/)).toBeNull()
  })
})

describe('EvidencePanel', () => {
  // 侧栏的常驻性是承重结构（刷新后两栏不得塌成一栏）：零命中/尚未提问也要渲染 <aside>。
  it('always renders the sidebar, with the empty label the caller chose', () => {
    render(<EvidencePanel hits={[]} emptyLabel="未找到依据" />)
    expect(screen.getByTestId('evidence-panel')).toBeInTheDocument()
    expect(screen.getByText('未找到依据')).toBeInTheDocument()
  })

  it('reports the picked hit and shows which one is selected', () => {
    const onSelect = vi.fn()
    const card = hit()
    const { rerender } = render(
      <EvidencePanel
        hits={[card]}
        emptyLabel="未找到依据"
        selectedRowid={null}
        onSelect={onSelect}
      />,
    )
    const button = screen.getByRole('button', { name: /线粒体自噬/ })
    expect(button).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(button)
    expect(onSelect).toHaveBeenCalledWith(card)

    rerender(
      <EvidencePanel
        hits={[card]}
        emptyLabel="未找到依据"
        selectedRowid={card.rowid}
        onSelect={onSelect}
      />,
    )
    expect(screen.getByRole('button', { name: /线粒体自噬/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('stays read-only when no picker is provided', () => {
    render(<EvidencePanel hits={[hit()]} emptyLabel="未找到依据" />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  // I2（整支复审 Important）：`metadata` 的 `ref` 是 PMID（`pdf` 是 txt 文件名），
  // 不是 vault 相对 `.md` 路径。点它只会得到 400「该路径不在本库范围内」——那是
  // **事实错误**：篇目并不越界，只是没有可读原文。故：不给可点入口 + 如实说明。
  it('不给非 vault 来源可点入口，并说明它没有可读原文（I2）', () => {
    const onSelect = vi.fn()
    render(
      <EvidencePanel
        hits={[hit({ source: 'metadata', ref: '12345678', title: '一条摘要命中' })]}
        emptyLabel="未找到依据"
        onSelect={onSelect}
      />,
    )

    // 卡片仍在（命中不得被藏起来），但没有可点入口
    expect(screen.getByText('一条摘要命中')).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
    // 说明必须可见：沉默的卡会让人以为「点了没反应」
    expect(screen.getByText(/没有可读原文/)).toBeInTheDocument()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('vault 来源照常可点（I2 不得顺手关掉整个入口）', () => {
    const onSelect = vi.fn()
    render(
      <EvidencePanel
        hits={[hit({ source: 'vault:ocr', ref: 'OCR/x.md', title: 'OCR 命中' })]}
        emptyLabel="未找到依据"
        onSelect={onSelect}
      />,
    )

    const button = screen.getByRole('button', { name: /OCR 命中/ })
    fireEvent.click(button)
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(/没有可读原文/)).toBeNull()
  })
})
