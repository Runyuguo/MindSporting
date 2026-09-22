import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Hit } from '../lib/events'
import {
  PARAMS_KEY,
  createConversation,
  loadConversations,
  loadCurrentId,
  migrateLegacyKeys,
  params,
  saveConversations,
  saveCurrentId,
  titleFrom,
  type Conversation,
} from '../lib/conversations'

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

describe('conversations 读取/写入', () => {
  beforeEach(() => localStorage.clear())

  it('按库隔离：两库互不可见', () => {
    saveConversations('ai4s', [conv('a1')])
    saveConversations('mito', [conv('m1')])
    expect(loadConversations('ai4s').map((c) => c.id)).toEqual(['a1'])
    expect(loadConversations('mito').map((c) => c.id)).toEqual(['m1'])
  })

  it('未知库返回空数组', () => {
    expect(loadConversations('nope')).toEqual([])
  })

  it('多对话并存：一次保存多条，互不覆盖且保序', () => {
    const list = [conv('a1'), conv('a2'), conv('a3')]
    saveConversations('ai4s', list)
    saveConversations('ai4s', [...list, conv('a4')])
    expect(loadConversations('ai4s').map((c) => c.id)).toEqual(['a1', 'a2', 'a3', 'a4'])
  })

  it('往返保留消息与按轮命中', () => {
    const c = conv('a1', {
      messages: [
        { role: 'user', content: '问一' },
        { role: 'assistant', content: '答一' },
      ],
      evidenceByRound: { 0: [hit] },
    })
    saveConversations('ai4s', [c])
    expect(loadConversations('ai4s')).toEqual([c])
  })

  it('损坏 JSON 返回空数组且不抛', () => {
    localStorage.setItem('ragqa:conv:ai4s', '{not json')
    expect(() => loadConversations('ai4s')).not.toThrow()
    expect(loadConversations('ai4s')).toEqual([])
  })

  it('形状不符（非数组）返回空数组且不抛', () => {
    localStorage.setItem('ragqa:conv:ai4s', JSON.stringify({ id: 'a1' }))
    expect(loadConversations('ai4s')).toEqual([])
    localStorage.setItem('ragqa:conv:ai4s', JSON.stringify('nope'))
    expect(loadConversations('ai4s')).toEqual([])
  })

  it('丢弃残破条目，保留完好条目', () => {
    localStorage.setItem(
      'ragqa:conv:ai4s',
      JSON.stringify([conv('ok'), { id: 'no-title' }, 42, null, { title: '无 id' }]),
    )
    expect(loadConversations('ai4s').map((c) => c.id)).toEqual(['ok'])
  })

  it('丢弃 messages 或 evidenceByRound 形状不符的条目', () => {
    localStorage.setItem(
      'ragqa:conv:ai4s',
      JSON.stringify([
        conv('ok'),
        conv('bad-msgs', { messages: [{ role: 'x', content: '' }] as never }),
        conv('bad-rounds', { evidenceByRound: { 0: [{ rowid: 'no' }] } as never }),
      ]),
    )
    expect(loadConversations('ai4s').map((c) => c.id)).toEqual(['ok'])
  })
})

describe('conversations 当前选中 id', () => {
  beforeEach(() => localStorage.clear())

  it('无存储时返回 null', () => {
    expect(loadCurrentId('ai4s')).toBeNull()
  })

  it('往返保存与读取当前 id', () => {
    saveConversations('ai4s', [conv('a1'), conv('a2')])
    saveCurrentId('ai4s', 'a2')
    expect(loadCurrentId('ai4s')).toBe('a2')
  })

  it('存储的 id 不在列表内时回退到首条', () => {
    saveConversations('ai4s', [conv('a1'), conv('a2')])
    localStorage.setItem('ragqa:current:ai4s', 'stale-id')
    expect(loadCurrentId('ai4s')).toBe('a1')
  })

  it('从未写过 current 但列表非空时回退到首条', () => {
    saveConversations('ai4s', [conv('a1'), conv('a2')])
    expect(loadCurrentId('ai4s')).toBe('a1')
  })

  it('列表为空时返回 null（即使存了 id）', () => {
    localStorage.setItem('ragqa:current:ai4s', 'ghost')
    expect(loadCurrentId('ai4s')).toBeNull()
  })

  it('current 只作用于本库', () => {
    saveConversations('ai4s', [conv('a1')])
    saveConversations('mito', [conv('m1')])
    saveCurrentId('ai4s', 'a1')
    expect(loadCurrentId('mito')).toBe('m1')
  })
})

describe('migrateLegacyKeys 旧键迁移', () => {
  beforeEach(() => localStorage.clear())

  it('把两库旧键原样搬入 legacy-backup 并删除原键', () => {
    const raw4s = JSON.stringify([{ role: 'user', content: '旧问' }])
    const rawMito = JSON.stringify([{ role: 'assistant', content: '旧答' }])
    localStorage.setItem('ragqa:ai4s', raw4s)
    localStorage.setItem('ragqa:mito', rawMito)

    migrateLegacyKeys()

    const backup = JSON.parse(localStorage.getItem('ragqa:legacy-backup')!) as Record<string, unknown>
    expect(backup.ai4s).toBe(raw4s)
    expect(backup.mito).toBe(rawMito)
    expect(typeof backup.migratedAt).toBe('number')
    expect(localStorage.getItem('ragqa:ai4s')).toBeNull()
    expect(localStorage.getItem('ragqa:mito')).toBeNull()
  })

  it('幂等：第二次调用不再搬移，备份与 migratedAt 均不变', () => {
    localStorage.setItem('ragqa:ai4s', '["first"]')
    migrateLegacyKeys()
    const after = localStorage.getItem('ragqa:legacy-backup')

    // 模拟迁移后又出现旧键（幂等判据是 migratedAt，不应再次搬移）
    localStorage.setItem('ragqa:ai4s', '["second"]')
    migrateLegacyKeys()

    expect(localStorage.getItem('ragqa:legacy-backup')).toBe(after)
    expect(localStorage.getItem('ragqa:ai4s')).toBe('["second"]')
  })

  it('无旧键时也写 migratedAt（标记迁移已完成）', () => {
    migrateLegacyKeys()
    const backup = JSON.parse(localStorage.getItem('ragqa:legacy-backup')!) as Record<string, unknown>
    expect(typeof backup.migratedAt).toBe('number')
    expect(backup.ai4s).toBeUndefined()
    expect(backup.mito).toBeUndefined()
  })

  it('只迁移单个旧键，缺的那个不写入', () => {
    localStorage.setItem('ragqa:mito', '["m"]')
    migrateLegacyKeys()
    const backup = JSON.parse(localStorage.getItem('ragqa:legacy-backup')!) as Record<string, unknown>
    expect(backup.mito).toBe('["m"]')
    expect(backup.ai4s).toBeUndefined()
  })

  it('不碰新键：会话数据与当前选中在迁移后完好', () => {
    saveConversations('ai4s', [conv('a1')])
    saveCurrentId('ai4s', 'a1')
    localStorage.setItem('ragqa:ai4s', '["legacy"]')

    migrateLegacyKeys()

    expect(loadConversations('ai4s').map((c) => c.id)).toEqual(['a1'])
    expect(loadCurrentId('ai4s')).toBe('a1')
  })

  it('备份损坏时视为未迁移，可重新迁移', () => {
    localStorage.setItem('ragqa:legacy-backup', '{broken')
    localStorage.setItem('ragqa:ai4s', '["x"]')
    migrateLegacyKeys()
    const backup = JSON.parse(localStorage.getItem('ragqa:legacy-backup')!) as Record<string, unknown>
    expect(backup.ai4s).toBe('["x"]')
    expect(typeof backup.migratedAt).toBe('number')
  })

  it('备份写入失败时不动原键：两库旧值原样保留且不记 migratedAt', () => {
    const raw4s = JSON.stringify([{ role: 'user', content: '旧问' }])
    const rawMito = JSON.stringify([{ role: 'assistant', content: '旧答' }])
    localStorage.setItem('ragqa:ai4s', raw4s)
    localStorage.setItem('ragqa:mito', rawMito)

    // 只让写入失败（配额满），删除键仍可用——这正是会静默丢数据的失败形状。
    const originalSet = Storage.prototype.setItem
    Storage.prototype.setItem = () => {
      throw new Error('quota exceeded')
    }
    try {
      expect(() => migrateLegacyKeys()).not.toThrow()
    } finally {
      Storage.prototype.setItem = originalSet
    }

    // 备份没落地，原键就必须原样还在，否则历史被静默永久销毁。
    expect(localStorage.getItem('ragqa:ai4s')).toBe(raw4s)
    expect(localStorage.getItem('ragqa:mito')).toBe(rawMito)

    // 未记录 migratedAt → 视为未迁移，后续调用仍会重试搬移。
    const backupRaw = localStorage.getItem('ragqa:legacy-backup')
    const backup = backupRaw === null ? null : (JSON.parse(backupRaw) as Record<string, unknown>)
    expect(backup?.migratedAt).toBeUndefined()
  })

  it('删除失败时备份已落地：数据仍可挽回', () => {
    const raw4s = JSON.stringify([{ role: 'user', content: '旧问' }])
    localStorage.setItem('ragqa:ai4s', raw4s)

    // 写入可用、删除键抛错：旧键删不掉只是残留，不许连备份一起丢。
    const originalRemove = Storage.prototype.removeItem
    Storage.prototype.removeItem = () => {
      throw new Error('storage disabled')
    }
    try {
      expect(() => migrateLegacyKeys()).not.toThrow()
    } finally {
      Storage.prototype.removeItem = originalRemove
    }

    const backup = JSON.parse(localStorage.getItem('ragqa:legacy-backup')!) as Record<string, unknown>
    expect(backup.ai4s).toBe(raw4s)
    expect(typeof backup.migratedAt).toBe('number')
  })
})

describe('titleFrom 标题规则', () => {
  it('取首条问题前 24 字', () => {
    expect(titleFrom('一二三四五六七八九十一二三四五六七八九十一二三四五六')).toBe(
      '一二三四五六七八九十一二三四五六七八九十一二三四',
    )
    expect(titleFrom('一二三四五六七八九十一二三四五六七八九十一二三四五六')).toHaveLength(24)
  })

  it('折叠空白并去除首尾空白', () => {
    expect(titleFrom('  关于   线粒体\n\n自噬  ')).toBe('关于 线粒体 自噬')
  })

  it('空输入返回占位标题', () => {
    expect(titleFrom('')).toBe('新对话')
    expect(titleFrom('   \n\t ')).toBe('新对话')
  })
})

describe('ragqa:params 读取辅助', () => {
  beforeEach(() => localStorage.clear())

  it('未存过时返回默认值', () => {
    expect(PARAMS_KEY).toBe('ragqa:params')
    expect(params()).toEqual({ divergence: 1, length: 1500, topn: 10 })
  })

  it('存过时读取已存字段，缺失字段回落到默认值', () => {
    localStorage.setItem(PARAMS_KEY, JSON.stringify({ divergence: 0.5 }))
    expect(params()).toEqual({ divergence: 0.5, length: 1500, topn: 10 })
  })

  it('损坏或形状不符时返回默认值而不抛', () => {
    localStorage.setItem(PARAMS_KEY, '{broken')
    expect(params()).toEqual({ divergence: 1, length: 1500, topn: 10 })
    localStorage.setItem(PARAMS_KEY, JSON.stringify({ divergence: 'big' }))
    expect(params()).toEqual({ divergence: 1, length: 1500, topn: 10 })
  })
})

describe('createConversation', () => {
  beforeEach(() => localStorage.clear())

  it('生成唯一 id 与占位标题的空对话', () => {
    const a = createConversation()
    const b = createConversation()
    expect(a.id).not.toBe(b.id)
    expect(a.title).toBe('新对话')
    expect(a.messages).toEqual([])
    expect(a.evidenceByRound).toEqual({})
    expect(a.updatedAt).toBe(a.createdAt)
  })
})

// ---- T46: 思考字段的向后兼容 ---------------------------------------------------
// 003 给每轮加了 `reasoningSummary` / `reasoningMs`。守法与 `evidenceByRound` 一致：
// **可选**且不进守卫 —— 已存在的会话（写入时还没有这两个字段）必须照常加载，
// 否则一次版本升级就会把用户的历史会话全部判为「形状不符」而丢弃（静默数据丢失）。
describe('思考字段的向后兼容', () => {
  beforeEach(() => localStorage.clear())

  it('旧会话（无思考字段）加载不报错且内容不丢', () => {
    // 走真实读取路径（localStorage + 守卫），而不是直接调 loadConversations(legacy)：
    // 要钉的正是「守卫放行缺字段的旧条目」这件事。
    localStorage.setItem(
      'ragqa:conv:ai4s',
      JSON.stringify([{ id: 'a', title: '旧', messages: [{ role: 'user', content: 'q' }] }]),
    )
    const out = loadConversations('ai4s')
    expect(out).toHaveLength(1)
    expect(out[0].messages).toHaveLength(1)
    expect(out[0].messages[0].content).toBe('q')
    expect(out[0].reasoningSummary).toBeUndefined()
    expect(out[0].reasoningMs).toBeUndefined()
    // 后加的字段就地补出中性值：时间未知补 0（沉到历史列表末尾，不冒充最新），
    // 按轮依据补空表（语义即「还没有任何轮次的命中」）
    expect(out[0].evidenceByRound).toEqual({})
    expect(out[0].createdAt).toBe(0)
    expect(out[0].updatedAt).toBe(0)
    expect(out[0].id).toBe('a')
    expect(out[0].title).toBe('旧')
  })

  it('补齐后的旧条目形状完整，可继续被 update 写回', () => {
    // 归一化必须产出**真的** Conversation：否则 update 的 {...c, ...patch} 会把
    // undefined 的 evidenceByRound 一起写回存储，坏形状就此扩散。
    localStorage.setItem(
      'ragqa:conv:ai4s',
      JSON.stringify([{ id: 'a', title: '旧', messages: [] }]),
    )
    const out = loadConversations('ai4s')
    expect(Object.keys(out[0]).sort()).toEqual(
      ['createdAt', 'evidenceByRound', 'id', 'messages', 'title', 'updatedAt'],
    )
    saveConversations('ai4s', out)
    expect(loadConversations('ai4s')[0].evidenceByRound).toEqual({})
  })

  it('带思考字段的会话原样往返', () => {
    const c = conv('a1', {
      messages: [
        { role: 'user', content: '问一' },
        { role: 'assistant', content: '答一' },
      ],
      reasoningSummary: '先核对证据。',
      reasoningMs: 900,
    })
    saveConversations('ai4s', [c])
    const out = loadConversations('ai4s')
    expect(out[0].reasoningSummary).toBe('先核对证据。')
    expect(out[0].reasoningMs).toBe(900)
  })
})

describe('localStorage 抛错时全部退化', () => {
  const originalGet = Storage.prototype.getItem
  const originalSet = Storage.prototype.setItem
  const originalRemove = Storage.prototype.removeItem

  beforeEach(() => {
    localStorage.clear()
    Storage.prototype.getItem = () => {
      throw new Error('storage disabled')
    }
    Storage.prototype.setItem = () => {
      throw new Error('quota exceeded')
    }
    Storage.prototype.removeItem = () => {
      throw new Error('storage disabled')
    }
  })

  afterEach(() => {
    Storage.prototype.getItem = originalGet
    Storage.prototype.setItem = originalSet
    Storage.prototype.removeItem = originalRemove
  })

  it('读函数降级为空值且不抛', () => {
    expect(() => loadConversations('ai4s')).not.toThrow()
    expect(loadConversations('ai4s')).toEqual([])
    expect(() => loadCurrentId('ai4s')).not.toThrow()
    expect(loadCurrentId('ai4s')).toBeNull()
    expect(() => params()).not.toThrow()
    expect(params()).toEqual({ divergence: 1, length: 1500, topn: 10 })
  })

  it('写函数静默失败且不抛', () => {
    expect(() => saveConversations('ai4s', [conv('a1')])).not.toThrow()
    expect(() => saveCurrentId('ai4s', 'a1')).not.toThrow()
  })

  it('迁移不得抛错，也不阻断启动', () => {
    expect(() => migrateLegacyKeys()).not.toThrow()
  })
})

/**
 * T39（004 C-12）：非安全上下文下的 id 生成。
 *
 * 部署形态是**局域网明文 HTTP**（`isSecureContext === false`），此时
 * `crypto.randomUUID` 不存在；旧实现在 `createConversation()` 里直接调用它，
 * React 挂载即抛 `TypeError` ⇒ 整页白屏。`crypto.getRandomValues` 在非安全上下文
 * 仍可用，故这是代码缺陷而非环境限制。
 */
describe('createConversation 在非安全上下文（crypto.randomUUID 缺失）下', () => {
  /** v4 形状：版本位 = 4，变体位 = 8/9/a/b。 */
  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  let original: PropertyDescriptor | undefined

  beforeEach(() => {
    original = Object.getOwnPropertyDescriptor(globalThis.crypto, 'randomUUID')
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      value: undefined,
      configurable: true,
      writable: true,
    })
  })

  afterEach(() => {
    if (original) Object.defineProperty(globalThis.crypto, 'randomUUID', original)
    else delete (globalThis.crypto as { randomUUID?: unknown }).randomUUID
  })

  it('桩确实生效：randomUUID 为 undefined，getRandomValues 仍可用', () => {
    expect(typeof globalThis.crypto.randomUUID).toBe('undefined')
    expect(typeof globalThis.crypto.getRandomValues).toBe('function')
  })

  it('仍能生成合法 v4 UUID 且不抛异常', () => {
    const c = createConversation()
    expect(c.id).toMatch(UUID_V4)
  })

  it('两次调用生成的 id 不同', () => {
    expect(createConversation().id).not.toBe(createConversation().id)
  })

  it('randomUUID 可用时优先使用它（不被回退实现取代）', () => {
    Object.defineProperty(globalThis.crypto, 'randomUUID', {
      value: () => 'sentinel-uuid',
      configurable: true,
      writable: true,
    })
    expect(createConversation().id).toBe('sentinel-uuid')
  })
})
