import type { KeyboardEvent } from 'react'

/**
 * 输入框是**受控**的：草稿由 `ChatPanel` 持有，因为空态的示例问题要能写进来
 * （使用者 2026-09-19）。内部再存一份会让"点击示例 → 输入框没变"这类不同步出现。
 */
export function Composer({
  value,
  onChange,
  onSubmit,
  onAbort,
  busy,
}: {
  value: string
  onChange: (next: string) => void
  onSubmit: (text: string) => void
  onAbort: () => void
  busy: boolean
}) {
  const send = () => {
    const text = value.trim()
    if (!text) return
    onSubmit(text)
    onChange('')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send()
    }
  }

  return (
    <div className="flex items-end gap-2 border-t border-[var(--color-border)] p-3">
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        rows={2}
        placeholder="提一个问题，Enter 发送，Shift+Enter 换行"
        className="flex-1 resize-none rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none transition-colors duration-[var(--duration-fast)] focus-visible:border-[var(--color-accent)]"
      />
      {busy ? (
        <button
          type="button"
          onClick={onAbort}
          className="rounded-md border border-[var(--color-border)] px-4 py-2 text-sm transition-colors duration-[var(--duration-fast)] hover:border-[var(--color-danger)] active:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
        >
          中断
        </button>
      ) : (
        <button
          type="button"
          onClick={send}
          disabled={!value.trim()}
          className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm text-[var(--color-accent-fg)] transition-opacity duration-[var(--duration-fast)] hover:opacity-90 active:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] disabled:opacity-40"
        >
          发送
        </button>
      )}
    </div>
  )
}
