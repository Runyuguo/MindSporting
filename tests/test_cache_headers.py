"""T40 —— 静态前端的**分层缓存头**（只作用于静态挂载，绝不是全局中间件）。

为什么必须存在（T39 §5.4 的实测，不是假设）：部署后两个浏览器配置**都**继续用着
部署前的 `index.html` 缓存、加载旧的 bundle，于是白屏依旧——而服务端早就在发修好的
文档。成因是 `GET /` 带 `ETag`/`Last-Modified` 但**没有 `Cache-Control`**：
预热过的浏览器不会重新验证，也就永远看不到新文档。

本模块钉住三条策略（见 brief）：
1. **入口文档**（`/`、`/index.html`，以及任何从产物目录发出的 HTML）→ `no-cache`：
   每次都必须**重新验证**；`ETag`/`Last-Modified` 仍在，故命中时是便宜的 **304**。
   这里**不许**用 `no-store` —— 那会把重新验证本身也一起废掉。
2. **`/assets/` 下文件名带构建哈希的产物**（如 `index-KB5is_gI.js`）→
   `public, max-age=31536000, immutable`（内容寻址，永不失效）。
3. **其余非指纹化静态文件**（`favicon.svg`、`icons.svg`、`/assets/plain.js`）→ `no-cache`，
   **不得**给 `immutable`。

第 4 条边界同样被钉住：`/capabilities` 的 `no-store`
（既有断言 `tests/test_capabilities.py:96`）必须**原样存活** —— 缓存策略一旦做成
「给一切响应盖章」的全局中间件，那条既有断言就会转红。本文件不修改、不弱化它。

测试脚手架与 `tests/test_static_hosting.py` 同源：`RAG_FRONTEND_DIST` 环境变量 +
`importlib.reload`（模块 import 时才读产物目录）。临时产物里放一个**非**指纹化的
`assets/plain.js`，用来把「哈希」这一条判据与「在不在 assets/ 下」区分开。
"""
from __future__ import annotations

import importlib
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

from server import http_server

_DIST_ENV = "RAG_FRONTEND_DIST"

_SENTINEL = "T40-FRONTEND-INDEX-SENTINEL"
_FAKE_INDEX = f"<!doctype html><html><body>{_SENTINEL}</body></html>"
_FAKE_JS = "console.log('T40-FAKE-JS');"
_FAKE_CSS = "/* T40-FAKE-CSS */"

# 真实产物里的两种文件名（Vite/Rollup 默认哈希长度 8）：
#   指纹化 -> assets/index-KB5is_gI.js：最后一段「-哈希」是内容寻址
#   非指纹化 -> assets/plain.js：没有哈希段，**不得** immutable
_FINGERPRINTED_JS = "index-abc12345.js"
_FINGERPRINTED_CSS = "index-abc12345.css"
_PLAIN_JS = "plain.js"

_REVALIDATE = "no-cache"
_IMMUTABLE = "public, max-age=31536000, immutable"


def _make_dist(root: Path) -> None:
    root.mkdir(parents=True, exist_ok=True)
    (root / "index.html").write_text(_FAKE_INDEX, encoding="utf-8")
    (root / "favicon.svg").write_text("<svg/>", encoding="utf-8")
    (root / "icons.svg").write_text("<svg/>", encoding="utf-8")
    assets = root / "assets"
    assets.mkdir(parents=True, exist_ok=True)
    (assets / _FINGERPRINTED_JS).write_text(_FAKE_JS, encoding="utf-8")
    (assets / _FINGERPRINTED_CSS).write_text(_FAKE_CSS, encoding="utf-8")
    (assets / _PLAIN_JS).write_text(_FAKE_JS, encoding="utf-8")


class _CacheHeaderCase(unittest.TestCase):
    """造临时产物 / 重载模块 / 用例后还原（与 test_static_hosting 同一套路）。"""

    def setUp(self) -> None:
        self.addCleanup(self._restore_module)

    def _restore_module(self) -> None:
        if "server.http_server" in sys.modules:
            importlib.reload(http_server)

    def _temp_dist(self) -> Path:
        tmp = tempfile.TemporaryDirectory(prefix="t40-dist-")
        self.addCleanup(tmp.cleanup)
        dist = Path(tmp.name) / "dist"
        _make_dist(dist)
        return dist

    def _client_with_dist(self, dist: Path | str | None):
        if dist is None:
            with mock.patch.dict(os.environ, {}, clear=False):
                os.environ.pop(_DIST_ENV, None)
                mod = importlib.reload(http_server)
        else:
            with mock.patch.dict(os.environ, {_DIST_ENV: str(dist)}):
                mod = importlib.reload(http_server)
        return TestClient(mod.app, raise_server_exceptions=False), mod

    def _assert_static_is_live(self, client) -> None:
        """前置：静态**确实在服务**——否则下面的缓存头断言是空转。"""
        index = client.get("/index.html")
        self.assertEqual(index.status_code, 200,
                         "静态前端产物未被托管，本用例的断言在此之前是空转的："
                         + index.text[:200])
        self.assertIn(_SENTINEL, index.text)

    @staticmethod
    def _cc(resp) -> str:
        return resp.headers.get("cache-control", "")


class TestEntryDocumentRevalidates(_CacheHeaderCase):
    """① 入口文档 → `no-cache`（必须重新验证），且**不是** `no-store`。"""

    def test_root_and_index_html_carry_no_cache(self):
        client, _ = self._client_with_dist(self._temp_dist())
        self._assert_static_is_live(client)

        for path in ("/", "/index.html"):
            with self.subTest(path=path):
                resp = client.get(path)
                self.assertEqual(resp.status_code, 200, resp.text[:200])
                self.assertEqual(
                    self._cc(resp), _REVALIDATE,
                    f"{path} 的 Cache-Control 必须是 {_REVALIDATE!r}"
                    f"（预热浏览器必须重新验证），实际 {self._cc(resp)!r}"
                    f" headers={dict(resp.headers)!r}")

    def test_entry_document_keeps_etag_so_revalidation_can_be_a_304(self):
        """`no-cache` 只有在带验证器时才有意义：ETag/Last-Modified 必须仍在。

        否则「每次重新验证」会退化成「每次重传整份文档」。
        """
        client, _ = self._client_with_dist(self._temp_dist())
        self._assert_static_is_live(client)
        resp = client.get("/")
        self.assertTrue(resp.headers.get("etag"),
                        f"入口文档丢了 ETag：{dict(resp.headers)!r}")
        self.assertTrue(resp.headers.get("last-modified"),
                        f"入口文档丢了 Last-Modified：{dict(resp.headers)!r}")

    def test_conditional_request_on_the_document_returns_304_with_no_cache(self):
        """条件请求（`If-None-Match`）→ **304**，且 304 上仍带 `no-cache`。

        这就是关掉「陈旧 index.html」的那条机制本身：重新验证成功时零重传，
        失败时拿到新文档 —— 两种结局都不会让浏览器继续跑旧 bundle。
        """
        client, _ = self._client_with_dist(self._temp_dist())
        self._assert_static_is_live(client)

        first = client.get("/")
        etag = first.headers.get("etag")
        self.assertTrue(etag, f"前置不成立：入口文档没有 ETag：{dict(first.headers)!r}")

        second = client.get("/", headers={"If-None-Match": etag})
        self.assertEqual(second.status_code, 304,
                         f"带 If-None-Match 的 GET / 必须 304，实际 "
                         f"{second.status_code} headers={dict(second.headers)!r}")
        self.assertEqual(self._cc(second), _REVALIDATE,
                         f"304 上必须仍带 {_REVALIDATE!r}：{dict(second.headers)!r}")
        self.assertEqual(second.content, b"", "304 不得带响应体")


class TestFingerprintedAssetsAreImmutable(_CacheHeaderCase):
    """② `/assets/` 下带构建哈希的文件名 → 一年 + `immutable`。"""

    def test_fingerprinted_js_and_css_are_immutable(self):
        client, _ = self._client_with_dist(self._temp_dist())
        self._assert_static_is_live(client)

        for name, marker in ((_FINGERPRINTED_JS, _FAKE_JS),
                             (_FINGERPRINTED_CSS, _FAKE_CSS)):
            with self.subTest(name=name):
                resp = client.get(f"/assets/{name}")
                self.assertEqual(resp.status_code, 200, resp.text[:200])
                self.assertIn(marker, resp.text)
                self.assertEqual(
                    self._cc(resp), _IMMUTABLE,
                    f"指纹化产物 /assets/{name} 的 Cache-Control 必须是 "
                    f"{_IMMUTABLE!r}，实际 {self._cc(resp)!r}")

    def test_fingerprinted_asset_304_keeps_the_immutable_policy(self):
        """条件请求命中指纹化产物时，304 上**仍**是 immutable 那条策略。

        否则浏览器可能把 304 之后的重用判成「需要重新验证」，白白丢掉内容寻址的意义。
        """
        client, _ = self._client_with_dist(self._temp_dist())
        self._assert_static_is_live(client)

        first = client.get(f"/assets/{_FINGERPRINTED_JS}")
        etag = first.headers.get("etag")
        self.assertTrue(etag, f"前置不成立：产物没有 ETag：{dict(first.headers)!r}")
        second = client.get(f"/assets/{_FINGERPRINTED_JS}",
                            headers={"If-None-Match": etag})
        self.assertEqual(second.status_code, 304,
                         f"实际 {second.status_code} {dict(second.headers)!r}")
        self.assertEqual(self._cc(second), _IMMUTABLE,
                         f"304 上的策略被改动了：{dict(second.headers)!r}")


class TestNonFingerprintedFilesAreNotImmutable(_CacheHeaderCase):
    """③ 非指纹化静态文件 → `no-cache`，**不得** `immutable`。

    `assets/plain.js` 是这条判据的关键样本：它**在** `assets/` 下、**是** `.js`，
    但文件名里没有构建哈希 —— 只按「目录 + 扩展名」分类的实现会在这里露馅。
    """

    def test_favicon_icons_and_plain_asset_are_not_immutable(self):
        client, _ = self._client_with_dist(self._temp_dist())
        self._assert_static_is_live(client)

        for path in ("/favicon.svg", "/icons.svg", f"/assets/{_PLAIN_JS}"):
            with self.subTest(path=path):
                resp = client.get(path)
                self.assertEqual(resp.status_code, 200, resp.text[:200])
                cc = self._cc(resp)
                self.assertNotIn(
                    "immutable", cc,
                    f"{path} 没有构建哈希，**不得** immutable（实际 {cc!r}）")
                self.assertEqual(
                    cc, _REVALIDATE,
                    f"{path} 应回落到重新验证（{_REVALIDATE!r}），实际 {cc!r}")


class TestApiRoutesKeepTheirOwnHeaders(_CacheHeaderCase):
    """④ 静态挂载之外的路径**保持现状** —— 特别是 `/capabilities` 的 `no-store`。

    这条是 `tests/test_capabilities.py:96` 的**显式回归护栏**：把缓存策略写成
    全局中间件（给一切响应盖章）就会在这里转红。本次实现只包住静态挂载。
    """

    def test_capabilities_still_returns_no_store(self):
        client, _ = self._client_with_dist(self._temp_dist())
        self._assert_static_is_live(client)

        resp = client.get("/capabilities")
        self.assertEqual(resp.status_code, 200, resp.text[:200])
        self.assertEqual(
            self._cc(resp), "no-store",
            f"/capabilities 的 no-store 被缓存策略覆盖了：{dict(resp.headers)!r}")

    def test_unknown_path_404_gets_no_static_cache_policy(self):
        """静态兜底自己的 404 不是产物：不得被盖上静态缓存头。"""
        client, _ = self._client_with_dist(self._temp_dist())
        self._assert_static_is_live(client)

        resp = client.get("/nope-unknown-path")
        self.assertEqual(resp.status_code, 404, resp.text[:200])
        self.assertNotIn("immutable", self._cc(resp),
                         f"404 被盖上了 immutable：{dict(resp.headers)!r}")


class TestRealDistCachePolicy(_CacheHeaderCase):
    """真实产物上的同一套判据（产物存在是既有事实，见 test_static_hosting）。

    用**真实**的 `frontend/dist` 跑一遍，证明策略对将要部署的那批文件成立，
    而不是只对临时哨兵产物成立。不写死产物文件名：从磁盘现取。
    """

    def _real_dist(self) -> Path:
        return (Path(http_server.__file__).resolve().parent.parent
                / "frontend" / "dist")

    def test_real_dist_root_revalidates_and_real_assets_are_immutable(self):
        dist = self._real_dist()
        self.assertTrue((dist / "index.html").exists(),
                        f"前置事实变了：本机应存在 {dist / 'index.html'}")

        client, _ = self._client_with_dist(None)  # None：走模块默认产物目录

        root = client.get("/")
        self.assertEqual(root.status_code, 200, root.text[:200])
        self.assertEqual(
            self._cc(root), _REVALIDATE,
            f"真实产物 GET / 必须有 Cache-Control: {_REVALIDATE}，"
            f"实际 {dict(root.headers)!r}")

        real_assets = sorted((dist / "assets").glob("index-*.js"))
        self.assertTrue(real_assets, f"前置事实变了：{dist / 'assets'} 下没有 index-*.js")
        for asset in real_assets:
            with self.subTest(asset=asset.name):
                resp = client.get(f"/assets/{asset.name}")
                self.assertEqual(resp.status_code, 200, resp.text[:200])
                self.assertEqual(
                    self._cc(resp), _IMMUTABLE,
                    f"真实产物 /assets/{asset.name} 必须是 {_IMMUTABLE!r}，"
                    f"实际 {self._cc(resp)!r}")

        for path in ("/favicon.svg", "/icons.svg"):
            with self.subTest(path=path):
                resp = client.get(path)
                self.assertEqual(resp.status_code, 200, resp.text[:200])
                self.assertNotIn("immutable", self._cc(resp),
                                 f"{path} 不是指纹化产物：{dict(resp.headers)!r}")


if __name__ == "__main__":
    unittest.main()
