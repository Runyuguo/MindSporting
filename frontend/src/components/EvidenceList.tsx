import type { Hit } from '../lib/events'
import { EvidenceCard } from './EvidenceCard'

export function EvidenceList({
  hits,
  emptyLabel,
}: {
  hits: Hit[]
  emptyLabel?: string
}) {
  if (hits.length === 0) {
    if (!emptyLabel) return null
    return (
      <p className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-muted)]">
        {emptyLabel}
      </p>
    )
  }
  return (
    <section aria-label="检索证据">
      <h2 className="mb-2 text-xs tracking-wide text-[var(--color-muted)]">
        依据来源
      </h2>
      <ol className="flex flex-col gap-2">
        {hits.map((h, i) => (
          <EvidenceCard key={h.rowid} index={i + 1} hit={h} />
        ))}
      </ol>
    </section>
  )
}
