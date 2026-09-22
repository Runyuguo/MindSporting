"""T20：双实现评测脚本（`scripts/eval.py`）的判别力测试。

本文件的每一层都**不加载模型、不打开真实索引**（真跑 99 条查询是 `scripts/eval.py`
本体的事，见 task-20-report.md 的命令与实测输出）：

- `TestMetrics`：纯度量（brief 指定的 `compute_metrics` 缝）；
- `TestSummarize`：控制器 Ruling 1 —— 三口径指标，**SC-1 取「排除追问」那一份**；
- `TestFollowupProtocol`：控制器 Ruling 2 —— 指代型追问必须以**先行词条目自己的问句**
  为上一轮去消解，且非追问条目不得被改写；
- `TestVaultGuard`：宪法 §2.1 —— 新旧两套实现都是只读跑，vault 不得有任何落地变化；
- `TestLegacyLoading`：控制器 Ruling 3 —— 旧实现取不到检索函数时必须**响亮失败**，
  绝不返回一个看似有效的空基线。

为什么 `TestFollowupProtocol` 用假引擎而不用真引擎：真引擎要 3.6s 加载 bge-m3、
3.3s 加载交叉编码器，而这里要钉的是**协议**（谁被当作上一轮、什么文本被送去检索），
不是检索质量本身。检索质量由真跑产生的那四份 JSON 负责。
"""
import contextlib
import io
import json
import os
import pathlib
import shutil
import tempfile
import unittest
from unittest import mock

import numpy as np

from rag_core import rag_engine
from scripts import build_eval_set
from scripts import eval as evalmod


def _temp_engine(tmp: pathlib.Path, lib: str = "ai4s", *, seed: bool = True):
    """临时配置上的**真** `RAGEngine`：临时库里放 2 条 chunk + 对应向量。

    不加载任何模型（`index_docs` 只写库、不做嵌入），故可以放心在单测里建。
    `seed=False` 得到一口**空库** —— `_ensure_schema()` 会替它建出表来，
    正是 I4 那条「指错 index_db 也一切正常」的现场。
    """
    cfg = json.loads((pathlib.Path(rag_engine.__file__).parent / f"config_{lib}.json")
                     .read_text(encoding="utf-8"))
    cfg["workspace"] = str(tmp / "ws")
    cfg["index_db"] = str(tmp / "idx.db")
    cfg["faiss_index"] = str(tmp / "missing.faiss")   # 索引不存在：本测试不检索
    cfg_path = tmp / f"config_{lib}.json"
    cfg_path.write_text(json.dumps(cfg, ensure_ascii=False), encoding="utf-8", newline="\n")
    engine = rag_engine.RAGEngine(str(cfg_path))
    if seed:
        engine.index_docs([
            ("vault:note", "01-Literature/a.md", "甲", "note", "", "数字孪生的方法"),
            ("vault:note", "01-Literature/b.md", "乙", "note", "", "数字孪生的局限"),
        ])
        con = engine._connect()
        for (rowid,) in con.execute("SELECT rowid FROM chunks").fetchall():
            con.execute("INSERT OR REPLACE INTO vecs (rowid, vec) VALUES (?,?)",
                        (rowid, np.ones(1024, dtype=np.float32).tobytes()))
        con.commit()
        con.close()
    return engine


class TestMetrics(unittest.TestCase):
    """brief Step 1 的四条 + 三条补强。

    补强的理由：brief 的 ndcg 用例只断言「理想顺序得 1.0」——很多**错误**实现也能得 1.0
    （例如恒返回 1.0、或把 dcg 与 ideal 写成同一个式子）。故补一条「真实但非理想顺序」
    与一条「recall 是比例而非命中即 1」。
    """

    def test_recall_and_mrr_on_a_perfect_ranking(self):
        ranked = [["a", "b"], ["c"]]
        relevant = [{"a"}, {"c"}]
        m = evalmod.compute_metrics(ranked, relevant, ks=[1, 10])
        self.assertEqual(m["recall@1"], 1.0)
        self.assertEqual(m["recall@10"], 1.0)
        self.assertEqual(m["mrr"], 1.0)

    def test_mrr_penalises_late_hits(self):
        m = evalmod.compute_metrics([["x", "a"]], [{"a"}], ks=[10])
        self.assertAlmostEqual(m["mrr"], 0.5)

    def test_miss_gives_zero(self):
        m = evalmod.compute_metrics([["x", "y"]], [{"a"}], ks=[10])
        self.assertEqual(m["mrr"], 0.0)
        self.assertEqual(m["recall@10"], 0.0)

    def test_ndcg_is_one_for_ideal_order(self):
        m = evalmod.compute_metrics([["a", "b"]], [{"a", "b"}], ks=[10])
        self.assertAlmostEqual(m["ndcg@10"], 1.0, places=6)

    def test_ndcg_penalises_a_late_relevant_doc(self):
        """命中但排在后面：ndcg 必须低于 1（恒返回 1.0 的假实现会在这里红）。"""
        m = evalmod.compute_metrics([["x", "a"]], [{"a"}], ks=[10])
        self.assertAlmostEqual(m["ndcg@10"], 1 / 1.584962500721156, places=4)
        self.assertLess(m["ndcg@10"], 1.0)

    def test_recall_is_a_fraction_of_the_relevant_set(self):
        """recall = |命中∩相关| / |相关|，不是「有没有命中」。"""
        m = evalmod.compute_metrics([["a", "x"]], [{"a", "b"}], ks=[10])
        self.assertAlmostEqual(m["recall@10"], 0.5)

    def test_ks_actually_slice_the_ranking(self):
        ranked = [["x", "y", "z", "w", "a"]]
        relevant = [{"a"}]
        m = evalmod.compute_metrics(ranked, relevant, ks=[1, 5])
        self.assertEqual(m["recall@1"], 0.0)
        self.assertEqual(m["recall@5"], 1.0)

    def test_n_is_the_number_of_ranked_items(self):
        m = evalmod.compute_metrics([["a"], ["b"], ["c"]], [{"a"}, {"b"}, {"c"}], ks=[10])
        self.assertEqual(m["n"], 3)

    def test_empty_input_does_not_raise(self):
        m = evalmod.compute_metrics([], [], ks=[10])
        self.assertEqual(m["n"], 0)
        self.assertEqual(m["recall@10"], 0.0)


ITEMS = [
    {"id": "1", "query": "线粒体自噬的机制", "relevant": ["a.md"]},
    {"id": "2", "query": "复合物 I 的质子泵", "relevant": ["b.md"]},
    {"id": "3", "query": "那它的调控因子呢", "relevant": ["c.md"],
     "note": "followup", "antecedent": "1"},
]


class TestSummarize(unittest.TestCase):
    """Ruling 1：SC-1 的数值必须**排除**追问条目，两口径都要出现在输出 JSON 里。

    固定装置：条目 1 命中、条目 2 未命中、条目 3（追问）命中。于是
    SC-1 口径（1、2）recall@1 = 0.5，全集 recall@1 = 2/3，追问口径 = 1.0。
    """

    def setUp(self):
        self.ranked = [["a.md"], ["x.md"], ["c.md"]]
        self.out = evalmod.summarize("new", "ai4s", 10, ITEMS, self.ranked, [1, 10])

    def test_metrics_is_the_sc1_scope_excluding_followups(self):
        self.assertEqual(self.out["metrics_scope"], "excluding_followups")
        self.assertEqual(self.out["metrics"]["n"], 2)
        self.assertEqual(self.out["metrics"]["recall@1"], 0.5)

    def test_all_items_scope_includes_followups(self):
        self.assertEqual(self.out["metrics_all_items"]["n"], 3)
        self.assertAlmostEqual(self.out["metrics_all_items"]["recall@1"], round(2 / 3, 4))

    def test_followup_scope_is_the_followup_subset_only(self):
        self.assertEqual(self.out["metrics_followups"]["n"], 1)
        self.assertEqual(self.out["metrics_followups"]["recall@1"], 1.0)

    def test_counts_describe_the_split(self):
        self.assertEqual(self.out["counts"],
                         {"all": 3, "followups": 1, "non_followups": 2})

    def test_both_numbers_are_labelled_with_their_sc(self):
        self.assertIn("SC-1", self.out["scopes"]["metrics"])
        self.assertIn("SC-6", self.out["scopes"]["metrics_followups"])

    def test_a_followup_only_set_reports_n_zero_for_the_sc1_scope(self):
        """整集都是追问时 SC-1 口径没有样本：n=0，不得伪装成 0 分或 1 分。"""
        fu = [i for i in ITEMS if i.get("note") == "followup"]
        out = evalmod.summarize("new", "ai4s", 10, fu, [["c.md"]], [10])
        self.assertEqual(out["metrics"]["n"], 0)
        self.assertEqual(out["metrics_followups"]["n"], 1)

    def test_legacy_labels_do_not_claim_a_resolution_that_never_happened(self):
        """旧实现**没有**改写前置（`rank_legacy` 不做消解）：它的追问口径是单轮原句。

        两份产物若都写「按先行词消解后检索」，同一个 scope 名下就装着两次不同的测量，
        而 C-20 的表格把它们并排印在同一行 —— 读者无从分辨哪一栏是消解过的。
        """
        out = evalmod.summarize("legacy", "ai4s", 10, ITEMS, self.ranked, [1, 10])
        for key in ("metrics_all_items", "metrics_followups"):
            with self.subTest(scope=key):
                self.assertIn("单轮", out["scopes"][key])
                self.assertNotIn("消解后检索", out["scopes"][key])
        # SC-6 是**新实现**的口径；旧实现这一栏必须自述它与 SC-6 不是一回事。
        self.assertIn("不是 SC-6", out["scopes"]["metrics_followups"])

    def test_new_kernel_labels_keep_the_resolution_wording(self):
        """新实现留着消解口径的字样（它真的消解了）—— 反例守卫，防「一律改成单轮」。"""
        self.assertIn("按先行词消解后检索", self.out["scopes"]["metrics_followups"])
        self.assertIn("SC-6", self.out["scopes"]["metrics_followups"])
        self.assertIn("消解后检索", self.out["scopes"]["metrics_all_items"])


class TestFollowupProtocol(unittest.TestCase):
    """Ruling 2：追问以**先行词条目自己的问句**为上一轮；非追问条目原样检索。"""

    def _fake_engine(self):
        class Fake:
            def __init__(self):
                self.queries = []
                self.kwargs = []

            def search(self, query, **kwargs):
                self.queries.append(query)
                self.kwargs.append(kwargs)
                return [{"ref": "hit.md"}]

        return Fake()

    def test_prior_of_maps_followup_to_the_antecedent_query(self):
        prior = evalmod.prior_of(ITEMS)
        self.assertEqual(prior, {"3": "线粒体自噬的机制"})

    def test_prior_of_fails_loudly_on_a_dangling_antecedent(self):
        """先行词不成立时**不得**静默退回单轮检索（那正是要避免的错误测量）。"""
        bad = [{"id": "3", "query": "那它呢", "relevant": ["c.md"],
                "note": "followup", "antecedent": "nope"}]
        with self.assertRaises(SystemExit):
            evalmod.prior_of(bad)

    def test_followup_is_resolved_with_the_antecedent_turn(self):
        seen = []

        def resolve(item, prior_query):
            seen.append((item["id"], prior_query))
            return f"{prior_query} {item['query']}", False

        engine = self._fake_engine()
        with mock.patch.object(rag_engine, "get_engine", return_value=engine):
            ranked = evalmod.rank_new("ai4s", ITEMS, 10,
                                      evalmod.prior_of(ITEMS), resolve=resolve)

        self.assertEqual(seen, [("3", "线粒体自噬的机制")],
                         "只有追问条目该被消解，且喂进去的必须是先行词的问句")
        self.assertEqual(
            engine.queries,
            ["线粒体自噬的机制", "复合物 I 的质子泵",
             "线粒体自噬的机制 那它的调控因子呢"],
            "追问必须检索**消解后**的查询，而不是它自己的指代句")
        self.assertEqual(len(ranked), 3)

    def test_without_prior_every_item_is_searched_verbatim(self):
        """brief 的三参调用形态必须仍然可用（= 单轮，不做消解）。"""
        engine = self._fake_engine()
        with mock.patch.object(rag_engine, "get_engine", return_value=engine):
            evalmod.rank_new("ai4s", ITEMS, 10)
        self.assertEqual(engine.queries, [i["query"] for i in ITEMS])

    def test_resolution_is_recorded_per_item(self):
        def resolve(item, prior_query):
            return "线粒体自噬 调控因子", False

        queries, record = evalmod.resolve_followups(
            ITEMS, evalmod.prior_of(ITEMS), resolve=resolve)
        self.assertEqual(queries[2], "线粒体自噬 调控因子")
        self.assertEqual(record["3"]["prior"], "线粒体自噬的机制")
        self.assertTrue(record["3"]["changed"], "改写后与原句不同，changed 必须为真")
        self.assertFalse(record["3"]["degraded"])
        self.assertEqual(set(record), {"3"}, "非追问条目不该有消解记录")

    def test_degraded_resolution_is_recorded(self):
        """"改写降级" 必须可见：否则 SC-6 的数值会被当成「消解过了」来读。"""
        def resolve(item, prior_query):
            return item["query"], True  # 降级 ⇒ 返回原句

        _, record = evalmod.resolve_followups(
            ITEMS, evalmod.prior_of(ITEMS), resolve=resolve)
        self.assertTrue(record["3"]["degraded"])
        self.assertFalse(record["3"]["changed"])

    def test_resolve_followup_feeds_the_antecedent_as_the_previous_turn(self):
        """生产协议：先行词问句 + 助手回复 + 追问 ⇒ `llm.rewrite_query`。

        这里只钉**消息结构**（谁当上一轮），不钉 LLM 的输出——真调用在真跑里发生。
        """
        captured = {}

        def fake_rewrite(messages, **kwargs):
            captured["messages"] = messages
            return type("R", (), {"query": "消解后的查询", "degraded": False})()

        from rag_core import llm
        with mock.patch.object(llm, "rewrite_query", side_effect=fake_rewrite):
            query, degraded = evalmod.resolve_followup(ITEMS[2], "线粒体自噬的机制")

        self.assertEqual(query, "消解后的查询")
        self.assertFalse(degraded)
        roles = [m["role"] for m in captured["messages"]]
        self.assertEqual(roles, ["user", "assistant", "user"])
        self.assertEqual(captured["messages"][0]["content"], "线粒体自噬的机制")
        self.assertEqual(captured["messages"][-1]["content"], "那它的调控因子呢")


class TestRerankDiagnostic(unittest.TestCase):
    """诊断开关 `--no-rerank`：只有 T21 需要它来解释「新内核为何在 MRR 上输给旧基线」。

    T17 把精排改成默认开启。旧系统**没有精排层**，故「新 vs 旧」的差异里混着两件事：
    检索层的差异，与精排带来的重排。要判断 SC-1 的 T1 该定在哪，必须能把后者单独拿掉
    再测一次 —— 该开关就是为此存在的，默认仍与生产一致（开）。
    """

    def _fake_engine(self):
        class Fake:
            def __init__(self):
                self.kwargs = []

            def search(self, query, **kwargs):
                self.kwargs.append(kwargs)
                return [{"ref": "hit.md"}]

        return Fake()

    def test_rerank_is_explicitly_passed_and_defaults_to_on(self):
        engine = self._fake_engine()
        with mock.patch.object(rag_engine, "get_engine", return_value=engine):
            evalmod.rank_queries("ai4s", ["q"], 10)
            evalmod.rank_queries("ai4s", ["q"], 10, rerank=False)
        self.assertEqual(engine.kwargs[0], {"topn": 10, "rerank": True},
                         "精排模式必须**显式**传入：产物要能自述它测的是哪一种")
        self.assertEqual(engine.kwargs[1], {"topn": 10, "rerank": False})

    def test_cli_flag_defaults_to_rerank_on(self):
        self.assertTrue(evalmod.parse_args(["--impl", "new", "--lib", "ai4s"]).rerank)
        self.assertFalse(evalmod.parse_args(
            ["--impl", "new", "--lib", "ai4s", "--no-rerank"]).rerank)


class TestVaultGuard(unittest.TestCase):
    """宪法 §2.1 / spec「只读部署」：新旧两套实现跑评测都不得写 vault。"""

    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="t20_vault_"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        (self.tmp / "01-Literature").mkdir()
        (self.tmp / "01-Literature" / "a.md").write_text("# a\n", encoding="utf-8")

    def test_unchanged_vault_passes(self):
        before = evalmod.vault_snapshot(self.tmp)
        self.assertTrue(before)
        evalmod.assert_vault_unchanged(self.tmp, before)

    def test_new_file_fails_loudly(self):
        before = evalmod.vault_snapshot(self.tmp)
        (self.tmp / "01-Literature" / "b.md").write_text("# b\n", encoding="utf-8")
        with self.assertRaises(SystemExit) as ctx:
            evalmod.assert_vault_unchanged(self.tmp, before)
        self.assertIn("b.md", str(ctx.exception))

    def test_modified_file_fails_loudly(self):
        before = evalmod.vault_snapshot(self.tmp)
        target = self.tmp / "01-Literature" / "a.md"
        target.write_text("# a changed\n", encoding="utf-8")
        os.utime(target, (1, 1))  # 保证 mtime 真的变了（同秒写入在粗粒度文件系统上可能相同）
        with self.assertRaises(SystemExit):
            evalmod.assert_vault_unchanged(self.tmp, before)

    def test_deleted_file_fails_loudly(self):
        before = evalmod.vault_snapshot(self.tmp)
        (self.tmp / "01-Literature" / "a.md").unlink()
        with self.assertRaises(SystemExit):
            evalmod.assert_vault_unchanged(self.tmp, before)

    def test_obsidian_own_state_dir_is_excluded(self):
        """`.obsidian/` 由 Obsidian 自身随时重写，不算我们的写入（同 test_no_vault_write）。

        不排除它，评测会因「别人写的文件」偶发失败 —— 那会诱使后来者删掉这条只读闸门。
        """
        d = self.tmp / ".obsidian"
        d.mkdir()
        (d / "workspace.json").write_text("{}", encoding="utf-8")
        before = evalmod.vault_snapshot(self.tmp)
        (d / "workspace.json").write_text('{"x":1}', encoding="utf-8")
        (d / "app.json").write_text("{}", encoding="utf-8")
        evalmod.assert_vault_unchanged(self.tmp, before)


class TestMainGuards(unittest.TestCase):
    """`main()` 出数前的两道闸门（复审 I2/I4）。

    - **空索引** ⇒ 拒绝出数，而不是产出一份「全 0 指标 + vault_unchanged: true + 退出码 0」
      的产物 —— T1 正是从这些产物推导的（C-20），全 0 看起来像一次成功的测量；
    - **只读闸门触发** ⇒ 消解缓存也不得落盘：产物被拒了，产物背后的输入不该留下。

    这里跑的是 `main()` 本身（检索与 LLM 被替换掉），故钉的是**顺序与闸门**，
    不是检索质量。
    """

    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="t57_main_"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.vault = self.tmp / "vault"
        (self.vault / "01-Literature").mkdir(parents=True)
        (self.vault / "01-Literature" / "a.md").write_text("# a\n", encoding="utf-8")
        self.cache = self.tmp / "followup_resolutions.json"
        self.out = self.tmp / "out.json"
        self.items = [
            {"id": "1", "query": "线粒体自噬", "relevant": ["01-Literature/a.md"]},
            {"id": "2", "query": "那它的调控因子呢", "relevant": ["01-Literature/a.md"],
             "note": "followup", "antecedent": "1"},
        ]

    def _main(self, engine, *, rank=None):
        """跑 `main(--impl new)`：模型、检索、LLM 全部替换；磁盘与闸门是真跑。"""
        rank = rank or (lambda lib, queries, topn, **kw:
                        [["01-Literature/a.md"] for _ in queries])
        with mock.patch.object(evalmod.build_eval_set, "load", return_value=self.items), \
             mock.patch.object(evalmod.build_eval_set, "validate", return_value=None), \
             mock.patch.object(evalmod.build_eval_set, "check_antecedents", return_value=[]), \
             mock.patch.object(evalmod.build_eval_set, "check_refs", return_value=[]), \
             mock.patch.object(evalmod.build_eval_set, "vault_of",
                               return_value=(self.vault, ())), \
             mock.patch.object(rag_engine, "get_engine", return_value=engine), \
             mock.patch.object(evalmod, "followup_resolver",
                               return_value=lambda item, prior: ("消解后的查询", False)), \
             mock.patch.object(evalmod, "rank_queries", side_effect=rank), \
             contextlib.redirect_stdout(io.StringIO()):
            return evalmod.main(["--impl", "new", "--lib", "ai4s", "--topn", "10",
                                 "--resolutions", str(self.cache), "--out", str(self.out)])

    def test_an_empty_index_refuses_before_ranking_instead_of_emitting_metrics(self):
        empty = _temp_engine(self.tmp, seed=False)
        rank = mock.Mock(side_effect=AssertionError("空索引下不得开始排序"))
        with self.assertRaises(SystemExit) as ctx:
            self._main(empty, rank=rank)

        rank.assert_not_called()
        msg = str(ctx.exception)
        self.assertIn("ai4s", msg, "拒绝理由必须点出是哪一库")
        self.assertIn(str(empty.index_db), msg, "拒绝理由必须给出解析到的 DB 路径")
        self.assertFalse(self.out.exists(),
                         "空索引下仍然产出了度量产物 —— 全 0 会被当成一次成功的测量")

    def test_a_non_empty_index_passes_the_guard(self):
        """反例守卫：闸门不得把正常库也挡掉（否则它只会被删掉）。"""
        engine = _temp_engine(self.tmp)
        with mock.patch.object(rag_engine, "get_engine", return_value=engine):
            counts = evalmod.assert_library_index_nonempty("ai4s")
        self.assertGreater(counts["vecs"], 0)
        self.assertGreater(counts["chunks"], 0)

    def test_a_vault_violation_leaves_no_written_cache_behind(self):
        """只读闸门拒数时，消解缓存**不得**已被写盘。"""
        def leaking_rank(lib, queries, topn, **kw):
            (self.vault / "01-Literature" / "leak.md").write_text("x", encoding="utf-8")
            return [["01-Literature/a.md"] for _ in queries]

        with self.assertRaises(SystemExit):
            self._main(_temp_engine(self.tmp), rank=leaking_rank)

        self.assertFalse(self.cache.exists(),
                         "这次运行改动了 vault（已拒绝出数），却仍把消解结果写进了缓存")
        self.assertFalse(self.out.exists())

    def test_a_clean_run_still_writes_the_cache(self):
        """反例守卫：上一条不得靠「干脆不落盘」满足 —— 正常跑完必须留下缓存。"""
        self._main(_temp_engine(self.tmp))

        payload = json.loads(self.cache.read_text(encoding="utf-8"))
        self.assertTrue(self.out.is_file(), "正常跑完却没有产物")
        self.assertEqual(payload["libraries"]["ai4s"]["2"]["query"], "消解后的查询")


class TestLegacyLoading(unittest.TestCase):
    """Ruling 3：旧实现不可用时必须响亮失败，绝不产出看似有效的基线。"""

    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="t20_legacy_"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def _write(self, body: str) -> pathlib.Path:
        p = self.tmp / "fake_legacy_server.py"
        p.write_text(body, encoding="utf-8")
        return p

    def test_missing_search_function_is_a_loud_refusal(self):
        path = self._write("def other():\n    return []\n")
        with self.assertRaises(SystemExit) as ctx:
            evalmod.load_legacy_search(path)
        self.assertIn("fake_legacy_server.py", str(ctx.exception))

    def test_missing_file_reports_the_path(self):
        path = self.tmp / "does_not_exist.py"
        with self.assertRaises((SystemExit, OSError, ImportError, FileNotFoundError)):
            evalmod.load_legacy_search(path)

    def test_import_error_propagates_verbatim(self):
        """导入期异常必须原样抛出（含原始信息）：伪造一个「看起来能跑」的空基线是最坏结果。"""
        path = self._write("raise RuntimeError('legacy exploded: numpy ABI mismatch')\n")
        with self.assertRaises(RuntimeError) as ctx:
            evalmod.load_legacy_search(path)
        self.assertIn("numpy ABI mismatch", str(ctx.exception))

    def test_search_is_found_and_returned(self):
        path = self._write("def search(q, topn=8):\n    return [{'ref': q}]\n")
        mod, fn = evalmod.load_legacy_search(path)
        self.assertEqual(fn("x"), [{"ref": "x"}])

    def test_rag_search_is_the_fallback_name(self):
        path = self._write("def rag_search(q, topn=8):\n    return [{'ref': q}]\n")
        _, fn = evalmod.load_legacy_search(path)
        self.assertEqual(fn("y"), [{"ref": "y"}])

    def test_rank_legacy_maps_hits_to_refs(self):
        path = self._write(
            "def search(q, topn=8):\n"
            "    return [{'ref': '01-Literature/a.md'}, {'path': '01-Literature/b.md'}]\n")
        mod, fn = evalmod.load_legacy_search(path)
        with mock.patch.object(evalmod, "load_legacy_search", return_value=(mod, fn)):
            ranked = evalmod.rank_legacy("ai4s", ITEMS[:2], 10)
        self.assertEqual(ranked, [["01-Literature/a.md", "01-Literature/b.md"]] * 2)

    def test_legacy_module_path_is_derived_from_root_not_hardcoded(self):
        """旧实现路径必须锚在 `ROOT` 上推导（代码内不出现绝对路径），且真的落在盘上。

        「真的存在」这一条不是多余的：它同时是 T20 旧基线探针可跑的前置条件 ——
        路径推导一旦漂移，探针会以「文件不存在」失败，而那正是 Ruling 3 要区分开的
        「旧实现不可用」与「我们找错了地方」。
        """
        for lib, workspace, name in (("ai4s", "AI4S", "ai4s_rag_server.py"),
                                     ("mito", "Mitochondria", "mito_rag_server.py")):
            with self.subTest(lib=lib):
                p = evalmod.legacy_module_path(lib)
                self.assertEqual(p.name, name)
                self.assertEqual(p.parent.name, "rag_mcp")
                self.assertEqual(p.parent.parent.name, workspace)
                self.assertTrue(p.is_relative_to(evalmod.ROOT.parent),
                                "旧实现路径没有锚在仓库根上（疑似写死了绝对路径）")
                self.assertTrue(p.is_file(), f"旧实现不在盘上：{p}")


class TestCliShape(unittest.TestCase):
    """CLI 契约：`--impl {new,legacy}` / `--lib {ai4s,mito}`；两库绝不合并成一个数。"""

    def test_parser_rejects_unknown_impl_and_lib(self):
        with self.assertRaises(SystemExit):
            evalmod.parse_args(["--impl", "old", "--lib", "ai4s"])
        with self.assertRaises(SystemExit):
            evalmod.parse_args(["--impl", "new", "--lib", "both"])

    def test_parser_defaults_are_topn_10(self):
        args = evalmod.parse_args(["--impl", "new", "--lib", "mito"])
        self.assertEqual(args.topn, 10)

    def test_eval_set_path_is_per_library(self):
        self.assertEqual(evalmod.eval_set_path("ai4s").name, "ai4s.json")
        self.assertEqual(evalmod.eval_set_path("mito").parent.name, "eval_set")


class TestJsonArtifacts(unittest.TestCase):
    """JSON 产物契约：UTF-8、无 BOM、LF、`ensure_ascii=False`（同 T19 的评测集）。"""

    def test_dump_is_utf8_without_bom_and_lf(self):
        payload = {"lib": "ai4s", "note": "中文不得被转义"}
        with tempfile.TemporaryDirectory() as d:
            out = pathlib.Path(d) / "o.json"
            evalmod.write_json(out, payload)
            raw = out.read_bytes()
        self.assertNotIn(b"\xef\xbb\xbf", raw, "不得写 BOM")
        self.assertNotIn(b"\r\n", raw, "行尾必须是 LF")
        self.assertIn("中文".encode("utf-8"), raw, "非 ASCII 必须原样写入（ensure_ascii=False）")
        self.assertEqual(json.loads(raw.decode("utf-8")), payload)

    def test_write_json_creates_missing_parent(self):
        with tempfile.TemporaryDirectory() as d:
            out = pathlib.Path(d) / "nested" / "deep" / "o.json"
            evalmod.write_json(out, {"a": 1})
            self.assertTrue(out.is_file())


if __name__ == "__main__":
    unittest.main()
