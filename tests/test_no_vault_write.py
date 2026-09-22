"""宪法 §2.1 / spec「只读部署形态」· 无任何写入。

与 test_mcp_surface 的分工：那个查「符号还在不在」，这个查「运行时有没有落地」。
两者缺一不可——符号没了不代表没有别的路径在写。

观测范围：断言我们的代码不写 vault；Obsidian 自身的应用状态目录不在观测范围内。
"""
import unittest
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

from rag_core import llm, rag_engine
from server import http_server


# 快照排除项：这些目录由 Obsidian 自身随时改写，不是我们的代码写的
# （如 `.obsidian/workspace.json` 会在本机 Obsidian 运行时被任意时刻重写）。
# 若不排除，测试会因「别人的写入」偶发失败，与本缺陷无关。
# 排除仅限这两处应用状态/回收站目录；其余路径的新增、删除、mtime 变化一律照常断言。
# 匹配用 **vault 相对路径** 的组成部分，绝不用绝对路径：否则若 vault 自身坐落于
# 某个叫 `.obsidian` / `.trash` 的祖先目录下，`_SNAPSHOT_EXCLUDE & set(p.parts)`
# 会命中祖先段、把整个 vault 排除干净，快照恒为 {}，三条断言永久为真——
# 测试会静默失效却依旧显示绿。
_SNAPSHOT_EXCLUDE = {".obsidian", ".trash"}


def snapshot(root: Path) -> dict[str, int]:
    out: dict[str, int] = {}
    for p in root.rglob("*"):
        if not p.is_file():
            continue
        rel = p.relative_to(root)  # 相对路径：排除项只对 vault 内的段生效
        if _SNAPSHOT_EXCLUDE & set(rel.parts):
            continue
        out[str(rel)] = p.stat().st_mtime_ns
    return out


class TestNoVaultWrite(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # 本任务在 T05（引擎单例）之前执行，只能用现有的 _engine_from_lib。
        # get_engine 由 T05 引入，此处不可用——预检时发现并已裁定。
        cls.engine = rag_engine._engine_from_lib("ai4s")
        cls.vault = Path(cls.engine.cfg["vault_path"])

    def setUp(self):
        self.client = TestClient(http_server.app)

    def _assert_unchanged(self, before: dict[str, int]) -> None:
        after = snapshot(self.vault)
        self.assertEqual(set(after) - set(before), set(), "vault 出现新文件")
        self.assertEqual(set(before) - set(after), set(), "vault 有文件被删")
        changed = {k for k in before.keys() & after.keys() if before[k] != after[k]}
        self.assertEqual(changed, set(), f"vault 有文件被改：{changed}")

    def test_ask_stream_does_not_touch_vault(self):
        before = snapshot(self.vault)
        # 只为隔离外部 LLM provider：本测试断言的是「HTTP 生成路径不写 vault」，
        # 检索（真实跑）与 SSE 组装全部真实执行，仅替换掉对外部网络的流式调用。
        with mock.patch.object(llm, "stream_parts",
                               return_value=iter([("content", "答")])):
            resp = self.client.post("/ask/stream", json={
                "lib": "ai4s",
                "messages": [{"role": "user", "content": "线粒体"}],
            })
        # T07 起 `/ask/stream` 已是 POST：生成器真实执行，本测试才真正覆盖
        # 「HTTP 生成路径不写 vault」。若此处回落 405，说明端点退化，必须立刻暴露。
        self.assertEqual(resp.status_code, 200)
        self._assert_unchanged(before)

    def test_search_does_not_touch_vault(self):
        before = snapshot(self.vault)
        self.client.get("/search", params={"lib": "ai4s", "q": "mitochondria", "topn": 1})
        self._assert_unchanged(before)

    def test_mcp_search_tool_does_not_touch_vault(self):
        from server import mcp_server
        tool = getattr(mcp_server.search, "fn", mcp_server.search)
        before = snapshot(self.vault)
        tool(lib="ai4s", query="mitochondria", topn=1)
        self._assert_unchanged(before)


if __name__ == "__main__":
    unittest.main()
