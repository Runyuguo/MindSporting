"""生成参数纯函数：发散→采样、篇幅→目标与容差、正文字数统计。

这些是「参数真正生效」的判定核心，故必须与 HTTP 层解耦、可独立单测。
"""
import tempfile
import unittest
from pathlib import Path

from rag_core import params

_SPEC = {"temperature_min": 0.1, "temperature_max": 1.2,
         "top_p_min": 0.5, "top_p_max": 0.95}


class TestDivergenceToSampling(unittest.TestCase):
    def test_zero_maps_to_minimum(self):
        out = params.divergence_to_sampling(0.0, _SPEC)
        self.assertAlmostEqual(out["temperature"], 0.1)
        self.assertAlmostEqual(out["top_p"], 0.5)

    def test_two_maps_to_maximum(self):
        out = params.divergence_to_sampling(2.0, _SPEC)
        self.assertAlmostEqual(out["temperature"], 1.2)
        self.assertAlmostEqual(out["top_p"], 0.95)

    def test_midpoint_is_linear(self):
        out = params.divergence_to_sampling(1.0, _SPEC)
        self.assertAlmostEqual(out["temperature"], 0.65)
        self.assertAlmostEqual(out["top_p"], 0.725)

    def test_monotonic_increase(self):
        vals = [params.divergence_to_sampling(d, _SPEC)["temperature"]
                for d in (0.0, 0.5, 1.0, 1.5, 2.0)]
        self.assertEqual(vals, sorted(vals))
        self.assertEqual(len(set(vals)), len(vals), "不同发散取值必须给出不同采样温度")

    def test_out_of_range_is_clamped_not_raised(self):
        # 端点取值必须正常完成（spec「参数边界」），故夹紧而非报错
        self.assertAlmostEqual(
            params.divergence_to_sampling(-5.0, _SPEC)["temperature"], 0.1)
        self.assertAlmostEqual(
            params.divergence_to_sampling(99.0, _SPEC)["temperature"], 1.2)


class TestLengthTolerance(unittest.TestCase):
    def test_count_excludes_markdown_markers_and_whitespace(self):
        text = "# 标题\n\n**加粗** 的正文 $x$ 还有 [1] 引用\n\n- 列表项\n"
        # 计数口径：只算可见正文字符——去掉 Markdown 标记、引用编号与空白
        out = params.count_answer_chars(text)
        self.assertGreater(out, 0)
        self.assertLess(out, len(text), "标记与空白不该被计入字数")

    def test_count_is_stable_for_plain_text(self):
        # 纯文本的字数 = 字符数。注意「线粒体自噬」是 **5** 个汉字
        # （线/粒/体/自/噬），brief 原稿写的 6 与函数实现（以及事实）矛盾，
        # 已按事实改为 5（见报告「偏离」一节）。
        self.assertEqual(params.count_answer_chars("线粒体自噬"), 5)
        self.assertEqual(params.count_answer_chars("线粒体自噬"), len("线粒体自噬"))

    def test_within_tolerance_accepts_boundaries(self):
        self.assertTrue(params.within_tolerance(900, 1000))   # -10%
        self.assertTrue(params.within_tolerance(1100, 1000))  # +10%
        self.assertTrue(params.within_tolerance(1000, 1000))

    def test_within_tolerance_rejects_outside(self):
        self.assertFalse(params.within_tolerance(899, 1000))
        self.assertFalse(params.within_tolerance(1101, 1000))

    def test_length_bounds(self):
        self.assertEqual(params.length_bounds(1000), (900, 1100))

    def test_max_tokens_grows_with_target(self):
        self.assertLess(params.max_tokens_for(500), params.max_tokens_for(3000))


class TestShippedGenerateConfig(unittest.TestCase):
    def _cfg(self, lib: str) -> dict:
        import json
        from pathlib import Path
        from rag_core import rag_engine
        p = Path(rag_engine.__file__).resolve().parent / f"config_{lib}.json"
        return json.loads(p.read_text(encoding="utf-8"))

    def test_both_libs_declare_generate_block(self):
        for lib in ("ai4s", "mito"):
            g = self._cfg(lib)["generate"]
            self.assertEqual(g["length"]["tolerance"], 0.10)
            self.assertGreaterEqual(g["length"]["max_retry"], 0)
            for k in ("temperature_min", "temperature_max", "top_p_min", "top_p_max"):
                self.assertIn(k, g["divergence"])

    def test_is_supported_reports_true_when_landed(self):
        out = params.is_supported(self._cfg("ai4s"))
        self.assertTrue(out["divergence"])
        self.assertTrue(out["length"])

    def test_is_supported_reports_false_when_block_missing(self):
        out = params.is_supported({})
        self.assertFalse(out["divergence"])
        self.assertFalse(out["length"])


class TestGenerateBlockValidation(unittest.TestCase):
    """整支审查 I4：config 的 `generate` 块**要么完整、要么别声明**。

    为什么需要这条（`is_supported` 曾只是"这一块在不在"）：
    - `divergence` 少一个键 ⇒ `is_supported` 仍报 True（界面标「已生效」），
      而 `divergence_to_sampling` 取 `spec["temperature_min"]` 时会 KeyError ⇒
      **界面说的和实际做的不一致**，正是 spec「参数不被支持时的如实性」要禁的；
    - `load_config` 对嵌套块是**逐子键合并**（`rag_engine.py` 的 `merged.update(v)`），
      只合并到 `divergence` 这一层、**不深入其子键** ⇒ 用户配置若写了个半截块，
      缺的键**不会**被默认值补上，于是上面的失真真的会发生。
    故在读取配置时就校验：缺键 ⇒ 直接报错拒绝启动（与 `sources.source_prefixes`
    对不完整映射"响亮失败"的既有做法一致），而不是带着错配置跑到某一轮提问才炸。
    """

    def _write(self, tmp: Path, generate: dict) -> str:
        import json
        from rag_core import rag_engine
        src = Path(rag_engine.__file__).resolve().parent / "config_ai4s.json"
        cfg = json.loads(src.read_text(encoding="utf-8"))
        cfg["generate"] = generate
        p = tmp / "config_partial.json"
        p.write_text(json.dumps(cfg, ensure_ascii=False), encoding="utf-8")
        return str(p)

    def test_incomplete_divergence_block_is_rejected_at_load(self):
        from rag_core import rag_engine
        with tempfile.TemporaryDirectory(prefix="rag_stack_gen_") as d:
            # 半截块：truthy，但少了 temperature_min / temperature_max / top_p_*
            path = self._write(Path(d), {"divergence": {"top_p_min": 0.5}})
            with self.assertRaises(ValueError) as ctx:
                rag_engine.load_config(path)
        msg = str(ctx.exception)
        self.assertIn("divergence", msg, "报错必须指出是哪个块不完整")
        self.assertIn("temperature_min", msg, "报错必须指出缺了哪个键")

    def test_complete_divergence_without_length_is_allowed(self):
        """只落地一项是**合法**状态（另一项报 false 即可），不得被这条校验误伤。"""
        from rag_core import rag_engine
        complete = {"divergence": {"temperature_min": 0.1, "temperature_max": 1.2,
                                   "top_p_min": 0.5, "top_p_max": 0.95}}
        with tempfile.TemporaryDirectory(prefix="rag_stack_gen_") as d:
            cfg = rag_engine.load_config(self._write(Path(d), complete))
        self.assertTrue(params.is_supported(cfg)["divergence"])
        self.assertFalse(params.is_supported(cfg)["length"])

    def test_shipped_configs_pass_validation(self):
        """两份真实配置必须过校验 —— 否则服务直接起不来。"""
        from rag_core import rag_engine
        for lib in ("ai4s", "mito"):
            p = Path(rag_engine.__file__).resolve().parent / f"config_{lib}.json"
            cfg = rag_engine.load_config(str(p))
            self.assertEqual(params.is_supported(cfg), {"divergence": True, "length": True, "topn": True})
