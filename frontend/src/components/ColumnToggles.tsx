import { COLUMN_LABEL, COLUMN_ORDER, type ColumnKey, type Layout } from '../lib/layout'

interface Props {
  layout: Layout
  onToggle: (key: ColumnKey) => void
}

/**
 * 标题后的四个栏开关（spec「栏开关」）。
 *
 * 两条硬约束：
 * 1. **恒在且顺序固定**——包括 <1280px 窄视口（spec C-2：关掉的栏只能靠它们恢复，
 *    隐藏按钮等于让人无法恢复）；
 * 2. **对话栏的开关禁用**——它不可关闭（spec C-4），按钮可点却无效果会是失信状态。
 *
 * 名称与顺序取自 `COLUMN_LABEL` / `COLUMN_ORDER`（与分隔线的可访问名同一份映射），
 * 不在这里另写一套中文；`aria-pressed` 与栏的 `open` 同源，故开关状态与栏的开合
 * 不可能各说一套。
 */
export default function ColumnToggles({ layout, onToggle }: Props) {
  return (
    <div className="flex items-center gap-2">
      {COLUMN_ORDER.map((key) => (
        <button
          key={key}
          type="button"
          aria-label={COLUMN_LABEL[key]}
          aria-pressed={layout[key].open}
          disabled={key === 'chat'}
          title={key === 'chat' ? '对话栏是必需栏，不可关闭' : undefined}
          onClick={() => onToggle(key)}
          className="rounded-sm border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-muted)] transition-colors duration-[var(--duration-fast)] hover:text-[var(--color-fg)] disabled:opacity-50"
        >
          {COLUMN_LABEL[key]}
        </button>
      ))}
    </div>
  )
}
