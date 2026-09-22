import pathlib
import tempfile
import unittest
from unittest import mock

from rag_core import rag_engine


class TestThresholdAndBudget(unittest.TestCase):
    def test_apply_threshold_filters_low_scores(self):
        hits = [{"ref": "a", "score": 0.1}, {"ref": "b", "score": 0.9}, {"ref": "c", "score": 0.5}]
        out = rag_engine.apply_threshold(hits, 0.5)
        self.assertEqual([h["ref"] for h in out], ["b", "c"])

    def test_apply_threshold_uses_custom_key(self):
        hits = [{"ref": "a", "cos": 0.1}, {"ref": "b", "cos": 0.7}]
        out = rag_engine.apply_threshold(hits, 0.3, score_key="cos")
        self.assertEqual([h["ref"] for h in out], ["b"])

    def test_clip_char_budget_cuts_at_word_boundary(self):
        out = rag_engine.clip_char_budget("hello world foo", 11)
        self.assertEqual(out, "hello world")

    def test_clip_char_budget_keeps_short_text(self):
        self.assertEqual(rag_engine.clip_char_budget("short", 100), "short")

    def test_config_key_is_named_for_chars(self):
        from rag_core import rag_engine
        cfg = rag_engine.load_config(
            rag_engine.Path("rag_core/config_ai4s.json"))
        self.assertIn("evidence_char_budget", cfg["search"])
        self.assertNotIn("token_budget", cfg["search"])


class TestAskReadsEvidenceCharBudget(unittest.TestCase):
    """T20 缺陷补测：`ask()` 必须真的**读** `search.evidence_char_budget`。

    缺陷：`tests/` 里没有任何 `.ask(` 调用点（T20 前 grep 命中 0 条），于是
    `RAGEngine.ask` 里那两行——`budget = int(self.cfg["search"].get(
    "evidence_char_budget", 4000))` 与随后的裁剪循环——从未被执行过。
    而 shipped config 的值与硬编码兜底**都是 4000**，所以「键名写错 ⇒ 配置被静默忽略」
    在既有测试下完全不可见。

    判别力来自**配置值 ≠ 兜底值**：本用例把预算设成一个小到必然发生裁剪的数，
    于是「读到配置」与「回落到 4000」给出可区分的结果。两个方向都钉：
    小预算必须裁、大预算必须不裁 —— 只钉一个方向的话，把 100 写死也能绿。

    不打模型：`_emb` 预置为哨兵 `False`（生产代码加载失败时同样置 False），
    语义路径因此直接返回空，`hybrid` 退化为纯 BM25；`rerank.model` 指向一个不存在的
    路径，任何一次真实的精排调用都不会加载交叉编码器。

    关于精排，这里**实际发生的事**与早先 docstring 的说法不同（原文说「精排只替换
    `predict_pairs` 这一个入口」，特此更正）：`_ask()` 的 `mock.patch.object(self.engine,
    "predict_pairs")` 把该入口整个换成一个返回全 0 的假实现，于是**真正的 `predict_pairs`
    从未执行** —— 连带 `_reranker()` 里的「模型路径不存在」判定也从未跑到（实测
    `engine._rr` 仍是 `None`，而不是 `False` 哨兵，且全程**没有任何精排日志**）。
    全 0 分数经 `sorted(..., key=-score)` 稳定排序后保持融合序，故 `_ask()` 与
    `search(rerank=False)` 的命中顺序一致。

    （对照片上：不打 mock 时同一份配置会走另一条路 —— `_reranker()` 记下 `False` 哨兵、
    记 "精排模型不可用" 警告，`predict_pairs` 返回 `None`，`rerank()` 再记 "精排不可用…
    保留融合序返回"。两条路最终的**排序结果相同**，差别只在是否真的触达模型判定。）

    这不影响本用例的判别力，因为被测的是**预算循环**而不是精排：精排生效与否，
    `ask()` 都必须读配置里的 `evidence_char_budget` 并裁剪证据 —— 实测两条路径下
    预算都被正确执行（总长裁到 100）。判别力来自「配置值 100 ≠ 兜底 4000」：
    键名写错时回落到 4000，两条断言都会红。
    """

    BUDGET = 100
    QUESTION = "线粒体自噬"

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="t20_budget_")
        self.addCleanup(self.tmp.cleanup)
        root = pathlib.Path(self.tmp.name)
        self.engine = rag_engine.RAGEngine({
            "lib": "testlib",
            "index_db": str(root / "index.db"),
            "faiss_index": str(root / "absent.faiss"),   # 不存在 ⇒ 语义路径返回空
            "sources": {"metadata": False, "extracted": False,
                        "weekly_watch": False, "vault": False},
            "search": {"topn": 10, "rrf_k": 60, "min_bm25": None, "min_cos": None,
                       "evidence_char_budget": self.BUDGET},
            "rerank": {"model": str(root / "no-such-reranker"),
                       "topk": 50, "final_topn": 8},
        })
        self.engine._emb = False
        self.engine.index_docs([
            ("vault:note", f"01-Literature/{n}.md", n, "", f"obsidian://{n}",
             "线粒体自噬的分子机制与调控因子 " * 40)
            for n in ("a", "b", "c")
        ])

    def _ask(self):
        # 只替换精排的推理入口，检索（FTS）真跑
        with mock.patch.object(self.engine, "predict_pairs",
                               side_effect=lambda pairs: [0.0] * len(pairs)):
            return self.engine.ask(self.QUESTION, topn=10)

    def _unclipped(self):
        return self.engine.search(self.QUESTION, topn=10, rerank=False)

    def test_small_budget_actually_clips_the_evidence(self):
        original = self._unclipped()
        unclipped_total = sum(len(h["snippet"]) for h in original)
        self.assertGreaterEqual(len(original), 2, "素材不足以观察裁剪")
        self.assertGreater(unclipped_total, self.BUDGET,
                           "未裁剪时就已不超预算，本用例失去判别力")

        hits = self._ask()["hits"]
        self.assertTrue(hits, "ask() 未返回任何证据")
        clipped_total = sum(len(h["snippet"]) for h in hits)
        self.assertLessEqual(
            clipped_total, self.BUDGET,
            f"证据片段总长 {clipped_total} 超过 evidence_char_budget={self.BUDGET}；"
            f"若等于未裁剪的 {unclipped_total}，说明读的是硬编码兜底 4000 而不是配置值")
        # 只断言「总长确实被压下来了」，不额外规定裁剪循环在第几条 break ——
        # 循环允许把最后一条裁短后正好用满预算（实测 63/63/63 → 63/31/6），
        # 那不是缺陷，按条数断言会把一个合法实现判红。
        self.assertLess(
            clipped_total, unclipped_total,
            "总长未被压低 ⇒ 裁剪循环没有生效")

    def test_large_budget_does_not_clip(self):
        """反方向：预算足够大时必须原样返回 —— 挡住「把 100 写死」也能变绿。"""
        self.engine.cfg["search"]["evidence_char_budget"] = 10 ** 6
        self.assertEqual(self._ask()["hits"], self._unclipped())


if __name__ == "__main__":
    unittest.main()
