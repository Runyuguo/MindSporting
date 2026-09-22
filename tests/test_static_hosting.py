"""T05：静态托管的四条不变式——**红测试**（实现是 Phase 2 的 T10）。

本文件只写测试，不含实现。它要钉死的是「挂载点一旦被日后挪到 API 路由或 `/mcp` 之前，
就会**静默吞掉接口**」这件事——表现是「接口莫名 404」，而代码看起来完全正常。

为什么断言长得这样（读代码的人先看这三条）：

1. `server/http_server.py` 的全部 API 路由是**模块级** `@app.get/@app.post` 注册的，
   而 `build_app()` 只建 app + 挂 `/mcp`，返回的新 app **没有任何 API**。
   故要换静态配置必须**先设环境变量、再 `importlib.reload(http_server)`**——
   重载后模块末行的 `mount_frontend(app)` 才会带着新配置跑一遍。
   为什么是环境变量而不是属性补丁：**reload 会用源码里的模块级赋值覆盖属性补丁**
   （`mock.patch.object(..., create=True)` 只在源码**未定义**该名字时才留得住），
   而环境变量能跨 reload 存活。详见 `_reload_with_dist`。
   重载后的恢复用 `addCleanup` 注销，保证同进程里其他测试拿到的是干净模块。
2. Starlette 1.6 里挂到 `/` 的 `Mount` 对**任何**路径都返回 `Match.FULL`，
   路由器**不会**再往下试后面的路由。所以「挂在前面」= 吞掉后面的一切；
   反过来，只要 API 路由**排在静态之前**，API 就照常命中。
3. 一律用**不需要加载模型**的探针（`lib=bogus` → 400）确认路由可达，
   绝不去碰真引擎、真模型、真 vault。`/reindex`、`/ask/stream` 会触真引擎，
   本文件只断言它们**仍在路由表里**（被静态吞掉则必然为 404）。

分类（控制器裁决：逐条分辨，不硬凑红）见 `.superpowers/sdd/004-spark-merge-deploy/task-T05-report.md`。
"""
from __future__ import annotations

import importlib
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock
from urllib.parse import urlsplit

from fastapi.testclient import TestClient

from server import http_server

# 静态目录的**可测配置面**：T10 在模块 import 时读它
# （`_FRONTEND_DIST = Path(os.environ.get("RAG_FRONTEND_DIST") or <repo>/frontend/dist)`）。
# 生产永不设置它；空串等于未设。它只为可测性存在。
_DIST_ENV = "RAG_FRONTEND_DIST"

# 假 index.html 的哨兵串：任何「响应体是不是 index.html」的判定都靠它，
# 而不是靠内部属性或路由类型（那会把测试写成实现快照）。
_SENTINEL = "T05-FRONTEND-INDEX-SENTINEL"
_FAKE_INDEX = f"<!doctype html><html><body>{_SENTINEL}</body></html>"
_FAKE_ASSET = "console.log('T05-FAKE-ASSET');"
_ASSET_NAME = "app.js"


def _make_dist(root: Path, *, with_index: bool = True) -> None:
    """在 root 下造一份最小前端产物（含 index.html 与一个静态资源）。"""
    root.mkdir(parents=True, exist_ok=True)
    if with_index:
        (root / "index.html").write_text(_FAKE_INDEX, encoding="utf-8")
    (root / _ASSET_NAME).write_text(_FAKE_ASSET, encoding="utf-8")


class _StaticHostingCase(unittest.TestCase):
    """公共脚手架：造临时 dist / 打补丁 / reload，并在用例后逐一还原。"""

    def setUp(self) -> None:
        # 注册在**最先**：LIFO 让「重载回干净模块」在最后执行，
        # 保证即使前面某条清理抛错，模块也不会以「带补丁」的状态留给下一个测试。
        self.addCleanup(self._restore_module)

    def _restore_module(self) -> None:
        """把模块恢复成「没有任何测试补丁」的干净形态（同进程其他测试依赖它）。"""
        if "server.http_server" in sys.modules:
            importlib.reload(http_server)

    def _temp_dist(self, *, with_index: bool = True) -> Path:
        tmp = tempfile.TemporaryDirectory(prefix="t05-dist-")
        self.addCleanup(tmp.cleanup)
        dist = Path(tmp.name) / "dist"
        _make_dist(dist, with_index=with_index)
        return dist

    def _reload_with_dist(self, dist: Path | str | None):
        """换掉静态目录配置后重载模块，返回 (client, mod)。

        配置面是**环境变量 `RAG_FRONTEND_DIST`**（T10 在模块 import 时读它）：
        `_FRONTEND_DIST = Path(os.environ.get("RAG_FRONTEND_DIST")
                               or (Path(__file__).resolve().parent.parent / "frontend" / "dist"))`
        生产永不设置它，空串等于未设——它**只为可测性存在**。

        为什么不用 `mock.patch.object(module, "_FRONTEND_DIST", ...)` + reload
        （**已实测的坑**）：reload 会用源码里的模块级赋值把补丁**覆盖掉**，
        `create=True` 只在「源码未定义该名字」时才留得住补丁。T10 一旦写下
        `_FRONTEND_DIST = ...`，属性补丁就必然失效，reload 后挂的会是**真实**
        `frontend/dist`，哨兵断言永远过不去。环境变量**能跨 reload 存活**，故用它。

        `dist=None` 表示不设环境变量（走模块默认值）。

        还原由 `setUp` 注册的 `_restore_module` 负责（它在 `addCleanup` 里**最先**注册，
        LIFO 使其在**最后**执行）：`mock.patch.dict` 退出时已把 env 逐键还原，
        随后那次 reload 让模块回到默认态。两者都不会留给下一个测试。
        """
        if dist is None:
            with mock.patch.dict(os.environ, {}, clear=False):
                os.environ.pop(_DIST_ENV, None)
                mod = importlib.reload(http_server)
        else:
            with mock.patch.dict(os.environ, {_DIST_ENV: str(dist)}):
                mod = importlib.reload(http_server)
        # raise_server_exceptions=False：/mcp 子应用在 TestClient 未启 lifespan 时
        # 自身会抛「Task group is not initialized」，我们要看的是**状态码**，
        # 而不是让异常穿出测试（异常穿出同样证明「请求到了 MCP 而不是静态」）。
        return TestClient(mod.app, raise_server_exceptions=False), mod

    @staticmethod
    def _assert_json(resp, *, expected_key: str) -> None:
        ctype = resp.headers.get("content-type", "")
        assert "application/json" in ctype, (
            f"期望 JSON 响应，实际 content-type={ctype!r} body={resp.text[:200]!r}")
        payload = json.loads(resp.text)
        assert expected_key in payload, f"JSON 体缺少 {expected_key!r}：{payload!r}"

    @staticmethod
    def _assert_not_frontend(resp) -> None:
        """响应体不得是前端产物（哨兵串不得出现）。"""
        assert _SENTINEL not in resp.text, (
            f"响应体含前端哨兵串（被静态产物吞了）：{resp.text[:200]!r}")

    @staticmethod
    def _api_route_paths(app) -> set[str]:
        return {getattr(r, "path", None) for r in app.routes} - {None}

    def _assert_static_is_live(self, client) -> None:
        """前置：静态确实在服务（否则「端口没被抢走」的断言是**空转**的）。

        「静态没挂」与「静态挂了但没抢走 API」是两件事；不先证明前者，
        后者会因为请求落到普通 404 而看起来成立。这条前置把它堵死。
        """
        index = client.get("/index.html")
        self.assertEqual(
            index.status_code, 200,
            "静态前端产物未被托管（静态挂载尚未实现）——"
            "此用例随后的断言在此之前是空转的：" + index.text[:200])
        self.assertIn(_SENTINEL, index.text,
                      f"/index.html 不是我们放进去的那份产物：{index.text[:200]!r}")

    def _assert_static_is_live_real_dist(self, client) -> None:
        """前置的**真实产物**版本：哨兵串不存在，故只验 `index.html` 可服务。"""
        index = client.get("/index.html")
        self.assertEqual(
            index.status_code, 200,
            "真实 frontend/dist 未被托管（静态挂载尚未实现）："
            + index.text[:200])
        self.assertEqual(
            index.headers.get("content-type", "").split(";")[0], "text/html")

    @staticmethod
    def _assert_mcp_not_swallowed(resp) -> None:
        """`/mcp/` 未被静态挂载接走的口径（两条探针共用）。

        判据 = **状态码 ∉ {404,405}**（实测：静态挂到 `/` 且排在 `/mcp` 之前时，
        被吞的 `/mcp/` 给 404（GET）或 405（POST）；正确顺序给 500）
        **且** 响应体里没有前端哨兵串。

        哨兵那一半是**补充**而非主力：实测 `html=True` 也**不会**让 `/mcp/`
        返回 index.html（挂载点前缀仍先匹配子应用），所以它抓的不是这个已知情形，
        而是「任何将来把界面文档发到 `/mcp/` 上」的未知吞法——成本为零，故保留。

        已用真实 `_build_mcp_app()` 构造「静态先挂」的错误顺序独立验证过：
        正确顺序 → 500（未被吞）；错误顺序 → 404/405（被吞）。护栏**有灵敏度**。
        """
        assert resp.status_code not in (404, 405), (
            "被静态挂载吞掉了（404/405 说明请求没到 MCP 子应用）："
            f"实际 {resp.status_code} {resp.text[:200]!r}")
        assert _SENTINEL not in resp.text, (
            f"/mcp 响应体含前端哨兵串（被静态产物吞了）：{resp.text[:200]!r}")


class TestInvariant1ApiRoutesWinOverStatic(_StaticHostingCase):
    """① API 路由优先于静态：静态挂上了，也**不得**抢走任何 API 路径。

    本类是新行为（今天 `_FRONTEND_DIST` / `mount_frontend` 都不存在、
    静态根本没挂）⇒ **红**。

    为什么把「静态真的挂上了」与「API 没被抢走」写进**同一条用例**：
    若分成两条，「API 仍是 400」那条会在「静态压根没挂」时**空转变绿**
    （本次实测就踩到了这个坑：分列时它 ok）。静态生效必须**先成立**，
    「API 没被抢走」才是有内容的证据。
    """

    def test_api_routes_win_over_an_active_static_mount(self):
        dist = self._temp_dist()
        client, _ = self._reload_with_dist(dist)

        # 前置：静态确实生效（否则下面的 API 断言是空转）。
        index = client.get("/index.html")
        asset = client.get(f"/{_ASSET_NAME}")
        self.assertEqual(
            index.status_code, 200,
            "静态前端产物未被托管（静态挂载尚未实现）——"
            "此用例的 API 断言在此之前是空转的：" + index.text[:200])
        self.assertIn(_SENTINEL, index.text)
        self.assertEqual(asset.status_code, 200, asset.text[:200])
        self.assertIn(_FAKE_ASSET, asset.text)

        # 正题：同在一条 / 挂载之下，API 路由必须仍然优先命中。
        for path in ("/search?lib=bogus", "/doc?lib=bogus",
                     "/capabilities?lib=bogus"):
            with self.subTest(path=path):
                resp = client.get(path)
                self.assertEqual(
                    resp.status_code, 400,
                    "API 路由被静态挂载吞掉了（挂到 / 且排在 API 之前时，"
                    "Starlette 的 Mount 对被吞掉的路径只会给 404/405）："
                    f"实际 {resp.status_code} {resp.text[:200]!r}")
                self._assert_json(resp, expected_key="error")
                self._assert_not_frontend(resp)

    def test_openapi_document_wins_over_an_active_static_mount(self):
        """非 API 的既有路径（`/openapi.json`）同样不得被静态抢走。"""
        dist = self._temp_dist()
        client, _ = self._reload_with_dist(dist)

        self._assert_static_is_live(client)  # 前置：静态确实在服务

        resp = client.get("/openapi.json")
        self.assertEqual(resp.status_code, 200, resp.text[:200])
        self._assert_json(resp, expected_key="paths")
        self._assert_not_frontend(resp)


class TestInvariant2McpNotSwallowed(_StaticHostingCase):
    """② `/mcp` 不被吞。

    **三条用例，今天两红一绿**（以本文件实测为准，逐类计数见修复报告 §L）：
    * **红 2**：`test_mcp_post_reaches_mcp_subapp_not_static`、
      `test_mcp_paths_are_still_behind_the_mcp_mount`。它们红在
      `_assert_static_is_live` **前置**上——静态今天还没挂，故「`/mcp/` 没被抢走」
      是**空转**，前置把它挡成红（T10 一上线即条件成立）。
    * **绿 1**：`test_bare_mcp_keeps_its_slash_redirect`（今天的**绿护栏**）。
      裸 `GET /mcp` 今天本就是 307 → `/mcp/`，与静态挂没挂无关；
      它防的是**T10 的静默回归**：静态挂到 `/` 之后若不显式登记该重定向，
      裸 `/mcp` 会变 404、`POST` 变 405（实测）。

    下面这段说的是 `/mcp/`（**不是**本类今天的绿那条）：静态一旦挂到 `/mcp` 之前，
    请求会落到 StaticFiles；`/mcp/` 是「到得了子应用」的主判据。

    两条探针共用同一个口径 `_assert_mcp_not_swallowed`：
    **状态码 ∉ {404,405} 且响应体无前端哨兵串**。

    **为什么探针必须带尾斜杠 `/mcp/`（实测踩坑）**：
    裸 `GET /mcp` 在「静态已挂载」时会变成 **404**——StaticFiles 让 `/mcp`
    不再匹配 `/mcp/{path:path}`，于是挂载点的斜杠重定向失效、直落 404；
    而它**不**说明 MCP 被吞（`/mcp/` 仍正常到达子应用）。
    把它写进「未被吞」那套断言会得到一个与实现无关的**假红**（本轮预演实测到）。
    `/mcp/` 则是稳定判据：正确顺序 → 500（到子应用）；
    错误顺序（静态先挂）→ **404 / 405**（被吞）——护栏灵敏度已用真实
    `_build_mcp_app()` 构造错误顺序独立验证过。

    `test_bare_mcp_keeps_its_slash_redirect` 补的是**另一件事**：裸 `/mcp` 的
    **既有 307 行为**不得被静态挂载破坏（规范 004 §5「保持既有行为」）。
    两条互补：`/mcp/` 证「到得了子应用」，裸 `/mcp` 证「重定向还在」。
    """

    def test_mcp_post_reaches_mcp_subapp_not_static(self):
        dist = self._temp_dist()
        client, _ = self._reload_with_dist(dist)

        # 前置：静态确实在服务——否则「/mcp/ 没被抢走」是空转（今天正是如此 ⇒ 红）。
        self._assert_static_is_live(client)

        resp = client.post(
            "/mcp/", content=b"{}",
            headers={"content-type": "application/json"})

        self._assert_mcp_not_swallowed(resp)

    def test_mcp_paths_are_still_behind_the_mcp_mount(self):
        """`GET /mcp/`：它仍走到 MCP 挂载点，而不是被 StaticFiles 接走。"""
        dist = self._temp_dist()
        client, _ = self._reload_with_dist(dist)

        self._assert_static_is_live(client)  # 前置：静态确实在服务

        resp = client.get("/mcp/")

        self._assert_mcp_not_swallowed(resp)

    def test_bare_mcp_keeps_its_slash_redirect(self):
        """裸 `/mcp` 必须保持既有行为：**307 → `/mcp/`**（规范 004 §5）。

        **今天是绿护栏**（今天没有静态挂载，裸 `/mcp` 本来就是 307），
        它防的是 **T10 的静默回归**：静态挂到 `/` 之后，`/mcp` 不再匹配
        `/mcp/{path:path}`，若不显式登记重定向，裸 `/mcp` 会变成 404——
        而客户端常用的正是不带斜杠的 `/mcp`。T10 的既定写法是在 `mount("/")`
        **之前**显式登记 `/mcp` → `/mcp/` 的 307，故这条会继续绿。
        （已实测：显式登记后 `GET /mcp` → 307，`location='/mcp/'`。）

        **必须 `follow_redirects=False`**：TestClient 默认跟随重定向，
        裸 `/mcp` 会被跟到 `/mcp/` 并呈现 500，**测不出重定向缺失**。
        实测链条：`GET /mcp` → 307 → `/mcp/` → 500（未启 lifespan 时）。

        **刻意不设 `_assert_static_is_live` 前置**（与同类**另两条**不同）：
        这条要的是「无论静态挂没挂，裸 `/mcp` 都是 307」。
        今天没有静态挂载 ⇒ 本条**今天为绿**；T10 挂上静态而没保住重定向时才变红。
        若加「静态已生效」前置，它会今天就红——那是**搭台子造出来的假红**，不是缺口的证据。
        """
        dist = self._temp_dist()
        _, mod = self._reload_with_dist(dist)

        # 裸 /mcp 与 /mcp/ 是两条不同路径，这里必须换一个不跟随重定向的 client。
        client = TestClient(mod.app, follow_redirects=False,
                            raise_server_exceptions=False)

        resp = client.get("/mcp")

        self.assertEqual(resp.status_code, 307,
                         "裸 /mcp 的既有 307 重定向丢失了（静态挂载把它吞成 404？）："
                         f"实际 {resp.status_code} {resp.text[:200]!r}")
        # location 是完整 URL（如 http://testserver/mcp/），故按 URL 解析取路径；
        # 不要用 Path(...)，它在 Windows 上是 WindowsPath（没有 .path 属性）。
        self.assertEqual(urlsplit(resp.headers["location"]).path, "/mcp/",
                         f"重定向目标应为 /mcp/：实际 {resp.headers.get('location')!r}")


class TestInvariant3ApisWorkWithoutDist(_StaticHostingCase):
    """③ `dist` 不存在时全部 API 仍可用。

    **今天是绿护栏**（本来就不挂静态）——它的价值在于钉住「不被迫先构建前端」
    这条 spec R1 场景 5 的要求，并防止 T10 把「无条件挂载」写进来：
    若实现漏了 `index.html` 存在性判断，目录不存在时挂载会直接抛错，
    或者 `GET /` 变成 200 而这里的三条 API 必须仍为 400。
    """

    def test_apis_available_when_dist_dir_absent(self):
        absent = Path(tempfile.gettempdir()) / "t05-dist-that-does-not-exist-9f3c"
        self.assertFalse(absent.exists(), f"该路径本不该存在：{absent}")
        client, _ = self._reload_with_dist(absent)

        for path in ("/search?lib=bogus", "/doc?lib=bogus",
                     "/capabilities?lib=bogus"):
            with self.subTest(path=path):
                resp = client.get(path)
                self.assertEqual(resp.status_code, 400,
                                 f"{path} 在无 dist 时应仍由 API 处理，"
                                 f"实际 {resp.status_code} {resp.text[:200]!r}")
                self._assert_json(resp, expected_key="error")

    def test_openapi_document_available_when_dist_absent(self):
        """非 API 的既有路径也要在：`/openapi.json` 若被静态吞掉必然是 HTML/404。"""
        absent = Path(tempfile.gettempdir()) / "t05-dist-that-does-not-exist-9f3c"
        client, _ = self._reload_with_dist(absent)

        resp = client.get("/openapi.json")

        self.assertEqual(resp.status_code, 200, resp.text[:200])
        self._assert_json(resp, expected_key="paths")
        self._assert_not_frontend(resp)

    def test_root_is_404_not_500_when_dist_absent(self):
        """dist 缺失时 `/` 必须是 **404**，**不是 500**（spec R1 场景「界面产物缺失时的降级」，
        `spec.md:124-127`：服务**仍**正常启动并提供全部接口）。

        「`/` 返回界面文档」这条要求**以产物存在为前提**：产物不在时 `/` 没有归属路由，
        得到的是普通 404。若实现把 `/` 的登记写在「`index.html` 存在」这个分支**之外**
        （例如无条件 `FileResponse(dist / "index.html")`），产物缺失时这里会变成
        **500**——本用例正是拦住那种写法。接口可用性由同类的
        `test_apis_available_when_dist_dir_absent` 独立钉住。
        """
        absent = Path(tempfile.gettempdir()) / "t05-dist-that-does-not-exist-9f3c"
        self.assertFalse(absent.exists(), f"该路径本不该存在：{absent}")
        client, _ = self._reload_with_dist(absent)

        resp = client.get("/")

        self.assertEqual(
            resp.status_code, 404,
            "dist 缺失时 GET / 应为 404（降级），不得为 500："
            f"实际 {resp.status_code} {resp.text[:200]!r}")
        self._assert_not_frontend(resp)

    def test_reload_keeps_every_api_route_reachable(self):
        """reload 后拿到的 app 必须**真的**带全部 API 路由（不是空壳）。

        否则上面几条会在「路由根本没注册」的假 model 上变绿。
        """
        dist = self._temp_dist()
        _, mod = self._reload_with_dist(dist)

        paths = self._api_route_paths(mod.app)
        for expected in ("/search", "/doc", "/capabilities",
                         "/ask/stream", "/reindex", "/mcp"):
            with self.subTest(route=expected):
                self.assertIn(expected, paths,
                              f"reload 后的 app 缺少路由 {expected}；"
                              f"实际 {sorted(p for p in paths)}")

    def test_engine_touching_routes_only_checked_for_registration(self):
        """触真引擎的路由（`/reindex`、`/ask/stream`）**不**发请求，只查注册表。

        发请求会加载模型/写索引，违反本机只读与「不碰真引擎」的约束。
        """
        absent = Path(tempfile.gettempdir()) / "t05-dist-that-does-not-exist-9f3c"
        _, mod = self._reload_with_dist(absent)

        paths = self._api_route_paths(mod.app)
        self.assertIn("/reindex", paths)
        self.assertIn("/ask/stream", paths)


class TestInvariant4UnknownPath404NotHtml(_StaticHostingCase):
    """④ 未知路径 404，**且响应体不是 `index.html`**（不设 SPA 回退）。

    T10 落地后本类**全绿**（原 docstring 记的「红 3 / 绿 1」是 T05 期的计数，已过时；
    那是 T10 尚未实现时的状态，不是本类的不变量本身）。

    ⚠️ **`/` 不是「未知路径」**，本类不得把它当未知路径断言。`/` 是「打开界面」的
    入口，按 spec 004 R1 场景「打开界面」（`spec.md:102-105`）与 **SC-25**
    （`spec.md:292`）必须**返回界面文档** ⇒ 见
    `test_root_returns_index_html_without_spa_fallback`。
    「不设回退」约束的是**未知**路径：`/` 命中的是产物目录**自身**的 `index.html`，
    不是「未命中后回退到界面文档」。T05 期把 `/` 写进本类的 `== 404` 口径是**越界**，
    已按规格纠正（见 `.superpowers/sdd/004-spark-merge-deploy/task-T10-fix1-report.md` §1）。
    """

    def test_unknown_path_404_without_dist(self):
        absent = Path(tempfile.gettempdir()) / "t05-dist-that-does-not-exist-9f3c"
        client, _ = self._reload_with_dist(absent)

        resp = client.get("/nope-unknown-path")

        self.assertEqual(resp.status_code, 404, resp.text[:200])
        self._assert_not_frontend(resp)

    def test_unknown_path_404_with_dist_and_body_is_not_index(self):
        dist = self._temp_dist()
        client, _ = self._reload_with_dist(dist)

        # 前置：静态**确实在服务**。否则「未知路径 404」只是因为压根没有静态挂载，
        # 那是空转变绿，不是「未命中没被回退成 index.html」的证据。
        self._assert_static_is_live(client)

        # 注意**不放 `/search/`**：Starlette 的斜杠重定向会让它 307 到 `/search` 再 200，
        # 那是既有 API 的重定向行为，不是「静态回退」——写进来只会得到一个假红。
        for path in ("/nope-unknown-path", "/mcp-typo", "/does-not-exist/deep"):
            with self.subTest(path=path):
                resp = client.get(path)
                self.assertEqual(resp.status_code, 404,
                                 f"{path} 应 404（不设 SPA 回退），"
                                 f"实际 {resp.status_code} {resp.text[:200]!r}")
                self._assert_not_frontend(resp)

    def test_real_frontend_dist_is_served_at_root(self):
        """**真实**产物上的 SC-25 口径：`GET /` 取回的就是 `frontend/dist/index.html`。

        这条把 SC-25（`plan.md:382`：`curl -s http://…:8000/` **返回 `index.html`**）
        钉在**真产物**上，而不是临时哨兵产物上：状态码 200、`content-type` 为
        `text/html`、体与磁盘那份**逐字节相同**（因此也含内置标题哨兵）。
        不写死 dist 里的资源文件名（那是产物内容，不该进测试）。
        """
        real_index = (Path(http_server.__file__).resolve().parent.parent
                      / "frontend" / "dist" / "index.html")
        self.assertTrue(real_index.exists(),
                        f"前置事实变了：本机应存在 {real_index}（brief 已实测）")

        client, _ = self._reload_with_dist(None)  # None：不设 env，走模块默认值

        self._assert_static_is_live_real_dist(client)

        resp = client.get("/")
        self.assertEqual(
            resp.status_code, 200,
            "GET / 未返回界面文档（spec 004 R1 场景「打开界面」/ SC-25）："
            f"实际 {resp.status_code} {resp.content[:200]!r}")
        self.assertEqual(
            resp.headers.get("content-type", "").split(";")[0], "text/html",
            f"GET / 的 content-type 不是 text/html：{resp.headers.get('content-type')!r}")
        expected = real_index.read_bytes()
        self.assertEqual(
            resp.content, expected,
            f"GET / 的响应体与 {real_index} 不是逐字节相同："
            f"len={len(resp.content)} vs {len(expected)}")
        self.assertIn("<title>思维游乐场</title>".encode("utf-8"), resp.content,
                      "GET / 的响应体缺少内置标题哨兵")

    def test_root_returns_index_html_without_spa_fallback(self):
        """`GET /` **必须返回界面文档**（spec 004 R1 场景「打开界面」；SC-25）。

        权威文本（逐字）：
        * `spec.md:102-105` —— 「#### Scenario: 打开界面 / **WHEN** 使用者访问根路径 /
          **THEN** 返回界面文档，且界面可正常渲染」
        * `spec.md:292`（**SC-25**）—— 「单一来源可访问 | **根路径返回界面文档**；
          界面全部请求与页面同源（跨源请求数 = 0）」

        口径 = **200 + `text/html` + 体就是那一份 `index.html`**（临时产物用哨兵串，
        并与磁盘那份逐字节比对）。**不接受 3xx**：SC-25 要求根路径**返回**文档，
        而「307 跳到 `/index.html` 再 200」是**重定向**，不是返回文档；且重定向响应体里
        没有哨兵串，哨兵断言单独也拦不住假回退——故这里必须写死 `== 200` 而非 `!= 404`。

        与「不设 SPA 回退」**不矛盾**：`/` 命中的是产物目录**自身**的 `index.html`
        （目录 URL 的既有语义），**未知**路径仍 404 且体不是 `index.html`——
        见 `test_unknown_path_404_with_dist_and_body_is_not_index`。
        """
        dist = self._temp_dist()
        client, _ = self._reload_with_dist(dist)

        # 前置：静态确实在服务——否则「/ 是 index.html」可能只是空转。
        self._assert_static_is_live(client)

        resp = client.get("/")

        self.assertEqual(
            resp.status_code, 200,
            "GET / 未返回界面文档（spec.md:102-105 / SC-25 = 根路径返回界面文档）："
            f"实际 {resp.status_code} {resp.text[:200]!r}")
        self.assertEqual(
            resp.headers.get("content-type", "").split(";")[0], "text/html",
            f"GET / 的 content-type 不是 text/html：{resp.headers.get('content-type')!r}")
        self.assertEqual(
            resp.content, (dist / "index.html").read_bytes(),
            "GET / 的响应体不是那一份 index.html（逐字节比对）")
        self.assertIn(_SENTINEL, resp.text,
                      f"GET / 的响应体缺少产物哨兵串：{resp.text[:200]!r}")


class TestMountFrontendContract(_StaticHostingCase):
    """T10 新函数 `mount_frontend` 的**契约**（今天该函数不存在 ⇒ 红）。

    只断言「文档化的对外结果」：返回值 + 是否真的挂上了（以 HTTP 行为验证），
    不去断言内部属性/路由类型。
    """

    def test_mount_frontend_returns_false_when_index_missing(self):
        empty = Path(tempfile.mkdtemp(prefix="t05-empty-"))
        self.addCleanup(shutil.rmtree, empty, ignore_errors=True)
        # 目录存在但**没有** index.html：契约是「仅当 <dist>/index.html 存在才挂」
        (empty / "other.txt").write_text("x", encoding="utf-8")

        from fastapi import FastAPI
        application = FastAPI()
        before = len(application.routes)

        mounted = http_server.mount_frontend(application, empty)

        self.assertFalse(mounted, "无 index.html 时不得挂载")
        self.assertEqual(len(application.routes), before,
                         "无 index.html 时路由表不应新增任何挂载")

    def test_mount_frontend_returns_false_when_dist_absent(self):
        absent = Path(tempfile.gettempdir()) / "t05-dist-absent-mount-frontend"
        self.assertFalse(absent.exists(), f"该路径本不该存在：{absent}")

        from fastapi import FastAPI
        application = FastAPI()
        before = len(application.routes)

        mounted = http_server.mount_frontend(application, absent)

        self.assertFalse(mounted, "目录不存在时不得挂载")
        self.assertEqual(len(application.routes), before,
                         "目录不存在时路由表不应新增任何挂载")

    def test_mount_frontend_default_dist_is_frontend_dist(self):
        """默认值契约：`_FRONTEND_DIST` 指向**本仓库**的 `frontend/dist`。

        只断言「常量存在 + 指向 `<repo>/frontend/dist`」这一份口径。
        **不**断言「必须是相对路径」：仓库惯例就是用 `__file__` 推导
        （`server/mcp_server.py:20`、`rag_core/rag_engine.py:900`），
        `tests/test_eval_resolution_cache.py:291-295` 明确「禁的是**写死**绝对路径，
        `__file__` 推导的**运行期**绝对路径是允许的」。若改回相对 `"frontend/dist"`，
        服务目录会依赖 CWD（异处启动 = 静默不挂载、失败不可见）——那是更糟的结果。
        """
        raw = getattr(http_server, "_FRONTEND_DIST", None)
        self.assertIsNotNone(raw, "契约缺失：模块常量 `_FRONTEND_DIST` 尚未实现（T10）")

        repo_root = Path(http_server.__file__).resolve().parent.parent
        self.assertEqual(
            Path(str(raw)).resolve(), (repo_root / "frontend" / "dist").resolve(),
            f"_FRONTEND_DIST 应指向 {repo_root / 'frontend' / 'dist'}，实际 {raw!r}")

    def test_application_routes_unchanged_by_reload(self):
        """reload 不得让 app 变成空壳（10 条路由：4 文档 + /mcp + 5 API）。"""
        dist = self._temp_dist()
        _, mod = self._reload_with_dist(dist)

        api = self._api_route_paths(mod.app)
        for expected in ("/search", "/doc", "/capabilities", "/ask/stream", "/reindex"):
            with self.subTest(route=expected):
                self.assertIn(expected, api)


if __name__ == "__main__":
    unittest.main()
