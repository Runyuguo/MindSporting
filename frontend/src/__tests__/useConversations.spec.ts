import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Hit } from '../lib/events'
import {
  loadConversations,
  loadCurrentId,
  saveConversations,
  saveCurrentId,
  type Conversation,
} from '../lib/conversations'
import { useConversations } from '../hooks/useConversations'

const hit: Hit = {
  rowid: 7,
  source: 'vault',
  ref: 'notes/a.md',
  title: '甲文',
  category: 'mito',
  extra: '',
  snippet: '片段',
  score: 0.5,
}

/** 构造一条结构完整的对话；测试只关心字段而非 id 具体取值。 */
function conv(id: string, over: Partial<Conversation> = {}): Conversation {
  return {
    id,
    title: `对话 ${id}`,
    createdAt: 1,
    updatedAt: 1,
    messages: [],
    evidenceByRound: {},
    ...over,
  }
}

describe('useConversations 列表与选中', () => {
  beforeEach(() => localStorage.clear())

  it('空库自动给出一条空对话并选中它', () => {
    const { result } = renderHook(() => useConversations('ai4s'))

    expect(result.current.list).toHaveLength(1)
    expect(result.current.currentId).toBe(result.current.list[0].id)
    expect(result.current.current).toEqual(result.current.list[0])
    expect(result.current.current?.title).toBe('新对话')
    expect(result.current.current?.messages).toEqual([])
    expect(result.current.current?.evidenceByRound).toEqual({})
  })

  it('自动补出的空对话立即落盘：重新挂载沿用同一条，不反复新建', () => {
    const first = renderHook(() => useConversations('ai4s'))
    const id = first.result.current.list[0].id
    expect(loadConversations('ai4s').map((c) => c.id)).toEqual([id])
    expect(loadCurrentId('ai4s')).toBe(id)
    first.unmount()

    const second = renderHook(() => useConversations('ai4s'))
    expect(second.result.current.list.map((c) => c.id)).toEqual([id])
    expect(second.result.current.currentId).toBe(id)
  })

  it('按库读取既有列表与当前选中', () => {
    saveConversations('ai4s', [conv('a1'), conv('a2')])
    saveCurrentId('ai4s', 'a2')

    const { result } = renderHook(() => useConversations('ai4s'))

    expect(result.current.list.map((c) => c.id)).toEqual(['a1', 'a2'])
    expect(result.current.currentId).toBe('a2')
    expect(result.current.current?.id).toBe('a2')
  })

  it('select(id) 切换当前对话并写入本库的 current 键', () => {
    saveConversations('ai4s', [conv('a1'), conv('a2')])
    saveCurrentId('ai4s', 'a2')
    const { result } = renderHook(() => useConversations('ai4s'))

    act(() => result.current.select('a1'))

    expect(result.current.currentId).toBe('a1')
    expect(result.current.current?.id).toBe('a1')
    expect(loadCurrentId('ai4s')).toBe('a1')
  })

  it('select 未知 id 不产生悬空选中', () => {
    saveConversations('ai4s', [conv('a1')])
    const { result } = renderHook(() => useConversations('ai4s'))

    act(() => result.current.select('ghost'))

    expect(result.current.currentId).toBe('a1')
    expect(result.current.current?.id).toBe('a1')
  })
})

describe('useConversations 新建与切换', () => {
  beforeEach(() => localStorage.clear())

  it('create() 把新对话插到顶部并选中，既有对话逐字段不变', () => {
    const existing = conv('a1', {
      title: '旧对话',
      updatedAt: 42,
      messages: [
        { role: 'user', content: '旧问' },
        { role: 'assistant', content: '旧答' },
      ],
      evidenceByRound: { 0: [hit] },
    })
    saveConversations('ai4s', [existing])
    saveCurrentId('ai4s', 'a1')
    const { result } = renderHook(() => useConversations('ai4s'))

    act(() => result.current.create())

    const fresh = result.current.list[0]
    expect(result.current.list).toHaveLength(2)
    expect(fresh.id).toBe(result.current.currentId)
    expect(fresh.id).not.toBe('a1')
    expect(result.current.current?.title).toBe('新对话')
    // 既有对话的内容、时间戳、按轮命中都不受新建影响
    expect(result.current.list.find((c) => c.id === 'a1')).toEqual(existing)
    // 落盘与内存一致
    expect(loadConversations('ai4s').map((c) => c.id)).toEqual([fresh.id, 'a1'])
    expect(loadCurrentId('ai4s')).toBe(fresh.id)
  })

  it('连续 create() 不复用 id，且每次都把新的置顶选中', () => {
    const { result } = renderHook(() => useConversations('ai4s'))

    act(() => result.current.create())
    const firstNew = result.current.currentId
    act(() => result.current.create())

    expect(result.current.currentId).not.toBe(firstNew)
    expect(result.current.list).toHaveLength(3) // 自动补出的空对话 + 两次新建
    expect(new Set(result.current.list.map((c) => c.id)).size).toBe(3)
    expect(result.current.list[0].id).toBe(result.current.currentId)
  })

  it('切库后只看到该库自己的列表与选中项，且新建不写到别的库', () => {
    saveConversations('ai4s', [conv('a1'), conv('a2')])
    saveCurrentId('ai4s', 'a1')
    saveConversations('mito', [conv('m1'), conv('m2'), conv('m3')])
    saveCurrentId('mito', 'm2')

    const { result, rerender } = renderHook(
      (props: { lib: string }) => useConversations(props.lib),
      { initialProps: { lib: 'ai4s' } },
    )
    expect(result.current.list.map((c) => c.id)).toEqual(['a1', 'a2'])
    expect(result.current.currentId).toBe('a1')

    rerender({ lib: 'mito' })
    expect(result.current.list.map((c) => c.id)).toEqual(['m1', 'm2', 'm3'])
    expect(result.current.currentId).toBe('m2')

    rerender({ lib: 'ai4s' })
    expect(result.current.list.map((c) => c.id)).toEqual(['a1', 'a2'])
    expect(result.current.currentId).toBe('a1')

    act(() => result.current.create())

    expect(result.current.list.map((c) => c.id)).toHaveLength(3)
    // 另一库的会话与选中项一个字都没被改动
    expect(loadConversations('mito').map((c) => c.id)).toEqual(['m1', 'm2', 'm3'])
    expect(loadCurrentId('mito')).toBe('m2')
  })
})

describe('useConversations 降级', () => {
  beforeEach(() => localStorage.clear())

  it('存储写入不可用时降级为内存态，不抛错穿到 React', () => {
    const originalSet = Storage.prototype.setItem
    Storage.prototype.setItem = () => {
      throw new Error('quota exceeded')
    }
    try {
      const { result } = renderHook(() => useConversations('ai4s'))
      expect(result.current.list).toHaveLength(1)

      act(() => result.current.create())
      expect(result.current.list).toHaveLength(2)

      act(() => result.current.select(result.current.list[1].id))
      expect(result.current.current?.id).toBe(result.current.list[1].id)
    } finally {
      Storage.prototype.setItem = originalSet
    }
  })
})

describe('useConversations 写入路径 update', () => {
  beforeEach(() => localStorage.clear())

  it('update 持久化被改动的 messages 数组（从 localStorage 读回断言）', () => {
    saveConversations('ai4s', [conv('a1')])
    saveCurrentId('ai4s', 'a1')
    const { result } = renderHook(() => useConversations('ai4s'))
    const messages = [
      { role: 'user' as const, content: '新问' },
      { role: 'assistant' as const, content: '新答' },
    ]

    act(() => result.current.update('a1', { messages }))

    expect(result.current.current?.messages).toEqual(messages)
    const stored = loadConversations('ai4s').find((c) => c.id === 'a1')
    expect(stored?.messages).toEqual(messages)
  })

  it('update 让 updatedAt 不减而 createdAt 原样不动', () => {
    const before = Date.now() - 10_000
    saveConversations('ai4s', [conv('a1', { createdAt: 111, updatedAt: before })])
    saveCurrentId('ai4s', 'a1')
    const { result } = renderHook(() => useConversations('ai4s'))

    act(() => result.current.update('a1', { title: '改过的标题' }))

    const after = result.current.current
    expect(after?.updatedAt).toBeGreaterThan(before)
    expect(after?.createdAt).toBe(111)
    // 落盘的时间戳与内存一致
    const stored = loadConversations('ai4s').find((c) => c.id === 'a1')
    expect(stored?.updatedAt).toBe(after?.updatedAt)
    expect(stored?.createdAt).toBe(111)
  })

  it('update 未知 id 是 no-op：不抛错也不损坏已存列表', () => {
    const existing = [conv('a1'), conv('a2')]
    saveConversations('ai4s', existing)
    saveCurrentId('ai4s', 'a2')
    const { result } = renderHook(() => useConversations('ai4s'))
    const storedBefore = localStorage.getItem('ragqa:conv:ai4s')

    expect(() => act(() => result.current.update('ghost', { title: '幽灵' }))).not.toThrow()

    expect(result.current.list.map((c) => c.id)).toEqual(['a1', 'a2'])
    expect(result.current.list).toEqual(existing)
    expect(result.current.currentId).toBe('a2')
    expect(localStorage.getItem('ragqa:conv:ai4s')).toBe(storedBefore)
  })

  it('update 一条对话不改变另一条的 messages 与 updatedAt', () => {
    const other = conv('a2', {
      messages: [{ role: 'user' as const, content: '甲问' }],
      updatedAt: 7,
      evidenceByRound: { 0: [hit] },
    })
    saveConversations('ai4s', [conv('a1'), other])
    saveCurrentId('ai4s', 'a1')
    const { result } = renderHook(() => useConversations('ai4s'))

    act(() => result.current.update('a1', { messages: [{ role: 'user', content: '乙问' }] }))

    expect(result.current.list.find((c) => c.id === 'a2')).toEqual(other)
    expect(loadConversations('ai4s').find((c) => c.id === 'a2')).toEqual(other)
  })

  it('title 可通过 update 写入（首条 user 消息由此成为标题）', () => {
    saveConversations('ai4s', [conv('a1')])
    saveCurrentId('ai4s', 'a1')
    const { result } = renderHook(() => useConversations('ai4s'))

    act(() => result.current.update('a1', { title: '首条问题前 24 字' }))

    expect(result.current.current?.title).toBe('首条问题前 24 字')
    expect(loadConversations('ai4s').find((c) => c.id === 'a1')?.title).toBe('首条问题前 24 字')
  })

  it('update 不改变当前选中项', () => {
    saveConversations('ai4s', [conv('a1'), conv('a2')])
    saveCurrentId('ai4s', 'a2')
    const { result } = renderHook(() => useConversations('ai4s'))

    act(() => result.current.update('a1', { title: '改非当前那条' }))

    expect(result.current.currentId).toBe('a2')
    expect(result.current.current?.id).toBe('a2')
    expect(loadCurrentId('ai4s')).toBe('a2')
  })
})
