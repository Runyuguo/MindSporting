"""T26 · 只读取文接口 `GET /doc`（文献卡面板的取文后端）。

安全边界是本任务的核心：`ref` 由前端传来，必须保证**任何**落在该库 vault 之外的
文件都读不到（宪法 §2.1 只读、§2.2 双库隔离；plan.md §12.3 五条校验）。

测试如何做到「真实越界」而不是空口断言：
- vault 与「根外」目标都建在**临时目录**里，绝不触碰真实 vault（不许在真实 vault 写文件）；
- 改写真实 `config_<lib>.json` 的副本、只替换 `vault_path` 与索引落点，再喂给真实
  `RAGEngine` —— 于是端点仍走「从 config 读 vault_path」的真实路径。若实现改读了别的键
  （例如 `workspace`），vault 就会指到真实 workspace，成功用例立刻变红。
- 符号链接用例：本机 Python 无 SeCreateSymbolicLinkPrivilege（WinError 1314），
  故退化为目录 junction（`mklink /J`）。junction 是内核级重解析点，`Path.resolve()`
  同样会解析到根外目标，越界断言依旧真实；用例内会自校验「该重解析点确实解析到根外」，
  确保这一枪不是空放。

状态契约（与 `server/http_server.py::doc` 对齐）：200 正常；400 `ref` 缺失/空/非法
（绝对路径 / 含 `..` / 解析后越界 / 非 `.md` / **不在允许目录内**）或 `lib` 非法（客户端错误）；
404 篇目不存在；500 篇目**存在**但服务端解不开/读不了（服务端条件，必带 JSON 体）。
三者互不冒充：400 与 404 文案不同，500 不被谎报成 404。
"""
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

from rag_core import rag_engine
from server import http_server

_SECRET = "SECRET-OUTSIDE-CONTENT"
_NOTE_TEXT = "线粒体自噬的机制\n\n第一手资料原文。\n"

# 「盘符 + 反斜杠」的通用绝对路径形态：`C:\` 与 JSON 转义后的 `C:\\` 都能匹配。
# 用它把 assert_no_leak 从「枚举已知临时前缀」升级为「任何盘符路径都不许出现」。
_DRIVE_PATH_RE = r"[A-Za-z]:\\"


def _config_for(tmp_dir: Path, lib: str, vault: Path) -> str:
    """把真实 config_<lib>.json 复制到临时目录，仅改写 vault 与索引落点后返回其路径。

    走真实 `load_config`，所以「vault 根来自 config 的哪个键」是被真正验证的：
    键名写错/换成 workspace，端点就会去真实路径找文件，成功用例必然变红。
    """
    src = Path(rag_engine.__file__).resolve().parent / f"config_{lib}.json"
    cfg = json.loads(src.read_text(encoding="utf-8"))
    cfg["vault_path"] = str(vault)
    cfg["workspace"] = str(tmp_dir / "workspace")
    cfg["index_db"] = str(tmp_dir / f"{lib}.index.db")
    cfg["faiss_index"] = str(tmp_dir / f"{lib}.faiss")
    out = tmp_dir / f"config_{lib}.json"
    out.write_text(json.dumps(cfg, ensure_ascii=False, indent=2),
                   encoding="utf-8", newline="\n")
    return str(out)


def _make_dir_reparse_point(link: Path, target: Path) -> str:
    """在 link 处创建指向 target 的真实目录重解析点，返回所用机制名。

    优先真符号链接；无权限时退回目录 junction（Windows）。两者都是内核级重解析点，
    `Path.resolve()` 都会解析到真实目标，故不削弱越界校验。两种都失败时直接抛错——
    绝不静默跳过，否则这条安全用例会变成永远绿的摆设。
    """
    try:
        os.symlink(target, link, target_is_directory=True)
        return "symlink"
    except OSError as symlink_exc:
        if sys.platform != "win32":
            raise
        proc = subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(target)],
                              capture_output=True, text=True)
        if proc.returncode != 0:
            raise OSError(
                f"无法构造重解析点：os.symlink 失败({symlink_exc}); "
                f"mklink /J 失败(rc={proc.returncode}, {proc.stderr.strip()})"
            )
        return "junction"


def snapshot(root: Path) -> dict[str, int]:
    """vault 全量快照（相对路径 -> mtime_ns），用于证明「只读、零写入」。"""
    return {str(p.relative_to(root)): p.stat().st_mtime_ns
            for p in root.rglob("*") if p.is_file()}


class TestDocReadOnlyEndpoint(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="rag_stack_t26_")
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name).resolve()

        # env_var 会覆盖 vault_path（`load_config` 里 `os.environ.get(env_var)` 为真即生效），
        # 故必须在**构造引擎之前**清空：否则本用例的临时 vault 会被真实 AI4S_VAULT_PATH
        # 顶掉，「vault 取自 config 文件」这条保证对主引擎根本没生效。
        patcher = mock.patch.dict(os.environ, {"AI4S_VAULT_PATH": "", "MITO_VAULT_PATH": ""})
        patcher.start()
        self.addCleanup(patcher.stop)

        # vault 树（全部在临时目录内）。
        # A 案（T36 第 6 条规则）之后 `/doc` 只认三个允许目录，故**所有**「应当读得到」的
        # 篇目都落在 `01-Literature/` 下——vault 根下的散篇现在按设计一律 400。下面各用例的
        # 断言意图（后缀大小写、越界、编码、双库隔离…）不变，只是换了落点；别把它们挪回根目录。
        self.vault = self.tmp / "vault"
        self.note = self.vault / "01-Literature" / "自噬.md"
        self.note.parent.mkdir(parents=True)
        self.note.write_text(_NOTE_TEXT, encoding="utf-8")
        (self.vault / "00-MOC").mkdir()
        (self.vault / "00-MOC" / "index.md").write_text("# MOC\n", encoding="utf-8")
        (self.vault / "01-Literature" / "UPPER.MD").write_text("# 大写后缀\n", encoding="utf-8")
        (self.vault / "notes.txt").write_text("not markdown\n", encoding="utf-8")
        (self.vault / "image.png").write_bytes(b"\x89PNG\r\n\x1a\n")

        # 根外目标：越界若被放行，响应里就会出现它的内容
        self.outside = self.tmp / "outside"
        self.outside.mkdir()
        self.outside_note = self.outside / "secret.md"
        self.outside_note.write_text(_SECRET, encoding="utf-8")

        self.engine = rag_engine.RAGEngine(_config_for(self.tmp, "ai4s", self.vault))

        self.get_engine = mock.patch.object(
            rag_engine, "get_engine", side_effect=lambda lib: self.engines[lib])
        self.get_engine.start()
        self.addCleanup(self.get_engine.stop)
        self.engines = {"ai4s": self.engine}

        self.client = TestClient(http_server.app)

    # ---------- 工具 ----------
    def get(self, **params):
        return self.client.get("/doc", params=params)

    def assert_no_leak(self, resp):
        """响应体不得含根外内容，也不得泄漏任何绝对路径（JSON 转义形态一并查）。"""
        body = resp.text
        self.assertNotIn(_SECRET, body, "响应泄漏了根外文件内容")
        for leak in (str(self.tmp), str(self.outside), str(self.outside_note)):
            self.assertNotIn(leak, body, f"响应泄漏绝对路径：{leak}")
            self.assertNotIn(leak.replace("\\", "\\\\"), body,
                             f"响应以 JSON 转义形态泄漏绝对路径：{leak}")
        # 上面只枚举了本用例已知的临时前缀；再加一条**通用**形态断言，
        # 任何盘符绝对路径（`C:\` 或 JSON 转义后的 `C:\\`）都不许出现。
        self.assertNotRegex(body, _DRIVE_PATH_RE, "响应含盘符绝对路径")

    def assert_json_error(self, resp):
        """错误响应必须是 JSON 对象且带 error 文案——否则前端拿不到可分态的错误信息。"""
        ctype = resp.headers.get("content-type", "").split(";")[0].strip()
        self.assertEqual(ctype, "application/json",
                         f"错误响应不是 JSON：content-type={resp.headers.get('content-type')!r}")
        self.assertIn("error", resp.json())

    # ---------- 正常读取 ----------
    def test_reads_markdown_inside_the_vault(self):
        r = self.get(lib="ai4s", ref="01-Literature/自噬.md")
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(set(body), {"lib", "ref", "title", "content", "mtime"})
        self.assertEqual(body["lib"], "ai4s")
        # ref 回显为**规范化 POSIX** 形式（入参里的 `\` 统一成 `/`，`.` 段被丢弃）：
        # 前端请按本字段比对/回填，不要逐字节比对原始入参。契约注释见
        # `server/http_server.py::doc` 的返回体。下一条用例锁住这条回显契约。
        self.assertEqual(body["ref"], "01-Literature/自噬.md")
        self.assertEqual(body["title"], "自噬")
        self.assertEqual(body["content"],
                         self.note.read_text(encoding="utf-8"))
        # mtime 必须是**该文件**的 mtime，不是「现在」
        self.assertAlmostEqual(body["mtime"], self.note.stat().st_mtime, places=3)
        self.assertLess(abs(body["mtime"] - time.time()), 3600)

    def test_backslash_ref_is_echoed_normalized_to_posix(self):
        """入参用反斜杠，回显统一为 `/`——这是回显契约，不是「碰巧」。"""
        r = self.get(lib="ai4s", ref="01-Literature\\自噬.md")
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["ref"], "01-Literature/自噬.md")
        self.assertNotIn("\\", body["ref"])
        self.assertEqual(body["content"], _NOTE_TEXT)

    def test_markdown_suffix_is_case_insensitive(self):
        r = self.get(lib="ai4s", ref="01-Literature/UPPER.MD")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["content"], "# 大写后缀\n")

    def test_reading_does_not_write_the_vault(self):
        """宪法 §2.1：取文路径必须一个字节都不写。"""
        before = snapshot(self.vault)
        self.assertEqual(self.get(lib="ai4s", ref="01-Literature/自噬.md").status_code, 200)
        self.assertEqual(snapshot(self.vault), before, "取文改动了 vault")

    # ---------- 双库隔离 ----------
    def test_each_lib_reads_only_its_own_vault(self):
        mito_vault = self.tmp / "mito_vault"
        mito_vault.mkdir()
        (mito_vault / "01-Literature").mkdir()
        (mito_vault / "01-Literature" / "mito-only.md").write_text("# 线粒体库\n", encoding="utf-8")
        self.engines["mito"] = rag_engine.RAGEngine(
            _config_for(self.tmp, "mito", mito_vault))

        ok = self.get(lib="mito", ref="01-Literature/mito-only.md")
        self.assertEqual(ok.status_code, 200, ok.text)
        self.assertEqual(ok.json()["content"], "# 线粒体库\n")
        # 同一 ref 在 ai4s 库不存在 -> 404，绝不跨库取文
        crossed = self.get(lib="ai4s", ref="01-Literature/mito-only.md")
        self.assertEqual(crossed.status_code, 404, crossed.text)
        self.assert_no_leak(crossed)

    # ---------- 404：篇目不存在 ----------
    def test_missing_note_is_404_and_distinguishable_from_400(self):
        r = self.get(lib="ai4s", ref="01-Literature/不存在.md")
        self.assertEqual(r.status_code, 404, r.text)
        self.assert_json_error(r)
        self.assert_no_leak(r)
        denied = self.get(lib="ai4s", ref="../outside/secret.md")
        self.assertEqual(denied.status_code, 400)
        self.assertNotEqual(r.json()["error"], denied.json()["error"],
                            "404 与 400 的文案必须可区分（前端 missing/denied 稿件不同）")
        # Ruling 64 之后还要与「没给 ref」的 400 区分：合法 ref 但篇目不在 = 404，
        # 没给 ref = 400，两者不再共用一条「无此资源」路径。
        no_ref = self.client.get("/doc")
        self.assertEqual(no_ref.status_code, 400, no_ref.text)
        self.assertNotEqual(r.json()["error"], no_ref.json()["error"],
                            "「篇目不存在」(404) 与「缺 ref」(400) 必须可区分")

    def test_empty_ref_is_400(self):
        r = self.get(lib="ai4s", ref="")
        self.assertEqual(r.status_code, 400, r.text)
        self.assert_json_error(r)
        self.assert_no_leak(r)

    # ---------- 400：缺 ref（Ruling 64）/ 非法 lib ----------
    def test_bare_doc_without_ref_is_400(self):
        """控制器 Ruling 64：不传 `ref` = 请求不合法 → **400**（客户端错误），不是 404。

        旧实现把裸 `/doc` 判成 404，于是「没给 ref」有两种状态码（裸 `/doc` → 404、
        `/doc?ref=` → 400），取决于参数怎么编码；还让 `GET /doc?lib=nope` 的响应
        变成「篇目缺失」而不是本该有的 bad-lib 400。`/doc` 这个只读接口由
        `specs/001-rag-qa-multiturn/spec.md`「文献卡查阅」背书，与 T01 删掉的旧目录树
        `/doc` 不是同一个东西（故 `tests/test_removed_surface.py` 里的旧条目已同步移除）。
        """
        r = self.client.get("/doc")
        self.assertEqual(r.status_code, 400, r.text)
        self.assert_json_error(r)
        self.assertIn("ref", r.json()["error"])
        self.assert_no_leak(r)

    def test_no_ref_with_bad_lib_is_400_bad_lib(self):
        """`GET /doc?lib=nope`（不带 ref）必须先撞 lib 白名单：明确的 bad-lib 400。

        lib 校验先于 ref 校验，所以这条不会被「缺 ref」或「无此篇目」掩盖。
        """
        r = self.client.get("/doc", params={"lib": "nope"})
        self.assertEqual(r.status_code, 400, r.text)
        self.assert_json_error(r)
        self.assertIn("lib", r.json()["error"])
        self.assert_no_leak(r)

    def test_ref_to_a_directory_named_md_is_404_not_500(self):
        """名字像 Markdown 但不能当文件读（目录），归入「篇目不存在」的 404 三态。

        读取才是唯一权威：去掉读处的 except，这里会变成 500（UnicodeDecodeError 之外
        的 IsADirectoryError），把「文件没了」误报成服务故障。
        """
        (self.vault / "01-Literature" / "dir.md").mkdir()
        r = self.get(lib="ai4s", ref="01-Literature/dir.md")
        self.assertEqual(r.status_code, 404, r.text)
        self.assert_json_error(r)
        self.assert_no_leak(r)

    # ---------- 500：篇目在、服务端读不了（服务端条件，须为 JSON 体） ----------
    def test_non_utf8_note_is_500_json_and_leaks_no_path(self):
        """真实非 UTF-8 字节 → UnicodeDecodeError → 500 **JSON**，不裸 500、不谎报 404。

        用真实字节写入（不是 mock）：读取本身抛 UnicodeDecodeError，两个旧 except 都接不住，
        旧实现会让客户端收到非 JSON 的 500 体。现在归 500 + `{"error": ...}`，
        前端据状态码落 error 态；文案不含绝对路径。
        """
        bad = self.vault / "01-Literature" / "bad-encoding.md"
        bad.write_bytes(b"# \xff\xfe\x80 not valid utf-8\n")
        with self.assertRaises(UnicodeDecodeError):   # 自校验：这些字节确实不是 UTF-8
            bad.read_text(encoding="utf-8")

        r = self.get(lib="ai4s", ref="01-Literature/bad-encoding.md")
        self.assertEqual(r.status_code, 500, r.text)
        self.assert_json_error(r)
        self.assert_no_leak(r)
        self.assertNotEqual(r.json()["error"],
                            self.get(lib="ai4s", ref="01-Literature/不存在.md").json()["error"],
                            "500 不得与 404 共用文案（否则前端分不出服务故障与篇目缺失）")

    def test_unreadable_note_is_500_json_and_leaks_no_path(self):
        """篇目在、但服务端读不了（PermissionError）→ 同样 500 + JSON。

        Windows 上无法可移植地构造真实 PermissionError：目录会被 `is_dir()` 先归 404，
        单纯被占用的文件 CPython 仍可读（共享模式不含 FILE_SHARE_DELETE 也能读）。
        故把这一篇的 `Path.read_text` 打桩成抛 PermissionError——走的是与真实权限错误
        **同一段** except 分支；非 UTF-8 那一条则是真实字节，不做桩。
        """
        note = self.vault / "01-Literature" / "locked.md"
        note.write_text("# locked\n", encoding="utf-8")
        real_read_text = Path.read_text

        def fake_read_text(self_path, *args, **kwargs):
            if Path(self_path).name == "locked.md":
                raise PermissionError(13, "Permission denied")
            return real_read_text(self_path, *args, **kwargs)

        with mock.patch.object(Path, "read_text", fake_read_text):
            r = self.get(lib="ai4s", ref="01-Literature/locked.md")
        self.assertEqual(r.status_code, 500, r.text)
        self.assert_json_error(r)
        self.assert_no_leak(r)

    # ---------- 日志级别（发现①：INFO 在 uvicorn 直跑下等于没记） ----------
    def test_caught_paths_log_at_warning_level(self):
        """被捕获的路径必须发 **WARNING**（宪法 §3.3「禁止空 catch」的可观测后果）。

        文档化的启动方式是 `python -m uvicorn server.http_server:app`：root logger 没有
        handler，只有 `logging.lastResort`（级别 WARNING）兜底——`_log.info` 会被直接丢弃，
        于是「except 必须记进服务日志」这条要求事实上不成立。故直接对 `_log` 断言级别：
        把任一处改回 `info`，这里立刻变红（不依赖 stderr 抓取，避免测试自己加 handler
        把噪音灌进输出）。
        """
        with self.assertLogs(http_server._log, level="WARNING") as missing:
            r = self.get(lib="ai4s", ref="01-Literature/不存在.md")
        self.assertEqual(r.status_code, 404, r.text)
        self.assertTrue(any("doc note unreadable" in m for m in missing.output),
                        missing.output)

        # 每个用例都有独立 setUp 的临时 vault，故非 UTF-8 篇目在这里自己造
        (self.vault / "01-Literature" / "bad-encoding.md").write_bytes(
            b"# \xff\xfe\x80 not valid utf-8\n")
        with self.assertLogs(http_server._log, level="WARNING") as bad_utf8:
            r = self.get(lib="ai4s", ref="01-Literature/bad-encoding.md")
        self.assertEqual(r.status_code, 500, r.text)
        self.assertTrue(any("undecodable/unreadable" in m for m in bad_utf8.output),
                        bad_utf8.output)
        # 日志只带**相对** ref：任何一条记录都不许出现绝对路径
        for record in missing.output + bad_utf8.output:
            self.assertNotRegex(record, _DRIVE_PATH_RE, "日志泄漏了绝对路径")
        self.assertNotIn(str(self.tmp), "\n".join(missing.output + bad_utf8.output))

    # ---------- 400：越界 ----------
    def test_rejects_parent_traversal(self):
        for ref in ("../outside/secret.md",
                    "01-Literature/../../outside/secret.md",
                    "..",
                    "a/../../outside/secret.md",
                    "..\\outside\\secret.md"):
            with self.subTest(ref=ref):
                r = self.get(lib="ai4s", ref=ref)
                self.assertEqual(r.status_code, 400, r.text)
                self.assertIn("..", r.json()["error"], "拒绝原因须指向越界，便于前端区分")
                self.assert_no_leak(r)

    def test_rejects_absolute_paths(self):
        """plan §12.3 规则 2。注意必须按**原因**断言，不能只看状态码：

        这些绝对路径即便去掉「绝对路径」规则，也会被规则 3（解析后落在根外）挡下并同样
        返回 400；只断言 400 的话，规则 2 被删掉测试依然全绿（已实测）。故此处锁住原因。
        """
        for ref in (str(self.outside_note),          # D:\...\secret.md
                    str(self.outside_note).replace("\\", "/"),   # D:/.../secret.md
                    "/etc/passwd",                   # POSIX 绝对路径
                    "/",
                    "C:/Windows/win.ini",
                    "\\\\server\\share\\x.md"):      # UNC
            with self.subTest(ref=ref):
                r = self.get(lib="ai4s", ref=ref)
                self.assertEqual(r.status_code, 400, r.text)
                self.assertIn("absolute", r.json()["error"],
                              "绝对路径必须以「绝对路径」为由拒绝（plan §12.3 规则 2）")
                self.assert_no_leak(r)

    def test_rejects_reparse_point_escaping_the_vault(self):
        link = self.vault / "escape_dir"
        mechanism = _make_dir_reparse_point(link, self.outside)
        # 自校验：这一枪必须打在真实重解析点上，且它确实解析到 vault 之外
        self.assertTrue(link.resolve().is_relative_to(self.outside.resolve()),
                        f"{mechanism} 没有解析到根外，越界用例会空放")
        r = self.get(lib="ai4s", ref="escape_dir/secret.md")
        self.assertEqual(r.status_code, 400, f"{mechanism}: {r.text}")
        self.assertIn("outside", r.json()["error"], "须以「落在 vault 之外」为由拒绝")
        self.assert_no_leak(r)

    def test_allows_reparse_point_that_stays_inside_the_vault(self):
        """校验的是「解析后是否在根内」，不是「见到链接就拒」。"""
        link = self.vault / "01-Literature" / "inside_dir"
        mechanism = _make_dir_reparse_point(link, self.note.parent)
        r = self.get(lib="ai4s", ref="01-Literature/inside_dir/自噬.md")
        self.assertEqual(r.status_code, 200, f"{mechanism}: {r.text}")
        self.assertEqual(r.json()["content"], _NOTE_TEXT)

    def test_rejects_non_markdown_refs(self):
        for ref in ("notes.txt", "image.png", "01-Literature/自噬", "notes.md.bak", ".md"):
            with self.subTest(ref=ref):
                r = self.get(lib="ai4s", ref=ref)
                self.assertEqual(r.status_code, 400, r.text)
                self.assertIn(".md", r.json()["error"], "拒绝原因须指向后缀")
                self.assert_no_leak(r)

    # ---------- 400：非法 lib ----------
    def test_invalid_lib_is_400_and_never_falls_back(self):
        for lib in ("nope", "", "AI4S"):
            with self.subTest(lib=lib):
                r = self.get(lib=lib, ref="01-Literature/自噬.md")
                self.assertEqual(r.status_code, 400, r.text)
                self.assertIn("lib", r.json()["error"])
                self.assertNotIn(_NOTE_TEXT, r.text, "非法 lib 回退到了默认库")


class TestDocWhitelistRule(unittest.TestCase):
    """取文期第 6 条规则：非白名单 ref 必须 400（不得靠索引期过滤兜底）。"""

    def setUp(self):
        self.client = TestClient(http_server.app)

    def test_non_whitelisted_ref_is_rejected(self):
        for ref in ("00-MOC/index.md", "OCR/x/full_output.md", "99-Templates/t.md"):
            r = self.client.get("/doc", params={"lib": "ai4s", "ref": ref})
            self.assertEqual(r.status_code, 400, f"{ref} 应被拒（400），实得 {r.status_code}")
            # 错误体必须与第 1~5 条规则同形（`{"error": ...}`）：前端 doc.ts::reasonFrom
            # 只读 `error`，若这里给 FastAPI 的 `{"detail": ...}`，理由就会被前端丢掉、
            # 退化成泛化提示（001 的 /doc 契约要求 400 = denied 态且理由可见）。
            self.assertIn("ref", r.json()["error"].lower())

    def test_error_body_shape_matches_other_rules(self):
        """第 6 条与第 1~5 条的错误体形状必须一致——防回归成 `{"detail": ...}`。"""
        r = self.client.get("/doc", params={"lib": "ai4s", "ref": "00-MOC/index.md"})
        body = r.json()
        self.assertIn("error", body)
        self.assertNotIn("detail", body)


if __name__ == "__main__":
    unittest.main()
