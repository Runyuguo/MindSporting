import { describe, expect, it } from 'vitest'
import { citationTarget } from '../lib/citations'
import type { Hit } from '../lib/events'

/**
 * T56：答案里的 `[编号]` 怎么定位到**本轮**的具体一条命中。
 *
 * 这条映射此前只存在于后端提示词的口头约定里（「每条关键论断后用 [编号] 标注证据」），
 * 前端没有任何落地 —— 于是 [编号] 只是正文里的一段死文字，spec 001「引用可追溯」的
 * Scenario「该编号能在本轮证据集合中找到对应条目」在界面上不可兑现。
 *
 * 本文件只钉**映射规则**本身（纯函数）；渲染与跳转由
 * `citationLinks.spec.tsx`（组件级）与 `app-citations.spec.tsx`（整机）钉。
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

describe('citationTarget —— [编号] 到命中的定位规则（T56）', () => {
  it('编号 = 该轮命中数组的下标 + 1（送达顺序即编号顺序）', () => {
    const hits = [hit(11, '第一条'), hit(22, '第二条'), hit(33, '第三条')]
    expect(citationTarget(hits, 1)?.rowid).toBe(11)
    expect(citationTarget(hits, 2)?.rowid).toBe(22)
    expect(citationTarget(hits, 3)?.rowid).toBe(33)
  })

  it('越界编号不指向任何一条（模型可能发出这种编号）', () => {
    const hits = [hit(11), hit(22)]
    expect(citationTarget(hits, 3)).toBeNull()
    expect(citationTarget(hits, 0)).toBeNull()
    expect(citationTarget(hits, -1)).toBeNull()
    expect(citationTarget(hits, 1.5)).toBeNull()
    expect(citationTarget(hits, Number.NaN)).toBeNull()
    expect(citationTarget(hits, Number.POSITIVE_INFINITY)).toBeNull()
  })

  it('该轮没有命中、或整轮依据还没落到前端时，一律不指向', () => {
    expect(citationTarget([], 1)).toBeNull()
    expect(citationTarget(undefined, 1)).toBeNull()
  })

  // 编号只在**本轮**内解释：同一个 n 在不同轮指向各自的第 n 条。
  // 这正是「累积视图里各轮并集重排」不得参与定位的理由（见 lib/citations.ts 的注释）。
  it('同一个编号在不同轮各指各的第 n 条（编号不跨轮解释）', () => {
    const round0 = [hit(11), hit(22)]
    const round1 = [hit(22), hit(33)]
    expect(citationTarget(round0, 1)?.rowid).toBe(11)
    expect(citationTarget(round1, 1)?.rowid).toBe(22)
    expect(citationTarget(round0, 2)?.rowid).toBe(22)
    expect(citationTarget(round1, 2)?.rowid).toBe(33)
  })
})
