import os
import tempfile
import unittest

# 精排层必须**离线快速失败**（T17）：本文件的 stub 配置（`_cfg`）刻意不写 `rerank` 块
# ⇒ `rerank.model` 落到默认空值，`_reranker()` 应在本地立刻降级，**不得**去
# huggingface.co 找同名仓库 —— 精排默认开启后，不设离线标志时该文件单跑会从 ~2s
# 变成 349s（HEAD 请求 10 次重试，WinError 10060；见 task-17-report.md §7.1）。
# 与 tests/test_engine_singleton.py 同一手法，也让本文件不再隐式依赖
# 「哪个测试模块先被导入」（此前全靠排在它前面的模块设了这个变量）。
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

from rag_core import rag_engine  # noqa: E402


def _cfg(tmpdir: str, lib: str) -> dict:
    return {
        "lib": lib,
        "index_db": os.path.join(tmpdir, lib + ".db"),
        "chunk": {"max_chars": 500},
        "search": {"topn": 8, "rrf_k": 60, "min_bm25": None, "min_cos": None,
                   "evidence_char_budget": 1000},
        "sources": {"metadata": True, "extracted": True, "weekly_watch": True, "vault": True},
    }


class TestLibIsolation(unittest.TestCase):
    def test_two_libs_do_not_cross_talk(self):
        with tempfile.TemporaryDirectory() as d:
            a = rag_engine.RAGEngine(_cfg(d, "ai4s"))
            b = rag_engine.RAGEngine(_cfg(d, "mito"))
            self.assertNotEqual(a.index_db, b.index_db)
            # A 案（T36 检索期白名单）：只有白名单 vault 片段会出现在结果里，故这里用
            # vault 来源的篇目验证隔离。库外来源（metadata/extracted/weekly）的片段现在
            # 一律不出现在结果中——那条规则单独钉在
            # tests/test_sources.py::TestQueryTimeWhitelist 里，不在本用例重复。
            a.index_docs([("vault:note", "01-Literature/p1.md", "Mitochondrial dynamics", "",
                           "j", "mitochondria fusion fission")])
            hits_a = a.search("mitochondria", mode="bm25")
            hits_b = b.search("mitochondria", mode="bm25")
            self.assertTrue(any(h["ref"] == "01-Literature/p1.md" for h in hits_a))
            self.assertEqual(hits_b, [])


if __name__ == "__main__":
    unittest.main()
