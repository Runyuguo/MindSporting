"""T20 收尾：追问消解的**确定性缓存**（控制器 Ruling 后续）。

动机：SC-6 口径（`metrics_followups`）此前在两次运行之间会变，因为追问消解走
`llm.rewrite_query`，而改写预算 `timeout_s=8` 恰卡在实测耗时（4.9–11.0s）分布中部 ——
同一条追问会在「消解成功」与「降级」之间翻转。本评测的职责是**可复现的测量**，
故把「用过的消解结果」冻结进一份受版本管理的 JSON：命中即不再调用 LLM。

两条被钉住的性质：
1. **命中缓存时不调用消解器**（用 mock 证明，且不需要网络）；
2. **`--refresh-resolutions` 会绕过缓存、调用消解器并覆写条目**。

另钉住「缓存不得洗白降级」：`degraded=True` 的条目被缓存后，读回来**仍是 True**。
"""
import json
import pathlib
import shutil
import tempfile
import unittest
from unittest import mock

from scripts import eval as evalmod

LIB = "ai4s"          # 缓存按库分栏；单库测试固定用一个库即可
OTHER_LIB = "mito"


def _entry(prior="上一轮问句", query="消解后的查询", changed=True, degraded=False):
    return {"prior": prior, "query": query, "changed": changed, "degraded": degraded}


class TestResolutionCache(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="t20_cache_"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.path = self.tmp / "followup_resolutions.json"

    def _read(self):
        return json.loads(self.path.read_text(encoding="utf-8"))

    def _resolve(self, items, prior, *, resolve, cache):
        return evalmod.resolve_followups(items, prior, resolve=resolve,
                                         cache=cache, lib=LIB)

    def test_cache_file_declares_its_version(self):
        """缓存是可长期存在的数据文件，格式必须有版本号才能安全演进。"""
        cache = evalmod.ResolutionCache(self.path)
        cache.set(LIB, "ai4s-015", _entry())
        cache.save()
        self.assertEqual(self._read()["version"], 1)

    def test_hit_is_used_without_invoking_the_resolver(self):
        """命中缓存 ⇒ **不得**调用消解器（这是确定性的全部意义）。"""
        cache = evalmod.ResolutionCache(self.path)
        cache.set(LIB, "ai4s-015", _entry(query="缓存的消解结果"))
        cache.save()

        fresh = evalmod.ResolutionCache(self.path)
        explode = mock.Mock(side_effect=AssertionError("命中缓存却调用了消解器！"))
        items = [{"id": "ai4s-015", "query": "追问原句"}]
        queries, record = self._resolve(items, {"ai4s-015": "上一轮问句"},
                                        resolve=explode, cache=fresh)

        explode.assert_not_called()
        self.assertEqual(queries, ["缓存的消解结果"])
        self.assertEqual(record["ai4s-015"]["query"], "缓存的消解结果")

    def test_miss_resolves_live_and_records_into_the_cache(self):
        """未命中 ⇒ 照旧现场消解，且结果被写回缓存（下一次即可复现）。"""
        cache = evalmod.ResolutionCache(self.path)
        calls = []

        def resolver(item, prior_query):
            calls.append((item["id"], prior_query))
            return "现场消解结果", False

        items = [{"id": "ai4s-020", "query": "追问原句"}]
        queries, _ = self._resolve(items, {"ai4s-020": "上一轮问句"},
                                   resolve=resolver, cache=cache)

        self.assertEqual(len(calls), 1, "未命中应当现场消解一次")
        self.assertEqual(queries, ["现场消解结果"])
        self.assertEqual(cache.get(LIB, "ai4s-020")["query"], "现场消解结果")

    def test_refresh_bypasses_the_cache_and_overwrites(self):
        """`--refresh-resolutions` ⇒ 绕过缓存、调用消解器、覆写条目。"""
        cache = evalmod.ResolutionCache(self.path)
        cache.set(LIB, "ai4s-015", _entry(query="旧的缓存值"))
        cache.save()

        refreshed = evalmod.ResolutionCache(self.path, refresh=True)
        resolver = mock.Mock(return_value=("新的现场值", False))
        items = [{"id": "ai4s-015", "query": "追问原句"}]
        # 即便先行词与缓存逐字相同，refresh 也必须重算（否则"刷新"名不副实）
        queries, _ = self._resolve(items, {"ai4s-015": "上一轮问句"},
                                   resolve=resolver, cache=refreshed)

        resolver.assert_called_once()
        self.assertEqual(queries, ["新的现场值"])
        self.assertEqual(refreshed.stats()["live"], 1)
        # 覆写要落到**盘上**才作数：refresh 实例自己不吃缓存，故换个新实例读回来核对。
        refreshed.save()
        reread = evalmod.ResolutionCache(self.path)
        self.assertEqual(reread.get(LIB, "ai4s-015")["query"], "新的现场值")

    def test_refresh_does_not_trust_a_different_prior(self):
        """先行词变了则缓存值作废 —— 覆写而不是沿用（否则会把旧上下文的结果安上来）。"""
        stale = evalmod.ResolutionCache(self.path)
        stale.set(LIB, "ai4s-015", _entry(prior="老的先行词", query="老的消解结果"))
        stale.save()

        cache = evalmod.ResolutionCache(self.path)
        resolver = mock.Mock(return_value=("按新先行词消解", False))
        items = [{"id": "ai4s-015", "query": "追问原句"}]
        queries, _ = self._resolve(items, {"ai4s-015": "新的先行词"},
                                   resolve=resolver, cache=cache)
        resolver.assert_called_once()
        self.assertEqual(queries, ["按新先行词消解"])
        self.assertEqual(cache.get(LIB, "ai4s-015")["prior"], "新的先行词")

    def test_cache_is_partitioned_by_library(self):
        """两库绝不混用（宪法 §2.2）：同名 id 在两个库里是两条独立记录。"""
        cache = evalmod.ResolutionCache(self.path)
        cache.set(LIB, "x-001", _entry(query="ai4s 的结果"))
        cache.set(OTHER_LIB, "x-001", _entry(query="mito 的结果"))
        cache.save()

        fresh = evalmod.ResolutionCache(self.path)
        self.assertEqual(fresh.get(LIB, "x-001")["query"], "ai4s 的结果")
        self.assertEqual(fresh.get(OTHER_LIB, "x-001")["query"], "mito 的结果")

    def test_cached_degradation_is_not_laundered_into_success(self):
        """缓存冻结的是「用了哪次消解」，**不得**把 degraded 洗成正常。"""
        cache = evalmod.ResolutionCache(self.path)
        cache.set(OTHER_LIB, "mito-021",
                  _entry(query="退回原句", changed=False, degraded=True))
        cache.save()

        fresh = evalmod.ResolutionCache(self.path)
        items = [{"id": "mito-021", "query": "退回原句"}]
        _, record = evalmod.resolve_followups(
            items, {"mito-021": "上一轮问句"},
            resolve=mock.Mock(side_effect=AssertionError("不该调用")),
            cache=fresh, lib=OTHER_LIB)

        self.assertTrue(record["mito-021"]["degraded"],
                        "缓存的 degraded=True 被洗成了 False —— 缓存变成了掩盖降级的工具")
        self.assertEqual(fresh.stats()["degraded"], 1)

    def test_stats_separate_cached_from_live(self):
        """产物要自述「这份数是用缓存还是现场消解跑出来的」，故必须分别计数。"""
        same_prior = "同一轮先行词"
        cache = evalmod.ResolutionCache(self.path)
        cache.set(LIB, "a", _entry(prior=same_prior))
        cache.save()
        fresh = evalmod.ResolutionCache(self.path)

        items = [{"id": "a", "query": "q1"}, {"id": "b", "query": "q2"}]
        prior = {"a": same_prior, "b": "另一轮先行词"}
        self._resolve(items, prior, resolve=lambda i, p: ("现场值", False), cache=fresh)

        stats = fresh.stats()
        self.assertEqual(stats["cached"], 1, "先行词相同的条目应当命中缓存")
        self.assertEqual(stats["live"], 1, "未命中的条目应当现场消解")
        self.assertEqual(stats["total"], 2)

    def test_modality_is_cached_only_when_every_resolution_came_from_cache(self):
        same_prior = "同一轮先行词"
        cache = evalmod.ResolutionCache(self.path)
        cache.set(LIB, "a", _entry(prior=same_prior))
        cache.save()

        all_cached = evalmod.ResolutionCache(self.path)
        self._resolve([{"id": "a", "query": "q1"}], {"a": same_prior},
                      resolve=mock.Mock(side_effect=AssertionError("不该调用")),
                      cache=all_cached)
        self.assertEqual(all_cached.stats()["modality"], "cached")

        mixed = evalmod.ResolutionCache(self.path)
        self._resolve([{"id": "a", "query": "q1"}, {"id": "b", "query": "q2"}],
                      {"a": same_prior, "b": "另一轮先行词"},
                      resolve=lambda i, p: ("现场值", False), cache=mixed)
        self.assertEqual(mixed.stats()["modality"], "mixed")

        live = evalmod.ResolutionCache(self.tmp / "other.json")
        self._resolve([{"id": "b", "query": "q2"}], {"b": "另一轮先行词"},
                      resolve=lambda i, p: ("现场值", False), cache=live)
        self.assertEqual(live.stats()["modality"], "live")

    def test_save_writes_utf8_without_bom_and_lf(self):
        """与评测集/产物同一条编码契约。"""
        cache = evalmod.ResolutionCache(self.path)
        cache.set(LIB, "ai4s-015", _entry(prior="中文先行词", query="中文消解结果"))
        cache.save()

        raw = self.path.read_bytes()
        self.assertFalse(raw.startswith(b"\xef\xbb\xbf"), "有 BOM")
        self.assertNotIn(b"\r\n", raw, "含 CRLF")
        self.assertNotIn(b"\\u", raw, "出现 \\u 转义（ensure_ascii 不是 False）")
        self.assertIn("中文消解结果".encode("utf-8"), raw)

    def test_save_creates_missing_parent_directory(self):
        nested = self.tmp / "deep" / "er" / "cache.json"
        cache = evalmod.ResolutionCache(nested)
        cache.set(LIB, "x", _entry())
        cache.save()
        self.assertTrue(nested.is_file())

    def test_absent_cache_file_is_an_empty_cache_not_an_error(self):
        """首次运行没有缓存文件 —— 应当是「空缓存」，不是崩溃。"""
        cache = evalmod.ResolutionCache(self.tmp / "does-not-exist.json")
        self.assertIsNone(cache.get(LIB, "whatever"))
        self.assertEqual(cache.stats()["total"], 0)

    def test_require_lib_when_a_cache_is_used(self):
        """缓存按库分栏，忘了给 lib 就该响亮失败，而不是默默写到错的分栏里。"""
        cache = evalmod.ResolutionCache(self.path)
        with self.assertRaises(ValueError):
            evalmod.resolve_followups([{"id": "a", "query": "q"}], {"a": "上一轮"},
                                      resolve=lambda i, p: ("v", False), cache=cache)

    def test_save_merges_with_the_other_library_instead_of_clobbering_it(self):
        """两库各跑各的进程，各自 save —— **先跑的那一库不得被后跑的抹掉**。

        实测过这个回归：缓存文件按 lib 分栏，但每次 save 只写自己这一栏，
        于是 `mito` 跑完会把 `ai4s` 的条目整段抹掉（反之亦然）。
        """
        first = evalmod.ResolutionCache(self.path)
        first.set(LIB, "ai4s-015", _entry(query="ai4s 的结果"))
        first.save()

        second = evalmod.ResolutionCache(self.path)
        second.set(OTHER_LIB, "mito-021", _entry(query="mito 的结果"))
        second.save()

        payload = self._read()["libraries"]
        self.assertIn(LIB, payload, "后跑的库把先跑的库整栏抹掉了")
        self.assertIn(OTHER_LIB, payload)
        self.assertEqual(payload[LIB]["ai4s-015"]["query"], "ai4s 的结果")
        self.assertEqual(payload[OTHER_LIB]["mito-021"]["query"], "mito 的结果")

    def test_save_upserts_this_library_without_dropping_its_other_entries(self):
        """同一库里：更新的条目要覆盖旧的，**其余条目必须留着**。"""
        cache = evalmod.ResolutionCache(self.path)
        cache.set(LIB, "a", _entry(query="旧 a"))
        cache.set(LIB, "b", _entry(query="旧 b"))
        cache.save()

        update = evalmod.ResolutionCache(self.path)
        update.set(LIB, "a", _entry(query="新 a"))
        update.save()

        lib_entries = self._read()["libraries"][LIB]
        self.assertEqual(lib_entries["a"]["query"], "新 a")
        self.assertEqual(lib_entries["b"]["query"], "旧 b",
                         "同一库内的其它条目被顺手删掉了")

    def test_refresh_replaces_only_this_library_and_keeps_the_other_verbatim(self):
        """`--refresh-resolutions` 只重算**本库**那一栏；另一库必须逐字留存。

        实测过的后果（复审 I2）：先跑 ai4s、再带 `--refresh-resolutions` 跑 mito，
        ai4s 整栏消失（反之亦然）。下一轮 ai4s 便找不到缓存，六条追问**现场消解**——
        而改写预算 `timeout_s=8` 正卡在实测 4.9–11.0s 分布中部，SC-6 又会随改写可用率
        抖动：缓存存在的全部意义（可复现）被一次刷新抹掉，且没有任何测试会发现
        （每个刷新用例都只用一个库）。
        """
        frozen = _entry(prior="mito 的先行词", query="mito 冻结的消解结果", changed=True)
        seed = evalmod.ResolutionCache(self.path)
        seed.set(LIB, "ai4s-015", _entry(prior="ai4s 的先行词", query="ai4s 冻结的消解结果"))
        seed.set(OTHER_LIB, "mito-006", frozen)
        seed.save()

        refreshed = evalmod.ResolutionCache(self.path, refresh=True)
        self._resolve([{"id": "ai4s-015", "query": "追问原句"}], {"ai4s-015": "ai4s 的先行词"},
                      resolve=mock.Mock(return_value=("ai4s 重新消解", False)),
                      cache=refreshed)
        refreshed.save()

        libs = self._read()["libraries"]
        self.assertEqual(libs[LIB]["ai4s-015"]["query"], "ai4s 重新消解",
                         "被刷新的那一库没有换成现场值 —— 「刷新」名不副实")
        self.assertIn(OTHER_LIB, libs, "刷新一个库把另一个库整栏抹掉了")
        self.assertEqual(libs[OTHER_LIB]["mito-006"], frozen, "另一库的条目被改动了")

    def test_cli_flag_defaults_to_off_and_can_be_turned_on(self):
        args = evalmod.parse_args(["--impl", "new", "--lib", "ai4s"])
        self.assertFalse(args.refresh_resolutions)
        self.assertTrue(evalmod.parse_args(
            ["--impl", "new", "--lib", "ai4s", "--refresh-resolutions"]
        ).refresh_resolutions)

    def test_default_cache_path_lives_under_root_from_relative_parts(self):
        """代码内不出现绝对路径（宪法 §2.6）：默认路径必须由 ROOT 拼相对段得出。

        运行时它当然是绝对路径（ROOT 由 `__file__` 推导）—— 被禁止的是**写死**的
        绝对路径，故这里钉的是「它确实由 ROOT + 相对段构成」。
        """
        p = evalmod.resolutions_cache_path()
        self.assertEqual(p, evalmod.ROOT / "tests" / "eval_set" /
                         evalmod.RESOLUTIONS_NAME)
        self.assertEqual(p.relative_to(evalmod.ROOT).as_posix(),
                         f"tests/eval_set/{evalmod.RESOLUTIONS_NAME}")


if __name__ == "__main__":
    unittest.main()
