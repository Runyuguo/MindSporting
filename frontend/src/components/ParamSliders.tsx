import {
  UNCONFIRMED,
  supportOf,
  type CapabilityReport,
  type ParamSupport,
} from '../lib/capabilities'
import {
  PARAM_RANGES,
  clampParams,
  type QaParams,
} from '../lib/conversations'

/**
 * 三条参数的界面文案。`unit` **不写死范围**，而是由 `PARAM_RANGES` 生成 ——
 * 范围是唯一真值源，手写一遍必然漂移（本轮把篇幅从 500–3000 改成 1000–5000 时，
 * 若是硬编码文案，漏改一处就会出现"滑杆能拖到 5000 但写着 3000"。
 */
const FIELDS: {
  key: keyof QaParams
  label: string
  unit: string
}[] = [
  { key: 'divergence', label: '发散', unit: `${PARAM_RANGES.divergence.min}–${PARAM_RANGES.divergence.max}` },
  { key: 'length', label: '篇幅', unit: `${PARAM_RANGES.length.min}–${PARAM_RANGES.length.max} 字` },
  { key: 'topn', label: '证据数', unit: `${PARAM_RANGES.topn.min}–${PARAM_RANGES.topn.max} 条` },
]

/**
 * 三种支持状态各自的标注（文案与配色同处一表，避免两处各写一份而漂移）。
 *
 * 「已生效 / 未生效」都只在**确实知道**时才出现；不知道时是中性的一档，
 * 既不声称生效也不声称未生效（spec「参数不被支持时的如实性」的全部要点）。
 */
const BADGE: Record<ParamSupport, { text: string; tone: string }> = {
  supported: {
    text: '已生效',
    tone: 'border-[var(--color-success)] text-[var(--color-success)]',
  },
  unsupported: {
    text: '未生效',
    tone: 'border-[var(--color-warning)] text-[var(--color-warning)]',
  },
  unknown: {
    text: '待确认',
    tone: 'border-[var(--color-muted)] text-[var(--color-muted)]',
  },
}

/**
 * 该状态需要向使用者说明什么。返回 `null` = 没有可说的（各归各的诚实）：
 * 「已生效」不需要免责声明，也就**不该**再出现任何「不生效」的措辞。
 */
function noteFor(support: ParamSupport, report: CapabilityReport): string | null {
  if (support === 'supported') return null
  if (support === 'unsupported') {
    return '未生效：后端当前不会采纳这一项，调节它不会改变生成结果；你的设定仍会被保存。'
  }
  // 未确认的两种来路必须可区分（零静默失败）：还在问，与问不到（附原因）
  if (report.pending) return '正在确认后端是否支持这一项…'
  if (report.error) {
    return `未能确认后端是否支持这一项（${report.error}），故此处不对它是否生效作判断。`
  }
  return '尚未确认后端是否支持这一项，故此处不对它是否生效作判断。'
}

function Slider({
  field,
  value,
  onChange,
  support,
  report,
}: {
  field: (typeof FIELDS)[number]
  value: number
  onChange: (next: number) => void
  support: ParamSupport
  report: CapabilityReport
}) {
  const range = PARAM_RANGES[field.key]
  const id = `param-${field.key}`
  const noteId = `${id}-note`
  const note = noteFor(support, report)
  return (
    <div className="rounded-md border border-[var(--color-panel-border)] bg-[var(--color-panel)] px-3 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex items-baseline gap-2">
          <label htmlFor={id} className="text-sm">
            {field.label}
          </label>
          {/* 标注**由后端能力驱动**（plan §2.2(d)）：每条滑杆各自标注，
              使用者看到的是这一条的状态，而不是一个笼统的区块结论。 */}
          <span
            data-testid={`param-${field.key}-support`}
            className={`rounded-sm border px-1.5 py-0.5 text-xs ${BADGE[support].tone}`}
          >
            {BADGE[support].text}
          </span>
        </span>
        <span className="tabular text-xs text-[var(--color-muted)]">
          {value}
          <span className="sr-only">，范围 {field.unit}</span>
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={range.min}
        max={range.max}
        step={range.step}
        value={value}
        // 刻意**不** disabled：使用者需要能设定并看到它被保存（plan §12.5）。
        // 「当前不生效」由标注 + 说明承担，而不是禁用控件。
        // 没有说明可读时**不挂** aria-describedby：指向一个不存在的 id 是无效引用。
        aria-describedby={note ? noteId : undefined}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-2 w-full accent-[var(--color-accent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
      />
      {note && (
        <p id={noteId} className="mt-2 text-xs text-[var(--color-muted)]">
          {note}
        </p>
      )}
    </div>
  )
}

/**
 * 两条生成参数滑杆（`plan.md` §12.5）。
 *
 * 受控组件：值由调用方持有（App 同时落盘 `PARAMS_KEY`），本组件只负责渲染与夹紧。
 * 范围、步长与默认值全部取自 `lib/conversations.ts` 的 `PARAM_RANGES` / `DEFAULT_PARAMS`
 * —— 组件里不写第二份数字。
 *
 * 「是否生效」同样**不在这里写死**：`capabilities` 由 App 从 `GET /capabilities` 取回
 * （`hooks/useCapabilities`），本组件只负责把答复翻成界面。默认值 `UNCONFIRMED`
 * 表示「还没问过」，此时标注是中性的一档 —— 绝不默认「已生效」。
 */
export function ParamSliders({
  value,
  onChange,
  capabilities = UNCONFIRMED,
}: {
  value: QaParams
  onChange: (next: QaParams) => void
  /** 后端能力答复（含尚未确认/确认失败两种来路）。 */
  capabilities?: CapabilityReport
}) {
  const set = (key: keyof QaParams, next: number) => {
    onChange(clampParams({ ...value, [key]: next }))
  }

  return (
    <section aria-label="生成参数" className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <h2 className="text-xs tracking-wide text-[var(--color-muted)]">生成参数</h2>
      </div>
      {FIELDS.map((field) => (
        <Slider
          key={field.key}
          field={field}
          value={value[field.key]}
          onChange={(next) => set(field.key, next)}
          support={supportOf(capabilities, field.key)}
          report={capabilities}
        />
      ))}
    </section>
  )
}
