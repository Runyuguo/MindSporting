import type { Hit } from '../lib/events'

export const SOURCE_LABELS: Record<string, string> = {
  metadata: '摘要库',
  pdf: 'PDF 全文',
  weekly: '周报候选',
  'vault:survey': '综述',
  'vault:reading': '精读',
  'vault:note': '文献笔记',
  'vault:moc': '索引',
  'vault:ocr': 'OCR 原文',
}

/**
 * 非 vault 来源的 `ref` **不是** vault 相对 `.md` 路径（`metadata`/`weekly` 是 PMID，
 * `pdf` 是 txt 文件名），而 `/doc` 只接受 vault 内的 `.md`。把它们当可读原文去点，
 * 只会得到 400「该路径不在本库范围内」——那是**事实错误**：篇目并不越界，只是没有
 * 可读原文。故这里如实说明，且不给可点入口（I2；后端契约不变）。
 *
 * 这句只在**有选择器**（`onSelect`）的上下文里出现：那里非 vault 卡与 vault 卡确有
 * 「无入口 / 有入口」之别，说明是在解释这个差别。只读上下文（`EvidenceList` 内联列表）
 * 里两类卡同样不可点，挂它等于凭空造出一个入口差异（定点复审 Minor）。
 */
export const NO_ORIGINAL_HINT = '该来源没有可读原文（仅摘要 / PDF 元数据）'

/**
 * 该命中是否有**可读原文**（`/doc` 取得到的那一篇）。
 * 判据就是 `source` 前缀：只有 `vault:*` 的 `ref` 是 vault 相对 `.md` 路径。
 */
export function hasReadableOriginal(hit: Pick<Hit, 'source'>): boolean {
  return hit.source.startsWith('vault:')
}

export function EvidenceCard({
  index,
  hit,
  selected = false,
  selectable,
  onSelect,
}: {
  index: number
  hit: Hit
  /** 选中态（文献卡正在展示这一条）。 */
  selected?: boolean
  /**
   * 是否可点选；缺省 = 由 `source` 推断（`vault:*` 可点，其余没有可读原文）。
   * 显式传入只用于测试或将来别的来源约定，生产路径一律走推断。
   */
  selectable?: boolean
  /** 传入即变为可点选；不传则保持只读（EvidenceList 内联渲染仍走这条路径）。 */
  onSelect?: (hit: Hit) => void
}) {
  const label = SOURCE_LABELS[hit.source] ?? hit.source
  const readable = selectable ?? hasReadableOriginal(hit)
  const body = (
    <>
      <div className="mb-1 flex items-baseline gap-2">
        <span className="tabular text-xs text-[var(--color-accent)]">
          [{index}]
        </span>
        <span className="rounded-sm border border-[var(--color-border)] px-1.5 py-0.5 text-xs text-[var(--color-muted)]">
          {label}
        </span>
        <span className="text-sm font-medium">{hit.title}</span>
      </div>
      <p className="mb-1 line-clamp-3 text-xs text-[var(--color-muted)]">
        {hit.snippet}
      </p>
      <p className="truncate text-xs text-[var(--color-muted)]">{hit.extra || hit.ref}</p>
      {/* 「没有可读原文」只在**有选择器**的上下文里给：只有那里才存在「能点 / 不能点」
          的入口差异（vault 卡有入口、非 vault 卡没有）可解释。只读内联列表（`EvidenceList`）
          里两类卡同样点不开，单给非 vault 卡挂这句会读出一个并不存在的差异。 */}
      {onSelect !== undefined && !readable && (
        <p className="mt-1 text-xs text-[var(--color-muted)]">{NO_ORIGINAL_HINT}</p>
      )}
    </>
  )
  return (
    <li
      className={`rounded-md border bg-[var(--color-panel)] p-3 ${
        selected ? 'border-[var(--color-accent)]' : 'border-[var(--color-panel-border)]'
      }`}
    >
      {onSelect && readable ? (
        // 可点选时用真正的 button：键盘可达，且 aria-pressed 让选中态可被读出。
        <button
          type="button"
          aria-pressed={selected}
          onClick={() => onSelect(hit)}
          className="block w-full cursor-pointer text-left transition-colors duration-[var(--duration-fast)]"
        >
          {body}
        </button>
      ) : (
        body
      )}
    </li>
  )
}
