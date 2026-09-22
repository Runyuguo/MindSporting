import unittest

from fastapi.testclient import TestClient

from rag_core import rag_engine
from server import http_server


class TestRemovedSurface(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(http_server.app)

    def test_removed_endpoints_return_404(self):
        # 注意 `/doc` **不**在此列：T01 删掉的是旧的目录树 `/doc`（四窗口退场），
        # 现行 `/doc` 是 `specs/001-rag-qa-multiturn/spec.md`「文献卡查阅」重新引入的
        # **同类名不同用途**的只读取文接口（AGENTS.md §3 注、澄清记录 C-6），行为由
        # tests/test_doc.py 更强地断言（状态码 + 无绝对路径泄漏）。故这条陈旧条目移除。
        for path in ("/graph", "/library", "/library/tree"):
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path).status_code, 404)
        with self.subTest(path="/close_read/stream"):
            self.assertEqual(
                self.client.post("/close_read/stream").status_code, 404)

    def test_graph_builders_are_gone(self):
        self.assertFalse(hasattr(rag_engine, "build_graph"))
        self.assertFalse(hasattr(rag_engine, "build_wikilink_graph"))


if __name__ == "__main__":
    unittest.main()
