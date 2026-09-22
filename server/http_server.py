"""rag-stack FastAPI 服务：HTTP 检索 + SSE 流式问答 + 同进程挂载 MCP（/mcp）。"""
from __future__ import annotations

import json
import logging
import os
import re
import time as _time
from pathlib import Path, PurePosixPath

# 模型已本地缓存，服务强制离线加载（零网络，避免 HF hub 检查超时）
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

from fastapi import Body, FastAPI, Query
from fastapi.responses import JSONResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.datastructures import URL
from starlette.routing import Route, get_route_path

from rag_core import llm, params as gen_params, rag_engine, sources
from server.mcp_server import MCP_MOUNT_PATH, mcp


def _build_mcp_app():
    """MCP 的 ASGI 子应用，其自身路由为 "/"。

    子应用路由设成 "/"，再由父应用 mount 到 "/mcp"，拼接后恰好是 /mcp。
    若用子应用默认的 "/mcp" 再 mount 到 "/mcp"，真实路径会变成 /mcp/mcp。
    """
    return mcp.streamable_http_app(streamable_http_path="/")


def _make_lifespan(mcp_app):
    """为**已挂载的那一个** MCP 子应用织 lifespan，返回 FastAPI 用的 lifespan。

    为什么必须显式织：`app.mount()` **不会**把子应用的 lifespan 传给父应用
    （Starlette 的 Mount 不参与 lifespan 转发）。子应用到不了自己的 lifespan，
    `StreamableHTTPSessionManager.run()` 就永远不会执行——没有任务组、没有
    `_lifespan_state`，任何 MCP 会话都会以
    「Task group is not initialized. Make sure to use run().」失败，
    而路由本身看起来完全正常。

    为什么用闭包而不是模块级变量：子应用与它的 session manager 必须与挂载的那个
    **是同一个实例**。若在 lifespan 里另调一次 `streamable_http_app()`，
    起的会是另一个从未被挂载的实例，挂载的那个仍然没有任务组。
    """
    async def _lifespan(app):
        # app 参数由 Starlette/FastAPI 传入，此处不需要；要启动的是 mcp_app。
        async with mcp_app.router.lifespan_context(mcp_app):
            yield

    return _lifespan


def build_app() -> FastAPI:
    """构造完整服务应用：HTTP 检索 + SSE 问答 + 同进程挂载的 MCP（/mcp）。

    注意 `StreamableHTTPSessionManager.run()` 每个实例只能调一次，故每次调用本函数
    都取一个新的 MCP 子应用（新的 session manager）——生产只调一次，
    测试可以按用例各建一个，从而走**同一条**挂载 + lifespan 接线。
    """
    mcp_app = _build_mcp_app()
    application = FastAPI(title="rag-stack", lifespan=_make_lifespan(mcp_app))
    application.mount(MCP_MOUNT_PATH, mcp_app)
    return application


app = build_app()

# 双库白名单（宪法 §2.2：按 lib 路由、绝不混用、非法 lib 不回退默认库）
_VALID_LIBS = ("ai4s", "mito")

# ——————————————— `/reindex` 闸门（004 T11 · R-37 / R-38 / R-39①）———————————————
#
# 004 的裁定：部署形态（`spark-10af`）**永久只读、任何写入路径都不得存在**（宪法 §0.2），
# 而本仓库里唯一的一条写入路径就是 `POST /reindex`（重建检索索引 = 改写派生数据）。
# 该形态下它必须**根本不注册**（路由表里没有 ⇒ 自然 404），而**不是**「注册了再拒绝（403）」
# ——「注册了再拒，等于承认写能力存在」。
#
# 取值语义（R-37）：**strip 后非空即禁**，刻意的 fail-closed。
# 部署机上这条 env 是**给人手写**的，写错的取值（`true`/`yes`/`TRUE`/带空格的 `1`）
# **绝不能静默把写路径留在只读部署机上**——多禁一次只是少一个端点（可发现、可修），
# 少禁一次则是一条**不该存在的重建索引路径**（不可接受的不对称）。
# 空串 / 纯空白 / 未设 ⇒ **不禁**：本机形态（唯一写源）的行为与改动前**一字不变**。
#
# 读取时机（R-39①）：**模块 import（= `build_app()` 之后的路由登记期）**读，不做请求期惰性读。
# 闸门是「这条路由存不存在」的**注册期**事实，不是每个请求各自判断的运行时策略；
# 请求期判断只能表达成 403/中间件拦截，那正是被否掉的那种形态。
#
# ⚠️ 不要写成「只认 `1`」——那会把 `=0`/`=true`/`=yes` 静默当成「别禁」。
_REINDEX_DISABLED = bool(os.environ.get("RAG_DISABLE_REINDEX", "").strip())

_log = logging.getLogger(__name__)

# 与旧 GET 端点 Query(..., ge=1, le=50) 同界：越界或非法一律 400，不静默夹紧。
# 默认值 8 → 10（2026-09-19）：界面新增「证据数」滑杆，范围 10–30，默认 10。
# 校验界仍是 1–50（**不**收窄到 10–30）：那是界面给使用者的调节范围，
# 而 API 要能继续接受 `topn=1` 这类既有调用方（收紧会静默打断它们）。
_TOPN_MIN, _TOPN_MAX, _TOPN_DEFAULT = 1, 50, 10


class _BadLib(Exception):
    """非法 lib 的显式信号——由路由捕获后返回 400，不回退任何默认库。"""


class _BadParam(Exception):
    """非法请求参数的显式信号——同样转 400，不落到 500。"""


def _parse_topn(raw) -> int:
    """校验 topn：必须是 1..50 的整数。非整数/越界一律 _BadParam（→400）。"""
    if isinstance(raw, bool):
        raise _BadParam(f"topn must be an integer in [{_TOPN_MIN}, {_TOPN_MAX}], got {raw!r}")
    if isinstance(raw, int):
        topn = raw
    elif isinstance(raw, str) and raw.strip().lstrip("+-").isdigit():
        topn = int(raw)
    else:
        raise _BadParam(f"topn must be an integer in [{_TOPN_MIN}, {_TOPN_MAX}], got {raw!r}")
    if not _TOPN_MIN <= topn <= _TOPN_MAX:
        raise _BadParam(f"topn must be in [{_TOPN_MIN}, {_TOPN_MAX}], got {topn}")
    return topn


# T26 取文接口（文献卡面板）：只允许读该库 vault 内的 Markdown（plan.md §12.3）
_DOC_SUFFIX = ".md"

# 篇目**存在**但服务端解不开/读不了（非 UTF-8 字节、权限不足）时的稳定文案。
# 不含任何路径，前端据 500 这个状态码分到 error 态（不是 missing、也不是 denied）。
_DOC_UNREADABLE = "note exists but the server could not read it (bad encoding or permission)"


def _doc_unreadable() -> JSONResponse:
    """500 + JSON 体：服务端读不了这一篇——既不谎报缺失(404)，也不裸 500 出非 JSON。"""
    return JSONResponse({"error": _DOC_UNREADABLE}, status_code=500)


def _vault_root(eng: rag_engine.RAGEngine) -> Path:
    """该库的 vault 根目录：取自 config 的 `vault_path`（宪法 §2.6：代码内不出现绝对路径）。"""
    raw = eng.cfg.get("vault_path")
    if not raw:
        # 缺键时**不得**回退到当前工作目录——那等于把整个仓库当 vault 暴露出去
        raise RuntimeError(f"lib {eng.cfg.get('lib')!r} 的配置缺少 vault_path")
    return Path(raw)


def _parse_source(raw, allowed: tuple[str, ...]) -> str | None:
    """校验检索的 `source` 前缀，返回规范化后的取值（`None` = 不筛选）。

    为什么在这里判、而不是只靠引擎返回空（T49 验收 Defect 2）：未注册的 `source` 是
    **客户端**输入错误 —— 打错字、或调了不存在的来源。它此前落到语义分支的
    `np.stack([])` 上、以 500 收场，等于把客户端的错误报成服务端故障。
    与 `/doc` 的分工保持一致：客户端错误 400（理由可见），500 只留给服务端故障。

    「已注册」的判据取自**本库配置**（`allowed_prefixes` → `sources.source_prefixes`），
    而不是写死一份前缀表：白名单目录就是来源的真值来源，配置一改，这里跟着改。
    取值是**前缀**语义（与引擎的 `source LIKE '<值>%'` 一致），故 `vault` 这类族前缀合法
    —— 它选到的仍然是本库已注册的来源。`None` 与空串表示「不筛选」，与既有行为一致。

    真正的越界防线不在这里、也不靠这段校验：命中仍要过 `_within_whitelist`（SC-17）。
    本函数只管**分类**（客户端错误 vs 服务端故障），不承担安全边界。
    """
    if raw is None or raw == "":
        return None
    if not isinstance(raw, str):
        raise _BadParam(f"source must be a string, got {raw!r}")
    known = sources.source_prefixes(allowed)
    if not any(k.startswith(raw) for k in known):
        # 理由里列出**合法取值**（来源名不是秘密，也不是路径），使用打错字时能自查
        raise _BadParam(f"source must be one of {known} (or a prefix of one), got {raw!r}")
    return raw


def _parse_doc_ref(ref: str | None) -> str:
    """校验前端传来的 `ref`，返回规范化的 vault 相对 POSIX 路径。

    拒绝：缺失/空、绝对路径（Windows 盘符 / UNC / POSIX 根）、任何 `..` 段、非 `.md`
    （大小写不敏感）。非法一律 _BadParam → 400。错误信息**不回显** `ref`，
    免得把客户端传来的绝对路径写进响应体。
    """
    text = ref.strip() if isinstance(ref, str) else ""
    if not text:
        raise _BadParam("ref must be a non-empty vault-relative path")
    norm = text.replace("\\", "/")
    if (text.startswith(("/", "\\")) or Path(text).is_absolute()
            or Path(text).drive):
        raise _BadParam("ref must be vault-relative, not an absolute path")
    if ".." in PurePosixPath(norm).parts:
        raise _BadParam("ref must not contain '..' path segments")
    if PurePosixPath(norm).suffix.lower() != _DOC_SUFFIX:
        raise _BadParam("ref must point to a .md file")
    return "/".join(PurePosixPath(norm).parts)


def _doc_path(eng: rag_engine.RAGEngine, ref: str) -> Path:
    """把已校验的 `ref` 落到 vault 内的真实路径。

    解析后断言目标位于 vault 根之下（`is_relative_to`）——符号链接/junction 等
    重解析点若指向根外，在此被拒。越界一律 _BadParam → 400。
    """
    root = _vault_root(eng).resolve()
    try:
        target = (root / PurePosixPath(ref)).resolve()
    except (OSError, ValueError) as exc:
        # 非法字符 / NUL / 超长路径等：拒为 400，不落 500（原因不丢：链接异常链）
        # 级别用 warning：uvicorn 直跑时 root 无 handler，INFO 会被 lastResort(WARNING) 丢弃，
        # 等于没记（与本仓 rag_engine 里被捕获/降级路径的惯例一致）。
        _log.warning("doc ref unresolvable: ref=%s err=%s", ref, type(exc).__name__)
        raise _BadParam("ref cannot be resolved to a vault path") from exc
    if not target.is_relative_to(root):
        raise _BadParam("ref points outside the library vault")
    return target


def _doc_missing() -> JSONResponse:
    """404：该篇目在 vault 内**不存在**（与 400「路径不合法」文案不同，前端据此分态）。

    注意与 500 的分工：文件在、只是服务端解不开/读不了 → `_doc_unreadable()`，
    不归这一支（谎报缺失会让前端把服务故障当成内容缺失）。
    """
    return JSONResponse({"error": "note not found in library vault"}, status_code=404)


def _engine(lib: str) -> rag_engine.RAGEngine:
    return rag_engine.get_engine(lib)


def _resolve(lib: str) -> rag_engine.RAGEngine:
    """校验 lib 后取引擎单例。非法 lib 抛 _BadLib，由调用方转成 400。"""
    if lib not in _VALID_LIBS:
        raise _BadLib(f"unknown lib: {lib!r}; expected one of {_VALID_LIBS}")
    return rag_engine.get_engine(lib)


def _sse(payload: dict, event: str | None = None) -> str:
    head = f"event: {event}\n" if event else ""
    return head + "data: " + json.dumps(payload, ensure_ascii=False) + "\n\n"


def _build_system_prompt() -> str:
    """回答生成用的 system 提示词（003 第 8 条：回答由分析组织）。

    三层约定必须同时在场，缺一层即回归旧行为：
    1. 证据与格式（001 既有）：只依据证据、[编号] 引用、不参考历史问答、Markdown、KaTeX 公式；
    2. 分析要求（003 新增）：跨证据综合、指出矛盾或不一致、给出结论并说明理由；
    3. 外推标记（003 新增）：证据未直接支持但合理的判断，段首用 [推测] 并说明所缺依据的种类。

    为什么要「跨两条及以上证据」这句：003 的 C-11 只允许**有限外推**——分析必须落在本次
    检索证据的语境里。一句话结论可以只靠一条证据，但没有这条约束，模型容易退化成
    「逐条复述 + 一句总结」，正是本条要修掉的旧行为。
    """
    return (
        "你是严谨的科研助手。只依据下面提供的检索证据回答，"
        "每条关键论断后用 [编号] 标注证据；证据不足处明确说明为通用知识；"
        "不参考历史问答记录。"
        "输出用 Markdown 组织：分点或分小节，关键结论可用 **加粗** 突出（勿滥用）；"
        "数学公式用 $…$（行内）或 $$…$$（独立行）。"
        # —— 003 新增：要分析，不要复述 ——
        "你必须给出**分析**而不是逐条复述证据："
        "要跨多条证据综合出结论（结论应建立在两条及以上证据之上）、"
        "指出证据之间的矛盾或不一致之处、并给出你的判断及其理由。"
        # —— 003 新增：外推必须标记 ——
        "若你所做的判断并未被证据直接支持（例如对研究缺口、未来方向的推断），"
        "该段必须用 [推测] 开头，并在同处说明所缺的是哪一类证据；"
        "不得为这类推测编造引用编号。"
    )


@app.get("/search")
def search(lib: str = "ai4s", q: str = "", mode: str = "hybrid",
           topn: int = Query(8, ge=1, le=50), source: str | None = None):
    """检索。状态契约：200 正常（**零命中也是 200**）；400 客户端输入错误。

    400 覆盖两类输入：非法 `lib`（与 `/doc`、`/ask/stream` 同形，不再落到 500），
    以及未注册的 `source`（T49 验收 Defect 2：此前语义分支在过滤后为空时
    `np.stack([])` 抛 ValueError → 500，把「打错来源名」谎报成服务端故障）。
    错误体一律 `{"error": ...}`，与 `/doc` 的 400 同形，前端只读 `error` 字段。
    """
    try:
        eng = _resolve(lib)
        src = _parse_source(
            source, tuple(eng.cfg.get("allowed_prefixes") or sources.ALLOWED_PREFIXES))
    except (_BadLib, _BadParam) as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)
    hits = eng.search(q, mode=mode, topn=topn, source=src) if q else []
    return {"lib": lib, "query": q, "mode": mode, "hits": hits}


@app.get("/doc")
def doc(lib: str = "ai4s", ref: str | None = None):
    """只读取文（文献卡面板）：返回该库 vault 内单篇 Markdown 的全文。

    状态契约：200 正常；400 `ref` 缺失/空/非法（绝对路径 / 含 `..` / 解析后越界 / 非 `.md`
    / **不在允许目录内**）或非法 `lib`；404 篇目不存在。500 **不属于篇目状态**——只在篇目确实
    存在、但服务端解不开或读不了（非 UTF-8 字节、权限不足）时返回，且必带 JSON 体
    （前端映射为 error 态）。
    **400 的体一律为 `{"error": ...}`**：规则 1~6 走同一条 `JSONResponse` 路径，
    前端 `reasonFrom` 只读 `error`，故任何一条规则的拒绝理由都能原样显示。
    **不要改用 `HTTPException`**——它的体是 `{"detail": ...}`，会让前端丢掉具体理由、退化成
    「服务端返回 HTTP 400」这一档通用文案（该形状曾短暂存在于第 6 条，已由提交 `6b96bb7` 纠正，
    并有回归测试 `test_error_body_shape_matches_other_rules` 钉住）。

    lib 校验与 ref 校验都先于任何文件系统访问：缺失/空 `ref` 是**客户端**错误 → 400
    （控制器 Ruling 64），不是 404。旧实现把裸 `/doc` 判成 404，既让 `GET /doc` 与
    `GET /doc?ref=` 对「没给 ref」给出两种状态码，又盖住了 `GET /doc?lib=nope` 本该有的
    bad-lib 400。仅读：不写、不建目录，错误信息不含绝对路径。
    """
    try:
        eng = _resolve(lib)
        # `_parse_doc_ref` 同时承担 ref 的存在性检查（None/空/纯空白 → _BadParam），
        # 故这一步必须在 `_resolve` 之后、任何 stat/读取之前。
        rel = _parse_doc_ref(ref)
        target = _doc_path(eng, rel)
    except (_BadLib, _BadParam) as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)

    # A 案第 6 条规则：只读三个允许目录（spec SC-17 要求「取文成功数 = 0」）。
    # 与「越界」「非 .md」同级：都是 400，理由字段必须可区分。
    # 判定用**规范化后**的 `rel` 而不是原始入参 `ref`：`rel` 才是随后真正被解析并读取的
    # 路径（查你所读）。原始形态里带 `.` 段或 `//` 的请求（如 `01-Literature/./a.md`）经
    # 既有规则规范化后本就落在允许目录内，用 `ref` 判会把它们从 200 误改成 400。
    #
    # 错误体必须与第 1~5 条规则一致用 `{"error": ...}`（而不是 FastAPI `HTTPException` 的
    # `{"detail": ...}`）：前端 `doc.ts::reasonFrom` 只读 `error`，用 `detail` 会让这条 400
    # 退化成泛化的「服务端返回 HTTP 400」——理由不可见。001 的 /doc 契约里 400 = denied 态，
    # 且要求**理由可见**，故此处走同一条 JSONResponse 路径。
    allowed = tuple(_engine(lib).cfg.get("allowed_prefixes") or sources.ALLOWED_PREFIXES)
    if not sources.is_allowed_ref(rel, allowed):
        return JSONResponse({"error": "ref must be inside an allowed directory"}, status_code=400)

    if target.is_dir():
        # 目录不是篇目。Windows 上读目录抛 PermissionError，不能只靠异常类型区分，
        # 故此处显式判定；也免得把「不是文件」误报成服务故障。
        return _doc_missing()

    try:
        # 不用 is_file() 预判缺失：校验与读取之间文件可能被删，
        # 读取本身（连同 stat）才是唯一权威，缺失一律归 404 三态。
        content = target.read_text(encoding="utf-8")
        mtime = target.stat().st_mtime
    except (FileNotFoundError, NotADirectoryError, IsADirectoryError):
        # 校验与读取之间被删/被替换：属正常「篇目不存在」态，但仍须留痕（宪法 §3.3）
        _log.warning("doc note unreadable: lib=%s ref=%s", lib, rel)
        return _doc_missing()
    except (UnicodeDecodeError, OSError) as exc:
        # 文件**存在**但读不出「合法 UTF-8 文本」：非 UTF-8 字节（UnicodeDecodeError）、
        # 权限不足（PermissionError，`is_dir()` 在 OSError 上返回 False，故前面拦不住）
        # 等。这是**服务端**条件：改 ref 解决不了，谎报 missing 会让前端把服务故障当内容缺失，
        # 故归 500 + JSON 体（前端已把 500 映射到 error 态），不新增第四种篇目状态。
        # 留痕（宪法 §3.3）：记原因类型与**相对** ref；响应体只给稳定文案，绝不含绝对路径。
        _log.warning("doc note undecodable/unreadable: lib=%s ref=%s err=%s",
                     lib, rel, type(exc).__name__)
        return _doc_unreadable()

    return {
        "lib": lib,
        # ref 回显为**规范化 POSIX** 形式（入参里的 `\` 统一成 `/`，`.`
        # 段已丢弃）：前端比对/回填请以本字段为准，别逐字节比对原始入参。
        "ref": rel,
        "title": target.stem,
        "content": content,
        "mtime": mtime,
    }


@app.get("/capabilities")
def capabilities(lib: str = "ai4s"):
    """只读能力端点：本库的**生成参数当前是否真的会被采纳**。

    为什么必须存在（T49 验收 Defect 1）：界面原先写死「待接入 / 后端当前不读取它们」，
    而 `params` 早已真正生效 —— 那句免责声明是**假的**。spec
    §「参数不被支持时的如实性」要求标注**随真实能力变化**，plan §2.2(d) 把它写成
    「由后端能力驱动」；没有任何端点暴露能力，前端就只能继续写死。本端点补上这一环。

    真值来源是 `rag_core/params.py::is_supported(cfg)`（读本库配置的 `generate` 区块），
    **不得**在端点里写死任何 true/false：配置一关，界面必须跟着改口（`tests/test_capabilities.py`
    用改写过的临时配置钉住这一点）。

    契约：
    - `GET /capabilities?lib=<ai4s|mito>`（缺省 `ai4s`，与 /search、/doc 一致）
    - 200 → `{"lib": <lib>, "params": {"divergence": bool, "length": bool}}`
      `params` 的键**就是** `is_supported` 的键（参数 id 只有这一个真值来源，不另起一份
      同义副本 —— 两份映射迟早分叉，那正是本缺陷的成因）。
    - 400 → 非法 `lib`，体为 `{"error": ...}`（与 /doc、/ask/stream 同形），**不回落默认库**。
    - 只读：不写盘、不建索引、错误信息不含任何路径。
    - `Cache-Control: no-store`：答复必须**永远是现在**的。任何一层缓存（浏览器/代理）
      都可能让界面拿着旧答复重新开始撒谎，而本端点的全部意义就是「此刻是否生效」。

    前端在**请求失败或尚未取到**时不得默认「已生效」，也不得默认「未生效」——
    那是「未确认」这个第三态，由 `frontend/src/lib/capabilities.ts::supportOf` 判定。
    """
    try:
        eng = _resolve(lib)
    except _BadLib as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)
    resp = JSONResponse({"lib": lib, "params": gen_params.is_supported(eng.cfg)})
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.post("/ask/stream")
def ask_stream(payload: dict = Body(...)):
    lib = str(payload.get("lib", ""))
    messages = payload.get("messages") or []

    try:
        eng = _resolve(lib)
        # `params.topn`（证据数滑杆）优先；顶层 `topn` 仍接受 —— 那是本端点自 001 起的
        # 既有字段，老调用方（脚本/探针）一直在用，删掉即静默失效。
        raw_params = payload.get("params") or {}
        topn_raw = raw_params.get("topn", payload.get("topn", _TOPN_DEFAULT))
        topn = _parse_topn(topn_raw)
    except (_BadLib, _BadParam) as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)

    def gen():
        # 阶段耗时一律取**服务端实测**（perf_counter），不由前端推测：前端猜测会在网络
        # 抖动下撒谎（spec 第 9 条「阶段耗时来自服务端实际经历的时间」）。
        t_start = _time.perf_counter()

        def _stage(name: str, since: float) -> str:
            """`stage` 事件：某个阶段**已经发生**，耗时 = 从 `since` 到现在（毫秒）。"""
            return _sse({"name": name,
                         "elapsed_ms": int((_time.perf_counter() - since) * 1000)},
                        event="stage")

        try:
            question = ""
            for m in reversed(messages):
                if m.get("role") == "user":
                    question = str(m.get("content", ""))
                    break

            # 只把 user/assistant 当「上文」：仅含 system/tool 的 messages 无真实历史，
            # 既不该触发改写，也不该进改写 prompt（宪法 §4：历史问答不作检索证据）。
            history = llm._conversation_history(messages[:-1])

            resolved = question
            if question and history and eng.cfg["rewrite"]["enabled"]:
                # 门用「过滤后的历史」：仅含 system/tool 的 messages 没有真实上文，
                # 不该触发改写（旧门 len(messages) > 1 会把一条 system 提示词当上文）。
                t_rewrite = _time.perf_counter()
                rw = llm.rewrite_query(
                    history + [{"role": "user", "content": question}],
                    history_rounds=int(eng.cfg["rewrite"]["history_rounds"]),
                    max_chars=int(eng.cfg["rewrite"]["max_chars"]),
                    timeout_s=float(eng.cfg["rewrite"]["timeout_s"]),
                )
                resolved = rw.query or question
                yield _sse({"query": resolved, "degraded": rw.degraded}, event="rewrite")
                # 阶段事件**与改写事件同条件发出**：未触发改写时不发 rewrite 阶段 ——
                # spec 有专门 Scenario 断言「未触发改写却显示改写阶段」= 违反
                # （不得为了让流程看起来完整而补全一个没发生的阶段）。
                yield _stage("rewrite", t_rewrite)

            t_evidence = _time.perf_counter()
            hits = eng.search(resolved, mode="hybrid", topn=topn) if resolved else []
            yield _sse({"lib": lib, "query": resolved, "hits": hits}, event="evidence")
            yield _stage("evidence", t_evidence)

            if resolved:
                evidence_text = "\n".join(
                    f"[{i + 1}] {h.get('title', '')}\n{h.get('snippet', '')}"
                    for i, h in enumerate(hits)
                )
                # 输出格式必须显式约定：前端把答案当 Markdown 渲染（react-markdown +
                # rehype-katex），但提示词原先只说了 [编号] 引用、没说格式，模型于是
                # 时用时不用 Markdown，同一段答案里粗体时有时无。这里补齐约定。
                # 注意与前端能力对齐：KaTeX 只认 $…$ / $$…$$，故明确写出行内/独立公式。
                # 003 的分析要求与 [推测] 外推标记同在 `_build_system_prompt()` 里
                # （三层约定各自有回归测试钉住，改提示词请先看那里的文档字符串）。
                system = _build_system_prompt()
                # 生成参数（003 第 7 条）：发散→采样；篇幅→目标字数 + 容差 + 重试预算。
                # 三个取值都来自请求体 `params`（前端自 001 起一直在发，此处才真正被读）。
                raw_params = payload.get("params") or {}
                gen_cfg = eng.cfg.get("generate") or {}
                length_cfg = gen_cfg.get("length") or {}
                divergence = float(raw_params.get("divergence", 1.0))
                # **只有客户端显式给了篇幅才做容差核对与重试**（控制器 Ruling）：
                # 否则不传 params 的老客户端会被套上一个它从未要求的字数契约，
                # 任何偏短的回答都会白跑一次完整生成（延迟与成本翻倍）。
                target = int(raw_params["length"]) if "length" in raw_params else None
                sampling = dict(gen_params.divergence_to_sampling(
                    divergence, gen_cfg.get("divergence") or {}))
                # ⚠️ **绝不发 `max_tokens`**（使用者 2026-09-19 明确要求）。
                #
                # 早先按目标字数算上限（`max_tokens_for(1000) = 997`）并透传给 provider。
                # 那个上限**同时管住思考与正文**：模型的长思考本身就能超过它
                # （实测单轮思考 18,638 字），于是正文在剩余预算里被**从中间砍断**
                # （实测正文 1727 字、结尾停在"…与体内分布、安全性和基因编辑等"），
                # 而补救重试也救不回来 —— 再生成一次仍会撞同一个上限。
                #
                # 篇幅的语义是**范围**，不是硬上限：给多少都由模型自然写完，
                # 实际字数经 `count_answer_chars` 如实报回（不达标就走既有 notice）。
                # 于是这里既不设上限，也不需要"客户端没给就不设"的特例 —— 一律不设。
                tolerance = float(length_cfg.get("tolerance", 0.10))
                max_retry = int(length_cfg.get("max_retry", 0)) if target is not None else 0

                # **反思式补救**（控制器 Ruling，修复审查 Critical 1）：
                # 在「某一轮核对通过」之前**一个 delta 都不流**。为什么必须如此：
                # 早先的写法边流边核对，第一稿的 delta 已经到达浏览器，而重试的第二稿会被
                # 前端**追加**到同一条消息上（契约里没有「清空」）⇒ 用户看到两份拼接的答案，
                # 且字数只量了第二稿 ⇒ 一个交付了约两倍目标字数的轮次反而被报成**完全合规**，
                # 正是 spec 禁止的「把不合规的结果直接交付」。
                # 现在「交付的文本」恒等于「被核对的文本」，静默失败在结构上不再可能。
                # 代价：正文出现时间推迟到「出完 + 核对完」（思考片段仍实时流，由 T42/T43 提供）。
                attempt = 0
                delivered = ""
                chars: int | None = None
                # 思考是否真的到过（整轮请求一次判定，用于「不可用」的可见告知）。
                # 声明在重试循环**之外**：一轮请求只告知一次，而不是每次补救都重复一条。
                saw_reasoning = False
                # `reasoning` stage 的「本轮已发过」标记**提到重试循环外**（复审 Minor 3）：
                # 否则补救重试时第二轮会再发一条同名 stage，前端会渲染成两个「思考」行
                # （stage 的语义是「这一轮有哪些阶段」，不是「每个 attempt 各一条」）。
                reasoning_stage_sent = False
                # 思考转发量的上限（spec 第 9 条 ★：实测单轮可达约 3,500 字，必须设上限）。
                # 思考**不设上限**（使用者 2026-09-19 明确要求："去掉这个限制，把所有思考
                # 过程都打印出来"）。故这里既没有转发量预算、也没有「已截断」状态，
                # 更没有对应的 notice —— 那套机制在无上限时不可能触发，留着就是死代码。
                # 代价如实记档：思考越长，SSE 转发量与前端渲染量越大（实测单轮可达 1.2 万字以上）。
                reasoning_chars = 0
                while True:
                    prompt = (
                        f"问题：{resolved}\n\n检索证据：\n{evidence_text or '（无检索证据）'}"
                        + (f"\n\n目标篇幅：约 {target} 字。" if target is not None else "")
                    )
                    answer = ""
                    # 本轮的思考耗时 = 「生成开始 → 首个正文字」。它不随正文的交付时刻走：
                    # 正文要等核对完才发（反思式补救），而思考确实在这之前就结束了。
                    t_reasoning = _time.perf_counter()
                    round_saw_reasoning = False
                    try:
                        for kind, text in llm.stream_parts(
                            [{"role": "system", "content": system},
                             {"role": "user", "content": prompt}],
                            lib=lib, **sampling,
                        ):
                            if kind == "reasoning":
                                # 思考片段**实时转发、不设上限**：它不参与篇幅核对，且
                                # 「等待期有事可看」正是 003 第 9 条的全部价值（实测首段
                                # 1.2~2.6s 就到，而正文要等 65~75s —— 这段等待原先被整段丢弃）。
                                saw_reasoning = True
                                round_saw_reasoning = True
                                reasoning_chars += len(text)
                                yield _sse({"delta": text}, event="reasoning")
                            else:
                                if round_saw_reasoning and not reasoning_stage_sent:
                                    # 思考阶段到此结束（第一个正文字出现）。仅当**本轮真的
                                    # 有过思考**才发：spec 明确禁止呈现后端并未发生的阶段。
                                    reasoning_stage_sent = True
                                    yield _stage("reasoning", t_reasoning)
                                # 正文只累积、**不在此处发**：见上面的反思式补救不变量
                                # 「交付的文本 == 被核对的文本」。若在此 yield answer，
                                # 重试稿会被前端追加到同一消息上（审查 Critical 1 原样复现）。
                                answer += text
                    except Exception as exc:  # noqa: BLE001
                        if attempt == 0:
                            # 首轮就失败：没有任何文本可给 ⇒ 这才是真正的 error
                            yield _sse({"message": f"生成失败：{exc}"}, event="error")
                            break
                        # 补救轮失败：**不得**翻成 error（那会把用户整体推向失败态），
                        # 也**不得**覆盖 `delivered` —— 那里存的是上一轮已成功生成的文本。
                        # ⚠️ 这里曾写成 `delivered = answer`，而 `answer` 在本轮开头刚被重置为 ""，
                        # 于是「交付上一稿」实际交付了**空** —— 正是这条 Ruling 要避免的结果。
                        # 修复由测试 `test_failed_retry_delivers_the_first_attempt_instead_of_erroring` 抓出。
                        yield _sse({"message": f"补救生成失败：{exc}", "chars": chars,
                                    "target": target}, event="notice")
                        break

                    delivered = answer
                    chars = gen_params.count_answer_chars(answer)
                    if target is None or gen_params.within_tolerance(chars, target, tolerance):
                        break
                    if attempt >= max_retry:
                        # 宪法 §4.3 零静默失败：补救后仍不合规必须可见告知（spec SC-22）。
                        # 用 notice 而非 error：这一轮是**成功但有需要说明的事**，不是失败。
                        yield _sse({"message": f"本轮字数 {chars} 未落在 {target} 字的 "
                                              f"±{int(tolerance * 100)}% 容差内（已重试 {attempt} 次）",
                                    "chars": chars, "target": target},
                                   event="notice")
                        break
                    attempt += 1

                # 思考不可用的告知：**只在没有抛过 error 时**发。首轮生成就失败时也会走到这里
                # （saw_reasoning 仍为 False），若照发就会把一个「生成失败」误报成
                # 「上游没给思考」——那是错误归因（T41–T43 复审 Minor 8）。
                if not saw_reasoning and delivered:
                    # 零静默失败（宪法 §4.3 / spec SC-24「不可用信息的如实告知率 = 100%」）：
                    # 用户等的是思考，上游没给就必须明说，静默留白等于骗人。
                    # 位置在核对之后、交付之前：既保证「一轮一条」（不随补救重复），
                    # 又保证它在正文之前到达 —— 它要填的正是首字之前的等待。
                    yield _sse({"message": "本轮未能获取模型思考内容（上游未提供）"},
                               event="notice")

                # 零静默失败：**这一轮什么都没交付**时必须明说（复审 Important 2）。
                # 可达路径：模型只思考不产出正文（思考占满 max_tokens）且客户端未指定篇幅 ⇒
                # 既没有 answer、也没有错、notice 也不会发（思考不可用的那条刚被 delivered 挡住）
                # ⇒ 用户对着一条空消息干等。这条 notice 把它堵上。
                if not delivered:
                    yield _sse({"message": "本轮未能生成正文（未获得可交付的回答内容）"},
                               event="notice")

                # 核对结束后**一次性交付**被核对过的那一版文本（交付的 == 被核对的）
                if delivered:
                    # answer 阶段 = 从请求开始到正文**真的开始交付**。不用「首个正文字到达」
                    # 计时：那一刻浏览器里什么都还没有（正文要等核对完），拿它当「正文开始」
                    # 会在补救重试时撒谎（说了「正文开始」，用户却再等一整轮生成）。
                    yield _stage("answer", t_start)
                    yield _sse({"delta": delivered}, event="answer")
        except Exception as exc:  # noqa: BLE001
            yield _sse({"message": f"服务异常：{exc}"}, event="error")
        finally:
            # 宪法 §4.3：无论中途是否抛错，done 必发且只发一次
            # （stage 的 done 在其前，总耗时 = 整轮请求实际经历的时间）
            yield _stage("done", t_start)
            yield _sse({}, event="done")

    return StreamingResponse(gen(), media_type="text/event-stream; charset=utf-8")


def reindex(lib: str = "ai4s"):
    """唯一的写路径：重建该库的检索索引（改写 `rag_core/data` 下的派生数据）。

    ⚠️ 它**不是**模块级 `@app.post` 注册的，而是在下面**条件登记**（见那一段的说明）：
    部署形态（`RAG_DISABLE_REINDEX` 非空）下这条路由**根本不存在**。
    直接 import 本模块**不会**触发任何重建——只有真的向 `/reindex` 发请求才会。
    """
    return _engine(lib).sync_index()


# 条件登记（R-38）：**先把处理函数定义好**，再在这里条件地登记它——而不是
# 先 `@app.post` 注册再用 `routes.remove`/重建 app 把它摘掉。后者会改动别的路由记录
# （记录数/顺序），而 T06 的护栏 ③ 断言「闸门**只**让 `/reindex` 一条消失、其余路由
# （含 `/mcp` 挂载点）逐条不变」；T10 也已经踩过同类的「按 path 查重」坑。
# 故这里只有两种结局：**登记一次**，或**完全不登记**（不碰任何别的记录、不改顺序）。
if _REINDEX_DISABLED:
    # 部署形态：**根本不注册**该路由。没有这条记录 ⇒ 自然 404，也没有任何
    # 「已注册但被拦下」的中间态（那等于承认写能力存在）。
    _log.info("RAG_DISABLE_REINDEX 已设置：POST /reindex 不注册（只读部署形态）")
else:
    app.post("/reindex")(reindex)


# ——————————————————————— 静态托管（004 T10）：界面产物与接口同一个部署单元 ———————————————
#
# ⚠️ 这一段必须留在**文件最末**，且只能写成下面这一次性调用（R-4）。
# 全部 API 路由都是模块级 `@app.get/@app.post` 在 `build_app()` 之后注册到同一个 app 上的，
# 而 Starlette 的 `Mount("/")` 对**任何**路径都返回 `Match.FULL` ⇒ 若把静态挂载放进
# `build_app()`，它会先于全部 API 路由与 `/mcp` 进入路由表，**静默吞掉所有接口**
# （表现是「接口莫名 404」，而代码看起来完全正常）。
_FRONTEND_DIST = Path(os.environ.get("RAG_FRONTEND_DIST")
                      or (Path(__file__).resolve().parent.parent / "frontend" / "dist"))
# 上面那行里的 `RAG_FRONTEND_DIST` **不是配置项**：它是 T05 测试用来替换产物目录的
# **仅供测试的缝**，生产**永不设置**（空串等同未设，`or` 已天然满足）。
# 不要把它当可配置项写进任何部署文档：生产若误设，会**静默覆盖**默认产物路径，
# 失败不可见（R-36）。默认路径一律由 `__file__` 推导（宪法 §2.6：不出现写死的绝对路径）。


class _BareMcpSlashRedirect:
    """裸 `/mcp` → `/mcp/` 的 **307**（静态挂到 `/` 之后，Starlette 的斜杠重定向不再触发）。

    为什么需要它（R-32 / R-35）：`Mount("/")` 对 `/mcp` 也返回 `Match.FULL`，
    Starlette 的「斜杠重定向」于是不再触发 ⇒ 裸 `GET /mcp`（客户端常用形式）
    会从今天的 307 变成 404，破坏 004 §5 的「`/mcp` 保持既有行为」。

    为什么是**纯 ASGI 中间件**而不是 `application.add_route("/mcp", ...)`：
    后者会在路由表里多出**第二条 `path == "/mcp"`** 的记录（第一条是 `Mount("/mcp")`），
    而 `tests/test_reindex_gate.py::test_without_gate_api_surface_is_intact`（本机形态的
    **绿护栏**）断言 `/mcp` 的记录**恰好 1 条**（`len(_find_path(mod, "/mcp")) == 1`）。
    实测：用 `add_route` 时该绿护栏转红（2 != 1）—— 那是「让 T06 变得更红」，
    违反 T10 验收第 2 条。中间件**不新增任何路由记录**，两个套件的判据同时成立。

    方法覆盖面与 Starlette 今日的 `redirect_slashes` **逐方法等价**（GET/POST/DELETE/HEAD
    以及其余方法一律重定向）—— 比写死一张方法表更忠实于「保持既有行为」；
    `POST /mcp`、`DELETE /mcp`（Streamable HTTP 用的两个方法）因此不会落 405。
    只在路径**恰好**是 `/mcp` 时介入：`/mcp/` 及其子路径原样透传给 MCP 挂载点。

    `Location` 也**逐字节照抄** Starlette 的算法（`Router.app` 的 `redirect_slashes` 分支）：
    判据用 `get_route_path(scope)`（剥掉 `root_path`），响应则用「把 `path` 补一个斜杠后的
    那份 scope」构造 `URL(scope=...)`。于是 query string（`/mcp?foo=1` → `/mcp/?foo=1`）
    与 `root_path` 前缀（`/x/mcp` → `http://host/x/mcp/`）都**原样保住**。
    ⚠️ 别改回 `url=f"{MCP_MOUNT_PATH}/"`：那会**丢掉 query string 与前缀**——status 与
    `location` 的 path 看起来仍然对（T05 只钉这两样），但已不是「保持既有行为」。
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and get_route_path(scope) == MCP_MOUNT_PATH:
            redirect_scope = dict(scope)
            redirect_scope["path"] = scope["path"] + "/"
            response = RedirectResponse(url=str(URL(scope=redirect_scope)), status_code=307)
            await response(scope, receive, send)
            return
        await self.app(scope, receive, send)


# ———————————————— 界面的分层缓存策略（T40）：**只作用于静态挂载** ————————————————
#
# 为什么必须存在（T39 §5.4 的实测）：`GET /` 带 `ETag`/`Last-Modified` 却**没有
# `Cache-Control`** ⇒ 预热过的浏览器不会重新验证，部署后**继续跑旧的 bundle**
# （白屏依旧，而服务端早就在发修好的文档）。默认策略按 RFC 9111 是启发式的，
# 这里必须**显式**写死，不能依赖启发式。
#
# 为什么是「包住静态挂载」而不是「全局中间件」：全站盖章会覆盖 `/capabilities`
# 的 `no-store`（`tests/test_capabilities.py:96` 钉着它），而那一条是有语义的
# ——能力答复必须**永远是现在**的。策略因此限定在本文件最末那次 `mount_frontend`
# 挂上的 `_StaticFrontend` 上：API 路由与静态兜底自己的 404/405 一个字节都不碰。
_CACHE_REVALIDATE = "no-cache"
"""入口文档与非指纹化文件的策略：**每次都必须重新验证**。

`ETag`/`Last-Modified` 仍在（`FileResponse` 加的），故未变时是一次便宜的 **304**。
刻意**不**用 `no-store`：那会让浏览器连重新验证都不做，把 304 这条廉价退路也一起废掉，
而且它表达的是「不得存储」，与「必须问一句」是两回事。"""

_CACHE_IMMUTABLE = "public, max-age=31536000, immutable"
"""**内容寻址**的构建产物的策略：文件名里带着构建哈希，内容一变名字就变，
因此可永久缓存、无需再验证。只给**确实带哈希**的文件名，见下面的判据。"""

_FINGERPRINTED_ASSET = re.compile(r"^[^/]+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$")
"""指纹化文件名的判据：`<名字>-<8 位以上 base64url 哈希>.<扩展名>`。

8 位是 Vite/Rollup 的默认哈希长度（本仓产物实测全为 8 位，见 `frontend/dist/assets`）。
判据**故意收紧到「带哈希」**而不是「在 `assets/` 下 + 扩展名对」：非指纹化的文件
（`favicon.svg`、`icons.svg`，或将来某个 `assets/plain.js`）一旦被盖上 `immutable`，
就再也没法靠改名让它失效 —— 那是**不可回滚**的错误方向，宁可保守回落成再验证。"""


def _static_cache_control(rel_path: str) -> str:
    """静态产物的 `Cache-Control` 取值（`rel_path` 是挂载根下的相对路径）。

    三分支收敛成两条：**带构建哈希的产物** → 永久 `immutable`；**其余一律** → 重新验证。
    入口文档（`/` 归一化成 `.`、`/index.html`）与 HTML 都落在后者，符合「任何从本目录
    发出的 HTML 都必须重新验证」这条要求 —— 它们的名字里没有哈希，改了名字也不会变。

    路径分隔符两种都要吃：挂载根在 Linux 上是 `/`，本机测试跑在 Windows 上给的是 `\\`
    （实测：`StaticFiles.get_path` 用的是 `os.path.normpath`），故先归一到 POSIX。
    """
    posix = PurePosixPath(rel_path.replace("\\", "/"))
    if posix.parts[:1] == ("assets",) and _FINGERPRINTED_ASSET.match(posix.name):
        return _CACHE_IMMUTABLE
    return _CACHE_REVALIDATE


class _StaticFrontend(StaticFiles):
    """**界面产物的托管体**：`html=True`（原因见 `mount_frontend`：根路径要返回界面文档，
    且该参数**不引入 SPA 回退**），且非 GET/HEAD 的请求按「路径是否已注册」分流（R-47）。

    要解决的两件事，**必须同时成立**：
    * 未注册路径（`POST /close_read/stream`）→ **404**（T10 之前就是 404）；
      部署形态下 `/reindex` 根本不注册，SC-27 要求它返回**不存在**（404）——
      405 的语义是「路径**存在**、只是方法不对」，与「未注册」**恰好相反**，
      会让人以为重建索引的路径还在。
    * 已注册路径但方法不符（`POST /capabilities`）→ **405**（`tests/test_capabilities.py:149`
      钉着的既有行为；这个 405 是「路径在、方法不对」的正确语义，**不许**被改成 404）。

    为什么必须在这里分流（实测，别想当然）：`Mount("/")` 对**任何**路径都返回
    `Match.FULL`，于是路由器**永远走不到**它给方法不符路径准备的 PARTIAL 分支
    （FULL 命中先返回）——PRE-T10 的 405 在 T10 之后其实是由 `StaticFiles` 自己
    「碰巧」给出的（它对非 GET/HEAD 抛 405）。因此这两件事没法靠路由器区分，
    只能在静态兜底里判：**看路径有没有被某条真正的路由认领**。
    认领了就把请求**交回那条路由**（`Route.handle` 对方法不符发出 Starlette 自己的
    HTTPException(405) + `Allow` 头），状态码、体、头与 PRE-T10 **逐字节相同**（实测见报告）；
    没认领才给 404（体与路由器 404 同形）。

    ⚠️ 这里刻意**不**把 405 一概改成 404，也**不**把 404 一概改成 405：判据是
    「路径是否已注册」，不是方法。`Mount` 不参与认领（它不限方法；`/mcp` 由
    `_BareMcpSlashRedirect` 在此之前处理）。
    """

    def __init__(self, application, **kwargs):
        super().__init__(**kwargs)
        self._application = application

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and scope["method"] not in ("GET", "HEAD"):
            owner = self._owning_route(scope)
            if owner is not None:
                # 路径存在、只是方法不符：交回那条路由，由 Starlette 出它本该出的 405
                # （含 Allow 头）。此处**不会**触达任何处理函数体：既然请求能走到静态兜底，
                # 就说明前面**没有**任何路由 FULL 命中过它。
                await owner.handle(scope, receive, send)
                return
            response = JSONResponse({"detail": "Not Found"}, status_code=404)
            await response(scope, receive, send)
            return
        await super().__call__(scope, receive, send)

    def _owning_route(self, scope):
        """第一条**路径**能匹配的 HTTP 路由（**不看方法**）；没人认领则 `None`。

        只认 `Route`（含 FastAPI 的 `APIRoute`）：`Mount` 不限方法、不属于「方法不符」的
        情形；`WebSocketRoute` 也不在此列。
        """
        route_path = get_route_path(scope)
        for route in self._application.router.routes:
            regex = getattr(route, "path_regex", None)
            if isinstance(route, Route) and regex is not None and regex.match(route_path):
                return route
        return None

    async def get_response(self, path: str, scope):
        """在**静态产物**这一层盖缓存策略（T40）—— 全站中间件会覆盖 `/capabilities`
        的 `no-store`，故只在挂载体这一层做，见上面 `_static_cache_control` 的说明。

        返回的可能是 200（`FileResponse`）也可能是 304（`NotModifiedResponse`，
        `StaticFiles.file_response` 在 `If-None-Match`/`If-Modified-Since` 命中时直接
        换成它，`starlette/staticfiles.py:185-186`）。**两者都要盖**：304 上的策略同样是
        浏览器下一次决策的依据，漏掉它等于「重新验证一次之后就再也没有策略了」。

        非 GET/HEAD 在本类 `__call__` 里就分流走了，未知路径由 `StaticFiles` 抛
        `HTTPException(404)`（此处的赋值根本执行不到），故 API 路由与 404/405 的形状不变。
        """
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = _static_cache_control(path)
        return response


def mount_frontend(application, dist_dir: Path | None = None) -> bool:
    """把前端静态产物挂到 `/`，返回**是否真的挂上了**。

    仅当 `<dist>/index.html` 存在时才挂（R-29）：前端产物不存在是**正常态**
    —— 不该因此让服务起不来，也不该挂一个空壳让路径变成非 404 的假象。

    `html=False` 且**不设 SPA 回退**（R-3 已否决）：未知路径必须 404，
    好让误配的接口路径暴露成明确失败，而不是伪装成一个页面。

    调用点必须在**全部** API 路由与 `/mcp` 挂载之后（本模块最末）：见上面 R-4 的说明。

    ⚠️ 只可在应用**启动前**调用：内部要 `add_middleware`，而 Starlette 在中间件栈已经
    构建（处理过第一个请求）之后再 `add_middleware` 会直接 `RuntimeError`。
    当前调用点（模块 import 时）与测试都在启动前，安全；换调用点时请把这一条一并带上。
    """
    dist = Path(dist_dir) if dist_dir is not None else _FRONTEND_DIST

    # 存在性判断**必须先于** StaticFiles 构造：后者对不存在的目录会直接抛 RuntimeError。
    if not (dist / "index.html").exists():
        return False

    # 裸 `/mcp` 的 307 必须在 mount("/") **之前**接上（R-32 / R-35）：见中间件自己的说明。
    # ⚠️ 不要加「按 path 查重」的守卫：`Mount("/mcp")` 的 `path` **也是** `"/mcp"`，
    # 守卫会误判「已存在」而跳过登记，裸 `/mcp` 仍然 404。
    application.add_middleware(_BareMcpSlashRedirect)

    # 挂载体是 `_StaticFrontend`（StaticFiles 的一层薄包装）：除 `html=True` 外，
    # 还负责把非 GET/HEAD 的请求按「路径是否已注册」分流成 404 / 405（R-47）——
    # 见那个类自己的说明。
    #
    # `html=True` 是**根路径返回界面文档**所必需的，依据：
    # spec 004 R1 场景「打开界面」（`spec.md:102-105`）、**SC-25**（`spec.md:292`）、
    # 以及 `plan.md:382`（`curl -s http://…:8000/` **返回 `index.html`**）。
    # 它**不引入 SPA 回退**（plan R-3 / §4.1 ④）：`plan.md:238` 否决的是
    # 「`html=True` **+ 全部未命中回退到 `index.html`**」那种写法，而 starlette 1.6.0
    # 的 `html` 只开两个分支（`staticfiles.py:134-152`）——
    # ① `:134-145` **目录 URL**：取 `<dir>/index.html`。`/` 的 route_path 以 `/` 结尾，
    #    故直接 200 出产物、**无 307**；产物里唯一的目录 `assets/` 没有 `index.html`，
    #    其状态码与 `html=False` 时**相同**。
    # ② `:147-151` 未命中时找 `<dist>/404.html`：`frontend/dist` **没有**该文件，
    #    故落回 `:152` 的 `raise HTTPException(404)`——未知路径仍是原来那个
    #    22 字节 `{"detail":"Not Found"}`，**逐字节相同**。
    # 非 GET/HEAD 在 `_StaticFrontend.__call__` 里就提前分流了、不经 StaticFiles，
    # 故 `html` **不改变**任何非 GET/HEAD 行为（R-47 的 404/405 分流原样）。
    application.mount("/",
                      _StaticFrontend(application, directory=str(dist), html=True),
                      name="frontend")
    return True


mount_frontend(app)
