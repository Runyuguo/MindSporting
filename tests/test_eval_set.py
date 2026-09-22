"""T19：评测集校验与统计（`scripts/build_eval_set.py`）的判别力测试。

分三层：
- **纯 schema 层**（`TestValidateSchema`）：不碰磁盘，失败信息直接指向判定规则；
- **磁盘层**（`TestCheckRefs*`）：在**临时目录**里建假 vault，验证 ref 的存在性、
  白名单、`.md` 形态；除 `TestBundledSets` 外**绝不触碰真实 vault**；
- **随仓库发布的评测集层**（`TestBundledSets`）：对 `tests/eval_set/*.json` 跑真实校验，
  含「≥5 条 note=followup」与「ref 在真实 vault 上确实存在」两条闸门（对应 spec SC-6 / SC-1）。

约定：`validate()` 是 brief 指定的接口，**抛 ValueError**（schema 不过即挡）；
`check_refs()` 返回**全部**问题清单（磁盘问题一次看全，便于一次改完）。
"""
import json
import pathlib
import re
import shutil
import tempfile
import unittest

from scripts import build_eval_set

SETS = pathlib.Path(__file__).resolve().parent / "eval_set"


class TestValidateSchema(unittest.TestCase):
    def test_schema_rejects_missing_fields(self):
        with self.assertRaises(ValueError):
            build_eval_set.validate([{"id": "x", "query": "q"}])

    def test_schema_rejects_empty_relevant(self):
        with self.assertRaises(ValueError):
            build_eval_set.validate(
                [{"id": "x", "query": "q", "relevant": []}])

    def test_schema_accepts_well_formed(self):
        build_eval_set.validate(
            [{"id": "x", "query": "q", "relevant": ["a.md"]}])

    def test_duplicate_queries_are_reported(self):
        dupes = build_eval_set.duplicate_queries([
            {"id": "1", "query": "q", "relevant": ["a.md"]},
            {"id": "2", "query": "q", "relevant": ["b.md"]},
        ])
        self.assertEqual(dupes, ["q"])

    def test_schema_rejects_duplicate_ids(self):
        with self.assertRaises(ValueError):
            build_eval_set.validate([
                {"id": "x", "query": "q1", "relevant": ["a.md"]},
                {"id": "x", "query": "q2", "relevant": ["b.md"]},
            ])

    def test_schema_rejects_blank_query(self):
        with self.assertRaises(ValueError):
            build_eval_set.validate([{"id": "x", "query": "   ", "relevant": ["a.md"]}])

    def test_schema_rejects_non_string_relevant_element(self):
        with self.assertRaises(ValueError):
            build_eval_set.validate([{"id": "x", "query": "q", "relevant": ["a.md", ""]}])

    def test_schema_rejects_empty_set(self):
        with self.assertRaises(ValueError):
            build_eval_set.validate([])

    def test_stats_reports_followup_count(self):
        s = build_eval_set.stats([
            {"id": "1", "query": "q1", "relevant": ["a.md"], "note": "followup",
             "antecedent": "2"},
            {"id": "2", "query": "q2", "relevant": ["b.md", "c.md"]},
        ])
        self.assertEqual(s["count"], 2)
        self.assertEqual(s["followup"], 1)
        self.assertEqual(s["relevant_total"], 3)


class TestFollowupAntecedents(unittest.TestCase):
    """指代型追问必须带**机器可读的先行词**（schema 层不变量）。

    没有先行词的追问 = 无法解析的指代；有先行词却不标 followup = 字段语义悬空。二者都挡。
    """

    def test_schema_rejects_followup_without_antecedent(self):
        with self.assertRaises(ValueError):
            build_eval_set.validate([
                {"id": "f", "query": "那它的机制呢？",
                 "relevant": ["a.md"], "note": "followup"}])

    def test_schema_rejects_blank_antecedent(self):
        with self.assertRaises(ValueError):
            build_eval_set.validate([
                {"id": "1", "query": "q1", "relevant": ["a.md"]},
                {"id": "f", "query": "那它的机制呢？", "relevant": ["a.md"],
                 "note": "followup", "antecedent": "  "}])

    def test_schema_rejects_orphan_antecedent(self):
        with self.assertRaises(ValueError):
            build_eval_set.validate([
                {"id": "1", "query": "q1", "relevant": ["a.md"]},
                {"id": "2", "query": "q2", "relevant": ["a.md"],
                 "antecedent": "1"}])

    def test_schema_accepts_well_formed_pair(self):
        build_eval_set.validate([
            {"id": "1", "query": "q1", "relevant": ["a.md"]},
            {"id": "2", "query": "那它的机制呢？", "relevant": ["a.md"],
             "note": "followup", "antecedent": "1"}])

    def _items(self, *extra):
        base = [
            {"id": "1", "query": "q1", "relevant": ["a.md"]},
            {"id": "2", "query": "q2", "relevant": ["a.md"]},
        ]
        return base + list(extra)

    def test_check_antecedents_accepts_valid_pair(self):
        items = self._items({"id": "3", "query": "那它呢？", "relevant": ["a.md"],
                             "note": "followup", "antecedent": "1"})
        self.assertEqual(build_eval_set.check_antecedents(items), [])

    def test_check_antecedents_reports_dangling_id(self):
        items = self._items({"id": "3", "query": "那它呢？", "relevant": ["a.md"],
                             "note": "followup", "antecedent": "999"})
        problems = build_eval_set.check_antecedents(items)
        self.assertEqual(len(problems), 1)
        self.assertIn("999", problems[0])

    def test_check_antecedents_rejects_self_reference(self):
        items = self._items({"id": "3", "query": "那它呢？", "relevant": ["a.md"],
                             "note": "followup", "antecedent": "3"})
        self.assertTrue(build_eval_set.check_antecedents(items))

    def test_check_antecedents_rejects_forward_reference(self):
        # 先行词必须在追问**之前**：否则「上一轮」并不存在
        items = [
            {"id": "1", "query": "那它呢？", "relevant": ["a.md"],
             "note": "followup", "antecedent": "2"},
            {"id": "2", "query": "q2", "relevant": ["a.md"]},
        ]
        self.assertTrue(build_eval_set.check_antecedents(items))

    def test_check_antecedents_rejects_followup_chain(self):
        # 追问的先行词本身又是追问 → 指代链，消解目标不唯一
        items = [
            {"id": "1", "query": "q1", "relevant": ["a.md"]},
            {"id": "2", "query": "那它呢？", "relevant": ["a.md"],
             "note": "followup", "antecedent": "1"},
            {"id": "3", "query": "那它呢？", "relevant": ["a.md"],
             "note": "followup", "antecedent": "2"},
        ]
        self.assertTrue(build_eval_set.check_antecedents(items))

    def test_check_antecedents_reports_every_problem(self):
        items = self._items(
            {"id": "3", "query": "那它呢？", "relevant": ["a.md"],
             "note": "followup", "antecedent": "999"},
            {"id": "4", "query": "那它呢？", "relevant": ["a.md"],
             "note": "followup", "antecedent": "4"})
        self.assertEqual(len(build_eval_set.check_antecedents(items)), 2)


class TestCheckRefs(unittest.TestCase):
    """磁盘层：ref 必须是「允许目录内的、真实存在的 vault 相对 .md」。"""

    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="t19_vault_"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        for d in ("01-Literature", "02-Surveys", "03-Reading", "OCR"):
            (self.tmp / d).mkdir(parents=True, exist_ok=True)
        self.ref = "01-Literature/a.md"
        (self.tmp / self.ref).write_text("# a\n", encoding="utf-8")
        self.prefixes = ("01-Literature", "02-Surveys", "03-Reading")

    def _problems(self, refs):
        items = [{"id": f"i{n}", "query": f"q{n}", "relevant": [r]}
                 for n, r in enumerate(refs)]
        return build_eval_set.check_refs(items, self.tmp, self.prefixes)

    def test_existing_allowed_md_passes(self):
        self.assertEqual(self._problems([self.ref]), [])

    def test_missing_file_is_reported(self):
        problems = self._problems(["01-Literature/nope.md"])
        self.assertEqual(len(problems), 1)
        self.assertIn("01-Literature/nope.md", problems[0])

    def test_outside_allowed_dirs_is_reported(self):
        (self.tmp / "OCR" / "x.md").write_text("# x\n", encoding="utf-8")
        self.assertTrue(self._problems(["OCR/x.md"]))

    def test_lookalike_prefix_is_reported(self):
        (self.tmp / "01-LiteratureX").mkdir()
        (self.tmp / "01-LiteratureX" / "a.md").write_text("# x\n", encoding="utf-8")
        self.assertTrue(self._problems(["01-LiteratureX/a.md"]))

    def test_non_markdown_is_reported(self):
        (self.tmp / "01-Literature" / "a.txt").write_text("x", encoding="utf-8")
        self.assertTrue(self._problems(["01-Literature/a.txt"]))

    def test_absolute_path_is_reported(self):
        abs_ref = (self.tmp / self.ref).as_posix()
        self.assertTrue(self._problems([abs_ref]))

    def test_dotdot_traversal_is_reported(self):
        self.assertTrue(self._problems(["01-Literature/../OCR/x.md"]))

    def test_backslash_form_is_reported(self):
        # /doc 契约要求 POSIX 相对路径；反斜杠形态不得混进评测集
        self.assertTrue(self._problems(["01-Literature\\a.md"]))

    def test_directory_is_not_a_valid_ref(self):
        (self.tmp / "01-Literature" / "sub.md").mkdir()
        self.assertTrue(self._problems(["01-Literature/sub.md"]))

    def test_check_refs_reports_every_problem_not_just_the_first(self):
        problems = self._problems(["01-Literature/nope.md", "OCR/x.md"])
        self.assertEqual(len(problems), 2)

    def test_check_refs_does_not_write_to_the_vault(self):
        before = {p.relative_to(self.tmp).as_posix(): p.stat().st_mtime_ns
                  for p in self.tmp.rglob("*")}
        self._problems([self.ref])
        after = {p.relative_to(self.tmp).as_posix(): p.stat().st_mtime_ns
                 for p in self.tmp.rglob("*")}
        self.assertEqual(before, after, "校验脚本改动了 vault")


class TestMainGate(unittest.TestCase):
    """`main()` 是闸门不是报告：任何一类问题都必须以非零码退出。"""

    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="t19_main_"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        (self.tmp / "01-Literature").mkdir(parents=True)
        (self.tmp / "01-Literature" / "a.md").write_text("# a\n", encoding="utf-8")
        self.set_path = self.tmp / "set.json"

    def _write(self, items):
        self.set_path.write_text(json.dumps(items, ensure_ascii=False),
                                 encoding="utf-8")

    def _run(self):
        # 显式注入参数列表（不含程序名——parse_args 不跳过首项），
        # 而不是 patch 进程级 sys.argv：测试不污染全局状态
        return build_eval_set.main(
            ["--lib", "ai4s", "--path", str(self.set_path), "--vault", str(self.tmp)])

    def test_valid_set_exits_zero(self):
        self._write([{"id": "i1", "query": "q1", "relevant": ["01-Literature/a.md"]}])
        self.assertIsNone(self._run())

    def test_missing_ref_exits_nonzero(self):
        self._write([{"id": "i1", "query": "q1", "relevant": ["01-Literature/nope.md"]}])
        with self.assertRaises(SystemExit) as ctx:
            self._run()
        self.assertNotEqual(ctx.exception.code, 0)

    def test_duplicate_query_exits_nonzero(self):
        self._write([
            {"id": "i1", "query": "same", "relevant": ["01-Literature/a.md"]},
            {"id": "i2", "query": "same", "relevant": ["01-Literature/a.md"]},
        ])
        with self.assertRaises(SystemExit) as ctx:
            self._run()
        self.assertNotEqual(ctx.exception.code, 0)

    def test_schema_violation_exits_nonzero(self):
        self._write([{"id": "i1", "query": "q1", "relevant": []}])
        with self.assertRaises(SystemExit) as ctx:
            self._run()
        self.assertNotEqual(ctx.exception.code, 0)

    def test_report_is_json_with_stats(self):
        self._write([
            {"id": "i1", "query": "q1", "relevant": ["01-Literature/a.md"]},
            {"id": "i2", "query": "那它的机制呢？", "relevant": ["01-Literature/a.md"],
             "note": "followup", "antecedent": "i1"},
        ])
        import io
        import contextlib
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self._run()
        payload = json.loads(buf.getvalue())
        self.assertEqual(payload["stats"]["count"], 2)
        self.assertEqual(payload["stats"]["followup"], 1)

    def test_dangling_antecedent_exits_nonzero(self):
        self._write([
            {"id": "i1", "query": "q1", "relevant": ["01-Literature/a.md"]},
            {"id": "i2", "query": "那它的机制呢？", "relevant": ["01-Literature/a.md"],
             "note": "followup", "antecedent": "nope"},
        ])
        with self.assertRaises(SystemExit) as ctx:
            self._run()
        self.assertNotEqual(ctx.exception.code, 0)


class TestBundledSets(unittest.TestCase):
    """对随仓库发布的真实评测集 + 真实 vault 跑闸门。"""

    LIBS = ("ai4s", "mito")

    def test_bundled_sets_are_well_formed_and_large_enough(self):
        for name in self.LIBS:
            with self.subTest(lib=name):
                items = build_eval_set.load(SETS / f"{name}.json")
                build_eval_set.validate(items)
                self.assertGreaterEqual(len(items), 30)
                self.assertLessEqual(len(items), 50)

    def test_bundled_sets_refs_exist_in_the_real_vault(self):
        for name in self.LIBS:
            with self.subTest(lib=name):
                items = build_eval_set.load(SETS / f"{name}.json")
                problems = build_eval_set.check_refs(
                    items, *build_eval_set.vault_of(name))
                self.assertEqual(problems, [], "\n".join(problems))

    def test_bundled_sets_have_at_least_five_followups_each(self):
        # spec SC-6：以 note 标注为追问的条目每库 ≥5 条
        for name in self.LIBS:
            with self.subTest(lib=name):
                items = build_eval_set.load(SETS / f"{name}.json")
                followups = [i for i in items if i.get("note") == "followup"]
                self.assertGreaterEqual(len(followups), 5)

    def test_bundled_followups_antecedents_resolve(self):
        for name in self.LIBS:
            with self.subTest(lib=name):
                items = build_eval_set.load(SETS / f"{name}.json")
                self.assertEqual(build_eval_set.check_antecedents(items), [])

    def test_bundled_followups_do_not_name_their_own_topic(self):
        """指代型追问不得自带足以解析指代的话题锚点（SC-6 的测量前提）。

        **判据（必要条件，非充分条件）**：追问句必须含指代/指示词，且不得含
        白名单之外的 ASCII 实体名 —— 模型名、蛋白名、化合物名一律是实体名，
        一旦出现在追问里，读者不看先行词也能定位话题，该条就退化成普通检索题。

        充分性（「赖氨酸质子化」这类中文领域词仍可能自带话题）无法机械判定，
        由人复核；本闸门只保证最容易犯的那一类不会悄悄回归。
        见 tests/eval_set/*.json 的 note/antecedent 字段与 T19 报告 §2.5。
        """
        pronouns = ("它", "它们", "这", "这些", "该", "此")
        generic_ascii = {"ATP", "DNA", "RNA", "ROS", "pH"}  # 跨语料的通用术语，不指认任何一篇
        ascii_token = re.compile(r"[A-Za-z][A-Za-z0-9_\-]{1,}")
        for name in self.LIBS:
            items = build_eval_set.load(SETS / f"{name}.json")
            for item in items:
                if item.get("note") != "followup":
                    continue
                with self.subTest(lib=name, item=item["id"]):
                    q = item["query"]
                    self.assertTrue(any(p in q for p in pronouns),
                                    f"{item['id']} 追问句缺少指代词：{q!r}")
                    named = sorted(set(ascii_token.findall(q)) - generic_ascii)
                    self.assertEqual(
                        named, [],
                        f"{item['id']} 追问句自带实体名 {named}，指代可被自行解析：{q!r}")

    def test_bundled_followups_are_the_only_item_kind_requiring_context(self):
        """`note == "followup"` ⟺ 需要先行词上下文；这是 T20/T21 划分 SC-1/SC-6 的判据。

        因此非追问条目必须**没有** note 字段：否则 T20 用真值判断取子集时会把普通
        检索题混进 SC-6 的测量集。
        """
        for name in self.LIBS:
            with self.subTest(lib=name):
                items = build_eval_set.load(SETS / f"{name}.json")
                for item in items:
                    if item.get("note") is None:
                        self.assertNotIn("antecedent", item, item["id"])
                    else:
                        self.assertEqual(item["note"], "followup", item["id"])

    def test_bundled_sets_are_not_all_from_one_source_dir(self):
        # 方法论裁定 #6：survey / reading 也是正当目标，不得整集都是 01-Literature
        for name in self.LIBS:
            with self.subTest(lib=name):
                items = build_eval_set.load(SETS / f"{name}.json")
                refs = [r for i in items for r in i["relevant"]]
                for prefix in ("02-Surveys", "03-Reading"):
                    n = sum(1 for r in refs if r.split("/")[0] == prefix)
                    self.assertGreaterEqual(n, 2, f"{name} 缺 {prefix} 目标")


if __name__ == "__main__":
    unittest.main()
