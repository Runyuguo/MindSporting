"""T16: Faiss ANN 查询路径的行为与量纲对照测试。

默认只读：真库 **两库各一份**（ai4s 13,806 行 / mito 10,020 行）+ 已构建的 HNSW 索引；
本测试不写 vault，也不覆盖真库索引 —— 唯一的例外是
`TestAnnBuildUsesConfiguredGraphParams`（T58），它在**临时目录**里真建一张小索引来
闭合「配置 → 落盘索引」这条链子。
"""
import json
import os
import pathlib
import tempfile
import unittest
from unittest import mock

# 模型只从本地缓存加载（T63）：本文件会被**单跑**（tasks.md:3215/3287 的
# `discover -s tests -p "test_ann.py"`），此时没有任何别的模块替它设过离线标志，
# 首次语义检索会挂在 huggingface.co 的连接上而不是在算（实测单跑 >15 分钟、
# 5.3s CPU、~660MB RSS）。必须在导入 rag_core 之前设定 —— 不依赖导入顺序，
# 也不依赖「哪个测试模块先被导入」。与 tests/test_isolation.py 同一手法。
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

import numpy as np  # noqa: E402

from rag_core import rag_engine  # noqa: E402


class _FakeEmbedder:
    """固定向量编码器：让回退路径在没有模型/没有索引时也能真跑。"""

    def encode(self, texts, normalize_embeddings=True):
        return np.ones((len(texts), 1024), dtype=np.float32)


class TestAnnPath(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        rag_engine.reset_engines()
        cls.engine = rag_engine.get_engine("ai4s")

    def test_ann_score_is_comparable_to_exact(self):
        """ANN 的 `score` 必须与精确路径**同量纲**（等价余弦），否则阈值过滤会静默清空语义检索。

        索引是 `metric_type = 1`（L2），精确路径给余弦；对归一化向量二者只差
        `cos = 1 − d/2`。若直接把 L2 距离当 score 回写，`min_cos` 一旦配上正阈值，
        `mode="semantic"` 会被 `apply_threshold` 整批滤掉。
        """
        q = "线粒体自噬"
        ann = self.engine.semantic_search(q, topn=5)
        exact = {h["rowid"]: h["score"] for h in self.engine.semantic_search_exact(q, topn=50)}
        self.assertTrue(ann, "ANN 返回空，无法比较")
        compared = 0
        for h in ann:
            if h["rowid"] in exact:
                compared += 1
                self.assertAlmostEqual(
                    h["score"], exact[h["rowid"]], delta=0.01,
                    msg=f"rowid={h['rowid']}: ANN score 与 exact 语义不一致")
        # 计数器不可省：上面每条比较都在 `if h["rowid"] in exact` 之内，
        # **一条都不命中 exact top-50 时整个循环体不执行**，测试会因「零次比较」变绿。
        # 与 test_source_filter_over_fetches 的非空断言同一类防「因错误的原因变绿」。
        self.assertTrue(
            compared,
            f"ANN 的 rowid 无一落在 exact top-50 内（ann={len(ann)} 条，exact={len(exact)} 条），"
            "本次未执行任何 score 比较 —— 断言失去判别力")

    def test_ann_search_does_not_full_scan_vecs(self):
        """ANN 路径不得再执行 JOIN vecs 的全表读取。"""
        src = (rag_engine.__file__ and open(rag_engine.__file__, encoding="utf-8").read()) or ""
        ann_body = src.split("def semantic_search(", 1)[1].split("\n    def ", 1)[0]
        self.assertNotIn("JOIN vecs", ann_body)

    def test_source_filter_over_fetches(self):
        hits = self.engine.semantic_search("mitochondria", topn=5, source_prefix="vault:note")
        # 非空断言不可省：`all(...)` 在 hits == [] 时**恒真**，
        # 于是「一条都没取到」也会变绿——正是本项目反复出现的「因错误的原因变绿」。
        self.assertTrue(hits, "vault:note 一条都没取到：all(...) 会因空集恒真")
        self.assertTrue(all(h["source"].startswith("vault:note") for h in hits))


class _AnnRecallChecks:
    """recall@10 对抗精确路径的**分库**检查矩阵（`LIB` 由子类给出）。

    为什么必须两库各跑一遍（复审 I1）：两库的向量规模与索引都不同（ai4s 13,806 行 /
    mito 10,020 行），同一句查询的 recall **不是同一个数** —— 断言只写在一个库上，
    得到的是一句只对该库成立的结论，而它的名字（与 T16 的标题）写的是「ANN recall@10 ≥
    0.95」。实测 mito 的 `oxidative phosphorylation` 就是 0.90。

    本矩阵**不**为了迁就某个库而放宽阈值：阈值是 T16 的验收口径，由所有者裁定；
    这里只负责把每个库自己的数如实量出来、量不到就红。

    2026-09-20 复审 I1 实测（固定的五条查询，`topn=10`，`ann_ef_search=1024`）：
    ai4s 五条全 1.00；mito 四条 1.00、`oxidative phosphorylation` **0.90**（9/10）——
    于是本文件在 mito 上如实变红。

    2026-09-21 T58 结案：红的原因是**建图期**参数弱（落盘索引读回来 `M=32`、
    `efConstruction=40`，即 faiss 默认值；查询期 `ann_ef_search` 从 1024 加到 4096
    都纹丝不动 ⇒ 瓶颈在建图不在查询期）。按 `build_vectors` 现在用的
    `ann_hnsw_m` / `ann_hnsw_ef_construction` 重建 mito 后，五条查询**全 1.00**，
    阈值原样保留 0.95。重建前后的逐条数字见 task-58-report.md §4。
    """

    LIB = ""

    @classmethod
    def setUpClass(cls):
        rag_engine.reset_engines()
        cls.engine = rag_engine.get_engine(cls.LIB)

    def test_faiss_index_is_actually_loaded(self):
        """度量有效性的前提：索引没加载时 `semantic_search` 会**回退到精确路径**，
        于是 recall 恒为 1.0 —— 下面那条断言会因错误的原因变绿（本库根本没在测 ANN）。
        """
        self.assertIsNotNone(self.engine._faiss_index(),
                             f"{self.LIB}: 索引未加载，回退路径下 recall 恒为 1.0")
        self.assertGreater(len(self.engine._faiss_rows), 0)

    def test_ann_recall_against_exact_is_high(self):
        """ANN 是近似检索；在固定查询样本上要求 recall@10 ≥ 0.95（**逐库**）。

        分母是 **exact（真值）**，故必须先证明 exact 自己不是空的 ——
        否则「双方都空」会让本断言恒真、什么也没证明。
        """
        queries = [
            "mitochondrial DNA replication",
            "线粒体自噬",
            "oxidative phosphorylation",
            "PINK1 Parkin pathway",
            "apoptosis regulation",
        ]
        for q in queries:
            with self.subTest(lib=self.LIB, query=q):
                exact_hits = self.engine.semantic_search_exact(q, topn=10)
                self.assertGreaterEqual(
                    len(exact_hits), 10,
                    f"{self.LIB} / {q}: 真值集本身不足 10 条，本条断言失去判别力")
                ann = {h["rowid"] for h in self.engine.semantic_search(q, topn=10)}
                exact = {h["rowid"] for h in exact_hits}
                overlap = len(ann & exact) / len(exact)
                self.assertGreaterEqual(
                    overlap, 0.95, f"{self.LIB} / {q}: recall@10 = {overlap}")


class TestAnnRecallAi4s(_AnnRecallChecks, unittest.TestCase):
    LIB = "ai4s"


class TestAnnRecallMito(_AnnRecallChecks, unittest.TestCase):
    LIB = "mito"


class TestAnnFallbackToExact(unittest.TestCase):
    """索引不可用时必须**回退**到精确路径，而不是返回空列表。

    这条分支若退化成 `return []`，`search()` 的混合路径会把空语义结果当作信号、
    整体降级为纯 BM25 —— 静默降质，且线上看不出任何异常。
    """

    def setUp(self):
        tmp = pathlib.Path(tempfile.mkdtemp())
        cfg = json.loads(
            (pathlib.Path(rag_engine.__file__).parent / "config_ai4s.json")
            .read_text(encoding="utf-8"))
        cfg["workspace"] = str(tmp / "ws")
        cfg["index_db"] = str(tmp / "idx.db")
        cfg["faiss_index"] = str(tmp / "missing.faiss")   # 索引文件不存在
        cfg_path = tmp / "config_ai4s.json"
        cfg_path.write_text(json.dumps(cfg, ensure_ascii=False), encoding="utf-8",
                            newline="\n")
        self.engine = rag_engine.RAGEngine(str(cfg_path))
        self.engine.index_docs([
            ("vault:note", "01-Literature/甲.md", "甲", "note", "", "数字孪生的方法"),
            ("vault:note", "01-Literature/乙.md", "乙", "note", "", "数字孪生的局限"),
        ])
        con = self.engine._connect()
        for (rowid,) in con.execute("SELECT rowid FROM chunks").fetchall():
            con.execute("INSERT OR REPLACE INTO vecs (rowid, vec) VALUES (?,?)",
                        (rowid, np.ones(1024, dtype=np.float32).tobytes()))
        con.commit()
        con.close()
        p = mock.patch.object(rag_engine.RAGEngine, "_embedder", lambda self: _FakeEmbedder())
        p.start()
        self.addCleanup(p.stop)

    def test_missing_index_falls_back_instead_of_returning_empty(self):
        self.assertIsNone(self.engine._faiss_index(), "索引不存在时应拿到 None 触发回退")
        hits = self.engine.semantic_search("数字孪生", 5)
        self.assertTrue(hits, "索引不可用时返回了空列表：混合路径会因此静默降级为纯 BM25")

    def test_fallback_still_returns_empty_when_source_has_no_rows(self):
        # 空**依然是合法的空**：回退不等于「永远非空」，来源确实没有行时必须返回空。
        self.assertEqual(self.engine.semantic_search("数字孪生", 5, "vault:reading"), [])

    def test_fallback_encodes_the_query_exactly_once(self):
        """回退路径不得重复编码：`semantic_search` 必须在**判定索引之后**才编码。

        若先编码再判索引，回退分支会把那次锁内的 bge-m3 推理白白丢掉、
        再由 `semantic_search_exact` 重编一次（2 次推理/查询，且并发下白占锁）。
        """
        calls = []
        real = self.engine.encode_texts

        def counting(texts):
            calls.append(texts)
            return real(texts)

        with mock.patch.object(self.engine, "encode_texts", counting):
            hits = self.engine.semantic_search("数字孪生", 5)

        self.assertTrue(hits, "回退路径没有取到结果")
        self.assertEqual(
            len(calls), 1,
            f"回退路径编码了 {len(calls)} 次（应立即返回并要求恰好 1 次）："
            "说明索引判定之前就编了码，白付一次推理")


class TestAnnIndexRowMapMismatch(unittest.TestCase):
    """索引与 `rows.json` 长度不一致 ⇒ **视为加载失败**，走精确回退（复审 M3）。

    两个方向都是坏的，且坏法不同：

    - `rows.json` **短**于索引：`self._faiss_rows[int(i)]` 抛 `IndexError` 冒出
      `search()` —— 回退契约承诺的是「降级」，不是把降级变成 500；
    - `rows.json` **长**于索引：位置映射整体错位（索引是上一次构建的），ANN 的名次被安到
      **别的 rowid** 上 —— 静默给出错误证据。T16 已把这条路径接成生产读路径，T56 又让
      引用标记可跳转，错的证据会一路错到读者眼前。

    写入侧（`build_vectors`）本就非原子（先写索引、后写 rows），故这不是假想状态。
    处理放在**加载期**：`index.ntotal != len(rows)` ⇒ `self._faiss = False` + 告警，
    与既有的失败契约一致（见 `TestAnnFallbackToExact`）。
    """

    def setUp(self):
        tmp = pathlib.Path(tempfile.mkdtemp())
        cfg = json.loads(
            (pathlib.Path(rag_engine.__file__).parent / "config_ai4s.json")
            .read_text(encoding="utf-8"))
        cfg["workspace"] = str(tmp / "ws")
        cfg["index_db"] = str(tmp / "idx.db")
        cfg["faiss_index"] = str(tmp / "idx.faiss")
        cfg_path = tmp / "config_ai4s.json"
        cfg_path.write_text(json.dumps(cfg, ensure_ascii=False), encoding="utf-8",
                            newline="\n")
        self.engine = rag_engine.RAGEngine(str(cfg_path))
        self.engine.index_docs([
            ("vault:note", "01-Literature/甲.md", "甲", "note", "", "数字孪生的方法"),
            ("vault:note", "01-Literature/乙.md", "乙", "note", "", "数字孪生的局限"),
        ])
        con = self.engine._connect()
        self.rowids = [r for (r,) in
                       con.execute("SELECT rowid FROM chunks ORDER BY rowid").fetchall()]
        for rowid in self.rowids:
            con.execute("INSERT OR REPLACE INTO vecs (rowid, vec) VALUES (?,?)",
                        (rowid, np.ones(1024, dtype=np.float32).tobytes()))
        con.commit()
        con.close()
        p = mock.patch.object(rag_engine.RAGEngine, "_embedder", lambda self: _FakeEmbedder())
        p.start()
        self.addCleanup(p.stop)

    def _write_pair(self, *, vectors: int, rows: list[int]) -> None:
        """写一对（索引, rows.json）：`vectors` 条向量 / `rows` 条 rowid 映射。"""
        import faiss
        index = faiss.IndexHNSWFlat(1024, 32)
        index.add(np.ones((vectors, 1024), dtype=np.float32))
        p = pathlib.Path(self.engine.cfg["faiss_index"])
        p.parent.mkdir(parents=True, exist_ok=True)
        faiss.write_index(index, str(p))
        p.with_suffix(p.suffix + ".rows.json").write_text(
            json.dumps(rows), encoding="utf-8", newline="\n")

    def test_matching_lengths_load_normally(self):
        """反例守卫：长度一致时索引照常加载（否则「一律判失败」也能让下面两条变绿）。"""
        self._write_pair(vectors=2, rows=self.rowids)
        self.assertIsNotNone(self.engine._faiss_index())
        self.assertEqual(self.engine._faiss_rows, self.rowids)

    def test_short_rows_json_is_a_load_failure_not_an_indexerror(self):
        self._write_pair(vectors=2, rows=self.rowids[:1])
        with self.assertLogs("rag_core.rag_engine", level="WARNING") as logs:
            self.assertIsNone(self.engine._faiss_index(),
                              "rows.json 短于索引时仍然加载了索引：search() 会抛 IndexError")
        self.assertIn("长度不一致", "\n".join(logs.output),
                      "判失败却不出声：线上只表现为「语义检索变慢」，看不出索引没在跑")
        hits = self.engine.semantic_search("数字孪生", 5)
        self.assertTrue(hits, "加载失败后没有回退到精确路径（回退契约要求降级而非抛错）")
        self.assertTrue(all(h["rowid"] in self.rowids for h in hits))

    def test_long_rows_json_is_a_load_failure_not_silently_wrong_rowids(self):
        self._write_pair(vectors=2, rows=self.rowids + [99999])
        with self.assertLogs("rag_core.rag_engine", level="WARNING") as logs:
            self.assertIsNone(self.engine._faiss_index(),
                              "rows.json 长于索引时仍然加载了索引：位置映射整体错位，"
                              "ANN 名次会被安到别的 rowid 上（静默给出错误证据）")
        self.assertIn("长度不一致", "\n".join(logs.output))
        hits = self.engine.semantic_search("数字孪生", 5)
        self.assertTrue(hits, "加载失败后没有回退到精确路径")
        self.assertNotIn(99999, {h["rowid"] for h in hits},
                         "映射错位的 rowid 漏进了结果")


def _temp_engine(tmp: pathlib.Path, search_overrides: dict | None = None,
                 drop_keys: tuple[str, ...] = ()):
    """在临时目录里造一个只含 2~3 篇小笔记的引擎（真 faiss，假编码器）。

    `search_overrides` 追加 / 覆盖 `search` 子键；`drop_keys` 从 `search` 里**删掉**键，
    用来验证「旧配置缺这一对键时默认值仍然生效」。
    """
    cfg = json.loads(
        (pathlib.Path(rag_engine.__file__).parent / "config_ai4s.json")
        .read_text(encoding="utf-8"))
    cfg["workspace"] = str(tmp / "ws")
    cfg["index_db"] = str(tmp / "idx.db")
    cfg["faiss_index"] = str(tmp / "idx.faiss")
    for k in drop_keys:
        cfg["search"].pop(k, None)
    cfg["search"].update(search_overrides or {})
    cfg_path = tmp / "config_ai4s.json"
    cfg_path.write_text(json.dumps(cfg, ensure_ascii=False), encoding="utf-8", newline="\n")
    return rag_engine.RAGEngine(str(cfg_path))


class TestAnnBuildUsesConfiguredGraphParams(unittest.TestCase):
    """`build_vectors` 必须**真的**按配置的建图参数建图（宪法 §3.1：能力要有调用点 + 覆盖它的测试）。

    为什么非有不可（T58）：`M` 与 `efConstruction` 只作用于**建图那一刻**。键名写错、
    忘了在 `add()` 之前赋值、或读成了别的键，索引都照样能建出来 —— 只是图质量静默退回
    faiss 默认（`efConstruction` = 40），而**查询期补不回来**：实测 mito 把 `ann_ef_search`
    从 1024 加到 4096，recall@10 纹丝不动停在 0.90。

    故这里读回**落盘索引文件**里的图参数（faiss 的 `write_HNSW` 会序列化 `M` 的邻居表与
    `efConstruction`），闭合「配置 → 索引文件」这条链子 —— 断言代码里那几个字面量不算数。
    """

    def setUp(self):
        tmp = pathlib.Path(tempfile.mkdtemp())
        self.engine = _temp_engine(
            tmp, {"ann_hnsw_m": 48, "ann_hnsw_ef_construction": 320})
        self.engine.index_docs([
            ("vault:note", "01-Literature/甲.md", "甲", "note", "", "数字孪生的方法"),
            ("vault:note", "01-Literature/乙.md", "乙", "note", "", "数字孪生的局限"),
            ("vault:note", "01-Literature/丙.md", "丙", "note", "", "数字孪生的边界"),
        ])
        # 预先塞满 vecs：这样 build_vectors 的嵌入循环无事可做，本测试只量**建图**这一段
        # （否则会在没有模型的环境里真的去加载 bge-m3）。
        con = self.engine._connect()
        for (rowid,) in con.execute("SELECT rowid FROM chunks").fetchall():
            con.execute("INSERT OR REPLACE INTO vecs (rowid, vec) VALUES (?,?)",
                        (rowid, np.ones(1024, dtype=np.float32).tobytes()))
        con.commit()
        con.close()
        p = mock.patch.object(rag_engine.RAGEngine, "_embedder", lambda self: _FakeEmbedder())
        p.start()
        self.addCleanup(p.stop)

    @staticmethod
    def _written_params(path: str) -> tuple[int, int, int]:
        """读回落盘索引：返回 (M, efConstruction, ntotal)。"""
        import faiss
        index = faiss.read_index(path)
        # faiss 1.15 的 python 绑定没有 `hnsw.M`：第 0 层的邻居数恒为 2*M。
        return index.hnsw.nb_neighbors(0) // 2, index.hnsw.efConstruction, index.ntotal

    def test_build_writes_the_configured_graph_params(self):
        self.engine.build_vectors()
        m, efc, ntotal = self._written_params(self.engine.cfg["faiss_index"])
        self.assertEqual(ntotal, 3, "索引条数应等于库内向量数")
        self.assertEqual(m, 48, "落盘索引的 M 不是配置值：建图用了别的 M")
        self.assertEqual(
            efc, 320,
            "落盘索引的 efConstruction 不是配置值：多半是没在 add() 之前赋值，"
            "或读错了配置键 —— 图会静默退回 faiss 默认的 40")

    def test_missing_keys_still_build_with_the_shipped_defaults(self):
        """旧配置（或 pod 上被裁过的 config）缺这一对键时，默认值必须是**确定的高质量值**。

        留空退回 faiss 默认（`efConstruction` = 40）正是 T58 要根除的东西，故默认值
        本身也要有断言，否则「配置缺失 ⇒ 悄悄退化成弱图」会重新变成无声故障。
        """
        tmp = pathlib.Path(tempfile.mkdtemp())
        engine = _temp_engine(tmp, drop_keys=("ann_hnsw_m", "ann_hnsw_ef_construction"))
        engine.index_docs([("vault:note", "01-Literature/甲.md", "甲", "note", "", "数字孪生")])
        con = engine._connect()
        for (rowid,) in con.execute("SELECT rowid FROM chunks").fetchall():
            con.execute("INSERT OR REPLACE INTO vecs (rowid, vec) VALUES (?,?)",
                        (rowid, np.ones(1024, dtype=np.float32).tobytes()))
        con.commit()
        con.close()
        engine.build_vectors()
        m, efc, _ = self._written_params(engine.cfg["faiss_index"])
        self.assertEqual(m, rag_engine._DEFAULTS["search"]["ann_hnsw_m"])
        # 等值断言单独不够：**默认值与配置一起降级**时它跟着一起变绿（T59 实测 M=32 仍 OK）。
        # 故与下面的 efConstruction 一样补一条**绝对下界**，让协同降级红出来。
        self.assertGreaterEqual(m, 64, "默认 M 低于 64：默认值不该是弱图")
        self.assertEqual(efc, rag_engine._DEFAULTS["search"]["ann_hnsw_ef_construction"])
        self.assertGreaterEqual(efc, 200, "默认 efConstruction 低于 200：默认值不该是弱图")


if __name__ == "__main__":
    unittest.main()

