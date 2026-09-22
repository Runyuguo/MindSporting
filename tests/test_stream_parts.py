"""思考转发旁路：把模型真实思考（reasoning_content）与正式回答分流。

用**真值对象**（不用 Mock）驱动 `_part_of`，因为 `getattr` 的缺省行为正是被测的容错点。
"""
import unittest
from unittest import mock

from rag_core import llm


class _Delta:
    def __init__(self, content=None, reasoning_content=None):
        if content is not None:
            self.content = content
        if reasoning_content is not None:
            self.reasoning_content = reasoning_content


class TestPartOf(unittest.TestCase):
    def test_reasoning_only(self):
        self.assertEqual(llm._part_of(_Delta(reasoning_content="想")), ("reasoning", "想"))

    def test_content_only(self):
        self.assertEqual(llm._part_of(_Delta(content="答")), ("content", "答"))

    def test_both_prefers_reasoning(self):
        # 同一 delta 同时带两者时先出思考（顺序即语义）
        self.assertEqual(
            llm._part_of(_Delta(content="答", reasoning_content="想")), ("reasoning", "想"))

    def test_missing_attributes_returns_none(self):
        self.assertIsNone(llm._part_of(_Delta()))

    def test_empty_strings_return_none(self):
        self.assertIsNone(llm._part_of(_Delta(content="", reasoning_content="")))

    def test_arbitrary_object_does_not_raise(self):
        # 兜底：上游换了形状也不能炸
        self.assertIsNone(llm._part_of(object()))


class TestStreamParts(unittest.TestCase):
    def _drive(self, deltas):
        """用假 SDK 客户端驱动 stream_parts，不触网。

        补丁必须打在 **`openai.OpenAI`**（包属性）上，而不是 `rag_core.llm.OpenAI`：
        `stream_parts` 里是**函数内** `from openai import OpenAI`，每次调用都从 openai 包
        重新取名字；llm 模块上根本没有 OpenAI 这个属性（brief 原稿打的就是它，
        实测 `AttributeError: module 'rag_core.llm' has no attribute 'OpenAI'`）。
        这与 `test_ask_stream.py::test_sampling_params_reach_the_sdk_create_call` 是同一手法。
        """
        made: list[str] = []

        class _Chunk:
            def __init__(self, d):
                self.choices = [type("C", (), {"delta": d})()]

        class _Stream:
            def __init__(self, ds):
                self._ds = ds

            def __iter__(self):
                return iter(_Chunk(d) for d in self._ds)

        class _Completions:
            def create(self, **kwargs):
                return _Stream(deltas)

        class _Client:
            def __init__(self, **kwargs):
                made.append("client")
                self.chat = type("Chat", (), {"completions": _Completions()})()

        with mock.patch("openai.OpenAI", _Client):
            parts = list(llm.stream_parts([{"role": "user", "content": "x"}]))
        # 防空转：补丁若失效（例如 stream_parts 被改成模块级 `from openai import OpenAI`，
        # 那时本补丁不再生效），这里必须响亮地失败，而不是悄悄去真连 provider。
        self.assertTrue(made, "假客户端未被构造 —— 补丁没生效，本用例已在触网")
        return parts

    def test_splits_reasoning_then_content(self):
        parts = self._drive([_Delta(reasoning_content="想"), _Delta(content="答")])
        self.assertEqual(parts, [("reasoning", "想"), ("content", "答")])

    def test_skips_empty_deltas(self):
        parts = self._drive([_Delta(), _Delta(content=""), _Delta(content="答")])
        self.assertEqual(parts, [("content", "答")])


if __name__ == "__main__":
    unittest.main()
