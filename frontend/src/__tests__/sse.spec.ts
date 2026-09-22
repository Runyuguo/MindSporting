import { describe, expect, it } from 'vitest'
import { parseSse } from '../lib/sse'
import type { SseEvent } from '../lib/events'

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(c) {
      for (const s of chunks) c.enqueue(enc.encode(s))
      c.close()
    },
  })
}

async function collect(s: ReadableStream<Uint8Array>): Promise<SseEvent[]> {
  const out: SseEvent[] = []
  for await (const e of parseSse(s)) out.push(e)
  return out
}

describe('parseSse', () => {
  it('parses a well-formed frame sequence', async () => {
    const evs = await collect(
      streamOf(
        'event: rewrite\ndata: {"query":"q","degraded":false}\n\n',
        'event: evidence\ndata: {"lib":"ai4s","query":"q","hits":[]}\n\n',
        'event: answer\ndata: {"delta":"你"}\n\n',
        'event: done\ndata: {}\n\n',
      ),
    )
    expect(evs.map((e) => e.event)).toEqual([
      'rewrite',
      'evidence',
      'answer',
      'done',
    ])
  })

  it('survives frames split across chunks', async () => {
    const evs = await collect(
      streamOf('event: ans', 'wer\ndata: {"del', 'ta":"x"}\n', '\nevent: done\ndata: {}\n\n'),
    )
    expect(evs.map((e) => e.event)).toEqual(['answer', 'done'])
    expect(evs[0].data).toEqual({ delta: 'x' })
  })

  it('ignores comment and heartbeat lines', async () => {
    const evs = await collect(
      streamOf(': ping\n\nevent: done\ndata: {}\n\n'),
    )
    expect(evs.map((e) => e.event)).toEqual(['done'])
  })

  it('throws on a malformed JSON payload rather than silently dropping', async () => {
    await expect(
      collect(streamOf('event: answer\ndata: {broken\n\n')),
    ).rejects.toThrow()
  })

  it('ignores unknown event names rather than mis-typing them', async () => {
    const evs = await collect(
      streamOf('event: future\ndata: {"x":1}\n\nevent: done\ndata: {}\n\n'),
    )
    expect(evs.map((e) => e.event)).toEqual(['done'])
  })

  // 契约决定：帧分隔符 CRLF 与 LF 等价（SSE 规范把 \r\n / \n / \r 都算行终止符），
  // 因为中间代理或服务端换行风格可能把 \n\n 改写成 \r\n\r\n。
  // 注意这不会放宽 data 载荷契约：真正的畸形 JSON 仍然照旧抛出。
  it('treats CRLF frame separators as equivalent to LF', async () => {
    const evs = await collect(
      streamOf(
        'event: answer\r\ndata: {"delta":"x"}\r\n\r\n',
        'event: done\r\ndata: {}\r\n\r\n',
      ),
    )
    expect(evs.map((e) => e.event)).toEqual(['answer', 'done'])
    expect(evs[0].data).toEqual({ delta: 'x' })
  })

  // 上一版按「分片」而不是「缓冲」做 CRLF 归一化，漏掉了 \r 收尾一片、\n 起头一片的
  // 跨片 CRLF：这对字符永远拼不回同一片，于是 \r\n\r\n 不被认作帧分隔符，
  // 整帧事件被静默丢弃（宪法 §4.3 零静默失败）。
  it('treats a CRLF pair split across chunks as a frame separator', async () => {
    const evs = await collect(
      streamOf(
        'event: answer\r\ndata: {"delta":"a"}\r\n\r', // 片尾悬空 \r
        '\nevent: done\r\ndata: {}\r\n\r\n', // 片头 \n 与其拼成 \r\n
      ),
    )
    expect(evs.map((e) => e.event)).toEqual(['answer', 'done'])
    expect(evs[0].data).toEqual({ delta: 'a' })
  })
})

// ---- T44: 003 新增事件（reasoning / notice / stage） -------------------------
// `parseSse` 对未知事件名 `continue`（静默丢弃）。后端 T40/42/43 已emit 这三种事件，
// 若 `KNOWN_EVENTS` 不同步扩展，它们会被**静默丢掉且不报任何错** —— 等待期又变成
// 一片空白，正是宪法 §4.3 禁止的静默失败。`collect` / `streamOf` 沿用本文件既有辅助。
describe('003 新增事件', () => {
  it('reasoning 事件被识别并透出', async () => {
    const out = await collect(streamOf('event: reasoning\ndata: {"delta":"想"}\n\n'))
    expect(out.map((e) => e.event)).toContain('reasoning')
  })

  it('notice 与 stage 事件被识别', async () => {
    const out = await collect(
      streamOf(
        'event: notice\ndata: {"message":"未达标"}\n\n',
        'event: stage\ndata: {"name":"evidence","elapsed_ms":42}\n\n',
      ),
    )
    expect(out.map((e) => e.event)).toEqual(['notice', 'stage'])
  })

  it('未知事件仍被安全忽略（回归）', async () => {
    const out = await collect(streamOf('event: totally-unknown\ndata: {"x":1}\n\n'))
    expect(out).toHaveLength(0)
  })
})
