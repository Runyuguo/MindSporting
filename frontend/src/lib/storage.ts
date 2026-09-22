/**
 * 会话消息的**类型**定义（仅此一项仍在使用）。
 *
 * 历史沿革：本模块原有一组按 `lib` 分存的扁平键读写函数
 * （`ragqa:<lib>` → `Message[]`）。T23 起会话真值改由 `lib/conversations.ts` 的
 * `ragqa:conv:<lib>` 持有（消息与逐轮依据同源落盘），旧扁平键由
 * `migrateLegacyKeys()` 原样备份到 `ragqa:legacy-backup` 后删除。
 *
 * 那组函数（`loadMessages` / `saveMessages` / `clearMessages`）此后**没有任何生产调用点**，
 * 只有自己的测试在调它们 —— 正是宪法 §3.1「禁止写了不接线」所指的形态。
 * 复审据此要求消除矛盾：已在本轮**删除**（连同仅覆盖它们的 `storage.spec.ts`），
 * 而不是靠文档承认「保留了死代码」。若将来要重新引入「按库扁平存储」，
 * 连同调用点一起立项，不要再复活这几个导出。
 */
export interface Message {
  role: 'user' | 'assistant'
  content: string
}
