import re
import unittest
from pathlib import Path

from scripts import measure_latency as m


class TestLatencyHelpers(unittest.TestCase):
    def test_percentile_p95(self):
        self.assertAlmostEqual(m.percentile(list(range(1, 101)), 95), 95.05, places=2)

    def test_percentile_single_value(self):
        self.assertEqual(m.percentile([7], 95), 7.0)

    def test_percentile_empty_is_zero(self):
        self.assertEqual(m.percentile([], 95), 0.0)

    def test_timeline_marks_the_three_moments(self):
        frames = [("rewrite", 0.40), ("evidence", 0.55), ("answer", 0.90),
                  ("answer", 1.00), ("done", 3.20)]
        t = m.timeline(frames)
        self.assertAlmostEqual(t["first_feedback"], 0.55, places=2)
        self.assertAlmostEqual(t["first_answer"], 0.90, places=2)
        self.assertAlmostEqual(t["complete"], 3.20, places=2)

    def test_timeline_without_rewrite_event(self):
        t = m.timeline([("evidence", 0.30), ("answer", 0.60), ("done", 2.0)])
        self.assertAlmostEqual(t["first_feedback"], 0.30, places=2)

    def test_timeline_missing_done_is_zero_not_silent_pass(self):
        t = m.timeline([("evidence", 0.30), ("answer", 0.60)])
        self.assertEqual(t["complete"], 0.0)


class TestLatencyArtifact(unittest.TestCase):
    """产物必须满足仓库的换行/编码约定：UTF-8、无 BOM、LF、`ensure_ascii=False`。

    依据是 `.gitattributes` 首行注释写明的「禁止 CRLF 入库，文本文件一律 LF」。
    这条测试守的是**落盘动作本身**，不是「提交时会被规范化」：
    `Path.write_text` 在 Windows 上会把 `\\n` 翻成 `\\r\\n`（T22 实跑时真的踩到过，
    产物带 CRLF），依赖提交环节去纠正意味着工作区与对象库的字节不一致，
    而两种落盘结果的差异无法从产物本身看出来。
    """

    def test_write_json_is_utf8_no_bom_and_lf_only(self):
        import json
        import os
        import tempfile

        payload = {"lib": "ai4s", "note": "中文键值", "runs": [{"a": 1.5}]}
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "artifact.json")
            m._write_json(path, payload)
            with open(path, "rb") as fh:
                raw = fh.read()

        self.assertFalse(raw.startswith(b"\xef\xbb\xbf"), "产物不得带 BOM")
        self.assertNotIn(b"\r\n", raw, "产物必须是 LF，不得出现 CRLF")
        self.assertNotIn(b"\r", raw, "产物不得含裸 CR")
        # `ensure_ascii=False`：中文按原字符落盘，而不是 \uXXXX 转义。
        self.assertIn("中文键值".encode("utf-8"), raw)
        self.assertNotIn(b"\\u", raw)
        self.assertEqual(json.loads(raw.decode("utf-8")), payload)


class TestIncompleteRoundsAreNotPasses(unittest.TestCase):
    """**没有拿到某一刻的轮次不得算通过**（复审 Fix 2）。

    服务端的失败路径发 `error` 而**不发 `answer`**，但 `done` 照发，
    于是那一轮留下 `first_answer = 0.0`。若把 0.0 当数值喂进 percentile，
    它会读成「答案来得极快」——**整轮失败反而让 SC-3 通过**；
    若每一轮都如此，脚本会打印 `all_within_budget: true` 并退出 0。
    这正是 brief 里 `test_timeline_missing_done_is_zero_not_silent_pass`
    要挡的那类静默通过，只是被抬高到了汇总层。
    """

    def test_round_without_answer_is_excluded_and_run_fails(self):
        runs = [
            {"first_feedback": 0.5, "first_answer": 0.0, "complete": 0.0},
            {"first_feedback": 0.6, "first_answer": 240.0, "complete": 240.1},
        ]
        report = m.summarize(runs, lib="ai4s", question="q")
        self.assertEqual(report["incomplete"]["count"], 1)
        self.assertEqual(report["incomplete"]["rounds"][0]["round"], 0)
        # 缺的轮次不进总体：总体只剩真实测到的那一轮。
        self.assertEqual(report["measured_rounds"]["first_answer"], 1)
        self.assertAlmostEqual(report["first_answer_p95"], 240.0, places=2)
        self.assertFalse(report["all_within_budget"])

    def test_every_round_erroring_is_not_a_pass(self):
        runs = [{"first_feedback": 0.0, "first_answer": 0.0, "complete": 0.0}] * 3
        report = m.summarize(runs, lib="ai4s", question="q")
        self.assertFalse(report["all_within_budget"])
        self.assertEqual(report["incomplete"]["count"], 3)
        # 「一个轮次都没有」是**未测得**，不是「0 秒，达标」。
        self.assertEqual(report["first_answer_verdict"], "UNMEASURED")
        self.assertEqual(report["measured_rounds"]["first_answer"], 0)

    def test_missing_done_makes_the_round_incomplete(self):
        runs = [{"first_feedback": 0.4, "first_answer": 12.0, "complete": 0.0}]
        report = m.summarize(runs, lib="ai4s", question="q")
        self.assertEqual(report["incomplete"]["count"], 1)
        self.assertEqual(report["incomplete"]["rounds"][0]["missing"], ["complete"])
        self.assertFalse(report["all_within_budget"])

    def test_a_healthy_set_can_still_pass(self):
        runs = [{"first_feedback": 0.5, "first_answer": 3.0, "complete": 3.1},
                {"first_feedback": 0.7, "first_answer": 3.5, "complete": 3.6}]
        report = m.summarize(runs, lib="ai4s", question="q")
        self.assertEqual(report["incomplete"]["count"], 0)
        self.assertTrue(report["all_within_budget"])
        self.assertEqual(report["first_answer_verdict"], "PASS")

    def test_main_with_zero_rounds_exits_nonzero(self):
        """0 轮（或全轮失败）必须**响亮地**失败，而不是安静地退 0。"""
        import contextlib
        import io
        import sys
        from unittest import mock

        argv = ["measure_latency.py", "--n", "0", "--lib", "ai4s"]
        with mock.patch.object(sys, "argv", argv):
            with contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(SystemExit) as ctx:
                    m.main()
        self.assertNotEqual(ctx.exception.code, 0)
        self.assertTrue(str(ctx.exception.code))


class TestArtifactSelfDescription(unittest.TestCase):
    """产物要能**自述**：什么时候、哪份代码、什么配置下测的（复审第三节）。"""

    def test_config_snapshot_carries_no_absolute_path(self):
        snapshot = m.config_snapshot("ai4s")
        self.assertTrue(snapshot["available"])
        self.assertEqual(self._absolute_paths(snapshot), [])

    def test_summarize_records_environment_and_verdicts(self):
        runs = [{"first_feedback": 0.5, "first_answer": 3.0, "complete": 3.1}]
        report = m.summarize(runs, lib="ai4s", question="q", n_requested=5)
        for key in ("measured_at", "revision", "config", "url",
                    "measured_rounds", "incomplete", "n_requested"):
            self.assertIn(key, report)
        for key in m.BUDGET:
            self.assertIn(f"{key}_verdict", report)
        self.assertEqual(report["n_requested"], 5)

    def _absolute_paths(self, node) -> list:
        """递归找出结构里所有形态像绝对路径的字符串（Windows 盘符或根斜杠）。"""
        found: list = []
        if isinstance(node, dict):
            for value in node.values():
                found += self._absolute_paths(value)
        elif isinstance(node, list):
            for value in node:
                found += self._absolute_paths(value)
        elif isinstance(node, str):
            if node.startswith(("/", "\\\\")) or (len(node) > 1 and node[1] == ":"):
                found.append(node)
        return found


class TestSanitiserKeepsIdentifiers(unittest.TestCase):
    """脱敏器的职责是**去掉绝对路径与凭据**，不是改写标识符（复审 Fix B）。

    原先的判定里有 `key == "model"` 这一支，于是配置里的 Hub 风格模型 id
    `"BAAI/bge-m3"` 会被当成路径、被改写成 `"bge-m3"` 写进产物。
    那让「配置快照」变成**有损**的：产物声称记录了配置，实际改了它。
    断言把两侧都钉住：标识符**逐字保留**，真绝对路径**仍然只留 basename**。
    """

    def test_hub_style_model_id_survives_verbatim(self):
        self.assertEqual(m._redact({"model": "BAAI/bge-m3"}, "model"),
                         {"model": "BAAI/bge-m3"})
        # 相对路径（含 ./ 或 ../）也不是绝对路径，同样不得改写。
        self.assertEqual(m._redact({"x_path": "./library/models/x"}, "x_path"),
                         {"x_path": "./library/models/x"})

    def test_genuine_absolute_paths_are_reduced_to_basename(self):
        for value, expected in (
            (r"D:\KnowledgeBase\rag-stack\library\models\bge-reranker-v2-m3",
             "bge-reranker-v2-m3"),
            ("/usr/share/models/bge-m3", "bge-m3"),
            (r"\\server\share\models\x", "x"),
        ):
            self.assertEqual(m._redact({"vault_path": value}, "vault_path"),
                             {"vault_path": expected}, value)

    def test_secret_looking_keys_are_redacted(self):
        snapshot = {"llm": {"api_key": "sk-should-never-be-committed",
                            "token": "t0ken", "model": "BAAI/bge-m3"}}
        red = m._redact(snapshot, "llm")
        self.assertEqual(red["llm"]["api_key"], "<redacted>")
        self.assertEqual(red["llm"]["token"], "<redacted>")
        self.assertEqual(red["llm"]["model"], "BAAI/bge-m3")

    def test_real_config_snapshot_keeps_its_identifiers(self):
        """真实配置里那些**不是路径**的值必须原样出现（拿真实数据回归，而非只有构造数据）。

        注意 `embed.model` 的真值是 **`"BAAI/bge-m3"`**（Hub 风格 id），
        不是 `"bge-m3"`——后者正是修复前被脱敏器改写出来的那一版。
        本断言就是钉住「别再改回去」。
        """
        values = m.config_snapshot("ai4s")["values"]
        self.assertEqual(values["embed"]["model"], "BAAI/bge-m3")
        self.assertEqual(values["vault_path"], "AI4S(obsidian)")
        self.assertEqual(values["allowed_prefixes"][0], "01-Literature")


class TestBudgetFollowsTheConstitution(unittest.TestCase):
    """闸门口径**只有一个真值源**：宪法第 421 行。

    在此之前 `m.BUDGET` 的三个数在测试里**一次都没有被断言过**——
    `TestArtifactSelfDescription` 只迭代它的**键**（`for key in m.BUDGET`），
    于是常量可以随意漂移而对套件完全不可见。事实上它已经漂移过：宪法第 421 行
    在 v1.1.2 把单轮完整答案的预算由 20s 改为 380s（依据 §8 C-22），
    而 `measure_latency.BUDGET["complete"]` 仍是 `20.0` ⇒ **该脚本拿一个已被推翻的
    暂定值当闸门，对 SC-4 只剩假阴性**（无论实测多快都判 FAIL）。

    故这里**从宪法现文解析**出三个数再逐字比对，而不是把 `2.0 / 4.0 / 380.0`
    再抄一份当期望值——抄一份只是把同一份真值复制成两处，漂移照旧不可见。
    """

    CONSTITUTION = (Path(__file__).resolve().parent.parent
                    / ".specify" / "memory" / "constitution.md")
    # 三个时刻在宪法那行里的**顺序**（= BUDGET 的语义顺序，与脚本产物字段一致）。
    MOMENT_ORDER = ("first_feedback", "first_answer", "complete")
    # 只按**标记**认那一行，不按行号：宪法 PATCH 会在其上增删行，行号会漂移。
    LINE_MARKER = "首个 SSE 事件"

    def test_budget_equals_the_numbers_written_in_the_constitution(self):
        budget, source = self._budget_from_constitution()
        for moment, value in zip(self.MOMENT_ORDER, budget):
            self.assertIn(moment, m.BUDGET,
                          f"脚本的 BUDGET 缺 `{moment}`，而宪法那行写的是 {source}")
            self.assertEqual(
                float(m.BUDGET[moment]), value,
                f"`measure_latency.BUDGET[{moment!r}]` = {m.BUDGET[moment]!r}，"
                f"与 {self.CONSTITUTION.name} 第 {source} 行写着的 {value!r} 不一致："
                "三处阈值是宪法给 SC-2/SC-3/SC-4 的**质量闸门**，"
                "改它就等于改判定口径，须走宪法 PATCH，"
                "不得为让某次测量变绿而在代码里就地改。")

    def _budget_from_constitution(self) -> tuple[list[float], int]:
        """从宪法现文取回那三个阈值 + 出处行号。

        **解析失败一律响亮报错**（`AssertionError` + 指名道姓的消息），
        不静默跳过、也不回退到硬编码期望值——静默跳过等于这道闸门不存在。
        """
        self.assertTrue(
            self.CONSTITUTION.is_file(),
            f"找不到宪法 {self.CONSTITUTION}（延迟阈值没有真值源可比）")
        lines = self.CONSTITUTION.read_text(encoding="utf-8").splitlines()
        hit = [(i, line) for i, line in enumerate(lines, start=1)
               if self.LINE_MARKER in line]
        self.assertEqual(
            len(hit), 1,
            f"{self.CONSTITUTION.name} 里含「{self.LINE_MARKER}」的行有 {len(hit)} 条，"
            f"应为唯一一条（延迟阈值那一行）")
        lineno, line = hit[0]
        # 容忍 markdown 强调符：该行写作 `**380s**`，去掉 `*` 再取数。
        numbers = re.findall(r"(\d+(?:\.\d+)?)\s*s", line.replace("*", ""))
        self.assertEqual(
            len(numbers), len(self.MOMENT_ORDER),
            f"{self.CONSTITUTION.name} 第 {lineno} 行没解析出三个延迟阈值，"
            f"实际取到 {numbers!r}；原行：{line!r}")
        return [float(n) for n in numbers], lineno


if __name__ == "__main__":
    unittest.main()
