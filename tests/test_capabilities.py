"""T49 修复 · 生成参数能力端点 `GET /capabilities`（Defect 1 的后端一半）。

界面「待接入 / 未生效」标注必须**由后端能力驱动**（spec §「参数不被支持时的如实性」、
plan §2.2(d)），而能力的唯一真值来源是 `rag_core/params.py::is_supported(cfg)`。
本文件钉住三件事：

1. 能力**取自配置**，不是端点里写死的常量 —— 用改写过的临时配置真跑一遍，把 `generate`
   区块关掉/换成两个都不一样的状态，端点必须如实跟着变（写死的实现在这些用例上变红）；
2. 非法 `lib` 是**客户端**错误 → 400 + `{"error": ...}`（与 `/doc`、`/ask/stream` 同形），
   不是 500，也不回退默认库；
3. 只读：GET 可用，写方法不被接受。

为什么必须真跑配置：`tests/test_params.py` 已证明 `is_supported` 这个**纯函数**对真实配置返回
true，但它证明不了端点把这个函数接上了线。只有「换一份配置、答复跟着变」才能证明接线存在。
"""
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

from rag_core import params as gen_params
from rag_core import rag_engine
from server import http_server

# 「盘符 + 反斜杠」的通用绝对路径形态：能力答复里不该出现任何文件系统路径。
_DRIVE_PATH_RE = r"[A-Za-z]:\\"


def _config_with_generate(tmp: Path, generate: dict | None) -> str:
    """把真实 `config_ai4s.json` 复制到临时目录，只替换 `generate` 区块。

    走真实 `RAGEngine`/`load_config`，故「能力从配置来」是被真正验证的：
    端点若改读别的键（或写死常量），下面各用例立刻变红。
    索引落点一并改到临时目录，避免用例误触真实索引（本用例其实不检索，纯保险）。
    """
    src = Path(rag_engine.__file__).resolve().parent / "config_ai4s.json"
    cfg = json.loads(src.read_text(encoding="utf-8"))
    if generate is None:
        cfg.pop("generate", None)          # 未落地：整个区块不存在
    else:
        cfg["generate"] = generate
    cfg["workspace"] = str(tmp / "workspace")
    cfg["index_db"] = str(tmp / "idx.db")
    cfg["faiss_index"] = str(tmp / "idx.faiss")
    out = tmp / "config_ai4s.json"
    out.write_text(json.dumps(cfg, ensure_ascii=False, indent=2),
                   encoding="utf-8", newline="\n")
    return str(out)


class _EngineFromConfig:
    """上下文管理器：让 `rag_engine.get_engine` 返回一份临时配置造出的真实引擎。"""

    def __init__(self, cfg_path: str):
        self.engine = rag_engine.RAGEngine(cfg_path)
        self._patch = mock.patch.object(rag_engine, "get_engine", return_value=self.engine)

    def __enter__(self):
        self._patch.start()
        return self.engine

    def __exit__(self, *exc):
        self._patch.stop()
        return False


class TestCapabilitiesEndpoint(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(http_server.app)

    # ---------- 正常路径：能力取自配置 ----------
    def test_shipped_configs_report_the_truth_of_their_generate_block(self):
        """真实两份配置：答复必须等于 `is_supported(真配置)` —— 而不是任何字面量。"""
        for lib in ("ai4s", "mito"):
            with self.subTest(lib=lib):
                r = self.client.get("/capabilities", params={"lib": lib})
                self.assertEqual(r.status_code, 200, r.text)
                body = r.json()
                self.assertEqual(set(body), {"lib", "params"},
                                 "答复形状被改动：前端只认 lib/params 两个字段")
                self.assertEqual(body["lib"], lib)
                self.assertEqual(set(body["params"]), {"divergence", "length", "topn"},
                                 "参数 id 必须与 params.is_supported 的键一一对应")
                self.assertEqual(
                    body["params"],
                    gen_params.is_supported(rag_engine.get_engine(lib).cfg),
                    "能力答复与 is_supported(真配置) 不一致 —— 端点没有真正接线到配置")
                # 「已生效」这一判定必须对两个库都成立，否则界面会退回「未生效」标注
                self.assertEqual(body["params"],
                                 {"divergence": True, "length": True, "topn": True})
                # 不许任何一层缓存：能力随配置变，缓存下来的答复会让界面**重新开始撒谎**
                # （本端点的全部意义就是「现在」）
                self.assertEqual(r.headers.get("cache-control"), "no-store", r.headers)
                self.assertNotRegex(r.text, _DRIVE_PATH_RE, "能力答复泄漏了文件系统路径")

    def test_missing_lib_defaults_to_ai4s_like_the_other_read_endpoints(self):
        """/search 与 /doc 都以 `lib=ai4s` 为默认；能力端点保持一致（不新增第三种约定）。"""
        r = self.client.get("/capabilities")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["lib"], "ai4s")

    def test_disabled_generate_block_is_reported_as_unsupported(self):
        """配置把 `generate` 关掉时，端点**必须**改口 —— 这正是「由后端能力驱动」的定义。"""
        with tempfile.TemporaryDirectory(prefix="rag_stack_cap_") as d:
            tmp = Path(d)
            with _EngineFromConfig(_config_with_generate(tmp, {})):
                r = self.client.get("/capabilities", params={"lib": "ai4s"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["params"], {"divergence": False, "length": False, "topn": False})

    def test_missing_generate_block_is_reported_as_unsupported(self):
        """键整个不存在（未落地）与「存在但关闭」同判：都不得声称已生效。"""
        with tempfile.TemporaryDirectory(prefix="rag_stack_cap_") as d:
            tmp = Path(d)
            with _EngineFromConfig(_config_with_generate(tmp, None)):
                r = self.client.get("/capabilities", params={"lib": "ai4s"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["params"], {"divergence": False, "length": False, "topn": False})

    def test_each_parameter_is_reported_independently(self):
        """只落地一项时，另一项必须单独报 false（不允许「一起 true」的懒惰实现）。"""
        only_divergence = {"divergence": {"temperature_min": 0.1, "temperature_max": 1.2,
                                          "top_p_min": 0.5, "top_p_max": 0.95}}
        with tempfile.TemporaryDirectory(prefix="rag_stack_cap_") as d:
            tmp = Path(d)
            with _EngineFromConfig(_config_with_generate(tmp, only_divergence)):
                r = self.client.get("/capabilities", params={"lib": "ai4s"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["params"], {"divergence": True, "length": False, "topn": False})

    # ---------- 客户端错误 ----------
    def test_unknown_lib_is_a_client_error_with_a_json_body(self):
        r = self.client.get("/capabilities", params={"lib": "nope"})
        self.assertEqual(r.status_code, 400, r.text)
        ctype = r.headers.get("content-type", "").split(";")[0].strip()
        self.assertEqual(ctype, "application/json")
        self.assertIn("error", r.json())
        # 非法 lib **不回落**默认库：答复里不得出现任何能力数据（否则前端会拿 ai4s 的能力
        # 去标注 mito 的界面，比不说更坏）
        self.assertNotIn("params", r.json())
        self.assertNotRegex(r.text, _DRIVE_PATH_RE, "错误体泄漏了文件系统路径")

    # ---------- 只读 ----------
    def test_endpoint_is_read_only(self):
        self.assertEqual(
            self.client.post("/capabilities", params={"lib": "ai4s"}).status_code, 405,
            "能力端点必须只读：写方法不得被接受")


if __name__ == "__main__":
    unittest.main()
