import type { DocController } from '../hooks/useDoc'
import { AnswerMarkdown } from './AnswerMarkdown'

/** 服务端给出的原因是英文机器文案；面向人的结论用中文（宪法 §5.2）。 */
function Reason({ text }: { text: string | null }) {
  if (text === null || text.trim() === '') return null
  return (
    <p className="mt-2 break-words text-xs text-[var(--color-muted)]">{text}</p>
  )
}

/**
 * 文献卡侧栏：展示所选证据那一篇的 Markdown 全文（`plan.md` §12.4）。
 *
 * 七态（§12.3 + Minor 复审新增 `empty`）：`idle` 中性提示 / `loading` 可见进度 /
 * `ready` 标题+出处+正文 / **`empty` 篇目在但正文为空（不是失败）** / `missing`（404）
 * 「原文没了」/ `denied`（400）「请求被拒」/ `error`（500 或网络）可见错误。
 * **零静默失败**（宪法 §4.3）：任何一态都有文字，不存在空白面板。
 *
 * 中文结论 + 英文原文诊断：服务端原因是英文机器文案（宪法 §5.2），中文标题给出
 * **人话结论**，英文作为次要诊断文本——不得让中文标题与英文原因各说一套。
 *
 * 正文复用 `AnswerMarkdown`（同一 Markdown+KaTeX 管线），不另起一套渲染。
 * 仅桌面（spec §6 不为窄屏做降级布局）：宽度自 003 起由 state 驱动（可拖可折叠），
 * 生效值经 `width` 传入，可读下限在状态层（`lib/layout.ts` 的 `clampWidth`）保证。
 */
export function DocPanel({
  doc,
  onClose,
  width,
}: {
  doc: DocController
  onClose: () => void
  /** 生效宽度（px），由调用方的 `useLayout` state 给出（T50/T51）；不传则不给宽度声明。 */
  width?: number
}) {
  const { state, doc: note, error } = doc

  return (
    <aside
      data-testid="doc-panel"
      // 见上方说明：宽度由 state 驱动（`style`），可读下限在状态层（`clampWidth`）保证。
      // **本栏吸收剩余空间**（`flex-1` + `min-w-0`）：对话栏自 2026-09-19 起改为实际宽度
      // 驱动（不再 `flex-1`），故"吃掉剩余空间"的角色交给本栏 —— 否则四栏都是固定宽，
      // 视口变宽时右下会留出一条空白。
      style={{ width }}
      className="flex h-full min-w-0 flex-1 flex-col border-l border-[var(--color-border)]"
    >
      <header className="flex shrink-0 items-start gap-3 border-b border-[var(--color-border)] p-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-xs tracking-wide text-[var(--color-muted)]">
            文献卡
          </h2>
          {note !== null && (
            <>
              <p className="mt-1 truncate text-sm font-medium">{note.title}</p>
              <p className="truncate text-xs text-[var(--color-muted)]">{note.ref}</p>
            </>
          )}
        </div>
        <button
          type="button"
          aria-label="关闭文献卡"
          onClick={onClose}
          className="cursor-pointer text-sm text-[var(--color-muted)] transition-colors duration-[var(--duration-fast)] hover:text-[var(--color-fg)]"
        >
          ×
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {state === 'idle' && (
          <p
            data-testid="doc-idle"
            className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-muted)]"
          >
            点击左侧证据查看文献卡
          </p>
        )}

        {state === 'loading' && (
          <div data-testid="doc-loading" role="status">
            <p className="text-sm text-[var(--color-muted)]">正在载入原文…</p>
            <div
              aria-hidden="true"
              className="mt-2 h-1 w-full animate-pulse rounded-sm bg-[var(--color-border)]"
            />
          </div>
        )}

        {state === 'ready' &&
          (note === null ? (
            // ready 却没有篇目：类型上不可能，但空白面板正是要禁止的静默失败，
            // 故兜一句可见文案而不是渲染空 div。
            <p className="text-sm text-[var(--color-muted)]">原文内容不可用</p>
          ) : (
            <div data-testid="doc-ready">
              <AnswerMarkdown content={note.content} />
            </div>
          ))}

        {state === 'empty' && (
          // 空文档 = 请求成功、篇目在、只是没有正文：**不是**「载入原文失败」。
          <div
            data-testid="doc-empty"
            className="rounded-md border border-[var(--color-border)] p-3"
          >
            <p className="text-sm">这篇原文没有正文（空文档）</p>
            <p className="mt-1 text-xs text-[var(--color-muted)]">
              篇目存在于知识库中，但内容为空——不是加载失败。
            </p>
          </div>
        )}

        {state === 'missing' && (
          <div data-testid="doc-missing" className="rounded-md border border-[var(--color-border)] p-3">
            <p className="text-sm">这篇原文已不在知识库中</p>
            <Reason text={error} />
          </div>
        )}

        {state === 'denied' && (
          <div data-testid="doc-denied" className="rounded-md border border-[var(--color-border)] p-3">
            <p className="text-sm">请求被拒绝：该路径不在本库范围内</p>
            <Reason text={error} />
          </div>
        )}

        {state === 'error' && (
          <div data-testid="doc-error" className="rounded-md border border-[var(--color-border)] p-3">
            <p className="text-sm">载入原文失败</p>
            {/* 没有原因也必须留可见文字，不能退回空白面板。 */}
            <Reason text={error ?? '原因未知，请重试'} />
          </div>
        )}
      </div>
    </aside>
  )
}
