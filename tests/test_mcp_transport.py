"""T08：MCP 传输层契约——streamable-http、服务路径 /mcp、工具面仅 search。

分两层，缺一不可：

1. **结构性断言**（前 3 条，逐字来自 task-8-brief.md）——断言源码文本里没有 stdio、
   有 /mcp、无鉴权标识。它们便宜，但**无法**区分两处真实陷阱（见下）。
2. **真实握手**（test_handshake_lists_search_only）——in-process ASGI 起一个真的
   `ClientSession`，走 `initialize()` + `tools/list`。

为什么必须有第 2 层：`assertIn("/mcp", src)` 对下面两种坏接线**同样通过**——
- 误挂成 `/mcp/mcp`（把已经自带 `/mcp` 路由的子应用再 mount 到 `/mcp`）：源码里照样有 "/mcp"；
- 挂对了但**没把子应用的 lifespan 织进父应用**：`StreamableHTTPSessionManager.run()`
  从不执行，源码里照样有 "/mcp"。

只有真的完成一次 MCP 会话才同时覆盖这两条：路径错 ⇒ 请求 404（协议错误 "Not Found"）；
lifespan 没起 ⇒ session manager 未运行，initialize 拿到
「Task group is not initialized. Make sure to use run().」
"""
from __future__ import annotations

import ast
import asyncio
import contextlib
import logging
import os
import pathlib
import unittest

# 与 server/http_server.py 同款的离线标志：模型只从本地缓存加载。
# 必须在导入 server.* 之前设定，否则首次语义检索会挂在 huggingface.co 连接上。
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")


def setUpModule():
    """压掉 MCP SDK / 模型库的日志，保持测试输出干净（只影响本测试模块）。

    streamable-http 的会话管理器每建一次会话就打一条 INFO，真实握手会为路径断言
    多连几次；模型库的 "Loading SentenceTransformer model"、tqdm 进度条同理。
    这些是被观测对象的正常噪声，不是本任务要断言的行为，故在测试进程内按名压低
    ——只改本测试进程的日志级别，不动生产代码。
    """
    for name in ("mcp", "httpx2", "httpcore", "sentence_transformers", "transformers"):
        logging.getLogger(name).setLevel(logging.WARNING)


MCP = pathlib.Path(__file__).resolve().parent.parent / "server" / "mcp_server.py"

# 客户端用的 base URL 与真实部署一致：带端口。
# 理由：`mcp` SDK 的 streamable-http 子应用默认开启 DNS-rebinding 防护，只接受
# `allowed_hosts = ["127.0.0.1:*", "localhost:*", "[::1]:*"]`——Host 头**必须带端口**。
# 不带端口的 base_url 会发 `Host: 127.0.0.1`，被拒 421 Misdirected Request。
# 真实部署里客户端访问的就是 `http://<host>:<port>/mcp`，Host 头天然带端口。
MCP_BASE_URL = "http://127.0.0.1:8000"
MCP_URL = MCP_BASE_URL + "/mcp"


class TestMcpTransport(unittest.TestCase):
    def setUp(self):
        self.src = MCP.read_text(encoding="utf-8")

    def test_uses_streamable_http_not_stdio(self):
        self.assertIn("streamable-http", self.src)
        self.assertNotIn('transport="stdio"', self.src)

    def test_mounts_at_slash_mcp(self):
        self.assertIn("/mcp", self.src)

    def test_no_authentication_guard(self):
        """spec「匿名调用」：服务端不要求任何凭据，也不做调用方身份识别。

        结构性断言：模块内不得出现鉴权相关标识。协议层的实际匿名调用
        由 T08 Step 5 的手工探针覆盖。
        """
        lowered = self.src.lower()
        for word in ("api_key", "apikey", "www-authenticate", "bearer "):
            with self.subTest(word=word):
                self.assertNotIn(word, lowered)

    def test_engine_rejects_unknown_lib_instead_of_defaulting(self):
        """宪法 §2.2：`lib` 非法值必须报错，不得默认命中某库。

        结构性断言 `(lib or "ai4s")` 不在 `_engine` 里——因为任何库名回退都意味着
        「调用方写错 lib 也照样拿到某个库的证据」，那正是跨库混用。
        """
        tree = ast.parse(self.src)
        fn = next(
            (n for n in ast.walk(tree)
             if isinstance(n, ast.FunctionDef) and n.name == "_engine"),
            None,
        )
        self.assertIsNotNone(fn, "mcp_server 里应有 _engine(lib) 解析入口")
        body = ast.get_source_segment(self.src, fn)
        self.assertNotIn('"ai4s"', body, f"_engine 仍存在默认库回退：\n{body}")


class TestMcpStreamableHttpHandshake(unittest.TestCase):
    """真实握手：in-process ASGI 上跑一个真的 MCP 客户端会话。

    选 in-process ASGI（而不是启 uvicorn）的理由：
    - 不占网络端口、不受本机防火墙 / 已有 8000 端口进程影响，测试可重复；
    - 应用由**生产同一个工厂** `http_server.build_app()` 构造，路由、mount 路径与
      lifespan 接线全是真的，唯一被替换的是 HTTP 传输层
      （httpx2.ASGITransport 直接调 ASGI app）；
    - 走的是 SDK 自带的 `streamable_http_client`，不是自造请求。

    为什么不用模块级 `http_server.app`：`StreamableHTTPSessionManager.run()`
    每个实例只能调一次，两个用例共用它会让第二条失败（真跑起来才发现的约束）。
    故每条用例各调一次 `build_app()`——接线代码完全同一条，只是实例不同。

    不用 `IsolatedAsyncioTestCase`：它的 asyncio 慢任务调试钩子会在**输出里**打
    「Executing <Task ...> took 0.725 seconds」告警（stderr），污染测试输出；
    本类用 `asyncio.run` 显式驱动，等价且安静。

    真实 uvicorn + 真端口的端到端验证由 `.scratch/test_mcp_streamable_http.py`
    手工探针承担。
    """

    async def _handshake(self, url: str) -> list[str]:
        """起 app lifespan，连 url，返回工具名列表（会话在退出时关闭）。"""
        import httpx2
        from mcp import ClientSession
        from mcp.client.streamable_http import streamable_http_client
        from server import http_server

        app = http_server.build_app()
        async with contextlib.AsyncExitStack() as stack:
            # 关键：父应用的 lifespan。挂载不会把子应用 lifespan 传上来，
            # 若没织进去，session manager 不会 run，握手必然失败。
            await stack.enter_async_context(app.router.lifespan_context(app))
            client = await stack.enter_async_context(
                httpx2.AsyncClient(
                    transport=httpx2.ASGITransport(app=app),
                    base_url=MCP_BASE_URL,
                    follow_redirects=True,
                    timeout=httpx2.Timeout(30.0),
                )
            )
            async with streamable_http_client(url, http_client=client) as (read, write):
                async with ClientSession(read, write) as session:
                    init = await session.initialize()
                    self.assertEqual(init.server_info.name, "rag-stack")
                    tools = await session.list_tools()
                    return [t.name for t in tools.tools]

    def test_handshake_lists_search_only(self):
        names = asyncio.run(self._handshake(MCP_URL))
        self.assertEqual(names, ["search"], f"工具面必须恰好是 [search]，实际 {names}")

    def test_handshake_also_succeeds_with_trailing_slash(self):
        """挂载边界：`/mcp/` 也必须落在同一个挂载点上。

        与上一条分工：接线完全相同，只改客户端 URL。若误挂成 /mcp/mcp，
        `/mcp/` 会被重定向到不存在的路由而失败——这条正是对「真实路径」的独立一票。
        """
        names = asyncio.run(self._handshake(MCP_URL + "/"))
        self.assertEqual(names, ["search"], f"工具面必须恰好是 [search]，实际 {names}")
