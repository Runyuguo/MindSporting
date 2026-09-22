import type { Conversation } from '../lib/conversations'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const MONTH = 30 * DAY

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * 相对时间：一分钟内「刚刚」，其后按分 / 小时 / 天递增；超过约一个月给绝对日期
 * （「37 天前」这种读不出时间点的表述对找一篇旧对话没有帮助）。
 */
function relativeTime(ts: number, now: number): string {
  const diff = now - ts
  if (diff < MINUTE) return '刚刚'
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`
  if (diff < MONTH) return `${Math.floor(diff / DAY)} 天前`
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * 功能栏下部的对话历史列表（`plan.md` §12.4）。
 *
 * **排序是展示层的事**：`useConversations.update` 刻意不按 `updatedAt` 重排列表
 * （流式回答期间每个 token 都会 update，重排会让条目在用户指下跳动），所以这里
 * 按 `updatedAt` 倒序排一份副本再渲染 —— 原列表一个字都不动。
 *
 * 纯展示组件：不发请求、不落盘，交互一律经 `onSelect` / `onCreate` 回调。
 */
export function HistoryList({
  list,
  currentId,
  onSelect,
  onCreate,
  onRemove,
}: {
  list: Conversation[]
  currentId: string | null
  onSelect: (id: string) => void
  onCreate: () => void
  onRemove: (id: string) => void
}) {
  // 排序不能改动入参：`[...list]` 排副本
  const ordered = [...list].sort((a, b) => b.updatedAt - a.updatedAt)
  const now = Date.now()

  return (
    <section aria-label="对话历史" className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xs tracking-wide text-[var(--color-muted)]">对话历史</h2>
        <button
          type="button"
          data-testid="new-conversation"
          onClick={onCreate}
          className="rounded-md border border-[var(--color-panel-border)] bg-[var(--color-panel)] px-2 py-1 text-xs transition-colors duration-[var(--duration-fast)] hover:border-[var(--color-accent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
        >
          ＋ 新对话
        </button>
      </div>

      {ordered.length === 0 ? (
        <p className="rounded-md border border-[var(--color-panel-border)] bg-[var(--color-panel)] px-3 py-2 text-xs text-[var(--color-muted)]">
          还没有对话，提问或新建一条即开始。
        </p>
      ) : (
        <ol className="flex flex-col gap-1">
          {ordered.map((c) => {
            const current = c.id === currentId
            return (
              // 一行 = 一个定位容器，**并排**放「选中按钮」与「删除按钮」两个兄弟节点。
              // 不把删除按钮嵌进选中按钮里：`<button>` 里再放 `<button>` 是无效 HTML，
              // 且内层按钮在多数浏览器里既不可聚焦、点击行为也未定义 —— 键盘使用者
              // 会**永远删不掉**（spec 的可访问性立场）。`group` 让删除按钮按行悬停显隐。
              <li key={c.id} className="group relative">
                <button
                  type="button"
                  data-testid="history-row"
                  // 选中态既要看得见（边框/底色），也要能被读屏读出
                  aria-current={current ? 'true' : undefined}
                  onClick={() => onSelect(c.id)}
                  // 右侧留出删除按钮的位置，否则标题会钻到它下面去
                  className={`flex w-full flex-col items-start gap-1 rounded-md border bg-[var(--color-panel)] py-2 pl-3 pr-8 text-left transition-colors duration-[var(--duration-fast)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] ${
                    current
                      ? 'border-[var(--color-accent)]'
                      : 'border-[var(--color-panel-border)] hover:border-[var(--color-muted)]'
                  }`}
                >
                  <span className="w-full truncate text-sm">{c.title}</span>
                  <span className="tabular text-xs text-[var(--color-muted)]">
                    {relativeTime(c.updatedAt, now)}
                  </span>
                </button>
                <button
                  type="button"
                  data-testid="history-delete"
                  // 可访问名带上对话标题：读屏列出一串「删除」时才知道删的是哪一条
                  aria-label={`删除对话「${c.title}」`}
                  title="删除这条对话"
                  onClick={() => onRemove(c.id)}
                  // opacity 控制显隐而**不是** display/hidden：它始终在可访问性树里，
                  // 键盘 Tab 到它时也能靠 focus-visible 显形（否则聚焦一个看不见的按钮）。
                  className="absolute right-1 top-1/2 -translate-y-1/2 rounded-sm px-1.5 py-1 text-xs text-[var(--color-muted)] opacity-0 transition-opacity duration-[var(--duration-fast)] hover:text-[var(--color-danger)] focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] group-hover:opacity-100 group-focus-within:opacity-100"
                >
                  ×
                </button>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
