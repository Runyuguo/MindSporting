export type ColumnKey = 'rail' | 'chat' | 'evidence' | 'doc'
export interface ColumnState { width: number; open: boolean }
export type Layout = Record<ColumnKey, ColumnState>

export const COLUMN_ORDER: ColumnKey[] = ['rail', 'chat', 'evidence', 'doc']

/** 四栏的**面向人的名称**（spec「栏开关」的顺序：参数 · 问答 · 依据 · 文献）。
 *  分隔线的可访问名与栏开关的可见文案共用这一份，避免两处各写一套中文。 */
export const COLUMN_LABEL: Record<ColumnKey, string> = {
  rail: '功能栏', chat: '对话栏', evidence: '依据栏', doc: '文献卡栏',
}

/**
 * 默认宽度沿用阶段 F 的既有观感（18rem/18rem/20rem）。
 *
 * ⚠️ 对话栏存**真实宽度**（不再是 0）：`App.tsx` 里它由 `flex-1` 改成了实际宽度驱动。
 * 原因见文件末 `applyPairResize` 的返工记录 —— 存 0 而 DOM 走 `flex-1`，
 * 会让"对话栏这一侧的调整"在界面上**完全看不出来**（模型改了、渲染没变）。
 */
export const DEFAULT_LAYOUT: Layout = {
  rail: { width: 288, open: true },
  chat: { width: 0, open: true },      // 首帧由容器宽度撑开，见 App.tsx 的 flex 说明
  evidence: { width: 288, open: true },
  doc: { width: 320, open: true },
}

/**
 * 「可读下限」——低于它就**折叠为关闭态**（spec「每栏有可读下限」/ C-3）。
 *
 * ⚠️ 这组数值曾经**恰好等于各自的默认宽度**（rail/evidence/doc 都是 288/288/320），
 * 于是「默认布局下按一次方向键就把这一栏折叠掉」——使用者实测反馈：
 * 「依据栏与文献卡栏之间的边界线无法向左移动超过中线」，根因就在这：
 * 分隔线每左移一格，依据栏就窄一格，而它起步就站在下限上，**一步即折**，
 * 于是分隔线看上去"走不远"。spec 只要求"有可读下限"，从未规定数值，
 * 故这里把下限下调到明显低于默认宽度，让「变窄」与「折叠」成为两件事：
 * 先把栏压到接近不可读，再继续压才折叠。
 */
export const MIN_WIDTH: Record<ColumnKey, number> = {
  rail: 180, chat: 260, evidence: 180, doc: 180,
}

/** 键盘步长；STEP_FAST 即 spec 所述「加速键」（Shift + 方向键）。 */
export const STEP = 16
export const STEP_FAST = 64

/**
 * 单栏宽度上限（px）——**只防病态增长**，不是布局预算。
 *
 * 为什么是「每栏上限」而不是「三栏合计上限」：实测过合计预算（1280 − 对话栏下限），
 * 它在默认布局下只剩 52px 余量，会让**正常拖动**被截断甚至把栏折叠掉（把 rail 拖宽 16px
 * 竟使 rail 自己消失）——约束把功能弄坏了。而「对话栏不被挤没」的正确着力点是它自己那条
 * 已绑在 DOM 上的 `min-width`（`App.tsx` 的 `chat-column`）：真实浏览器里 `flex-1` 的元素
 * 不会小于 `min-width`。本上限只负责拦住「一次大幅拖动把某栏推到几千像素」这种病态情形。
 */
export const MAX_WIDTH = 800

const STORAGE_KEY = 'ragqa:layout'
const LADDER = 4

/**
 * 夹紧宽度并判定开合。
 *
 * 两条边的归属（务必保持）：
 * - **下限**：对话栏是**唯一不可关闭**的栏（spec C-4），低于下限时停在下限而不折叠；
 *   其余栏越过下限即折叠为关闭态（spec C-3）。
 * - **上限**：`MAX_WIDTH` —— 只防病态增长。放在**这里**而不是 `applyPairResize` 里，
 *   是为了让**所有写入路径**（拖动/键盘/分隔线复位/开关恢复/`localStorage` 读入）都受同一约束：
 *   只在拖动路径上限制的话，手工改过的存档或将来新增的写入方都能绕过它。
 */
export function clampWidth(key: ColumnKey, width: number): ColumnState {
  const snapped = Math.round(width / LADDER) * LADDER
  const capped = Math.min(snapped, MAX_WIDTH)
  if (key === 'chat') {
    return { width: Math.max(MIN_WIDTH.chat, capped), open: true }
  }
  if (capped < MIN_WIDTH[key]) return { width: 0, open: false }
  return { width: capped, open: true }
}

function isColumnState(v: unknown): v is ColumnState {
  return !!v && typeof v === 'object'
    && typeof (v as ColumnState).width === 'number'
    && typeof (v as ColumnState).open === 'boolean'
}

/** 读取布局：任何损坏或字段缺失都回落到默认值，绝不抛错（旧用户无此键）。 */
export function loadLayout(): Layout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_LAYOUT
    const parsed = JSON.parse(raw) as Partial<Layout>
    const out = { ...DEFAULT_LAYOUT }
    for (const key of COLUMN_ORDER) {
      // 读入的值同样过一遍 `clampWidth`：存档可能被手工改过、或由**更早版本**写下，
      // 只做类型校验会让一个 `width: 50000` 的存档绕过上限、把界面撑坏（复审 O1）。
      if (isColumnState(parsed[key])) out[key] = clampWidth(key, (parsed[key] as ColumnState).width)
    }
    return out
  } catch {
    return DEFAULT_LAYOUT
  }
}

export function saveLayout(l: Layout): boolean {
  // 持久化不可用（存储禁用／配额满／隐私模式）不得让布局调整崩掉应用。
  //
  // ⚠️ 这里**不吞异常、也不写日志**，而是把失败**返回给调用方**：
  // 宪法 §3.3 要求「except 必须至少记录到服务日志；用户可见路径必须给出可见反馈」。
  // 前端没有服务日志，故本函数采取该规则要求的**另一半**——把事实交给调用方，
  // 由 useLayout 把它变成**用户可见的反馈**（HUD 提示「本次调整不会被记住」）。
  // 这样既不静默，也无需为「空 catch」向宪法申请作用域例外。
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(l))
    return true
  } catch {
    return false
  }
}

export interface StorageState {
  /** 持久化是否可用；初始 true，一旦写入失败即置 false。 */
  ok: boolean
  /** 已尽力保存过一次失败；UI 据此给出一次性提示。 */
  lastWriteFailed: boolean
}

export const DEFAULT_STORAGE_STATE: StorageState = { ok: true, lastWriteFailed: false }

/** 分隔线占位宽（`ColumnDivider` 的 `w-1`）与条数——用于 1280px 预算的**核算**（见测试）。 */
export const SEPARATOR_WIDTH = 4
export const SEPARATOR_COUNT = 3

/**
 * 夹紧一次「相邻两栏此消彼长」的调整（供分隔线拖动 / 键盘 / 双击复位使用）。
 *
 * 与 `clampWidth` 的分工：`clampWidth` 管**单栏**的可读下限与折叠（spec C-3/C-4）；
 * 本函数在此之上再过一遍**每栏上限** `MAX_WIDTH`。
 *
 * ⚠️ **一次真实的返工记录，勿再重犯**：这里曾实现过「三栏合计 ≤ `1280 − 对话栏下限`」
 * 的**静态预算**（`FIXED_COLUMNS_BUDGET` 等已删除）。它错在两处：
 * ① 默认布局已占 896/948，余量只剩 52px ⇒ **正常拖动就被截断**，甚至把被让位的一栏
 *    直接折叠掉（把 rail 拖宽 16px 会让 rail 自己消失）——约束把功能弄坏了；
 * ② 它用 1280 这个**静态常量**推预算，而真实视口是动态的（宽屏本就有富余空间）。
 * 现在的分工是：**模型层只管单栏上下限**，「对话栏不被挤没」交给它自己那条**已绑在 DOM 上的
 * `min-width`**（`App.tsx` 的 `chat-column`）——真实浏览器里 `flex-1` 的元素不会小于 `min-width`，
 * 那才是这条承诺的正确着力点，而不是在模型层做算术。
 */
export function applyPairResize(layout: Layout, a: ColumnKey, b: ColumnKey, delta: number): Layout {
  // `delta` = **分隔线自身的位移**（`ColumnDivider`: `clientX - 起始x`；键盘 ArrowRight = `+STEP`）。
  // `delta > 0` = 分隔线右移 ⇒ **左栏（a）变宽、右栏（b）变窄**。这正是 SC-18 的
  // 「拖动后栏宽与指针意图一致」：分隔线跟着指针走，两侧栏随之此消彼长。
  //
  // ⚠️ **一次真实的返工记录，勿再重犯**：这里曾写成 `a` **减** delta、`b` 加 delta，即把
  // `delta > 0` 当成「把空间让给右栏」。后果是**分隔线与指针反向移动**（向右拖反而左栏变窄），
  // 而 `ArrowRight` 会**把左栏一路收到折叠**（`MIN_WIDTH.rail === DEFAULT_LAYOUT.rail.width`，
  // 故默认态按一次就消失）。与之配套的旧断言把反向当成了正确值，曾整批钉住该缺陷：
  // `layout.spec.ts` 的"让位"用例、`app.spec.tsx` 的拖动/键盘用例（均已按正确方向重写）。
  // 判据本身没有歧义——指针右移就该让左栏变宽，无需在代码里另立约定。
  //
  // 两侧都过 `clampWidth`，故**只要走这条路径就自动带上**可读下限、越过即折叠、`MAX_WIDTH` 上限。
  // 上下限都集中在 `clampWidth` 里（含上限），是为了不给后人留「在拖动路径上限制、在别处绕过」的口子。
  return {
    ...layout,
    [a]: clampWidth(a, layout[a].width + delta),
    [b]: clampWidth(b, layout[b].width - delta),
  }
}
