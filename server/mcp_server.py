"""rag-stack 检索 MCP server（streamable-http，服务路径 /mcp）。

传输：streamable-http（宪法 §1.2 锁定，禁用 stdio）。本模块只**定义** MCP 应用与工具；
把它挂到 FastAPI 的 `/mcp` 由 `server/http_server.py` 完成（同进程、单端口）。

定位：只做「检索」，只出证据，不保留其他功能（无图谱 / 文献库 / 原文浏览 / 索引刷新）。

铁律：不含 LLM 生成（最终答案由调用方模型生成）；不写知识库（对外服务侧 vault 是只读副本）；
检索禁止命中历史问答记录（04-Answer&Plan 由 rag_engine 在索引阶段已排除）。
"""
from __future__ import annotations

import os
import sys

# 模型已本地缓存，强制离线加载（零网络，避免 HF hub 检查超时）
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from rag_core import rag_engine  # noqa: E402
from mcp.server.mcpserver import MCPServer  # noqa: E402

# 引擎缓存由 rag_core.rag_engine 统一持有（进程级单例，带并发保护）：
# 避免每次调用重建 RAGEngine 导致 bge-m3 / faiss / reranker 重复加载。

# 对外服务路径：恰好 /mcp（在 http_server.build_app() 里 mount）。
# 子应用自身路由取 "/"，父应用 mount 到 "/mcp"，拼接后才是 /mcp；
# 若用子应用默认的 "/mcp" 再 mount 到 "/mcp"，真实路径会变成 /mcp/mcp。
MCP_MOUNT_PATH = "/mcp"

# 双库白名单（宪法 §2.2：按 lib 路由、绝不混用、非法 lib 不回退默认库）
_VALID_LIBS = ("ai4s", "mito")

# 来源 emoji 标签（严格复刻旧版 fmt_hits）
_SRC_LABEL = {
    "metadata": "📋摘要库",
    "pdf": "📄PDF全文",
    "weekly": "🗓周报候选",
    "vault:survey": "📑综述",
    "vault:reading": "📖精读",
    "vault:note": "📓文献笔记",
    "vault:moc": "🗂索引",
    "vault:ocr": "🔬OCR原文",
}


def _engine(lib: str) -> rag_engine.RAGEngine:
    """校验 lib 后取引擎单例。非法/空 lib 显式报错，**不回退**任何默认库。

    宪法 §2.2：`lib` 非法值必须报错而非默认命中某库——回退意味着调用方写错库名
    也会拿到某个库的证据，那正是「跨库混用」的入口。
    """
    resolved = (lib or "").strip()
    if resolved not in _VALID_LIBS:
        raise ValueError(f"unknown lib: {lib!r}; expected one of {_VALID_LIBS}")
    return rag_engine.get_engine(resolved)


def _fmt_hits(hits: list[dict]) -> str:
    """证据命中格式化（严格复刻旧版 ai4s_rag_server.fmt_hits）。"""
    if not hits:
        return "（本地知识库无命中，可尝试换用英文术语或更短中文词组）"
    lines = []
    for i, h in enumerate(hits, 1):
        src = _SRC_LABEL.get(h.get("source", ""), h.get("source", ""))
        cite = h.get("extra") or h.get("ref") or ""
        lines.append(f"[{i}] {src} {h.get('title', '')}\n    引用: {cite}\n    片段: {h.get('snippet', '')}")
    return "\n\n".join(lines)


mcp = MCPServer(
    name="rag-stack",
    version="2.1.0",
    description="本地双库（AI4S / Mitochondria）检索服务：只做检索，返回证据，不写库。",
    instructions=(
        "这是只读「检索」服务，不含 LLM 生成，也不写知识库。"
        "用 search 拿证据，再用你自己的 LLM 生成最终答案。"
        "回答时：先给科学背景，再以证据为主作答并用 [编号] 标注，证据不足处说明，"
        "结尾列引用清单；禁止参考历史问答记录。"
        "lib 取值：ai4s（AI4S 库）| mito（Mitochondria 库）。"
    ),
)


@mcp.tool()
def search(
    lib: str,
    query: str,
    mode: str = "hybrid",
    topn: int = 8,
    source: str = "",
) -> str:
    """快速检索知识库，返回按相关度排序的证据命中列表（带出处引用）。

    参数：
    - lib: 知识库标识，必须是 "ai4s" 或 "mito"；非法值直接报错，不会回退到任何库。
    - query: 检索词，中英文均可（语义模式下自然语言整句效果更好）。
    - mode: "hybrid"(混合，默认) | "bm25"(关键词) | "semantic"(语义向量)。
    - topn: 返回条数，默认 8（上限 50）。
    - source: 可选限定来源，如 "vault"（全部笔记）、"vault:ocr"（OCR 原文）、
      "metadata"（摘要库）、"pdf"（PDF 全文）；空串=全部来源。

    返回：Markdown 文本（命中条数 + 逐条 [编号] 来源/引用/片段）。
    """
    topn = max(1, min(int(topn), 50))
    hits = _engine(lib).search(query, mode=mode, topn=topn, source=source or None)
    return (f"查询: {query}（模式: {mode}）\n"
            f"命中 {len(hits)} 条（按相关度排序）：\n\n{_fmt_hits(hits)}")


if __name__ == "__main__":
    # 独立进程调试用；生产由 http_server 以 streamable-http 同进程挂载 /mcp。
    mcp.run(transport="streamable-http")
