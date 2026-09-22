import { describe, expect, it } from 'vitest'
import { STAGE_LABEL, latestSentence, stageLabel, summarizeLatest } from '../lib/stages'

describe('latestSentence', () => {
  it('取最后一个完整句', () => {
    expect(latestSentence('第一句。第二句。')).toBe('第二句。')
  })

  it('支持中英文句末标点', () => {
    expect(latestSentence('先想一下。Then check? ')).toBe('Then check?')
  })

  it('无完整句时返回裁剪后的前缀', () => {
    const out = latestSentence('还没有结束的句子在流出中')
    expect(out).toBe('还没有结束的句子在流出中')
  })

  it('超长无标点文本被裁到上限', () => {
    const out = latestSentence('啊'.repeat(500))
    expect(out.length).toBeLessThanOrEqual(80)
  })

  it('空串返回空串', () => {
    expect(latestSentence('')).toBe('')
  })

  // 折叠断言：拼接「完整句 + 尚未结束的尾句」时必须只取完整句那一句。
  // 这钉住「摘要取自思考流自身、且必须是**已完成**的那一句」，而不是把半句也端出去。
  it('只取完整句，忽略其后尚未结束的尾巴', () => {
    expect(latestSentence('第一句。第二句。半句还没完')).toBe('第二句。')
  })

  // 同一句在流里出现多次（模型复述自己）时，取的必须是**最后**那一句；
  // 用 `indexOf` 定位会命中第一次出现的位置，从而取错分隔符。
  it('同一句重复出现时取最后一次出现', () => {
    expect(latestSentence('第二句。第二句。')).toBe('第二句。')
  })

  // 上面那条**区分不出**实现：重复的两句连分隔符都一样，`indexOf` 取错位置也得到同一个字符。
  // 这一条才真正钉住缺陷形状 —— 用 `indexOf(最后一段)` 回找分隔符时，若最后一段是前面
  // 某段的**前缀/子串**，`indexOf` 会命中更早的位置，那里的下一个字符是普通文字，
  // 于是句末标点被整个丢掉（『甲甲。甲。』→『甲』，摘要看着像被截断）。
  // 捕获组写法把标点与句子一起带出，不存在这个歧义。
  it('最后一句是前面某句的子串时，句末标点不得丢失', () => {
    expect(latestSentence('甲甲。甲。')).toBe('甲。')
  })

  it('无完整句时前缀取自**末尾**（流式下最新的才是有信息的）', () => {
    const text = `${'开头'.repeat(60)}最新的半句`
    expect(latestSentence(text)).toBe(text.slice(-80))
  })
})

describe('STAGE_LABEL', () => {
  it('五个阶段都有中文名', () => {
    expect(Object.keys(STAGE_LABEL).sort()).toEqual(
      ['answer', 'done', 'evidence', 'reasoning', 'rewrite'],
    )
  })

  it('每个阶段名都是非空中文标签', () => {
    for (const label of Object.values(STAGE_LABEL)) {
      expect(typeof label).toBe('string')
      expect(label.trim()).not.toBe('')
    }
  })
})

// 复审 Important 4：事件名 `stage` 是**已知**的，故解析器的未知事件闸门挡不住一个
// **未来新增的阶段名**。直接查表会得到 `undefined`，那一行就渲染成「 · 400ms」——
// 一个没有名字的阶段被当成事实说了出去（零静默失败的反面）。
describe('stageLabel', () => {
  it('已知阶段名给出中文名', () => {
    expect(stageLabel('evidence')).toBe('检索证据')
  })

  it('未知阶段名回退为可见的未知标注 + 服务端原样给出的名字，绝不返回 undefined', () => {
    const out = stageLabel('retrieval')
    expect(out).toBe('未知阶段（retrieval）')
    expect(out).not.toContain('undefined')
  })

  it('名字缺失或不是字符串时也有可见文案', () => {
    expect(stageLabel('')).toBe('未知阶段')
    expect(stageLabel(undefined)).toBe('未知阶段')
  })
})

// 复审 Important 1：摘要只承载**最后一句**（或未成句时的末尾片段），它短于全文是这种
// 取法的常态，**不是**「被截断」的证据。故取法本身必须可判定，供界面如实说明看到了什么。
describe('summarizeLatest', () => {
  it('取到最后一句完整句时标明取法为 sentence', () => {
    expect(summarizeLatest('第一句。第二句。')).toEqual({ text: '第二句。', kind: 'sentence' })
  })

  it('无完整句（还在写）时标明取法为 tail', () => {
    expect(summarizeLatest('还在写没有句号')).toEqual({ text: '还在写没有句号', kind: 'tail' })
  })

  it('空串两种情况都不算', () => {
    expect(summarizeLatest('')).toEqual({ text: '', kind: 'tail' })
  })
})
