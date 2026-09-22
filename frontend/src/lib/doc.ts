/**
 * 只读取文接口 `/doc` 的薄封装（`plan.md` §12.3）。
 *
 * 后端契约（T26 已实现并验收）：
 * - `GET /doc?lib=<ai4s|mito>&ref=<vault 相对路径>`
 * - 200 → `{ lib, ref, title, content, mtime }`（`ref` 回显为规范化 POSIX 形式，
 *   入参里的 `\` 会变成 `/`，故**以响应字段为准**，不要逐字节比对原始入参）
 * - 400 → `ref` 非法（缺失/空 / 绝对路径 / 含 `..` / 非 `.md` / 解析后越界）或 `lib` 非法
 * - 404 → 篇目在 vault 内不存在（或是个目录）
 * - 500 → 篇目**存在**但服务端读不了（非 UTF-8 / 权限）——服务端故障，不是内容缺失
 *
 * 三种失败各有独立的 `kind`，让调用方能分别呈现不同文案（`missing` 与 `denied`
 * 必须可区分，`plan.md` §12.3）。零静默失败（宪法 §4.3）：任何一条**失败**路径都抛出
 * 带可读原因的错误；而 **200 + 空正文不属于失败** —— 篇目在、请求成功，只是它本身没有
 * 内容，原样返回，由 `useDoc` 落到独立的 `empty` 态（见下方 `fetchDoc` 的说明）。
 */

export interface Doc {
  lib: string
  ref: string
  title: string
  content: string
  mtime: number
}

/**
 * `missing` 篇目不存在（404）；`denied` 请求被拒（400，路径不合法/越界）；
 * `server` 服务端故障（500）；`network` 请求根本没到服务端。
 */
export type DocErrorKind = 'missing' | 'denied' | 'server' | 'network'

export class DocError extends Error {
  readonly kind: DocErrorKind
  readonly status: number | null

  constructor(kind: DocErrorKind, message: string, status: number | null = null) {
    super(message)
    this.name = 'DocError'
    this.kind = kind
    this.status = status
  }
}

/**
 * 服务端错误体的解析：400/404/500 都是 `{"error": "..."}`，但**不能假定它可解析**
 * （网关/代理可能插入 HTML 错误页）。解析失败时退化为按状态码表述，绝不让
 * 「读错误体失败」本身变成一次静默失败。
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

function errorFor(status: number, reason: string): DocError {
  if (status === 404) return new DocError('missing', reason, 404)
  if (status === 400) return new DocError('denied', reason, 400)
  return new DocError('server', reason, status)
}

/**
 * 取一篇原文。`ref` 走 `URLSearchParams`（空格→`+`、`/`→`%2F`、CJK→UTF-8 百分号编码），
 * 服务器按 URL 解码后取回的原值与入参一字不差。
 *
 * **`content` 字段缺失/非字符串**才算失败（`DocError('server')`）：契约被破坏，拿不到可用正文。
 * 而 **200 + 空/纯空白正文不是失败**——篇目在、请求成功，只是它本身没有内容；
 * 这种情形原样返回，由 `useDoc` 落到独立的 `empty` 态、`DocPanel` 用「空文档」呈现。
 * 把它当故障（旧行为）等于把「文档是空的」谎报成「载入原文失败」，是**不诚实的错误归因**。
 */
export async function fetchDoc(
  lib: string,
  ref: string,
  signal?: AbortSignal,
): Promise<Doc> {
  const query = new URLSearchParams({ lib, ref })

  let res: Response
  try {
    res = await fetch(`/doc?${query.toString()}`, { signal })
  } catch (e) {
    // 被主动取消不是故障：原样抛出，由调用方按 aborted 区分（不得当成 error 态）。
    if (signal?.aborted) throw e
    const detail = e instanceof Error ? e.message : String(e)
    throw new DocError('network', `无法连接服务端：${detail}`)
  }

  if (!res.ok) {
    throw errorFor(res.status, await reasonFrom(res))
  }

  const body: unknown = await res.json()
  const record = (body ?? {}) as Partial<Doc>
  if (typeof record.content !== 'string') {
    // 200 却没有正文字段 —— 契约被破坏，谎报成功会让面板显示空白页（静默失败）。
    throw new DocError('server', '服务端返回的正文缺失或格式不正确', res.status)
  }

  return {
    lib: typeof record.lib === 'string' ? record.lib : lib,
    ref: typeof record.ref === 'string' ? record.ref : ref,
    title: typeof record.title === 'string' ? record.title : '',
    content: record.content,
    mtime: typeof record.mtime === 'number' ? record.mtime : 0,
  }
}
