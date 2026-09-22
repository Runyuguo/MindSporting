import unittest
from unittest import mock

from rag_core import llm


class TestRewriteQuery(unittest.TestCase):
    def test_single_question_returns_it_unchanged_without_llm(self):
        msgs = [{"role": "user", "content": "线粒体自噬的机制"}]
        with mock.patch.object(llm, "stream_chat") as sc:
            result = llm.rewrite_query(msgs)
        self.assertEqual(result.query, "线粒体自噬的机制")
        self.assertFalse(result.degraded)
        sc.assert_not_called()

    def test_followup_is_rewritten_via_llm(self):
        msgs = [
            {"role": "user", "content": "线粒体自噬的机制"},
            {"role": "assistant", "content": "……"},
            {"role": "user", "content": "那它的调控因子呢"},
        ]
        with mock.patch.object(llm, "stream_chat", return_value="线粒体自噬 调控因子"):
            result = llm.rewrite_query(msgs)
        self.assertEqual(result.query, "线粒体自噬 调控因子")
        self.assertFalse(result.degraded)

    def test_strips_quotes_and_prefixes(self):
        msgs = [
            {"role": "user", "content": "甲"},
            {"role": "assistant", "content": "乙"},
            {"role": "user", "content": "那它呢"},
        ]
        with mock.patch.object(llm, "stream_chat", return_value='查询："线粒体自噬"'):
            result = llm.rewrite_query(msgs)
        self.assertEqual(result.query, "线粒体自噬")

    def test_blank_question_skips_llm(self):
        with mock.patch.object(llm, "stream_chat") as sc:
            result = llm.rewrite_query([{"role": "user", "content": "   "}])
        self.assertEqual(result.query, "")
        self.assertFalse(result.degraded)
        sc.assert_not_called()

    def test_llm_failure_degrades_to_original_question(self):
        msgs = [
            {"role": "user", "content": "线粒体自噬"},
            {"role": "assistant", "content": "……"},
            {"role": "user", "content": "那它呢"},
        ]
        with mock.patch.object(llm, "stream_chat", side_effect=TimeoutError("slow")):
            result = llm.rewrite_query(msgs)
        self.assertEqual(result.query, "那它呢")
        self.assertTrue(result.degraded)

    def test_slow_llm_is_cut_off_by_timeout(self):
        """超时必须真实生效：用实际耗时断言，而不是只断言异常被捕获。"""
        import time

        def slow(messages, on_delta=None, *, timeout_s=None, lib=None):
            time.sleep(5)
            return "too late"

        msgs = [
            {"role": "user", "content": "线粒体自噬"},
            {"role": "assistant", "content": "……"},
            {"role": "user", "content": "那它呢"},
        ]
        started = time.monotonic()
        with mock.patch.object(llm, "stream_chat", side_effect=slow):
            result = llm.rewrite_query(msgs, timeout_s=0.3)
        elapsed = time.monotonic() - started

        self.assertTrue(result.degraded)
        self.assertEqual(result.query, "那它呢")
        self.assertLess(
            elapsed, 2.0,
            "超时后必须立即返回；若接近 5s 说明等待了慢调用（多半是误用了 "
            "`with ThreadPoolExecutor(...)` 导致 shutdown(wait=True)）",
        )

    def test_failure_is_logged(self):
        """宪法 §3.3：except 必须至少记录到服务日志。"""
        msgs = [
            {"role": "user", "content": "甲"},
            {"role": "assistant", "content": "乙"},
            {"role": "user", "content": "那它呢"},
        ]
        with mock.patch.object(llm, "stream_chat", side_effect=RuntimeError("boom")), \
                self.assertLogs("rag_core.llm", level="WARNING") as captured:
            llm.rewrite_query(msgs)
        self.assertTrue(any("boom" in line for line in captured.output))

    def test_history_is_trimmed_to_configured_rounds(self):
        msgs = [{"role": "user", "content": f"q{i}"} for i in range(20)]
        msgs.append({"role": "user", "content": "current"})
        captured = {}

        def fake(messages, on_delta=None, *, timeout_s=None, lib=None):
            captured["n"] = len(messages)
            captured["msgs"] = messages
            return "rewritten"

        with mock.patch.object(llm, "stream_chat", side_effect=fake):
            llm.rewrite_query(msgs, history_rounds=3)
        # 3 轮 = 6 条历史 + 1 条 system 提示词 + 当前问句 = 8
        self.assertEqual(captured["n"], 8)
        self.assertEqual(captured["msgs"][0]["role"], "system")
        self.assertEqual(
            sum(1 for m in captured["msgs"] if m["role"] == "user"), 7,  # 6 历史 + 当前
        )

    def test_history_is_trimmed_by_char_budget(self):
        msgs = [
            {"role": "user", "content": "x" * 5000},
            {"role": "assistant", "content": "y" * 5000},
            {"role": "user", "content": "current"},
        ]
        captured = {}

        def fake(messages, on_delta=None, *, timeout_s=None, lib=None):
            captured["n"] = len(messages)
            captured["msgs"] = messages
            return "rewritten"

        with mock.patch.object(llm, "stream_chat", side_effect=fake):
            llm.rewrite_query(msgs, history_rounds=3, max_chars=6000)
        # 整轮 5000+5000 超预算 -> 必须「整轮」丢弃，只留 system + 当前问句 = 2。
        # 若只丢半轮（留下 assistant 回复、丢掉它所回答的 user 提问）会得到 3。
        self.assertEqual(captured["n"], 2, "超预算时应丢弃最旧轮次（整轮，不留半轮）")
        self.assertEqual(captured["msgs"][0]["role"], "system")
        self.assertEqual(captured["msgs"][-1]["content"], "current")
        # 断言「历史被整轮丢弃」而不仅是总数
        self.assertEqual(sum(1 for m in captured["msgs"] if m["role"] != "system"), 1)

    def test_non_conversation_messages_do_not_enter_prompt_or_consume_budget(self):
        """Ruling 30（复审改判）：历史里混入 system/tool 时，它们既不进 prompt 也不占预算。

        `_trim_history` 收到的 `messages` 是未过滤的；若不在内部按角色过滤，
        system/tool 会作为「一条消息」进入 payload，并按其长度吃掉预算。
        """
        msgs = [
            {"role": "system", "content": "系" * 4000},
            {"role": "user", "content": "甲"},
            {"role": "assistant", "content": "乙"},
            {"role": "tool", "content": "工" * 4000},
            {"role": "user", "content": "那它呢"},
        ]
        captured = {}

        def fake(messages, on_delta=None, *, timeout_s=None, lib=None):
            captured["msgs"] = messages
            return "rewritten"

        with mock.patch.object(llm, "stream_chat", side_effect=fake):
            llm.rewrite_query(msgs, history_rounds=3, max_chars=6000)

        # [0] 是改写器自己的 system 提示词（本来就该在）；历史段从这里开始。
        history_segment = captured["msgs"][1:]
        non_conversation = [m for m in history_segment
                            if m["role"] not in ("user", "assistant")]
        self.assertEqual(non_conversation, [],
                         f"system/tool 不得进入改写 prompt，实际有：{non_conversation}")
        self.assertEqual([m["role"] for m in captured["msgs"]],
                         ["system", "user", "assistant", "user"])
        # 预算不被 8000 字符的 system/tool 吃掉：真实历史（甲/乙）仍应留下。
        self.assertIn({"role": "user", "content": "甲"}, captured["msgs"],
                      "非对话消息不应挤掉真实历史轮的预算")

    def test_tiny_budget_still_calls_llm_with_system_and_question(self):
        """预算小到装不下任何历史时：仍必须带 system 提示词与当前问句去调用 LLM，
        而不是抛异常或静默降级。"""
        msgs = [
            {"role": "user", "content": "甲" * 200},
            {"role": "assistant", "content": "乙" * 200},
            {"role": "user", "content": "current"},
        ]
        captured = {}

        def fake(messages, on_delta=None, *, timeout_s=None, lib=None):
            captured["msgs"] = messages
            return "rewritten"

        with mock.patch.object(llm, "stream_chat", side_effect=fake):
            result = llm.rewrite_query(msgs, history_rounds=3, max_chars=400)

        self.assertFalse(result.degraded)
        self.assertEqual(captured["msgs"][0]["role"], "system")
        self.assertEqual(captured["msgs"][-1]["content"], "current")
        self.assertEqual(len(captured["msgs"]), 2, "预算装不下历史时只应剩 system + 当前问句")


if __name__ == "__main__":
    unittest.main()
