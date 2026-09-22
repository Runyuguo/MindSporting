"""T17：精排（bge-reranker-v2-m3 交叉编码器）接入查询路径。

背景（缺陷）：`search(..., rerank: bool = False)` 是默认值，且**没有任何生产调用点**
传 `rerank=True` —— 于是 2.2GB 的交叉编码器与 `rerank.topk` 从未参与过真实问答。
本文件钉住接线后的五条行为：

1. 默认精排（不传 `rerank` 也走精排）；
2. 显式 `rerank=False` 时**不**碰精排模型（这是「关掉」的开关，必须仍然有效）；
3. 候选规模按 `fetch = max(topn×3, rerank.topk)` 取（`rerank.topk` 是**地板**，不是上界），
   详见 `test_candidate_fetch_uses_rerank_topk_as_a_floor` 的文档字符串；
4. 精排不可用 / 推理失败时**降级保留融合序**（不抛错、不返回空），且失败必须被记录；
5. 精排分数确实**改变顺序**（不是只把流程走通）。

本文件打真模型、真索引（只读 ai4s 库）。**精排模型缺席时第 1/3 条不会红**：两个 spy 都在
委托给真入口**之前**就 append，而 `predict_pairs` 返回 `None` 仍是一次**调用** ——
它们会「因模型缺席而空洞通过」（第 5 条会因降级而失败，但失败原因难辨）。
故 `setUpClass` 直接断言精排模型确实可加载，把「模型不在」变成显式前置失败。
"""
import os
import unittest
from unittest import mock

# 与 test_engine_singleton 一致：模型只从本地缓存加载（测试进程没有别处设离线标志）。
# 不强制离线时，缺失的模型会在 huggingface.co 的连接上长时间挂起。
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")

import numpy as np  # noqa: E402

from rag_core import rag_engine  # noqa: E402


def _pair_text(hit: dict) -> str:
    """精排喂给交叉编码器的文本：与 `RAGEngine.rerank` 的组对方式一致。"""
    return (hit.get("title") or "") + " " + (hit.get("snippet") or "")


class TestRerankWiring(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        rag_engine.reset_engines()
        cls.engine = rag_engine.get_engine("ai4s")
        # 非空前置断言不可省（见模块文档字符串）：精排缺席时 spy 断言会空洞通过，
        # 故把「模型不在」提到这里显式失败。
        cls.assertIsNotNone(
            cls.engine._reranker(),
            "bge-reranker-v2-m3 未能从本地路径加载：本文件的判别力依赖它，故先在此失败")

    def test_search_reranks_by_default(self):
        """默认精排：`search()` 不传 `rerank` 也必须调用 `predict_pairs`。

        为什么用 `predict_pairs` 当观测点而不是 `_reranker()`：T05 Ruling 14 规定精排
        必须经带推理锁的入口，直接持有 CrossEncoder 是**被禁止**的接线方式。
        故「默认走精排」与「走的是合规入口」由同一条断言一起钉住。
        """
        calls = []
        original = self.engine.predict_pairs

        def spy(pairs):
            calls.append(len(pairs))
            return original(pairs)

        with mock.patch.object(self.engine, "predict_pairs", side_effect=spy):
            self.engine.search("mitochondria", topn=5)
        self.assertTrue(calls, "默认应当调用精排")

    def test_rerank_false_skips_reranker(self):
        with mock.patch.object(self.engine, "predict_pairs") as spy:
            self.engine.search("mitochondria", topn=5, rerank=False)
        spy.assert_not_called()

    def test_candidate_fetch_uses_rerank_topk_as_a_floor(self):
        """候选规模语义：`fetch = max(topn × 3, rerank.topk)` —— `rerank.topk` 是**地板**。

        **两次改名与判据重写的实测依据（2026-09-20，本机真库）**：
        - 原名 `test_candidate_set_follows_rerank_topk` 断言 `seen[0] <= topk`（**上界**语义），
          而实现是 `max(...)`：`topn ≥ 17` 时 `topn×3 > topk`，那条断言必红；
        - brief 的修订版断言 `seen[0] >= min(topk, 50)`（即 ≥ 50）：**在真实数据上同样必红**。
          实测（`线粒体自噬`, topn=5）：`fetch = 50` 是**块级**候选数，而精排实收的是
          `aggregate_by_document` 去重后的**文献池** —— BM25 50 块 → 9 篇、语义 50 块 → 16 篇、
          `rrf_merge` 并集 **17 篇**（实测输出：`AssertionError: 17 not greater than or equal to 50`）。
          把「配置里取了多少块」当成「精排收到多少篇」是两个不同的量，故该判据不可判定。
        - 本版把语义拆成**两个可判定、且与索引内容无关**的观测点：
          ① 检索层按地板取候选（`topn` 小时的取值由 `topk` 兜底）；
          ② `topk` **不是上界**（`topn` 大到 `topn×3 > topk` 时，取的是 `topn×3`）。
          并顺带钉住「精排实收 = 去重后的文献池，不可能多于取回的块数」。
        """
        topk = int(self.engine.cfg["rerank"]["topk"])
        # topn_big 由配置推出（topk=50 ⇒ 17，此时 17×3 = 51 > topk），
        # 不把 50 写死，换成别的 topk 也仍然是一个「topn×3 已经超过 topk」的观测点。
        topn_small, topn_big = 5, topk // 3 + 1
        seen: list[int] = []
        original = self.engine.predict_pairs

        def spy(pairs):
            seen.append(len(pairs))
            return original(pairs)

        def fetch_and_rerank(topn: int) -> list[int]:
            """跑一次 search，返回两路检索被要求的候选条数（块级）。"""
            with mock.patch.object(self.engine, "bm25_search",
                                   wraps=self.engine.bm25_search) as bm, \
                 mock.patch.object(self.engine, "semantic_search",
                                   wraps=self.engine.semantic_search) as sem, \
                 mock.patch.object(self.engine, "predict_pairs", side_effect=spy):
                self.engine.search("线粒体自噬", topn=topn)
            return [c.args[1] for c in bm.call_args_list + sem.call_args_list]

        asked = fetch_and_rerank(topn_small)
        self.assertTrue(seen, "精排未被调用")
        self.assertEqual(len(asked), 2, "混合检索应分别向 BM25 与语义两路要候选")
        self.assertEqual(
            asked, [max(topn_small * 3, topk)] * 2,
            f"topn={topn_small} 时候选应取 max({topn_small}×3, {topk})="
            f"{max(topn_small * 3, topk)} 块（地板生效），实为 {asked}")

        asked_big = fetch_and_rerank(topn_big)
        self.assertEqual(
            asked_big, [max(topn_big * 3, topk)] * 2,
            f"topn={topn_big} 时候选应取 max({topn_big}×3, {topk})="
            f"{max(topn_big * 3, topk)} 块，实为 {asked_big}")
        self.assertGreater(
            asked_big[0], topk,
            "topk 被当成了上界：topn×3 已超过 topk 时候选数仍被压在 topk —— 上界语义是错的")

        # 精排实收 = RRF 去重后的文献池：非空，且不可能多于取回的块数。
        self.assertGreater(seen[0], 0, "精排收到 0 条候选")
        self.assertLessEqual(
            seen[0], asked[0],
            f"精排收到 {seen[0]} 篇，多于两路取回的 {asked[0]} 块 —— 候选不是从检索结果来的")

    def test_reranker_failure_degrades_to_rrf_order_without_raising(self):
        """推理抛错时必须降级（返回融合序），并且**留下诊断**（宪法 §3.3：不得静默吞掉）。

        `assertLogs` 不是装饰：只断言 `len(hits) == 5` 的话，「静默吞掉异常」也能变绿 ——
        那正是本任务要禁止的失败方式；故把「记录失败」一并钉住。
        """
        with mock.patch.object(self.engine, "predict_pairs",
                               side_effect=RuntimeError("no gpu")):
            with self.assertLogs("rag_core.rag_engine", level="WARNING") as cm:
                hits = self.engine.search("mitochondria", topn=5)
        self.assertEqual(len(hits), 5, "精排失败应降级返回，而不是抛错或返回空")
        self.assertTrue(
            any("精排" in line for line in cm.output),
            f"精排失败必须记录到日志（否则线上只能表现为「排序莫名其妙」）：{cm.output}",
        )

    def test_rerank_changes_order_when_scores_differ(self):
        """注入「第 2 个候选分数最高」的分数向量，断言它被提到第一位。

        **判据改写的原因（2026-09-20 实测）**：种子里 mock 直接 `return_value=np.array(...5 个...)`，
        而 `topn=5` 时候选池是 **17 篇**（实测：`fetch = max(15, 50) = 50` 条**块**经
        `aggregate_by_document` 去重后的文献数）—— 5 个分数喂 17 篇候选，
        `scores[i]` 会在 i=5 处 IndexError，或在实现里加一条「长度不符即降级」的
        分支才变绿，而那条分支与测试名声称的「排序被改变」毫无关系（本项目的
        「因错误的原因变绿」）。故这里先按**真实候选池规模**造分数向量：除第 2 条外全为 0，
        断言精排后的第一条就是候选池里的第 2 条。
        """
        captured = []

        def scores_for(pairs):
            captured.append(list(pairs))
            scores = np.zeros(len(pairs), dtype=np.float32)
            if len(pairs) > 1:
                scores[1] = 9.9
            return scores

        with mock.patch.object(self.engine, "predict_pairs", side_effect=scores_for):
            hits = self.engine.search("mitochondria", topn=5)

        self.assertEqual(len(hits), 5)
        self.assertTrue(captured, "精排未被调用：本测试失去判别力")
        pairs = captured[0]
        self.assertGreater(len(pairs), 1, "候选不足 2 条，无法验证排序变化")
        self.assertEqual(
            _pair_text(hits[0]), pairs[1][1],
            "最高分候选未被提到第一位——精排分数没有参与排序",
        )


if __name__ == "__main__":
    unittest.main()
