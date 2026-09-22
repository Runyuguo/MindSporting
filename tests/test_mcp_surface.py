import ast
import pathlib
import unittest


MCP = pathlib.Path(__file__).resolve().parent.parent / "server" / "mcp_server.py"


class TestMcpSurface(unittest.TestCase):
    def setUp(self):
        self.src = MCP.read_text(encoding="utf-8")
        self.tree = ast.parse(self.src)

    def test_no_qa_logging_symbols(self):
        for name in ("_log_qa", "QA_DIR_NAME"):
            with self.subTest(name=name):
                self.assertNotIn(name, self.src)

    def test_only_search_tool(self):
        decorated = [
            n.name
            for n in ast.walk(self.tree)
            if isinstance(n, ast.FunctionDef)
            and any(
                isinstance(d, ast.Call)
                and getattr(d.func, "attr", "") == "tool"
                for d in n.decorator_list
            )
        ]
        self.assertEqual(decorated, ["search"])

    def test_does_not_import_llm(self):
        imported = {
            alias.name
            for n in ast.walk(self.tree)
            if isinstance(n, ast.ImportFrom)
            for alias in n.names
        }
        self.assertNotIn("llm", imported)


if __name__ == "__main__":
    unittest.main()
