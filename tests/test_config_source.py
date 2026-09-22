"""T04（规范 004）：配置来源解析器的红测试 —— 本文件在 T07/T09 之前**必须全红**。

被钉的行为（契约来自 plan §R-1 与 tasks.md T07/T09）：

    rag_core/config.py::

        def resolve_config_path(lib: str, base_dir: pathlib.Path | None = None) -> pathlib.Path
        def load_config(lib: str, base_dir: pathlib.Path | None = None) -> tuple[dict, pathlib.Path]
        # 先做四键存在性核对再返回：index_db / faiss_index / vault_path / rerank.model

- 设了 `RAG_CONFIG_SUFFIX`（如 `_linux`）⇒ 用 `config_{lib}{suffix}.json`；
  **该文件不存在 ⇒ 抛异常**（信息含：选定的后缀 · 期望的完整路径 · 当前工作目录），
  **回落次数 = 0**（不得改用 `config_{lib}.json`）。
- 未设 ⇒ `config_{lib}.json`（既有行为一字不变）。

`base_dir` 是**为可测性**加的第二参数（默认取 `rag_core/` 自身目录），生产调用只传 `lib`；
本文件把它指向 `tempfile.TemporaryDirectory()`，因此**绝不写真实的 `rag_core/`**，
测试结束目录即删，仓库里不留下任何文件。

四组与 tasks.md T04 的对应：
    ① 设后缀且文件存在 → 用带后缀的那份
    ② 设后缀但文件不存在 → 抛异常且**不回落**
    ③ 未设后缀 → 用 `config_{lib}.json`
    ④ 选定的配置存在、但某个路径键的值指向不存在的位置 → 抛异常，信息含**键名与值**
"""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from rag_core import config as config_mod

ENV_KEY = "RAG_CONFIG_SUFFIX"


def _base_config(root: Path, lib: str) -> dict:
    """造一份四键**都指向真实存在的位置**的配置（在 root 下把那些位置按**正确的种类**建出来）。

    这一点是硬要求，不是装饰：`load_config` 在返回前要做四键存在性核对（T09），
    若本文件里任何一条 `load_config` 用例拿的是「路径值不存在」的配置，
    它就会**永远红下去**——T09 落地后照样红，谁也不知道该改哪边。

    **种类也要对**：真实配置里 `vault_path` 与 `rerank.model` 指向的是**目录**
    （见 `rag_core/config_ai4s.json`：`AI4S(obsidian)` 与 `library/models/bge-reranker-v2-m3`），
    `index_db` 与 `faiss_index` 指向**文件**。若这里全造成普通文件，而 T09 顺手写成
    `is_dir()`，则 ③『未设后缀』与 ④『阴性对照』两条会**永远红**——同样是坏测试。
    被测代码只做存在性核对，不打开、不读取这些路径。
    """
    d = root / "exists"
    d.mkdir(parents=True, exist_ok=True)
    locs = {
        # 生产里是**文件**
        "index_db": (d / "ai4s.index.db", "file"),
        "faiss_index": (d / "ai4s.hnsw.faiss", "file"),
        # 生产里是**目录**
        "vault_path": (d / "vault", "dir"),
        "rerank.model": (d / "rerank-model", "dir"),
    }
    for path, kind in locs.values():
        if kind == "dir":
            path.mkdir(parents=True, exist_ok=True)
        else:
            path.write_text("x", encoding="utf-8", newline="\n")
    cfg = {
        "lib": lib,
        "workspace": str(root),
        "rerank": {"topk": 50, "final_topn": 8,
                   "model": str(locs["rerank.model"][0])},
    }
    for k in ("index_db", "faiss_index", "vault_path"):
        cfg[k] = str(locs[k][0])
    return cfg


def _set_path(cfg: dict, dotted: str, value) -> None:
    """按 T09 的键面写法赋值：`rerank.model` 是点分键，其余是顶层键。"""
    if dotted == "rerank.model":
        cfg["rerank"] = {**cfg.get("rerank", {}), "model": value}
    else:
        cfg[dotted] = value


def _write_config(path: Path, payload: dict) -> Path:
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2),
                    encoding="utf-8", newline="\n")
    return path


class _EnvIsolatedTestCase(unittest.TestCase):
    """每个用例后把 `RAG_CONFIG_SUFFIX` 还原，不留残留。

    `mock.patch.dict` 会在 `stop()` 时把整个 `os.environ` 恢复成进入 `setUp` 前的快照
    ——`python -m unittest discover` 把全部测试跑在同一个进程里，污染会牵连别的模块。
    """

    def setUp(self):
        self._env_guard = mock.patch.dict(os.environ, {}, clear=False)
        self._env_guard.start()
        self.addCleanup(self._env_guard.stop)
        os.environ.pop(ENV_KEY, None)


# --------------------------------------------------------------------------
# ① 设了后缀且该文件存在 ⇒ 用带后缀的那一份
# --------------------------------------------------------------------------
class TestSuffixSelectedWhenPresent(_EnvIsolatedTestCase):
    def setUp(self):
        super().setUp()
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)

    def test_resolve_config_path_uses_suffixed_file(self):
        suffixed = _write_config(self.root / "config_ai4s_linux.json", {"lib": "ai4s"})
        with mock.patch.dict(os.environ, {ENV_KEY: "_linux"}):
            got = config_mod.resolve_config_path("ai4s", base_dir=self.root)
        self.assertEqual(got, suffixed)

    def test_load_config_reads_the_suffixed_file_not_the_default_one(self):
        # 临时目录里**故意只放带后缀的那份**：未受理 `base_dir` 的实现会去找
        # `rag_core/config_ai4s_linux.json` 而失败，从而被这条用例抓住。
        cfg = {**_base_config(self.root, "ai4s"), "marker": "suffixed"}
        suffixed = _write_config(self.root / "config_ai4s_linux.json", cfg)
        with mock.patch.dict(os.environ, {ENV_KEY: "_linux"}):
            loaded, src = config_mod.load_config("ai4s", base_dir=self.root)
        self.assertEqual(src, suffixed)
        self.assertEqual(loaded["marker"], "suffixed")

    def test_resolve_config_path_uses_suffix_for_any_lib(self):
        suffixed = _write_config(self.root / "config_mito_linux.json", {"lib": "mito"})
        with mock.patch.dict(os.environ, {ENV_KEY: "_linux"}):
            got = config_mod.resolve_config_path("mito", base_dir=self.root)
        self.assertEqual(got, suffixed)


# --------------------------------------------------------------------------
# ② 设了后缀但该文件不存在 ⇒ 抛异常，且**不回落**（本任务最重要的一条）
# --------------------------------------------------------------------------
class TestSuffixSelectedButMissingIsLoud(_EnvIsolatedTestCase):
    def setUp(self):
        super().setUp()
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)

    def test_resolve_config_path_raises_and_reports_suffix_path_and_cwd(self):
        # 无后缀的那份**存在**：实现一旦回落就会返回它，本用例必须因此失败。
        _write_config(self.root / "config_ai4s.json", {"lib": "ai4s"})
        expected = self.root / "config_ai4s_linux.json"
        cwd = os.getcwd()
        with mock.patch.dict(os.environ, {ENV_KEY: "_linux"}):
            with self.assertRaises(Exception) as ctx:
                config_mod.resolve_config_path("ai4s", base_dir=self.root)
        msg = str(ctx.exception)
        self.assertIn("_linux", msg, f"异常信息缺「选定的后缀」；实际：{msg!r}")
        self.assertIn(str(expected), msg, f"异常信息缺「期望的完整路径」；实际：{msg!r}")
        self.assertIn(cwd, msg, f"异常信息缺「当前工作目录」；实际：{msg!r}")

    def test_load_config_raises_and_does_not_fall_back(self):
        fallback = _write_config(self.root / "config_ai4s.json",
                                {"lib": "ai4s", "marker": "fallback"})
        expected = self.root / "config_ai4s_linux.json"
        with mock.patch.dict(os.environ, {ENV_KEY: "_linux"}):
            with self.assertRaises(Exception) as ctx:
                config_mod.load_config("ai4s", base_dir=self.root)
        msg = str(ctx.exception)
        self.assertIn(str(expected), msg, f"异常信息缺「期望的完整路径」；实际：{msg!r}")
        # 不回落：异常信息里不该把它**选**成生效的那份（只提后缀名本身。
        # `config_ai4s.json` 是 `config_ai4s_linux.json` 的子串，故这里比的是完整路径）。
        self.assertNotIn(str(fallback), msg,
                         "异常信息指向了未选定的回落文件，说明实现回落了")


# --------------------------------------------------------------------------
# ③ 未设后缀 ⇒ 用 `config_{lib}.json`（既有行为一字不变）
# --------------------------------------------------------------------------
class TestNoSuffixKeepsLegacyFilename(_EnvIsolatedTestCase):
    def setUp(self):
        super().setUp()
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)

    def test_resolve_config_path_without_suffix(self):
        plain = _write_config(self.root / "config_ai4s.json", {"lib": "ai4s"})
        self.assertNotIn(ENV_KEY, os.environ, "前置条件：本用例不得带后缀")
        got = config_mod.resolve_config_path("ai4s", base_dir=self.root)
        self.assertEqual(got, plain)

    def test_load_config_without_suffix_reads_plain_file(self):
        cfg = {**_base_config(self.root, "ai4s"), "marker": "plain"}
        plain = _write_config(self.root / "config_ai4s.json", cfg)
        loaded, src = config_mod.load_config("ai4s", base_dir=self.root)
        self.assertEqual(src, plain)
        self.assertEqual(loaded["marker"], "plain")

    def test_empty_suffix_env_behaves_as_unset(self):
        """空串不是「设了后缀」——`RAG_CONFIG_SUFFIX=` 不得变成 `config_ai4s.json` 之外的任何形状。"""
        plain = _write_config(self.root / "config_ai4s.json", {"lib": "ai4s"})
        with mock.patch.dict(os.environ, {ENV_KEY: ""}):
            got = config_mod.resolve_config_path("ai4s", base_dir=self.root)
        self.assertEqual(got, plain)

    def test_default_base_dir_is_rag_core_itself(self):
        """生产调用只传 `lib`：默认基准目录 = `rag_core/` 自身。

        这里**只**验解析结果，不验真配置里的路径值——把「本机真 vault/索引都在」绑进来，
        会让这条用例在别的机器上红，且遮蔽 ①③④ 各自真正要打的差异。
        """
        got = config_mod.resolve_config_path("ai4s")
        self.assertEqual(got, Path(config_mod.__file__).resolve().parent / "config_ai4s.json")
        self.assertTrue(got.exists(), "仓库里的既有配置应当存在（未设后缀 = 既有行为）")


# --------------------------------------------------------------------------
# ④ 配置存在、但路径值指向不存在的位置 ⇒ 抛异常，信息含键名与值（T09 才转绿）
# --------------------------------------------------------------------------
class TestMissingPathValueIsLoud(_EnvIsolatedTestCase):
    """四键**逐一**打：只核对其中一两个键的实现会被其余用例抓住。"""

    def setUp(self):
        super().setUp()
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)

    def _cfg_with_broken(self, dotted: str):
        missing = self.root / "does-not-exist" / "nope"
        cfg = _base_config(self.root, "ai4s")
        raw = str(missing)
        _set_path(cfg, dotted, raw)
        _write_config(self.root / "config_ai4s.json", cfg)
        return cfg, raw

    def test_load_config_rejects_missing_index_db(self):
        _cfg, raw = self._cfg_with_broken("index_db")
        with self.assertRaises(Exception) as ctx:
            config_mod.load_config("ai4s", base_dir=self.root)
        msg = str(ctx.exception)
        self.assertIn("index_db", msg, f"异常信息缺键名；实际：{msg!r}")
        self.assertIn(raw, msg, f"异常信息缺键值（原文，不是 repr 转义后的形状）；实际：{msg!r}")

    def test_load_config_rejects_missing_faiss_index(self):
        _cfg, raw = self._cfg_with_broken("faiss_index")
        with self.assertRaises(Exception) as ctx:
            config_mod.load_config("ai4s", base_dir=self.root)
        msg = str(ctx.exception)
        self.assertIn("faiss_index", msg, f"异常信息缺键名；实际：{msg!r}")
        self.assertIn(raw, msg, f"异常信息缺键值（原文，不是 repr 转义后的形状）；实际：{msg!r}")

    def test_load_config_rejects_missing_vault_path(self):
        _cfg, raw = self._cfg_with_broken("vault_path")
        with self.assertRaises(Exception) as ctx:
            config_mod.load_config("ai4s", base_dir=self.root)
        msg = str(ctx.exception)
        self.assertIn("vault_path", msg, f"异常信息缺键名；实际：{msg!r}")
        self.assertIn(raw, msg, f"异常信息缺键值（原文，不是 repr 转义后的形状）；实际：{msg!r}")

    def test_load_config_rejects_missing_rerank_model(self):
        _cfg, raw = self._cfg_with_broken("rerank.model")
        with self.assertRaises(Exception) as ctx:
            config_mod.load_config("ai4s", base_dir=self.root)
        msg = str(ctx.exception)
        self.assertIn("rerank.model", msg, f"异常信息缺键名；实际：{msg!r}")
        self.assertIn(raw, msg, f"异常信息缺键值（原文，不是 repr 转义后的形状）；实际：{msg!r}")

    def test_load_config_accepts_config_whose_four_paths_all_exist(self):
        """阴性对照：四键都指向真实存在的位置时**不得**抛异常。

        没有这条，上面四条可能因为「`load_config` 无条件抛异常」而假红/假绿。
        """
        _write_config(self.root / "config_ai4s.json", _base_config(self.root, "ai4s"))
        cfg, src = config_mod.load_config("ai4s", base_dir=self.root)
        self.assertEqual(src, self.root / "config_ai4s.json")
        self.assertEqual(cfg["lib"], "ai4s")


if __name__ == "__main__":
    unittest.main()
