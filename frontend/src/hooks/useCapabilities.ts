import { useEffect, useState } from 'react'
import {
  UNCONFIRMED,
  fetchCapabilities,
  type CapabilityReport,
} from '../lib/capabilities'

/**
 * 取当前库的生成参数能力（`GET /capabilities`），供滑杆如实标注。
 *
 * `lib` 变化时重取：能力是**每库**的（各自的 `config_<lib>.json` 有自己的 `generate`
 * 区块），沿用上一个库的答复会让 mito 的界面挂着 AI4S 的能力标注。
 *
 * `enabled=false`（滑杆不在屏上，例如窄视口或功能栏被折叠）时**连请求都不发**：
 * 没有需要标注的东西，就不去问。此时返回 `UNCONFIRMED`，界面不会替后端下任何结论。
 *
 * 三种结果都**如实**落到报告里（零静默失败，宪法 §4.3）：
 * 取到 → `params` 有值；失败 → `params=null` + `error` 有原因（界面显示「未能确认…」，
 * 而不是把失败悄悄当成「不支持」）；在飞 → `pending=true`（界面显示「正在确认…」）。
 */
export function useCapabilities(lib: string, enabled: boolean): CapabilityReport {
  const [report, setReport] = useState<CapabilityReport>(UNCONFIRMED)

  useEffect(() => {
    if (!enabled) {
      setReport(UNCONFIRMED)
      return
    }

    const controller = new AbortController()
    // 「这份结果还算不算数」的持有者：切库/卸载后迟到的答复不得写状态，
    // 否则 A 库的答复会盖在 B 库的界面上（useDoc 用同一套写法）。
    let current = true
    setReport({ params: null, error: null, pending: true })

    void (async () => {
      try {
        const params = await fetchCapabilities(lib, controller.signal)
        if (!current) return
        setReport({ params, error: null, pending: false })
      } catch (e) {
        // 被取代或主动取消：这一支不得写状态 —— 把「切库」记成「确认失败」是错误归因。
        if (!current || controller.signal.aborted) return
        setReport({
          params: null,
          error: e instanceof Error ? e.message : String(e),
          pending: false,
        })
      }
    })()

    return () => {
      current = false
      controller.abort()
    }
  }, [lib, enabled])

  return report
}
