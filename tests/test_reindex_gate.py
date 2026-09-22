"""T06：`/reindex` 闸门的三条不变式——**红测试**（实现是 Phase 2 的 T11）。

本文件只写测试，不含实现。它要钉死的是 004 规范对部署形态（`spark-10af` 侧）的裁定：

> 部署形态**永久只读、任何写入路径都不得存在**（宪法 §0.2）。
> 既有代码里唯一一条写入路径是 `POST /reindex`（重建检索索引 = 改写派生数据）。
> 该形态下它必须**根本不注册**（路由表里没有 ⇒ 404），
> **而不是**「注册了再拒绝（403）」——「注册了再拒，等于承认写能力存在」。

分类（控制器裁决：逐条分辨，不硬凑红）
见 `.superpowers/sdd/004-spark-merge-deploy/task-T06-report.md`（含 fix round 1）。
覆盖 ①②③ 三条不变式 + ④ 取值语义（非空即禁），用例构成见报告。

────────────────────────────────────────────────────────────────────────
**本文件绝不触发 `/reindex`（这是写它时最要命的一条）**

今天 `/reindex` **是注册着的**，且它的处理器体真的会跑 `_engine(lib).sync_index()`
——**真的重建索引、真的写 `rag_core/data`**（慢且破坏性）。因此本文件：

* **不向 `/reindex` 发任何 HTTP 请求**（不用 `TestClient.post("/reindex")`）。
  即使你以为「今天它该 404」——今天它**不会**，它会执行。
* ①②③④ 一律走**路由表**（`mod.app.routes` 的 `path` 属性）断言；
  唯一发出的 HTTP 请求是 `GET /openapi.json`（纯 schema 文档，不进任何处理器）。
* 「路由**不存在**」这条断言只可能用路由表来做——把「不存在」表达成 HTTP 状态码
  就必须真发一次请求，那正是本条禁止的动作。
* 「注册了」的判据也不靠**路由数**：`/openapi.json`、`/docs` 等 4 条是 FastAPI 自带的，
  数一变就误报。判据是 「`/reindex` 这条**记录**在不在」，数只作辅助。

────────────────────────────────────────────────────────────────────────
**为什么配置面是环境变量 + `importlib.reload`**

`RAG_DISABLE_REINDEX` 由 T11 在**模块 import 时**读取。故换配置必须
**先设环境变量、再 `importlib.reload(http_server)`**。
*已实测的坑*：`mock.patch.object(mod, "<常量>", ...)` + reload **不行**——
reload 会用源码里的模块级赋值把补丁覆盖掉。环境变量**能跨 reload 存活**。

还原：`setUp` **最先**注册（`addCleanup` LIFO ⇒ **最后**执行）「env 已由
`mock.patch.dict` 还原后再 reload 回默认态」。这样同进程里别的测试拿到的是干净模块
（本机有别人的 `unittest discover` 会话，不得互相污染）。
"""
from __future__ import annotations

import importlib
import os
import sys
import unittest
from unittest import mock

from fastapi.testclient import TestClient

from server import http_server

# T11 在模块 import 时读的**可测配置面**。生产（本机形态）永不设置它，空串等于未设。
_DISABLE_ENV = "RAG_DISABLE_REINDEX"

# 只有部署形态才闸掉的那**一条**写路径。
_REINDEX_PATH = "/reindex"

# 绝不能被这条闸门误伤的邻居：**4 条** API + 同进程挂载的 MCP。
# 注意这 4 条**不全只读**：`/search`、`/doc`、`/capabilities` 只读，
# `/ask/stream` 是 **POST 生成**（走 LLM，但不改派生数据）。
# 它们是「`/reindex` 之外的全部 API」——闸门只许动 `/reindex` 一条。
_OTHER_API_PATHS = ("/search", "/doc", "/capabilities", "/ask/stream")
_MCP_MOUNT_PATH = "/mcp"


def _route_paths(mod) -> list:
    """模块 app 的**路由表**里每一条的路径（含 Mount，故 `/mcp` 也在内）。

    读 `path` 属性而不是 `path_format`/`methods`：`Route`、`Mount`、`APIRoute` 都有
    `path`，故这一份清单同时看得到「API 路由」与「挂载点」——闸门若把挂载点也弄丢，
    这里必须能看见。
    """
    return [getattr(r, "path", None) for r in mod.app.routes]


def _find_path(mod, path: str) -> list:
    """路由表里**每一条**路径等于 `path` 的记录（含 Mount）。

    故意返回**条数**而不是布尔：闸门若「删掉一条、加回一条」或出现重复注册，
    布尔会当成通过，条数不会。
    """
    return [r for r in mod.app.routes if getattr(r, "path", None) == path]


def _api_inventory(mod) -> list:
    """路由表里**API 路由**（非 FastAPI 自带文档路由）的 (路径, 方法集) 清单。

    判据是「`/reindex` 这条记录在不在」，所以这里只取 `apiroute` 类记录，
    `/openapi.json`、`/docs`、`/docs/oauth2-redirect`、`/redoc` 四条自带的
    不计入——路由数一变就误报。
    """
    out = []
    for r in mod.app.routes:
        cls = type(r).__name__
        if cls == "APIRoute":
            out.append((getattr(r, "path", None),
                        frozenset(getattr(r, "methods", None) or ())))
    return out


class ReindexGateCase(unittest.TestCase):
    """公共脚手架：换 env 后 reload，并在用例后逐一还原。

    ────────────────────────────────────────────────────────────────────
    **取值语义：非空即禁（刻意的 fail-closed）**

    T11 的判据是 `os.environ.get("RAG_DISABLE_REINDEX", "").strip()` **为真** ⇒
    该路由不注册；**strip 后为空或未设** ⇒ 不启用闸门。

    为什么「非空即禁」而不是「只认 `1`」：部署机上这条 env 是**给人手写**的，
    写错的取值（`true`/`yes`/`TRUE`/带空格的 `1`）**绝不能静默把写路径留在只读部署机上**。
    对宪法 §0.2「部署侧任何写入路径都不得存在」而言，多禁一次只是少一个端点（可发现、
    可修）；少禁一次则是一条**不该存在的重建索引路径**（不可接受的不对称）。
    故本类用 `"1"`、`"0"`、`"true"` 三种**语义相反或书写相反**的取值钉住这条口径，
    并反过来要求「纯空白（strip 后为空）等同未设」——避免把**明显的空值**
    也当成「设了」，那样本机形态会被误闸。
    """

    def setUp(self) -> None:
        # 注册在**最先**：LIFO 让「reload 回默认态」在最后执行，
        # 保证即使前面某条清理抛错，模块也不会以「带 env 的形态」留给下一个测试。
        self.addCleanup(self._restore_default_module)
        # 每个用例都从默认态起步（不信前一个用例，也不信别人的会话）。
        self.default_mod = self._reload_without_gate()
        # **快照**默认态（fix round 1，复审 Important）：
        # `importlib.reload` 返回**同一个模块对象**并把 `app` **原地重绑**，故
        # `self.default_mod.app` 会在后续任何一次 reload 之后**变成新 app**——
        # 拿它当基准去比 reload 后的结果，两侧其实是**同一个对象**，断言恒真（空转）。
        # 只有**复制出来的列表**才留得住改动前的形态。
        self.default_paths = _route_paths(self.default_mod)
        self.default_api_inventory = _api_inventory(self.default_mod)
        self.default_openapi_paths = set(self._openapi(self.default_mod).get("paths", {}))

    def _restore_default_module(self) -> None:
        """把模块恢复成「没有 `RAG_DISABLE_REINDEX`」的默认形态。

        `mock.patch.dict` 退出时已经把 env 逐键还原，故这里直接 reload 即回到默认态。
        """
        if "server.http_server" in sys.modules:
            importlib.reload(http_server)

    def _reload_without_gate(self):
        """不设 `RAG_DISABLE_REINDEX`（= 本机形态）重载模块，返回模块。

        先 `pop` 再 reload：万一 ambient env 里真的设了它（跑测试的人手滑），
        「本机形态」也会是**真·未设**，而不是被环境悄悄变成部署形态。
        """
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop(_DISABLE_ENV, None)
            return importlib.reload(http_server)

    def _reload_with_gate(self, value: str = "1"):
        """设 `RAG_DISABLE_REINDEX=<value>`（= 部署形态）重载模块，返回模块。

        参数化的 `value` 是给「非空即禁」的取值语义用例用的（见类 docstring）：
        `"1"`、`"0"`、`"true"` 都必须关门；带 `"  "` 的用例走 `_reload_without_gate`。

        还原由 `setUp` 注册的 `_restore_default_module` 负责（它在 `addCleanup` 里
        **最先**注册，LIFO 使其**最后**执行）。
        """
        with mock.patch.dict(os.environ, {_DISABLE_ENV: value}):
            return importlib.reload(http_server)

    # ── 探针：唯一被允许发出的 HTTP 请求 ─────────────────────────────────
    def _openapi(self, mod) -> dict:
        """`GET /openapi.json` —— 纯 schema 文档，不进任何处理器、不碰引擎/vault。

        它是**行为层**的第三只眼：路由表是**规范**（要什么就一定有什么），
        schema 是**对外真实样子**。两者都要看，才不是看实现快照。
        `/reindex` 绝不出现在这个探针里——它不是被请求的那个对象。
        """
        client = TestClient(mod.app, raise_server_exceptions=False)
        resp = client.get("/openapi.json")
        self.assertEqual(resp.status_code, 200, f"/openapi.json 不可达：{resp.status_code}")
        return resp.json()

    # ── ① 部署形态：该路由**不存在**（今日为红） ─────────────────────────
    def test_gate_removes_reindex_route_from_route_table(self):
        """`RAG_DISABLE_REINDEX=1` ⇒ `/reindex` **不注册**（路由表里 0 条）。

        「不存在」的判据是**这条记录在不在**（`_find_path` 返回条数 == 0），
        不是路由总数：总数会被 FastAPI 自带文档路由搅浑。
        """
        mod = self._reload_with_gate()
        hits = _find_path(mod, _REINDEX_PATH)
        self.assertEqual(
            hits, [],
            f"部署形态下 /reindex 仍被注册（{len(hits)} 条）——"
            f"裁定是**根本不注册**（404），不是「注册了再拒绝（403）」："
            f"注册了再拒等于承认写能力存在。实际路由表：{_route_paths(mod)}")

    def test_gate_removes_reindex_from_openapi(self):
        """schema 是**对外真实样子**：部署形态下 `/reindex` 不得出现在 paths 里。

        与上一条互为独立证据（上条看内部注册表，这条看对外产物）；
        这条同时**独立**证明「没注册」而不是「注册了却被中间件挡下」。
        """
        mod = self._reload_with_gate()
        paths = self._openapi(mod).get("paths", {})
        # 断言对象只取**键**（set），故失败信息不会倾倒整份 schema；
        # 键集 == 对外宣称的端点集合，正是要判的东西。
        self.assertNotIn(
            _REINDEX_PATH, set(paths),
            f"部署形态下 /openapi.json 仍宣称有 {_REINDEX_PATH}；"
            f"实际 paths={sorted(paths)}")

    # ── ② 本机形态：与改动前**完全一致**（今日为绿护栏） ────────────────
    def test_without_gate_reindex_route_present_and_unchanged(self):
        """未设时既有的 `/reindex` 必须**照旧注册**、方法照旧（T11 改坏的护栏）。

        这条今天是**绿**的——它不靠今天的实现吃饭，它防的是 T11
        「加闸门时顺手把默认形态也改了」。
        """
        hits = _find_path(self.default_mod, _REINDEX_PATH)
        self.assertEqual(
            len(hits), 1,
            f"未设时 /reindex 应恰好注册 1 条，实际 {len(hits)} 条；"
            f"路由表：{_route_paths(self.default_mod)}")
        self.assertEqual(
            frozenset(getattr(hits[0], "methods", None) or ()), frozenset({"POST"}),
            "未设时 /reindex 的方法集应从 {'POST'} 起就不变")

    def test_without_gate_api_surface_is_intact(self):
        """未设时**全部** API 路由（含 `/reindex`）与默认态逐条相同、且能对外看到。

        这条也是**绿护栏**：T11 加闸门不得顺手改动默认形态的 API 面。

        基准是 `setUp` 里存下的**快照列表**（`self.default_paths` /
        `self.default_api_inventory` / `self.default_openapi_paths`），
        与这里「再一次不设 env 重载」后的读数比。
        **为什么必须是快照**（fix round 1，复审 Important）：`importlib.reload` 返回
        **同一个模块对象**并把 `app` **原地重绑**，所以 `self.default_mod.app` 在这次
        reload 之后**就是新 app**——拿它当基准等于自己跟自己比，断言恒真（空转）。
        快照是**复制出来的列表/集合**，留得住改动前的形态。
        **不硬编码**任何清单：基准来自同一次运行里的现读，故这不是实现快照。
        """
        mod = self._reload_without_gate()  # 第二次独立 reload，仍是本机形态
        paths = _route_paths(mod)
        for p in (*_OTHER_API_PATHS, _REINDEX_PATH):
            with self.subTest(path=p):
                self.assertIn(p, paths, f"未设时 {p} 应在路由表里")
        # 挂载点也必须在（闸门/重构别把 /mcp 一起弄丢）
        self.assertEqual(
            len(_find_path(mod, _MCP_MOUNT_PATH)), 1,
            f"未设时 {_MCP_MOUNT_PATH} 挂载点应恰好 1 条；路由表：{paths}")
        # 与 setUp 的快照逐条相同 ⇒「未设 = 行为与改动前一致」在路由层成立
        self.assertEqual(
            _api_inventory(mod), self.default_api_inventory,
            "「未设 env」重载后的 API 面（路径+方法集）与默认态快照不同")
        self.assertEqual(
            paths, self.default_paths,
            f"「未设 env」重载后的路由表与默认态快照不同（含挂载点/顺序）：\n"
            f"  快照 {self.default_paths}\n  实际 {paths}")
        schema_paths = self._openapi(mod).get("paths", {})
        for p in (*_OTHER_API_PATHS, _REINDEX_PATH):
            with self.subTest(path=p, via="openapi"):
                self.assertIn(p, schema_paths, f"未设时 openapi 应宣称有 {p}")
        self.assertEqual(
            set(schema_paths), self.default_openapi_paths,
            f"「未设 env」重载后的 openapi paths 与默认态快照不同：\n"
            f"  快照 {sorted(self.default_openapi_paths)}\n  实际 {sorted(schema_paths)}")

    # ── ④ 取值语义：非空即禁（fail-closed；今日全为红） ──────────────────
    def test_gate_is_closed_for_any_nonempty_value(self):
        """**非空即禁**：`"0"` 与 `"true"` 都必须让路由**消失**。

        这条今天是**真红**：今天没有任何代码读这个 env，故三种取值下
        `/reindex` 都照旧注册。它防的是 T11 把口径写成「只认 `1`」——
        那种写法在部署机上遇到手写的 `true`/`yes` 会**静默把写路径留下**，
        正是宪法 §0.2 最不能接受的方向（见类 docstring 的不对称性论证）。
        """
        for value in ("0", "true"):
            with self.subTest(RAG_DISABLE_REINDEX=value):
                mod = self._reload_with_gate(value)
                hits = _find_path(mod, _REINDEX_PATH)
                self.assertEqual(
                    hits, [],
                    f"RAG_DISABLE_REINDEX={value!r} 时 /reindex 仍被注册"
                    f"（{len(hits)} 条）——口径是「**非空即禁**」，不是「只认 1」；"
                    f"实际路由表：{_route_paths(mod)}")
                schema_paths = set(self._openapi(mod).get("paths", {}))
                self.assertNotIn(
                    _REINDEX_PATH, schema_paths,
                    f"RAG_DISABLE_REINDEX={value!r} 时 openapi 仍宣称有 {_REINDEX_PATH}；"
                    f"实际 paths={sorted(schema_paths)}")

    def test_blank_value_does_not_enable_the_gate(self):
        """纯空白（`"  "`，strip 后为空）⇒ **等同未设**，路由**在**。

        判据是 `.strip()` 之后的真假，不是「env 里有没有这个键」：
        空值/纯空白说明「没真的要求禁写」，此时闸门不该启用——否则本机形态
        会被一个空 env 误闸（反向失败）。

        **今天是绿的**（fix round 1 修正复审的一处口径：复审把它也算成红，
        实际不是）：今天不读 env ⇒ 路由在 ⇒ 它期望的「在」成立，与未设路径同向。
        两条独立价值使它仍值得存在：
        ① 钉住 `.strip()` 这一步——T11 若写成 `os.environ.get(...) is not None`
           或直接把原文当布尔用，本用例会红；
        ② 它是**跨用例的隔离探针**：本用例要求「设过一个非空值之后再设空白值」
           与「从未设过」逐条相同。若 env 泄漏（没还原干净），前一个用例留下的
           `"0"`/`"true"` 就会让它红——它把「隔离」这件事也纳入断言。
        """
        before = self.default_paths                      # 快照（见 setUp）
        mod = self._reload_with_gate("  ")
        paths = _route_paths(mod)
        hits = _find_path(mod, _REINDEX_PATH)
        self.assertEqual(
            len(hits), 1,
            f"纯空白取值不该启用闸门，/reindex 应仍在（实际 {len(hits)} 条）；"
            f"路由表：{paths}")
        self.assertEqual(
            paths, before,
            f"纯空白取值下的路由表应与未设时逐条相同（也说明前一个用例没泄漏 env）：\n"
            f"  未设 {before}\n  空白 {paths}")
        schema_paths = set(self._openapi(mod).get("paths", {}))
        self.assertIn(
            _REINDEX_PATH, schema_paths,
            f"纯空白取值不该把 {_REINDEX_PATH} 从 openapi 里拿掉；"
            f"实际 paths={sorted(schema_paths)}")

    # ── ③ 闸门不得误伤邻居（今日为绿护栏） ──────────────────────────────
    def test_gate_removes_only_reindex(self):
        """设了闸门时**只有** `/reindex` 消失；其余路由与挂载点原样保留。

        这是本文件里最锋利的一条：它把「闸门」与「顺手把 app 弄残」分开。
        做法是把 `setUp` 存下的**默认态快照**（`self.default_paths`，复制出来的列表，
        见 setUp 的 Important 说明）当基准，断言「部署形态清单 == 快照去掉 /reindex」。
        这里**不是**空转：`before` 是快照列表、`after` 是闸门形态的**新**读数，
        两个不同对象；只是把 `before` 复用给空白取值那条用例看的语义。
        """
        before = self.default_paths  # 快照（复制出来的列表，不是活对象）
        mod = self._reload_with_gate()
        after = _route_paths(mod)

        self.assertNotIn(_REINDEX_PATH, after)
        expected = [p for p in before if p != _REINDEX_PATH]
        self.assertEqual(
            after, expected,
            f"闸门误伤了别的路由：\n  默认态 {before}\n  期望   {expected}\n  实际   {after}")

        for p in _OTHER_API_PATHS:
            with self.subTest(path=p):
                self.assertIn(p, after, f"闸门不该动 {p}")
        self.assertEqual(
            len(_find_path(mod, _MCP_MOUNT_PATH)), 1,
            f"闸门不该动 {_MCP_MOUNT_PATH} 挂载点；路由表：{after}")

        # 对外样子同样只少这一条
        schema_paths = set(self._openapi(mod).get("paths", {}))
        for p in _OTHER_API_PATHS:
            with self.subTest(path=p, via="openapi"):
                self.assertIn(p, schema_paths, f"闸门下 openapi 不该丢掉 {p}")


if __name__ == "__main__":
    unittest.main()
