/**
 * 多对话数据模型（纯函数，无 React 依赖）。
 *
 * 键位（`plan.md` §12.2）：
 *   `ragqa:conv:<lib>`    → Conversation[]，两库各自独立
 *   `ragqa:current:<lib>` → 当前选中对话 id
 *   `ragqa:params`        → { divergence: number; length: number }，全局
 *   `ragqa:legacy-backup` → 旧扁平键的原始值备份 + migratedAt
 *
 * 降级原则与 `lib/storage.ts` 一致：`localStorage` 不可用、配额满或数据损坏时
 * 静默退化为「无持久化」，绝不把异常抛到 React。
 */
import type { Hit } from './events'
import type { Message } from './storage'

export interface Conversation {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: Message[]
  /** 轮次序号（messages 中第 n 条 user 消息，0 起）→ 该轮命中。 */
  evidenceByRound: Record<number, Hit[]>
  /**
   * 本轮思考摘要（003）。旧数据没有该字段，**必须保持可选**，
   * 也不进 `isConversation` 守卫 —— 否则升级一次就把既有会话全判为形状不符而丢弃。
   */
  reasoningSummary?: string
  /** 本轮思考耗时（毫秒，来自服务端 `stage` 事件）。同样可选。 */
  reasoningMs?: number
}

const convKey = (lib: string) => `ragqa:conv:${lib}`
const currentKey = (lib: string) => `ragqa:current:${lib}`

export const PARAMS_KEY = 'ragqa:params'
export const LEGACY_BACKUP_KEY = 'ragqa:legacy-backup'

export interface QaParams {
  divergence: number
  length: number
  /** 交给检索的证据条数（`topn`）。2026-09-19 由使用者新增：8 条太少，要可调。 */
  topn: number
}

export const DEFAULT_PARAMS: QaParams = { divergence: 1, length: 1500, topn: 10 }

/**
 * 三条生成参数的范围与步长（`plan.md` §12.5）。**唯一真值来源**：
 * 界面文案与范围都在这里，`ParamSliders`（控件属性）、`useChat`（请求体）与
 * `params.spec.tsx`（断言）都从这里取 —— 三处各写一份必然漂移。
 *
 * `divergence`（发散）/ `length`（篇幅）/ `topn`（证据数）。
 * （相关性与证据数曾被移除，2026-09-19 使用者要求**证据数**回归可调。）
 *
 * 范围口径：`divergence` 0–2、`length` 1000–5000 字（2026-09-19 使用者指定）、
 * `topn` 10–30 条（同）。`length` 的下限抬高后，请求体里的篇幅契约不会低于 1000 字，
 * 与「目标刻意选在自然长度两侧以暴露告知机制」的调试口径不再冲突（那是测试时才需要）。
 *
 * **是否生效不在这里判定**（T49 修复）：这三项由后端真正采纳，界面原先写死的
 * 「待接入」是假话。生效与否唯一来源于后端能力答复（`GET /capabilities` →
 * `lib/capabilities.ts::supportOf`），此处只留范围与默认值。
 */
export const PARAM_RANGES = {
  divergence: { min: 0, max: 2, step: 0.05 },
  length: { min: 1000, max: 5000, step: 50 },
  topn: { min: 10, max: 30, step: 1 },
} as const

type ParamRange = (typeof PARAM_RANGES)[keyof typeof PARAM_RANGES]

function clampOne(raw: unknown, range: ParamRange, fallback: number): number {
  // 非有限数（NaN / Infinity / 非 number）回落到默认值：NaN 会被 JSON 序列化成
  // null 送进请求体，那是一个「有参数却等于没给」的静默畸形。
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback
  return Math.min(range.max, Math.max(range.min, raw))
}

/** 夹紧到合法区间；缺失或非有限数回落到 `DEFAULT_PARAMS` 对应字段。 */
export function clampParams(value: unknown): QaParams {
  const raw = (value ?? {}) as Partial<QaParams>
  return {
    divergence: clampOne(raw.divergence, PARAM_RANGES.divergence, DEFAULT_PARAMS.divergence),
    length: clampOne(raw.length, PARAM_RANGES.length, DEFAULT_PARAMS.length),
    topn: clampOne(raw.topn, PARAM_RANGES.topn, DEFAULT_PARAMS.topn),
  }
}

/** 写入侧的收口：落盘前一律夹紧，`localStorage` 里不会出现越界值。 */
export function saveParams(value: QaParams): void {
  try {
    localStorage.setItem(PARAMS_KEY, JSON.stringify(clampParams(value)))
  } catch {
    // 同 saveConversations：配额满或隐私模式下静默失败；本次会话仍可用
  }
}

/** 空对话（无首条 user 消息）使用的占位标题。 */
export const EMPTY_TITLE = '新对话'

/** 标题长度上限：首条 user 消息的前 24 字。 */
export const TITLE_MAX = 24

export type LegacyBackup = {
  ai4s?: unknown
  mito?: unknown
  migratedAt?: number
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 与 `storage.ts` 的私有守卫同规则；此处内联以免改动既有模块的导出面。 */
function isMessage(v: unknown): v is Message {
  if (!isRecord(v)) return false
  return (v.role === 'user' || v.role === 'assistant') && typeof v.content === 'string'
}

function isHit(v: unknown): v is Hit {
  if (!isRecord(v)) return false
  return typeof v.rowid === 'number' && typeof v.ref === 'string' && typeof v.title === 'string'
}

/**
 * 按轮依据的形状校验。
 *
 * **缺字段放行、值畸形拒绝**：`evidenceByRound` 是后加的字段，缺了它的旧条目是
 * 合法的历史数据（语义上等于「还没有任何轮次的命中」），整条丢掉就是静默数据丢失；
 * 而写坏的值（如 `{0: [{rowid:'no'}]}`）仍必须拒绝，否则畸形数据会流进渲染层。
 */
function hasValidEvidenceByRound(v: unknown): boolean {
  if (v === undefined) return true
  if (!isRecord(v)) return false
  for (const value of Object.values(v)) {
    if (!Array.isArray(value) || !value.every(isHit)) return false
  }
  return true
}

/**
 * 条目守卫：只把**不可修复**的残缺挡在外面。
 *
 * `createdAt` / `updatedAt` / `evidenceByRound` 都是**后加**的字段。早期版本的会话
 * 没有它们，整条丢弃就是静默数据丢失（用户的提问与答案会凭空消失）；而它们都可以
 * 就地补出一个诚实的中性值（时间未知 → 0=最早；无按轮依据 → {}），故这里放行，
 * 由 `normalizeConversation` 补齐。
 *
 * 真正不可修复的是 `id` / `title` / `messages`：缺了它们这条记录没有任何可用内容，
 * 补出来的也是伪造物，故仍然拒绝（既有用例「丢弃残破条目」钉住这一点）。
 */
function isConversation(v: unknown): boolean {
  if (!isRecord(v)) return false
  return (
    typeof v.id === 'string' &&
    typeof v.title === 'string' &&
    Array.isArray(v.messages) &&
    v.messages.every(isMessage) &&
    (v.createdAt === undefined || typeof v.createdAt === 'number') &&
    (v.updatedAt === undefined || typeof v.updatedAt === 'number') &&
    hasValidEvidenceByRound(v.evidenceByRound)
  )
}

/**
 * 把通过守卫的条目补成完整的 `Conversation`。
 *
 * 缺失的时间补 0 而非 `Date.now()`：`HistoryList` 按 `updatedAt` 倒序排列，0 让它
 * 沉到列表末尾（未知 = 最早），而掐一个「现在」会让一条陈年旧会话冒充最新。
 * 不编造任何未知信息，是这里选 0 的唯一理由。
 */
function normalizeConversation(v: Record<string, unknown>): Conversation {
  const conversation = v as unknown as Conversation
  return {
    ...conversation,
    createdAt: conversation.createdAt ?? 0,
    updatedAt: conversation.updatedAt ?? 0,
    evidenceByRound: conversation.evidenceByRound ?? {},
  }
}

/** 首条 user 问题折叠空白后取前 24 字；无内容时返回占位标题。 */
export function titleFrom(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat === '' ? EMPTY_TITLE : flat.slice(0, TITLE_MAX)
}

/**
 * 生成一个 v4 UUID。
 *
 * `crypto.randomUUID` **只在安全上下文存在**：部署形态是局域网明文 HTTP
 * （`isSecureContext === false`），此时它是 `undefined`，直接调用会让 React 挂载即崩、
 * 整页白屏（004 C-12 的发布阻断缺陷；本机 `localhost` 是安全上下文，故开发期不暴露）。
 * `crypto.getRandomValues` 在非安全上下文**仍可用**，故缺失时按其字节手工拼一个 v4 UUID
 * —— 这是代码缺陷的修复，不是环境限制的回避。
 */
function randomUuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40 // RFC 4122：版本位 = 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80 // RFC 4122：变体位 = 10xx
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function createConversation(): Conversation {
  const now = Date.now()
  return {
    id: randomUuid(),
    title: EMPTY_TITLE,
    createdAt: now,
    updatedAt: now,
    messages: [],
    evidenceByRound: {},
  }
}

export function loadConversations(lib: string): Conversation[] {
  try {
    const raw = localStorage.getItem(convKey(lib))
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter(isConversation).map((c) => normalizeConversation(c as Record<string, unknown>))
      : []
  } catch {
    return [] // 存储损坏或不可用时降级为空，不阻断应用启动
  }
}

export function saveConversations(lib: string, list: Conversation[]): void {
  try {
    localStorage.setItem(convKey(lib), JSON.stringify(list))
  } catch {
    // 配额满或隐私模式下静默失败；会话仍可用，只是刷新后不保留
  }
}

/** 失效的 id（不在列表内，或列表为空）不返回，避免悬空选中。 */
export function loadCurrentId(lib: string): string | null {
  const list = loadConversations(lib)
  if (list.length === 0) return null
  try {
    const raw = localStorage.getItem(currentKey(lib))
    if (raw && list.some((c) => c.id === raw)) return raw
  } catch {
    // 读不到就当从未选中，回退到首条
  }
  return list[0].id
}

export function saveCurrentId(lib: string, id: string): void {
  try {
    localStorage.setItem(currentKey(lib), id)
  } catch {
    /* 同 saveConversations */
  }
}

export function params(): QaParams {
  // 读取侧同样夹紧：存储里的人为越界值（或早期版本写坏的形状）不得流进请求体。
  return clampParams(readParams())
}

function readParams(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(PARAMS_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function wasMigrated(): boolean {
  try {
    const raw = localStorage.getItem(LEGACY_BACKUP_KEY)
    if (!raw) return false
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) && typeof parsed.migratedAt === 'number'
  } catch {
    return false // 备份损坏视为未迁移，允许重新搬移
  }
}

/**
 * 把旧扁平键 `ragqa:<lib>` 原样搬入 `ragqa:legacy-backup` 后删除原键。
 *
 * 顺序保证（`plan.md` §12.2）：备份先落地，**再**删原键。备份写入失败或读取
 * 失败时原键一律保持不动，且不写 `migratedAt`，留待下次调用重试；只有备份
 * 已持久化后才进入删除阶段，因此任何一步失败都不会丢掉未被备份的数据。
 *
 * 幂等：以备份中是否存在 `migratedAt` 为判据，第二次调用不再搬移。
 * 只操作 `localStorage`，不触碰 vault 或任何非浏览器数据。
 */
export function migrateLegacyKeys(): void {
  try {
    if (wasMigrated()) return

    const legacyLibs = ['ai4s', 'mito'] as const
    const raws: Partial<Record<(typeof legacyLibs)[number], string>> = {}
    for (const lib of legacyLibs) {
      const raw = localStorage.getItem(`ragqa:${lib}`)
      if (raw === null) continue // 合法旧值 '' 照搬
      raws[lib] = raw
    }

    const backup: LegacyBackup = { ...raws, migratedAt: Date.now() }
    try {
      localStorage.setItem(LEGACY_BACKUP_KEY, JSON.stringify(backup))
    } catch {
      return // 备份未落地：原键保持不动，migratedAt 未记 → 下次重试
    }

    for (const lib of legacyLibs) {
      if (raws[lib] === undefined) continue // 没搬走的键不删
      try {
        localStorage.removeItem(`ragqa:${lib}`)
      } catch {
        // 备份已在手，删不掉最多残留一个旧键，不构成数据丢失
      }
    }
  } catch {
    // 存储不可用时整步退化为 no-op，不阻断启动
  }
}
