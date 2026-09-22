import type { SseEvent } from './events'
import { KNOWN_EVENTS } from './events'

type KnownName = (typeof KNOWN_EVENTS)[number]

function isKnown(name: string): name is KnownName {
  return (KNOWN_EVENTS as readonly string[]).includes(name)
}

export async function* parseSse(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent> {
  const reader = stream.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // 归一化「缓冲」而非「分片」：跨片的 \r | \n 只有在拼接后才成对，
      // 逐片替换会漏掉它，导致 \r\n\r\n 帧分隔符不被识别、整帧被静默丢弃。
      // `\r\n` 的匹配互不重叠且替换幂等，重复扫描已归一化文本不会破坏已有结果。
      buffer = buffer.replace(/\r\n/g, '\n')

      let sep: number
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)

        let name: string | null = null
        let raw: string | null = null
        for (const line of block.split('\n')) {
          if (line.startsWith(':') || line.trim() === '') continue
          if (line.startsWith('event: ')) name = line.slice(7).trim()
          else if (line.startsWith('data: ')) raw = line.slice(6)
        }
        if (name === null || raw === null) continue
        if (!isKnown(name)) continue

        // 畸形 JSON 必须暴露，不得静默吞掉（宪法 §4.3 零静默失败）
        yield { event: name, data: JSON.parse(raw) } as SseEvent
      }
    }
  } finally {
    reader.releaseLock()
  }
}
