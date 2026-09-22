"""A 案来源白名单：三个目录之外的 vault 内容一律不读。

本模块分两层：
- **纯逻辑层**（`TestIsAllowedRef` / `TestSourcePrefixes`）：直接调谓词，不碰文件系统，
  失败信息直接指向判定规则本身；
- **落地层**（`TestShippedConfigs` / `TestIndexTimeWhitelist` / `TestIndexTimeWhitelistFallback` /
  `TestSourcesDefaultsFailClosed` / `TestQueryTimeWhitelist`）：读随仓库发布的 config、
  在**临时目录**里建 vault 并跑真实 `iter_sources`/`search`。除临时目录外**绝不触碰真实 vault**；
  其中构造 engine 的类必须清掉 `AI4S_VAULT_PATH`/`MITO_VAULT_PATH` 环境变量，
  否则 `load_config` 的 `env_var` 覆盖会静默劫持临时 vault、让用例退化成同义反复。
"""
import unittest

from rag_core import sources


class TestIsAllowedRef(unittest.TestCase):
    def test_allows_the_three_directories(self):
        for ref in ("01-Literature/a.md", "02-Surveys/b.md", "03-Reading/c.md"):
            self.assertTrue(sources.is_allowed_ref(ref), f"{ref} 应被允许")

    def test_allows_nested_paths_inside_allowed_dirs(self):
        # C-9：允许目录的递归内容都算允许
        self.assertTrue(sources.is_allowed_ref("01-Literature/2024/deep/x.md"))

    def test_rejects_excluded_vault_dirs(self):
        for ref in ("OCR/x/full_output.md", "00-MOC/index.md", "99-Templates/t.md"):
            self.assertFalse(sources.is_allowed_ref(ref), f"{ref} 不该被允许")

    def test_rejects_unknown_dirs_not_in_whitelist(self):
        # 拒绝式语义：未列名目录（含将来新增）一律不放行
        self.assertFalse(sources.is_allowed_ref("04-Answer&Plan/q.md"))
        self.assertFalse(sources.is_allowed_ref("05-NewFolder/x.md"))

    def test_rejects_lookalike_prefix(self):
        # "01-LiteratureX" 不是允许目录，不得因前缀匹配而放行
        self.assertFalse(sources.is_allowed_ref("01-LiteratureX/a.md"))

    def test_rejects_empty_and_non_path_refs(self):
        for ref in ("", "12345678", "x.md"):
            self.assertFalse(sources.is_allowed_ref(ref), f"{ref!r} 不该被允许")

    def test_rejects_path_traversal(self):
        """穿越必须拒：首段合法但解析后落在被排除目录内。

        `/doc` 的 ref 由客户端提供且无鉴权（AGENTS.md §6.1），
        故本谓词必须自己拒穿越，不能指望调用方去 resolve。
        """
        for ref in (
            "01-Literature/../OCR/x/full_output.md",
            "01-Literature/../00-MOC/index.md",
            "01-Literature/../../secrets.md",
            "../01-Literature/a.md",
        ):
            self.assertFalse(sources.is_allowed_ref(ref), f"{ref!r} 含穿越，必须拒绝")

    def test_rejects_empty_segments_and_absolute_forms(self):
        for ref in ("01-Literature//a.md", "/01-Literature/a.md", "01-Literature/./a.md"):
            self.assertFalse(sources.is_allowed_ref(ref), f"{ref!r} 形态非法，必须拒绝")

    def test_accepts_backslash_form(self):
        """反斜杠归一化必须被钉住（否则删掉 replace 也不会变红）。"""
        self.assertTrue(sources.is_allowed_ref("01-Literature\\a.md"))

    def test_honours_the_allowed_argument(self):
        """`allowed` 参数必须真的被使用（否则闭包写死默认值也能全绿）。"""
        self.assertTrue(sources.is_allowed_ref("09-New/x.md", ("09-New",)))
        self.assertFalse(sources.is_allowed_ref("01-Literature/a.md", ("09-New",)))

    def test_non_str_is_rejected_not_raised(self):
        self.assertFalse(sources.is_allowed_ref(None))  # type: ignore[arg-type]
        self.assertFalse(sources.is_allowed_ref(12345678))  # type: ignore[arg-type]


class TestSourcePrefixes(unittest.TestCase):
    def test_prefixes_cover_the_three_dirs(self):
        self.assertEqual(
            sources.source_prefixes(),
            ["vault:note", "vault:survey", "vault:reading"],
        )

    def test_unmapped_directory_raises_instead_of_being_dropped(self):
        """未映射目录必须报错——静默丢弃会让调用方拿到更短的前缀列表而毫无察觉（宪法 §4.3）。"""
        with self.assertRaises(ValueError):
            sources.source_prefixes(("01-Literature", "09-New"))


class TestShippedConfigs(unittest.TestCase):
    """两份随仓库发布的配置都必须满足 A 案。"""

    def _cfg(self, lib: str) -> dict:
        import json
        from pathlib import Path
        from rag_core import rag_engine
        p = Path(rag_engine.__file__).resolve().parent / f"config_{lib}.json"
        return json.loads(p.read_text(encoding="utf-8"))

    def test_both_libs_stop_reading_outside_sources(self):
        for lib in ("ai4s", "mito"):
            srcs = self._cfg(lib)["sources"]
            for key in ("metadata", "extracted", "weekly_watch"):
                self.assertFalse(srcs.get(key), f"{lib} 的 {key} 必须为 false")
            self.assertTrue(srcs.get("vault"), f"{lib} 的 vault 必须为 true")

    def test_both_libs_declare_the_whitelist(self):
        for lib in ("ai4s", "mito"):
            self.assertEqual(
                self._cfg(lib)["allowed_prefixes"],
                list(sources.ALLOWED_PREFIXES),
            )


class TestIndexTimeWhitelist(unittest.TestCase):
    """索引期：非白名单目录的 .md 不得产出任何文档。"""

    def setUp(self):
        import json
        import os
        import tempfile
        from pathlib import Path
        from unittest import mock
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        vault = root / "vault"
        # 允许的三个目录
        for d in ("01-Literature", "02-Surveys", "03-Reading"):
            (vault / d).mkdir(parents=True)
            (vault / d / "ok.md").write_text("允许的内容\n", encoding="utf-8", newline="\n")
        # 排除的 vault 内目录
        for d in ("OCR/x", "00-MOC", "99-Templates", "04-Answer&Plan"):
            (vault / d).mkdir(parents=True)
            (vault / d / "bad.md").write_text("不该被索引\n", encoding="utf-8", newline="\n")
        # 未列名目录（拒绝式语义的验证点）
        (vault / "05-NewFolder").mkdir(parents=True)
        (vault / "05-NewFolder" / "x.md").write_text("也不该被索引\n", encoding="utf-8", newline="\n")

        # env_var 会覆盖 vault_path（test_doc.py 有详细说明）：若真实环境恰好设了
        # AI4S_VAULT_PATH，本用例的临时 vault 会被顶掉，「白名单是否生效」就测的是真实
        # vault，断言失去意义。故在构造引擎前清空。
        patcher = mock.patch.dict(os.environ, {"AI4S_VAULT_PATH": "", "MITO_VAULT_PATH": ""})
        patcher.start()
        self.addCleanup(patcher.stop)

        from rag_core import rag_engine
        src = Path(rag_engine.__file__).resolve().parent / "config_ai4s.json"
        cfg = json.loads(src.read_text(encoding="utf-8"))
        cfg["vault_path"] = str(vault)
        cfg["workspace"] = str(root / "workspace")
        cfg["index_db"] = str(root / "idx.db")
        cfg["faiss_index"] = str(root / "idx.faiss")
        cfg_path = root / "config_ai4s.json"
        cfg_path.write_text(json.dumps(cfg, ensure_ascii=False), encoding="utf-8", newline="\n")
        self.engine = rag_engine.RAGEngine(str(cfg_path))

    def tearDown(self):
        self.tmp.cleanup()

    def _all_docs(self):
        docs = []
        for _path, _mtime, ds in self.engine.iter_sources():
            docs.extend(ds)
        return docs

    def test_only_whitelisted_dirs_produce_docs(self):
        refs = [d[1] for d in self._all_docs()]
        self.assertTrue(any(r.startswith("01-Literature/") for r in refs))
        self.assertTrue(any(r.startswith("02-Surveys/") for r in refs))
        self.assertTrue(any(r.startswith("03-Reading/") for r in refs))

    def test_excluded_and_unknown_dirs_produce_no_docs(self):
        refs = [d[1] for d in self._all_docs()]
        for r in refs:
            head = r.split("/", 1)[0]
            self.assertIn(
                head, ("01-Literature", "02-Surveys", "03-Reading"),
                f"非白名单来源混入索引源：{r}",
            )

    def test_answer_plan_is_excluded(self):
        """铁律：历史 RAG 问答记录不得作为检索证据。

        旧实现靠一条 `folder == "04-Answer&Plan"` 专用分支；该分支已删除，
        此处钉住「铁律仍成立」——若哪天它被重新加进白名单，这条会立刻变红。
        """
        self.assertFalse(sources.is_allowed_ref("04-Answer&Plan/q.md"))
        refs = [d[1] for d in self._all_docs()]
        self.assertFalse([r for r in refs if r.startswith("04-Answer&Plan")],
                         "04-Answer&Plan 下的笔记混进了索引源")


class TestIndexTimeWhitelistFallback(unittest.TestCase):
    """配置缺 `allowed_prefixes` 时必须退回 `sources.ALLOWED_PREFIXES`。

    `cfg.get("allowed_prefixes") or _sources.ALLOWED_PREFIXES` 的 `or` 分支若被写错
    （例如改成 `cfg["allowed_prefixes"]`），省略该键的配置会直接抛 KeyError 或放行一切；
    只测「配置写了白名单」的用例发现不了，故这里用一份**不含该键**的配置真跑一遍。
    """

    def setUp(self):
        import json
        import os
        import tempfile
        from pathlib import Path
        from unittest import mock
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        vault = root / "vault"
        for d in ("01-Literature", "02-Surveys", "03-Reading", "00-MOC", "05-NewFolder",
                  "04-Answer&Plan"):
            (vault / d).mkdir(parents=True)
            (vault / d / "x.md").write_text("内容\n", encoding="utf-8", newline="\n")
        patcher = mock.patch.dict(os.environ, {"AI4S_VAULT_PATH": "", "MITO_VAULT_PATH": ""})
        patcher.start()
        self.addCleanup(patcher.stop)

        from rag_core import rag_engine
        src = Path(rag_engine.__file__).resolve().parent / "config_ai4s.json"
        cfg = json.loads(src.read_text(encoding="utf-8"))
        cfg["vault_path"] = str(vault)
        cfg["workspace"] = str(root / "workspace")
        cfg["index_db"] = str(root / "idx.db")
        cfg["faiss_index"] = str(root / "idx.faiss")
        cfg.pop("allowed_prefixes", None)  # 关键：键不存在
        cfg_path = root / "config_no_prefixes.json"
        cfg_path.write_text(json.dumps(cfg, ensure_ascii=False), encoding="utf-8", newline="\n")
        self.engine = rag_engine.RAGEngine(str(cfg_path))

    def tearDown(self):
        self.tmp.cleanup()

    def test_falls_back_to_module_whitelist(self):
        refs = []
        for _path, _mtime, docs in self.engine.iter_sources():
            refs.extend(d[1] for d in docs)
        self.assertEqual(
            sorted({r.split("/", 1)[0] for r in refs}),
            sorted(sources.ALLOWED_PREFIXES),
            f"省略 allowed_prefixes 时未退回模块白名单，实际来源：{refs}",
        )


class TestSourcesDefaultsFailClosed(unittest.TestCase):
    """配置省略 / 只写部分 `sources` 子键时，库外三类来源必须落在 false（失败即关闭）。

    `load_config` 对 `sources` 是**逐子键合并**的：库外三项若仍默认 True，
    将来任一份省略该键的配置都会静默恢复「读库外数据」——正是 A 案要根除的失败模式。
    这里断言的是**加载器的行为**，不是 `_DEFAULTS` 这个字面量。
    """

    def _load(self, cfg: dict) -> dict:
        import json
        import tempfile
        from pathlib import Path
        from rag_core import rag_engine
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "cfg.json"
            p.write_text(json.dumps(cfg), encoding="utf-8", newline="\n")
            return rag_engine.load_config(str(p))

    def test_omitted_sources_block_vault_external_reads(self):
        for key in ("metadata", "extracted", "weekly_watch"):
            self.assertFalse(self._load({"lib": "x"})["sources"].get(key),
                             f"省略 sources 时 {key} 必须为 false")

    def test_partial_sources_block_vault_external_reads(self):
        cfg = self._load({"lib": "x", "sources": {"vault": True}})
        for key in ("metadata", "extracted", "weekly_watch"):
            self.assertFalse(cfg["sources"].get(key),
                             f"只写 vault 时 {key} 必须为 false")
        self.assertTrue(cfg["sources"]["vault"], "vault 仍须默认可读")

    def test_explicit_true_is_still_honoured(self):
        """默认关闭不等于写死：运维显式打开仍须生效（否则是另一种静默）。"""
        cfg = self._load({"lib": "x", "sources": {"metadata": True}})
        self.assertTrue(cfg["sources"]["metadata"])


class TestQueryTimeWhitelist(unittest.TestCase):
    """检索期：索引里的旧残留也不得出现在结果中。"""

    def _engine_with_stale_row(self, tmp, vault):
        import json
        from pathlib import Path
        from rag_core import rag_engine
        src = Path(rag_engine.__file__).resolve().parent / "config_ai4s.json"
        cfg = json.loads(src.read_text(encoding="utf-8"))
        cfg["vault_path"] = str(vault)
        cfg["workspace"] = str(Path(tmp) / "workspace")
        cfg["index_db"] = str(Path(tmp) / "idx.db")
        cfg["faiss_index"] = str(Path(tmp) / "idx.faiss")
        cfg_path = Path(tmp) / "config_ai4s.json"
        cfg_path.write_text(json.dumps(cfg, ensure_ascii=False), encoding="utf-8", newline="\n")
        return rag_engine.RAGEngine(str(cfg_path))

    def test_stale_non_whitelisted_hit_is_filtered_out(self):
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp) / "vault"
            (vault / "01-Literature").mkdir(parents=True)
            (vault / "01-Literature" / "ok.md").write_text("线粒体自噬\n", encoding="utf-8", newline="\n")
            eng = self._engine_with_stale_row(tmp, vault)
            eng.sync_index()
            # 手工塞一条「旧索引残留」：非白名单 ref，但可被检索到
            con = eng._connect()
            con.execute(
                "INSERT INTO chunks (source, ref, title, category, extra, text) VALUES (?,?,?,?,?,?)",
                ("vault:note", "00-MOC/stale.md", "残留导航", "", "", "线粒体自噬 残留内容"),
            )
            con.commit()
            # 必须显式关闭：Windows 上未关闭的连接会锁住 idx.db，
            # TemporaryDirectory.cleanup() 随即 PermissionError，把断言失败淹没成 ERROR。
            con.close()
            hits = eng.search("线粒体自噬", mode="bm25", topn=10)
            refs = [h.get("ref") for h in hits]
            self.assertNotIn("00-MOC/stale.md", refs, "旧索引残留必须被检索期兜底挡掉")

    def _engine_with_vault_doc(self, tmp):
        """建一个只有白名单篇目的临时索引（供下面两条畸形/库外行用例共用）。"""
        from pathlib import Path
        vault = Path(tmp) / "vault"
        (vault / "01-Literature").mkdir(parents=True)
        (vault / "01-Literature" / "ok.md").write_text(
            "线粒体自噬\n", encoding="utf-8", newline="\n")
        eng = self._engine_with_stale_row(tmp, vault)
        eng.sync_index()
        return eng

    def _insert_hits(self, eng, rows):
        """把「旧索引残留」直接写进 chunks（绕过 iter_sources 的准入），随后必须关连接。"""
        con = eng._connect()
        try:
            con.executemany(
                "INSERT INTO chunks (source, ref, title, category, extra, text) VALUES (?,?,?,?,?,?)",
                rows)
            con.commit()
        finally:
            con.close()

    def test_non_vault_source_hits_are_dropped(self):
        """库外三类（metadata/pdf/weekly）的 ref 是 PMID 或文件名，一律不出现在结果中。

        spec C-1 的「无例外口径」：不接受「标注无原文/不可点开」换取保留可检索性，
        故这里的判定是**它是否出现在结果中**，本条钉住 `_within_whitelist` 的 else 分支。
        """
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            eng = self._engine_with_vault_doc(tmp)
            self._insert_hits(eng, [
                ("metadata", "12345678", "库外摘要", "", "", "线粒体自噬 摘要残留"),
                ("pdf", "paper.pdf", "库外全文", "", "", "线粒体自噬 全文残留"),
            ])
            hits = eng.search("线粒体自噬", mode="bm25", topn=10)
            sources = [h.get("source") for h in hits]
            refs = [h.get("ref") for h in hits]
            self.assertNotIn("12345678", refs, "库外 metadata 命中必须被挡掉")
            self.assertNotIn("paper.pdf", refs, "库外 pdf 命中必须被挡掉")
            self.assertFalse([s for s in sources if not str(s).startswith("vault:")],
                             f"结果里混入了非 vault 来源：{sources}")
            # 反面自校验：白名单篇目本身必须还在，否则「全被挡掉」也能让上面全绿
            self.assertIn("01-Literature/ok.md", refs)

    def test_missing_or_empty_ref_and_source_do_not_raise(self):
        """畸形行（空 ref / 缺 source）不得让检索抛异常，也不得被放行。"""
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            eng = self._engine_with_vault_doc(tmp)
            self._insert_hits(eng, [
                ("vault:note", "", "空 ref", "", "", "线粒体自噬 空ref"),
                (None, "01-Literature/x.md", "缺 source", "", "", "线粒体自噬 缺source"),
            ])
            hits = eng.search("线粒体自噬", mode="bm25", topn=10)  # 不得抛异常
            refs = [h.get("ref") for h in hits]
            self.assertNotIn("", refs, "空 ref 不得被放行")
            self.assertNotIn("01-Literature/x.md", refs,
                             "source 缺失的行即便 ref 合法也不得放行")
            self.assertIn("01-Literature/ok.md", refs)
