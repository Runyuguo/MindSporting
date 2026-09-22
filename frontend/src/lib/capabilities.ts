/**
 * 生成参数能力端点 `GET /capabilities` 的薄封装（T49 验收 Defect 1）。
 *
 * 后端契约（`server/http_server.py::capabilities`）：
 * - `GET /capabilities?lib=<ai4s|mito>`（缺省 `ai4s`，与 `/search`、`/doc` 一致）
 * - 200 → `{ lib, params: { divergence: boolean, length: boolean } }`
 *   取值来自本库配置的 `generate` 区块（`rag_core/params.py::is_supported`）
 * - 400 → `{ error }`（lib 非法；与 /doc、/ask/stream 同形）
 *
 * 为什么要有这一层：界面**不得**写死「这两项是否生效」—— spec
 * §「参数不被支持时的如实性」要求标注随**真实能力**变化，plan §2.2(d) 把它写成
 * 「由后端能力驱动」。能力只有两个来源：后端答复，或者猜。猜出来的标注必然有一天会变成假话
 * （本缺陷就是写死「未生效」而实际已生效）。
 *
 * 因此本模块的职责是**三态**而不是布尔：已生效 / 未生效 / **未确认**。
 * 「未确认」（请求在飞、失败、或答复里没有这个参数）必须是一等状态：
 * 此时界面既不能说它生效，也不能说不生效 —— 那两种默认都是在替使用者下结论。
 */

/** 参数 id → 后端是否**真的**会采纳它。键与 `rag_core/params.py::is_supported` 一一对应。 */
export type ParamCapabilities = Record<string, boolean>

/** 单条参数在界面上的支持状态。`unknown` **不是**「不支持」，而是「还不知道」。 */
export type ParamSupport = 'supported' | 'unsupported' | 'unknown'

/** 后端能力答复 + 本次确认过程的状态。 */
export interface CapabilityReport {
  /** 已取到的能力答复；`null` = **尚未确认**（请求在飞、或已失败）。 */
  params: ParamCapabilities | null
  /** 确认失败的原因（可见文案；零静默失败，宪法 §4.3）。`null` = 没有失败。 */
  error: string | null
  /** 仍在确认中（决定中性文案说「正在确认」还是「未能确认」）。 */
  pending: boolean
}

/**
 * 尚未确认时的报告（组件默认值、以及「滑杆不在屏上」时的状态）。
 *
 * 冻结的是这个对象本身，防止调用方就地改写它而让别处的默认值跟着变。
 * **不要**把它读成「都不支持」：那是另一种无据的断言。
 */
export const UNCONFIRMED: CapabilityReport = Object.freeze({
  params: null,
  error: null,
  pending: false,
})

/** `network` 请求根本没到服务端；`server` 到了但答复不可用（非 2xx / 非 JSON / 形状不对）。 */
export type CapabilityErrorKind = 'network' | 'server'

export class CapabilityError extends Error {
  readonly kind: CapabilityErrorKind
  readonly status: number | null

  constructor(kind: CapabilityErrorKind, message: string, status: number | null = null) {
    super(message)
    this.name = 'CapabilityError'
    this.kind = kind
    this.status = status
  }
}

/**
 * 服务端错误体的解析：400 也是 `{"error": "..."}`，但**不能假定它可解析**
 * （网关/代理可能插入 HTML 错误页）。解析失败时退化为按状态码表述，
 * 绝不让「读错误体失败」本身变成一次静默失败。
 *
 * 与 `lib/doc.ts::reasonFrom` 同规则但各自持有：两者是**不同端点**的状态契约，
 * 合并成一个共享工具会把「取文失败」与「能力确认失败」的文案绑在一起。
 */
async function reasonFrom(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json()
    const reason = (body as { error?: unknown } | null)?.error
    if (typeof reason === 'string' && reason.trim() !== '') return reason
  } catch {
    // 体不是 JSON：下面按状态码给出稳定文案。
  }
  return `服务端返回 HTTP ${res.status}`
}

/**
 * 形状校验：`params` 必须是一个「值全为布尔」的对象。
 *
 * 不在这里补默认值、也不把非布尔值强转成布尔 —— 那样等于把「答复不可用」伪装成
 * 「能力已确认」。宁可让调用方落到 `unknown`，也不能编一个能力出来。
 */
function parseCapabilities(body: unknown): ParamCapabilities {
  const params = (body as { params?: unknown } | null)?.params
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new CapabilityError('server', '服务端返回的能力答复缺少 params 对象')
  }
  const out: ParamCapabilities = {}
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    if (typeof value !== 'boolean') {
      throw new CapabilityError('server', `服务端返回的能力取值不是布尔：${key}`)
    }
    out[key] = value
  }
  return out
}

/**
 * 取本库的生成参数能力。失败一律抛 `CapabilityError`（带可读原因）；
 * 被主动取消（`signal.aborted`）时原样抛出，由调用方按 aborted 区分，不当成故障。
 */
export async function fetchCapabilities(
  lib: string,
  signal?: AbortSignal,
): Promise<ParamCapabilities> {
  const query = new URLSearchParams({ lib })

  let res: Response
  try {
    res = await fetch(`/capabilities?${query.toString()}`, { signal })
  } catch (e) {
    if (signal?.aborted) throw e
    const detail = e instanceof Error ? e.message : String(e)
    throw new CapabilityError('network', `无法连接服务端：${detail}`)
  }

  if (!res.ok) throw new CapabilityError('server', await reasonFrom(res), res.status)

  let body: unknown
  try {
    body = await res.json()
  } catch {
    // 200 却不是 JSON —— 契约被破坏（Vite 的 SPA 回退就会给出 HTML）。
    throw new CapabilityError('server', `服务端返回的答复不是 JSON（HTTP ${res.status}）`, res.status)
  }
  return parseCapabilities(body)
}

/**
 * 把「答复 + 确认过程」翻译成某条参数的三态。
 *
 * 判据刻意写成白名单式：**只有**答复里明确写着 `true`/`false` 才断言；
 * 其余（答复未取到、键缺失、值不是布尔）一律 `unknown`。
 * 反过来的写法（`=== false ? 'unsupported' : 'supported'`）会把
 * 「还没取到答复」默认成「已生效」—— 界面会重新开始撒谎。
 */
export function supportOf(report: CapabilityReport, key: string): ParamSupport {
  const value = report.params?.[key]
  if (value === true) return 'supported'
  if (value === false) return 'unsupported'
  return 'unknown'
}
