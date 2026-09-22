"""T49 修复 · `/search` 的 `source` 契约（Defect 2）。

现象（T49 端到端验收）：`GET /search?...&source=<未注册值>` 返回 **500**。
根因是语义检索**过滤后没有行**，`rag_core/rag_engine.py::semantic_search` 的
`np.stack([])` 抛 `ValueError`，被 FastAPI 兜底成 500。

为什么这不是「一个无关紧要的 500」：`source` 是**客户端**给的输入，未注册的值属于客户端
错误 —— `/doc` 已经把这条分工做对了（客户端错误 400、只在服务端解不开时 500）。
没注册的来源要么是打错字，要么是调用了不存在的来源；两种都不该报成服务端故障。

本文件钉住四件事：
1. 未注册 `source` → **400** + `{"error": ...}`（不是 500，也不是静默当成「没筛选」）；
2. 合法 `source` 行为**不变**：`vault:note` / `vault:survey` / `vault:reading` / 族前缀
   `vault` / 完全不传 / 传空串，都照旧 200，且过滤仍然真的在过滤；
3. **过滤后为空是合法结果**（某个已注册来源在本库索引里可能一条都没有）→ 200 + `hits: []`。
   这是同一条缺陷的另一半：只堵「未注册值」会漏掉它；
4. 非法 `lib` 与非法 `source` 同为客户端错误 → 400（`/doc`、`/ask/stream` 早已如此）。

第 3 条必须真跑**语义**分支（`np.stack` 就在那里），故把编码器换成固定向量的假编码器：
bge-m3 的加载在本用例里没有信息量（几十秒、且依赖本机模型缓存），而 SQL 取行、来源过滤、
`np.stack`、白名单兜底这些**被测代码**全部是真实路径。
"""
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
from fastapi.testclient import TestClient

from rag_core import rag_engine
from server import http_server

_VEC_DIM = 1024
_DRIVE_PATH_RE = r"[A-Za-z]:\\"


class _FixedEmbedder:
    """固定向量编码器：让语义分支在没有 bge-m3 的情况下真实跑完。"""

    def encode(self, texts, normalize_embeddings: bool = True):
        return np.ones((len(texts), _VEC_DIM), dtype=np.float32)


def _fake_embedder(self):  # noqa: ANN001 —— 作为 RAGEngine._embedder 的替身（方法位）
    return _FixedEmbedder()


class TestSearchSourceContract(unittest.TestCase):
    """真配置 + 真索引上的契约（不触发语义分支，故无需模型）。"""

    def setUp(self):
        self.client = TestClient(http_server.app)

    # ---------- 1. 未注册 source ----------
    def test_unregistered_source_is_a_client_error(self):
        for source in ("note", "vault:doc", "nonsense", "vault:notregistered"):
            with self.subTest(source=source):
                r = self.client.get("/search", params={
                    "lib": "ai4s", "q": "模板", "topn": 3, "source": source})
                self.assertEqual(r.status_code, 400,
                                 f"未注册 source 应为 400（客户端错误），实得 {r.status_code}: {r.text[:200]}")
                ctype = r.headers.get("content-type", "").split(";")[0].strip()
                self.assertEqual(ctype, "application/json")
                body = r.json()
                # 理由必须可见（前端只读 error 字段），且必须点出是 source 的问题
                self.assertIn("error", body)
                self.assertIn("source", body["error"])
                self.assertNotRegex(r.text, _DRIVE_PATH_RE, "错误体泄漏了文件系统路径")

    def test_bad_lib_is_a_client_error_too(self):
        """lib 与 source 同为客户端输入：非法 lib 不得落成 500（与 /doc、/ask/stream 一致）。"""
        r = self.client.get("/search", params={"lib": "nope", "q": "模板"})
        self.assertEqual(r.status_code, 400, r.text)
        self.assertIn("error", r.json())

    # ---------- 2. 合法 source 行为不变 ----------
    def test_registered_sources_still_filter_and_succeed(self):
        for source in ("vault:note", "vault:survey", "vault:reading", "vault"):
            with self.subTest(source=source):
                r = self.client.get("/search", params={
                    "lib": "ai4s", "q": "模板", "mode": "bm25", "topn": 5, "source": source})
                self.assertEqual(r.status_code, 200, r.text)
                hits = r.json()["hits"]
                self.assertIsInstance(hits, list)
                for h in hits:
                    self.assertTrue(h["source"].startswith(source),
                                    f"过滤未生效：{h['source']} 不以 {source} 开头")

    def test_absent_or_empty_source_is_unchanged(self):
        for params in ({"lib": "ai4s", "q": "模板", "mode": "bm25", "topn": 3},
                       {"lib": "ai4s", "q": "模板", "mode": "bm25", "topn": 3, "source": ""}):
            with self.subTest(params=params):
                r = self.client.get("/search", params=params)
                self.assertEqual(r.status_code, 200, r.text)
                self.assertIsInstance(r.json()["hits"], list)


class TestEmptySourceFilter(unittest.TestCase):
    """已注册来源在本库**没有**任何行时，必须是空结果而不是 500（Defect 2 的另一半）。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="rag_stack_t49_search_")
        self.addCleanup(self._tmp.cleanup)
        tmp = Path(self._tmp.name)

        src = Path(rag_engine.__file__).resolve().parent / "config_ai4s.json"
        cfg = json.loads(src.read_text(encoding="utf-8"))
        cfg["workspace"] = str(tmp / "workspace")
        cfg["index_db"] = str(tmp / "idx.db")
        cfg["faiss_index"] = str(tmp / "idx.faiss")
        cfg_path = tmp / "config_ai4s.json"
        cfg_path.write_text(json.dumps(cfg, ensure_ascii=False, indent=2),
                            encoding="utf-8", newline="\n")

        self.engine = rag_engine.RAGEngine(str(cfg_path))
        # 索引里**只有** vault:note 的行：`vault:reading` 是本库已注册、但一条都没有的来源。
        self.engine.index_docs([
            ("vault:note", "01-Literature/甲.md", "甲", "note", "", "数字孪生的方法"),
            ("vault:note", "01-Literature/乙.md", "乙", "note", "", "数字孪生的局限"),
        ])
        con = self.engine._connect()
        for (rowid,) in con.execute("SELECT rowid FROM chunks").fetchall():
            con.execute("INSERT OR REPLACE INTO vecs (rowid, vec) VALUES (?,?)",
                        (rowid, np.ones(_VEC_DIM, dtype=np.float32).tobytes()))
        con.commit()
        con.close()

        # 编码器换成固定向量：语义分支（`np.stack` 所在处）照样真跑
        self.embedder = mock.patch.object(rag_engine.RAGEngine, "_embedder", _fake_embedder)
        self.embedder.start()
        self.addCleanup(self.embedder.stop)
        self.get_engine = mock.patch.object(rag_engine, "get_engine", return_value=self.engine)
        self.get_engine.start()
        self.addCleanup(self.get_engine.stop)

        self.client = TestClient(http_server.app)

    def test_semantic_search_returns_empty_instead_of_raising(self):
        # 引擎层直测：过滤后无行时**返回空列表**，而不是 `np.stack([]) -> ValueError`
        self.assertEqual(self.engine.semantic_search("数字孪生", 5, "vault:reading"), [])
        # 同一引擎、同一查询：来源有行时必须真的取到（防止「永远返回空」也能变绿）
        self.assertGreaterEqual(len(self.engine.semantic_search("数字孪生", 5, "vault:note")), 1)

    def test_endpoint_reports_empty_hits_not_a_server_error(self):
        r = self.client.get("/search", params={
            "lib": "ai4s", "q": "数字孪生", "mode": "semantic",
            "topn": 5, "source": "vault:reading"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["hits"], [])

    def test_endpoint_still_returns_rows_for_a_source_that_has_them(self):
        r = self.client.get("/search", params={
            "lib": "ai4s", "q": "数字孪生", "mode": "semantic",
            "topn": 5, "source": "vault:note"})
        self.assertEqual(r.status_code, 200, r.text)
        hits = r.json()["hits"]
        self.assertGreaterEqual(len(hits), 1, "假编码器下的真实语义分支没有返回任何命中")
        for h in hits:
            self.assertEqual(h["source"], "vault:note")


if __name__ == "__main__":
    unittest.main()
