import { useCallback, useEffect, useState } from 'react'
import {
  createConversation,
  loadConversations,
  loadCurrentId,
  migrateLegacyKeys,
  saveConversations,
  saveCurrentId,
  type Conversation,
} from '../lib/conversations'

export interface ConversationsController {
  list: Conversation[]
  currentId: string | null
  current: Conversation | null
  create: () => void
  select: (id: string) => void
  remove: (id: string) => void
  update: (id: string, patch: Partial<Omit<Conversation, 'id' | 'createdAt'>>) => void
}

/**
 * `lib` 与它自己的 `list` / `currentId` 必须同处一个 state 对象：
 * 只改其中一个字段就可能出现「用 A 库的键写 B 库的列表」这种串库，
 * 绑在一起后每次写入拿到的 lib 一定与列表同源。
 */
interface ConversationsState {
  lib: string
  list: Conversation[]
  currentId: string | null
}

/**
 * 旧扁平键迁移**只做一次**：放在模块作用域（应用启动即求值），而不是 `useEffect`。
 * `useEffect` 随每个挂载它的组件各跑一次（App 与各测试可多次挂载），
 * 而模块只在每次页面加载时求值一次；`migrateLegacyKeys` 自身以 `migratedAt` 幂等，
 * 即便 HMR 重新求值也安全。此处不需要改 `App.tsx`（T24 不拥有它），
 * 入口的导入链必经本模块。
 */
migrateLegacyKeys()

/** 只读推导：读该库自己的列表与选中项；空库补一条空对话。落盘由下方 effect 统一负责。 */
function loadState(lib: string): ConversationsState {
  const stored = loadConversations(lib)
  const list = stored.length > 0 ? stored : [createConversation()]
  // loadCurrentId 已把失效 id 回退到首条；列表非空时它必不为 null。
  const currentId = loadCurrentId(lib) ?? list[0].id
  return { lib, list, currentId }
}

export function useConversations(lib: string): ConversationsController {
  const [state, setState] = useState<ConversationsState>(() => loadState(lib))

  // 切库：在**渲染期**把状态换成新库自己的列表与选中项（React 官方
  //「props 变化时调整 state」模式，本次渲染结果会被丢弃并立即重渲染）。
  // 刻意不用 effect：effect 要等提交后才跑，中间那一帧会拿**另一个库的对话列表**
  // 渲染，正是宪法 §2.2 双库完全隔离要禁止的。
  if (state.lib !== lib) {
    setState(loadState(lib))
  }

  // 唯一持久化出口：状态一变就按**该状态自己的 lib** 写回，内存与存储不会分叉。
  // 首屏把「自动补出的空对话」一并落盘，刷新后 id 稳定、不会反复新建。
  useEffect(() => {
    saveConversations(state.lib, state.list)
    // 列表与选中项同属该库状态，逐次一并落盘。**列表永不为空**：`loadState` 对空库补一条、
    // `remove` 删到一条不剩时也补一条 ⇒ `currentId` 恒非 null，这里的 null 判断只是类型守卫
    // —— 真为空时不写选中键（旧键留着无害，`loadCurrentId` 对空列表一律返回 null）。
    if (state.currentId !== null) saveCurrentId(state.lib, state.currentId)
  }, [state])

  const create = useCallback(() => {
    // 新对话在 updater 内创建：新列表必须由**最新**的 prev 推出，不能读渲染闭包里的
    // list —— 同一批次里的两次 create 都会读到同一份旧列表，后者覆盖前者。
    setState((prev) => {
      const fresh = createConversation()
      return { ...prev, list: [fresh, ...prev.list], currentId: fresh.id }
    })
  }, [])

  const select = useCallback((id: string) => {
    setState((prev) => {
      // 未知 id 不予选中，避免产生指向不存在对话的悬空选中
      if (prev.currentId === id || !prev.list.some((c) => c.id === id)) return prev
      return { ...prev, currentId: id }
    })
  }, [])

  /**
   * 会话内容的写入路径（T25 注入 `useChat`、T29 装配、T30 改标题都经此落盘）。
   *
   * 未命中 id 直接返回 `prev`：不抛错、不改状态 —— 落盘 effect 依赖 `state` 引用变化，
   * 返回同一个对象既能保证 no-op 语义，也不会把带时间戳的假改动写回存储。
   *
   * **故意不按 `updatedAt` 重排列表**：`plan.md` §12.2 的「最近更新在前」由展示层负责
   * （T30 排序 `list` 后再渲染，或另出排序后的 getter）。理由：`update` 会被每一次内容
   * 变更调到（提交与一轮结束各一次，见 useChat 的 C1 落盘），若在此重排，用户刚点下
   * 发送时历史列表就会跳动、条目在指下移走；且 `create` 已把新对话置顶，重排只对
   * 「更新旧对话」这一种情况有可见影响。
   *
   * `Date.now()` 在 updater 外取一次：updater 可能被调用两次（StrictMode），
   * 时间戳要稳定，不能两次拿到不同值。
   */
  const update = useCallback(
    (id: string, patch: Partial<Omit<Conversation, 'id' | 'createdAt'>>) => {
      const now = Date.now()
      setState((prev) => {
        // 列表里不存在的 id（如切库后旧对话的迟到回调）：静默 no-op
        if (!prev.list.some((c) => c.id === id)) return prev
        const list = prev.list.map((c) =>
          // id 由签名排除、createdAt 由类型排除，patch 无法覆盖二者
          c.id === id ? { ...c, ...patch, updatedAt: now } : c,
        )
        // 只换 list，currentId 原样带回：update 不可改变选中项
        return { ...prev, list }
      })
    },
    [],
  )

  /**
   * 删除一条对话（使用者 2026-09-19 要求：历史每条可删）。
   *
   * `remove` 曾因「没有能清空列表的路径」而退役，本方法把那条不变量**显式补回来**：
   * 删到一条不剩时立刻补一条空对话 —— 于是 `currentId` 恒非 null，`loadState`
   * 的「空库补一条」与这里的补法一致，刷新前后不会出现"一个对话都没有"的中间态。
   *
   * 删掉的是**当前**那条时，选中项必须跟着落到仍然存在的某条上：留一个指向
   * 不存在对话的 `currentId` 会让整个对话栏空白且无提示。选取规则取「最近更新的那条」，
   * 与历史列表的排法一致（列表本身按 `updatedAt` 倒序展示）。
   *
   * 未命中 id 直接 no-op（与 `update` 同一约定）：迟到的回调不该改状态。
   */
  const remove = useCallback((id: string) => {
    setState((prev) => {
      if (!prev.list.some((c) => c.id === id)) return prev
      const kept = prev.list.filter((c) => c.id !== id)
      const list = kept.length > 0 ? kept : [createConversation()]
      const removedCurrent = prev.currentId === id
      const nextCurrent = removedCurrent
        ? [...list].sort((a, b) => b.updatedAt - a.updatedAt)[0].id
        : prev.currentId
      return { ...prev, list, currentId: nextCurrent }
    })
  }, [])

  const current = state.list.find((c) => c.id === state.currentId) ?? null

  return { list: state.list, currentId: state.currentId, current, create, select, remove, update }
}
