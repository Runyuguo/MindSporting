import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { ParamSliders } from '../components/ParamSliders'
import {
  DEFAULT_PARAMS,
  PARAMS_KEY,
  PARAM_RANGES,
  clampParams,
  params,
} from '../lib/conversations'

const enc = new TextEncoder()

function sseResponse(...frames: string[]) {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(enc.encode(f))
      c.close()
    },
  })
  return { ok: true, status: 200, body } as unknown as Response
}

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response
}

const DONE = 'event: done\ndata: {}\n\n'

/** 后端能力答复（`GET /capabilities`）→ `ParamSliders` 的 `capabilities` 入参。 */
function report(
  capability: Record<string, boolean> | null,
  extra: { error?: string | null; pending?: boolean } = {},
) {
  return { params: capability, error: extra.error ?? null, pending: extra.pending ?? false }
}

/**
 * 滑杆住在四栏工作台的功能栏里，而四栏由 `≥1280px` 驱动（plan §12.4）——
 * 涉及 App 的用例必须显式桩成宽屏，否则功能栏根本不挂载。
 */
function stubWideViewport() {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('min-width: 1280px'),
    media: q,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }))
}

/** 只挑出发往某个前缀的请求（能力端点会与问答/取文请求共用同一个 fetch 桩）。 */
function callsTo(fetchMock: ReturnType<typeof vi.fn>, prefix: string) {
  return fetchMock.mock.calls.filter((c) => String(c[0]).startsWith(prefix))
}

/** 能力端点答复可关：宽屏用例即使不关心标注，也不该让滑杆落在「确认失败」态。 */
function capabilityAwareFetch(capability: Record<string, boolean>, sse: () => Response) {
  return vi.fn((url: string) =>
    String(url).startsWith('/capabilities')
      ? Promise.resolve(jsonResponse({ lib: 'ai4s', params: capability }))
      : Promise.resolve(sse()),
  )
}

describe('生成参数滑杆（T28）', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  // 泄漏防护：`restoreAllMocks` 不撤销 `stubGlobal`，而本仓库未开 unstubGlobals，
  // 于是 vi.stubGlobal('fetch' | 'matchMedia') 会渗到同文件后续用例（T25 已因此踩过）。
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('范围、步进与默认值由同一处常量钉住，越界输入被夹紧', () => {
    // `PARAM_RANGES` 与 `DEFAULT_PARAMS` 同处 `lib/conversations.ts`（唯一真值来源），
    // 组件、请求体与测试都从这里取，避免三处各写一份而漂移。
    expect(PARAM_RANGES.divergence).toEqual({ min: 0, max: 2, step: 0.05 })
    expect(PARAM_RANGES.length).toEqual({ min: 1000, max: 5000, step: 50 })
    expect(PARAM_RANGES.topn).toEqual({ min: 10, max: 30, step: 1 })
    expect(DEFAULT_PARAMS).toEqual({ divergence: 1, length: 1500, topn: 10 })

    expect(clampParams({ divergence: 5, length: 99_999 })).toEqual({
      divergence: 2,
      length: 5000,
      topn: 10,
    })
    expect(clampParams({ divergence: -3, length: 1 })).toEqual({
      divergence: 0,
      length: 1000,
      topn: 10,
    })
    // 证据数同样被夹到 10–30：低于下限抬到 10，高于上限压到 30
    expect(clampParams({ topn: 1 }).topn).toBe(10)
    expect(clampParams({ topn: 999 }).topn).toBe(30)
    expect(clampParams({ topn: 22 }).topn).toBe(22)
    // 非数（含 NaN / undefined 之类）回落到默认值，而不是把 NaN 写进请求体
    expect(
      clampParams({ divergence: Number.NaN, length: Number.NaN } as never),
    ).toEqual(DEFAULT_PARAMS)
  })

  it('三条滑杆的标签与使用者原话一致，且是可键盘操作的原生 range（未 disabled）', () => {
    render(<ParamSliders value={DEFAULT_PARAMS} onChange={() => {}} />)

    const divergence = screen.getByRole('slider', { name: '发散' })
    const length = screen.getByRole('slider', { name: '篇幅' })
    const topn = screen.getByRole('slider', { name: '证据数' })

    for (const [el, range] of [
      [divergence, PARAM_RANGES.divergence],
      [length, PARAM_RANGES.length],
      [topn, PARAM_RANGES.topn],
    ] as const) {
      expect(el.tagName).toBe('INPUT')
      expect(el).toHaveAttribute('type', 'range')
      expect(el).toHaveAttribute('min', String(range.min))
      expect(el).toHaveAttribute('max', String(range.max))
      expect(el).toHaveAttribute('step', String(range.step))
      // 使用者需要能设定并看到它被保存 —— 不得用 disabled 掩盖「后端未实现」
      expect(el).not.toBeDisabled()
    }

    // 「证据数」2026-09-19 由使用者要求**恢复**（原先 8 条太少，改为可调 10–30）。
    // 相关性不在本次范围内，仍不得复活。
    expect(screen.queryByRole('slider', { name: /相关性/ })).toBeNull()
  })

  // ── T49 修复（Defect 1）：标注必须**由后端能力驱动** ──────────────────────────────
  // 旧用例钉的是写死的「待接入 + 后端当前不读取它们」，而后端自始**确实读取**这两个参数
  // （T49 验收：发散 0/1/2 三份正文互不相同；篇幅触发字数核对与重试）——那句话是假的，
  // 违反 spec「参数不被支持时的如实性」（标注必须随真实能力变化）与 plan §2.2(d)。
  // 下面四种情形各自断言，缺任何一态都会有一条变红。

  it('后端答复「已生效」：不出现任何免责声明，并如实标注已生效', () => {
    render(
      <ParamSliders
        value={DEFAULT_PARAMS}
        onChange={() => {}}
        capabilities={report({ divergence: true, length: true, topn: true })}
      />,
    )

    expect(screen.getAllByText('已生效')).toHaveLength(3)
    expect(screen.getByTestId('param-divergence-support')).toHaveTextContent('已生效')
    expect(screen.getByTestId('param-length-support')).toHaveTextContent('已生效')
    // 反向断言：真实能力已具备时，任何「不生效」措辞都是假话
    expect(screen.queryByText(/待接入|未生效|未接入|不会改变结果/)).toBeNull()
    // 没有说明可读时不得挂一个指向空处的 aria-describedby
    for (const name of ['发散', '篇幅']) {
      expect(screen.getByRole('slider', { name }).getAttribute('aria-describedby')).toBeNull()
    }
  })

  it('后端答复「未生效」：如实标注未生效，并给出可被读屏引用的说明', () => {
    render(
      <ParamSliders
        value={DEFAULT_PARAMS}
        onChange={() => {}}
        capabilities={report({ divergence: false, length: false, topn: false })}
      />,
    )

    expect(screen.getAllByText('未生效')).toHaveLength(3)
    expect(screen.queryByText('已生效')).toBeNull()
    for (const name of ['发散', '篇幅']) {
      const el = screen.getByRole('slider', { name })
      const describedBy = el.getAttribute('aria-describedby')
      expect(describedBy).toBeTruthy()
      const note = document.getElementById(String(describedBy))
      expect(note).not.toBeNull()
      // 说明必须真的讲清「改了也不会生效」，而不只是一个空壳 id
      expect(note?.textContent ?? '').toMatch(/未生效/)
    }
  })

  it('能力未知（请求在飞）：中性标注，既不声称生效也不声称未生效', () => {
    render(
      <ParamSliders
        value={DEFAULT_PARAMS}
        onChange={() => {}}
        capabilities={report(null, { pending: true })}
      />,
    )

    expect(screen.queryByText('已生效')).toBeNull()
    expect(screen.queryByText('未生效')).toBeNull()
    expect(screen.getAllByText('待确认')).toHaveLength(3)
    // 中性态也要**可见**（宪法 §4.3 零静默失败）：写明正在确认，而不是留白
    expect(screen.getAllByText(/正在确认/)).toHaveLength(3)
  })

  it('能力确认失败：中性标注 + 可见原因，且不默认「已生效」', () => {
    render(
      <ParamSliders
        value={DEFAULT_PARAMS}
        onChange={() => {}}
        capabilities={report(null, { error: '无法连接服务端：Failed to fetch' })}
      />,
    )

    // 取不到答复时默认「已生效」是本缺陷最坏的修法：界面会重新开始撒谎
    expect(screen.queryByText('已生效')).toBeNull()
    expect(screen.queryByText('未生效')).toBeNull()
    expect(screen.getAllByText('待确认')).toHaveLength(3)
    expect(screen.getAllByText(/未能确认/)).toHaveLength(3)
    expect(screen.getAllByText(/Failed to fetch/)).toHaveLength(3)
  })

  it('答复里缺少某个参数时，该条单独保持「待确认」——绝不默认生效', () => {
    render(
      <ParamSliders
        value={DEFAULT_PARAMS}
        onChange={() => {}}
        capabilities={report({ divergence: true })}
      />,
    )

    // 逐条断言：标注必须挂在**它自己那个键**上（用计数断言会看不出挂错了谁）
    expect(screen.getByTestId('param-divergence-support')).toHaveTextContent('已生效')
    expect(screen.getByTestId('param-length-support')).toHaveTextContent('待确认')
    expect(screen.getByTestId('param-length-support')).not.toHaveTextContent('未生效')
    expect(screen.queryByText('未生效')).toBeNull()
  })

  it('/capabilities 按当前库取一次，标注随答复变化（切库重取）', async () => {
    stubWideViewport()
    const fetchMock = vi.fn((url: string) => {
      const target = String(url)
      if (target.startsWith('/capabilities')) {
        const mito = target.includes('lib=mito')
        return Promise.resolve(
          jsonResponse({
            lib: mito ? 'mito' : 'ai4s',
            params: mito
              ? { divergence: false, length: true, topn: false }
              : { divergence: true, length: true, topn: true },
          }),
        )
      }
      return Promise.resolve(sseResponse(DONE))
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)
    await waitFor(() => expect(screen.getAllByText('已生效')).toHaveLength(3))
    expect(callsTo(fetchMock, '/capabilities').map((c) => String(c[0]))).toEqual([
      '/capabilities?lib=ai4s',
    ])

    // 能力是**每库**的：切库必须重取，否则 mito 的界面会挂着 ai4s 的能力标注
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'mito' } })
    await waitFor(() => expect(screen.getAllByText('已生效')).toHaveLength(1))
    // mito 侧只剩 length 一项生效，另两项如实标未生效
    expect(screen.getAllByText('未生效')).toHaveLength(2)
    expect(callsTo(fetchMock, '/capabilities').map((c) => String(c[0]))).toEqual([
      '/capabilities?lib=ai4s',
      '/capabilities?lib=mito',
    ])
  })

  it('拖动后写入 PARAMS_KEY，重挂载后仍是拖动过的值', async () => {
    stubWideViewport()
    vi.stubGlobal('fetch', capabilityAwareFetch({ divergence: true, length: true, topn: true }, () => sseResponse(DONE)))
    const first = render(<App />)
    fireEvent.change(screen.getByRole('slider', { name: '发散' }), {
      target: { value: '1.8' },
    })
    fireEvent.change(screen.getByRole('slider', { name: '篇幅' }), {
      target: { value: '2800' },
    })

    await waitFor(() =>
      expect(params()).toEqual({ divergence: 1.8, length: 2800, topn: 10 }),
    )
    expect(JSON.parse(String(localStorage.getItem(PARAMS_KEY)))).toMatchObject({
      divergence: 1.8,
      length: 2800,
    })
    first.unmount()

    render(<App />)
    // 重挂载又会取一次能力（T49）：同样冲干净，避免 act 警告
    await act(async () => {})
    expect(screen.getByRole('slider', { name: '发散' })).toHaveValue('1.8')
    expect(screen.getByRole('slider', { name: '篇幅' })).toHaveValue('2800')
  })

  it('提交时请求体携带 params.divergence / length / topn', async () => {
    stubWideViewport()
    const fetchMock = capabilityAwareFetch({ divergence: true, length: true, topn: true }, () =>
      sseResponse('event: answer\ndata: {"delta":"答"}\n\n', DONE),
    )
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)
    fireEvent.change(screen.getByRole('slider', { name: '发散' }), {
      target: { value: '0.25' },
    })
    fireEvent.change(screen.getByRole('slider', { name: '篇幅' }), {
      target: { value: '1200' },
    })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '线粒体自噬' } })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })

    // 只数发往问答端点的请求：能力端点（T49 新增）也会用同一个 fetch 桩
    await waitFor(() => expect(callsTo(fetchMock, '/ask')).toHaveLength(1))
    const body = JSON.parse(String(callsTo(fetchMock, '/ask')[0][1]?.body))
    expect(body).toMatchObject({
      lib: 'ai4s',
      params: { divergence: 0.25, length: 1200, topn: 10 },
    })
    // 既有字段不得因新增 params 而丢失
    expect(body.messages).toEqual([{ role: 'user', content: '线粒体自噬' }])
  })
})
