import { useCallback, useEffect, useRef, useState } from 'react'
import { DocError, fetchDoc, type Doc } from '../lib/doc'

export type DocState =
  | 'idle'
  | 'loading'
  | 'ready'
  /** 篇目在、请求成功，但**正文是空的**（Minor 复审）：不是失败，不是 `ready` 的正文。 */
  | 'empty'
  | 'missing'
  | 'denied'
  | 'error'

export interface DocController {
  state: DocState
  doc: Doc | null
  /** 失败原因（可见文案；零静默失败，宪法 §4.3）。 */
  error: string | null
  open: (lib: string, ref: string) => void
  close: () => void
}

/** 当前选中的篇目；`null`（含空 `ref`）表示未选中 → `idle`。 */
type DocRequest = { lib: string; ref: string }

export function useDoc(): DocController {
  const [request, setRequest] = useState<DocRequest | null>(null)
  const [state, setState] = useState<DocState>('idle')
  const [doc, setDoc] = useState<Doc | null>(null)
  const [error, setError] = useState<string | null>(null)

  /**
   * 唯一能写状态的东西的持有者。取数在 effect 里进行，清理函数夺走写权并 abort：
   * 「A 之后又点了 B」时 A 的迟到响应不得覆盖 B（控制器决议 1）。
   */
  const activeRef = useRef<{ id: number; controller: AbortController } | null>(null)
  const seqRef = useRef(0)

  useEffect(() => {
    // 没有选中篇目：回到中性提示态（close() / 空 ref 走这里）。
    if (request === null) {
      activeRef.current = null
      setState('idle')
      setDoc(null)
      setError(null)
      return
    }

    const id = ++seqRef.current
    const controller = new AbortController()
    activeRef.current = { id, controller }
    const isCurrent = () => activeRef.current?.id === id

    setState('loading')
    // 每次发起取数都先丢弃上一篇的正文：留着它在失败时会渲染出
    // 「旧篇目的正文 + 本篇目的错误」，比空白更容易误导。
    setDoc(null)
    setError(null)

    void (async () => {
      try {
        const next = await fetchDoc(request.lib, request.ref, controller.signal)
        if (!isCurrent()) return
        setDoc(next)
        setError(null)
        // 空/纯空白正文不是故障：篇目在、只是没有内容。给一个**独立**于 ready 的
        // 呈现态，避免把它谎报成「载入原文失败」（Minor 复审）。
        setState(next.content.trim() === '' ? 'empty' : 'ready')
      } catch (e) {
        // 已被新的选中或卸载取代（含 abort 抛出）：这一支不得写任何状态。
        if (!isCurrent()) return
        if (e instanceof DocError) {
          setError(e.message)
          setState(
            e.kind === 'missing'
              ? 'missing'
              : e.kind === 'denied'
                ? 'denied'
                : 'error',
          )
        } else {
          setError(e instanceof Error ? e.message : String(e))
          setState('error')
        }
      }
    })()

    return () => {
      // 夺走写权 + 中断在飞请求：迟到的响应/失败都到不了 setState。
      activeRef.current = null
      controller.abort()
    }
  }, [request])

  const open = useCallback((lib: string, ref: string) => {
    setRequest((prev) => {
      // 空 ref 与「没选中」等价，而不是去请求一个必然 400 的路径。
      if (ref.trim() === '') return null
      // 同一篇目重复点选不重新取数（控制器决议 3）；切库/换篇必须重新取。
      if (prev !== null && prev.lib === lib && prev.ref === ref) return prev
      return { lib, ref }
    })
  }, [])

  const close = useCallback(() => setRequest(null), [])

  return { state, doc, error, open, close }
}
