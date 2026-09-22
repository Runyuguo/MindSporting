"""RAG 检索内核（跨平台参数化，唯一实现）。

纯函数部分（chunk_text / make_fts_query / aggregate_by_document / rrf_merge /
apply_threshold / clip_char_budget）不依赖重依赖，可直接单测；
semantic / faiss / rerank 等重依赖按需懒加载，未安装时优雅降级。
"""
from __future__ import annotations

import json
import logging
import os
import re
import sqlite3
import threading
import time
from pathlib import Path

from rag_core import config as _config
from rag_core import sources as _sources

# 懒加载失败必须留下诊断：引擎已是进程级单例，一次临时失败（OOM / 缓存缺失）
# 会被哨兵 `False` 记住整个进程，若再静默，服务端只会表现为「语义检索恒为空」。
logger = logging.getLogger(__name__)

_SENT_SPLIT = re.compile(r"(?<=[。！？!?.;；])\s*")


def chunk_text(text: str, max_chars: int = 500, overlap: int = 0) -> list[str]:
    """结构感知切分：按空行/标题分块，块内按句聚合，单句超限才硬切。

    - 每块长度 ≤ max_chars（避免超过 embedding 上限被截断）。
    - 标题行（# 开头）自成一块边界，保留结构。
    - overlap 保留接口兼容（当前实现为 0，句级不重叠）。
    """
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    blocks: list[str] = []
    cur = ""
    for raw in text.split("\n"):
        s = raw.rstrip()
        if not s.strip():
            if cur:
                blocks.append(cur)
                cur = ""
            continue
        if s.lstrip().startswith("#"):
            if cur:
                blocks.append(cur)
                cur = ""
            blocks.append(s)
            continue
        cur = (cur + " " + s).strip() if cur else s
    if cur:
        blocks.append(cur)

    chunks: list[str] = []
    for b in blocks:
        if not b.strip():
            continue
        if len(b) <= max_chars:
            chunks.append(b)
            continue
        sents = [x for x in _SENT_SPLIT.split(b) if x.strip()]
        piece = ""
        for st in sents:
            st = st.strip()
            if not st:
                continue
            if len(st) > max_chars:
                if piece:
                    chunks.append(piece)
                    piece = ""
                for i in range(0, len(st), max_chars):
                    chunks.append(st[i:i + max_chars])
                continue
            if piece and len(piece) + len(st) + 1 > max_chars:
                chunks.append(piece)
                piece = st
            else:
                piece = (piece + " " + st).strip() if piece else st
        if piece:
            chunks.append(piece)
    return [c for c in chunks if c.strip()]


_TERM_CHARS = r"A-Za-z0-9_.\u002f\u002d\u0370-\u03ff\u2070-\u209f\u00b2\u00b3\u00b9"
_TOKEN_RE = re.compile(rf"[{_TERM_CHARS}]+|[一-鿿]+")
_CJK_RE = re.compile(r"[一-鿿]+")


def make_fts_query(query: str) -> str:
    """FTS5 查询重写：保留希腊字母/上下标/斜杠/连字符，CJK 长词补三元组。"""
    if not query:
        return ""
    tokens = _TOKEN_RE.findall(query)
    expanded: list[str] = []
    for t in tokens:
        expanded.append(t)
        if _CJK_RE.fullmatch(t) and len(t) > 4:
            expanded += [t[i:i + 3] for i in range(0, len(t) - 2, 2)]
    return " OR ".join(f'"{t}"' for t in dict.fromkeys(expanded))


def _doc_key(h: dict) -> tuple:
    return (str(h.get("source", "")).split(":")[0], h.get("ref", ""))


def aggregate_by_document(ranked: list[dict]) -> list[dict]:
    """文献级聚合：同一 (source, ref) 只保留最高分块，消除块级垄断。"""
    best: dict[tuple, dict] = {}
    for h in ranked:
        k = _doc_key(h)
        score = float(h.get("score", h.get("rrf", 0.0)))
        if k not in best or score > best[k]["_score"]:
            item = dict(h)
            item["_score"] = score
            best[k] = item
    return sorted(best.values(), key=lambda x: -x["_score"])


def rrf_merge(*ranked_lists: list[dict], k: int = 60) -> list[dict]:
    """Reciprocal Rank Fusion：按文献聚合后的多路名次互惠融合。"""
    scores: dict[tuple, float] = {}
    info: dict[tuple, dict] = {}
    for lst in ranked_lists:
        for rank, h in enumerate(lst):
            key = _doc_key(h)
            scores[key] = scores.get(key, 0.0) + 1 / (k + rank + 1)
            info.setdefault(key, dict(h))
    ordered = sorted(scores.items(), key=lambda kv: -kv[1])
    out: list[dict] = []
    for key, score in ordered:
        h = dict(info[key])
        h["rrf"] = round(score, 4)
        out.append(h)
    return out


def apply_threshold(hits: list[dict], min_score: float | None,
                    score_key: str = "score") -> list[dict]:
    """评分阈值过滤：低于 min_score 的命中剔除；min_score 为空则原样返回。"""
    if min_score is None:
        return list(hits)
    return [h for h in hits if float(h.get(score_key, 0.0)) >= min_score]


def clip_char_budget(text: str, budget: int) -> str:
    """按**字符**预算裁剪，优先在空格边界截断。

    注意：这是字符预算而非 token 预算——中文 1 字符≈1 token、英文≈1/4 token。
    它只是上下文安全上限，不是硬配额；诚实命名优于虚假精度。
    """
    if budget <= 0:
        return ""
    if len(text) <= budget:
        return text
    cut = text[:budget]
    last_space = cut.rfind(" ")
    if last_space > budget // 2:
        return cut[:last_space]
    return cut


_DEFAULTS: dict = {
    "chunk": {"max_chars": 500, "overlap": 0},
    # ANN 五键：查询期三键（T16）+ 建图期两键（T58）。
    # - `ann_ef_search`：**查询期**图遍历广度。默认 efSearch=16 时
    #   「mitochondrial DNA replication」recall@10 = 0.00，提到 1024 才达标（T16）。
    # - `ann_over_fetch` / `ann_over_fetch_filtered`：过采样，只解决「过滤后仍够数」。
    # - `ann_hnsw_m` / `ann_hnsw_ef_construction`：**建图期**参数。查询期只能在既有图上
    #   多走几步——**图里没有的边走不出来**：mito 实测 efSearch 从 1024 加到 4096 仍停在
    #   0.90（T58），瓶颈在建图。故这两个值显式入配置，不留给 faiss 默认（`M` 由调用点传入，
    #   `efConstruction` 的默认只有 40，对万级向量的库偏低）。
    "search": {"topn": 8, "rrf_k": 60, "min_bm25": None, "min_cos": None, "evidence_char_budget": 4000,
               "ann_over_fetch": 3, "ann_over_fetch_filtered": 8, "ann_ef_search": 1024,
               "ann_hnsw_m": 64, "ann_hnsw_ef_construction": 200},
    "embed": {"model": "BAAI/bge-m3", "dim": 1024, "batch": 32},
    # `rerank.model` 默认**空**（T17）：省略该键时精排必须**快速、可见地**降级，而不是
    # 拿一个 HuggingFace 仓库 id 去联网找 —— 实测那种取值会让首个查询挂 **349s / 10 次重试**，
    # 期间用户侧零信号（见 task-17-report.md §7.1），与宪法 §3.3「可见地降级」正相反。
    # 两个 shipped config 都显式指向本地模型目录（library/models/bge-reranker-v2-m3），
    # 故这个默认值不再有兜底对象：它只承担「没配就别联网」这一件事。
    "rerank": {"model": "", "topk": 50, "final_topn": 8},
    # 库外三类来源默认 false（失败即关闭）：`load_config` 对 sources 是逐子键合并的，
    # 若这里留 True，任何省略该键 / 只写部分子键的配置都会静默恢复读库外数据。
    "sources": {"metadata": False, "extracted": False, "weekly_watch": False, "vault": True},
    "folder_kind": {"00-MOC": "moc", "01-Literature": "note", "02-Surveys": "survey", "03-Reading": "reading", "OCR": "ocr"},
}


# `generate` 各子块**一旦声明就必须完整**的键（整支审查 I4）。
#
# 为什么需要：`params.is_supported` 只能回答"这一块在不在"，而真正取数的地方
# （`divergence_to_sampling` 的 `spec["temperature_min"]`）是**直接下标**。
# 于是半截的 `divergence` 块会让界面标着「已生效」、请求却必然 KeyError ——
# 告知与事实不符，正是 spec「参数不被支持时的如实性」要禁的。
#
# 为什么必须在这里校验：`load_config` 对嵌套块是**逐子键合并**（下面的 `merged.update(v)`），
# 只合并到 `divergence` 这一层、**不深入其子键** ⇒ 用户写了个半截块时，
# 缺的键不会被默认值补上。故"合并后再查"才是唯一能拦住它的位置。
#
# 语义（与 spec「已落地 / 未落地」一致）：
# - 子块**缺失** ⇒ 合法，表示该项未落地，`is_supported` 如实报 False；
# - 子块**存在** ⇒ 必须含全部必需键，否则拒绝启动（响亮失败，与
#   `sources.source_prefixes` 对不完整映射的做法一致），而不是跑到某一轮提问才炸。
_REQUIRED_GENERATE_KEYS: dict[str, tuple[str, ...]] = {
    "divergence": ("temperature_min", "temperature_max", "top_p_min", "top_p_max"),
    "length": ("tolerance", "max_retry", "chars_per_token"),
    # 只要求 `enabled`：思考**转发上限已按使用者要求取消**（2026-09-19），
    # 故 `max_chars` 不再是必需键（也不再被任何代码读取）。
    "thinking": ("enabled",),
}


def _validate_generate(cfg: dict) -> None:
    """校验 `generate` 的已声明子块是否完整；不完整则抛 `ValueError`。

    错误信息同时给出**块名**与**缺失的键**，便于直接照着改配置。
    """
    g = cfg.get("generate")
    if not isinstance(g, dict):
        return  # 整个块未落地 ⇒ 合法
    for block, required in _REQUIRED_GENERATE_KEYS.items():
        sub = g.get(block)
        if sub is None:
            continue  # 该项未落地 ⇒ 合法（is_supported 会如实报 False）
        if not isinstance(sub, dict):
            raise ValueError(
                f"config.generate.{block} 必须是对象，实为 {type(sub).__name__}")
        missing = [k for k in required if k not in sub]
        if missing:
            raise ValueError(
                f"config.generate.{block} 声明了但缺少必需键 {missing}；"
                f"该块要么写全（{list(required)}），要么整个删掉表示该项未落地")


def load_config(config) -> dict:
    """读取配置：接受文件路径或 dict；env_var 可覆盖 vault_path；嵌套键并入默认。

    读入后校验 `generate` 的已声明子块是否**完整**（缺键即报错，见
    `_validate_generate`）——错配置在启动时就暴露，不带病运行。
    """
    if isinstance(config, (str, Path)):
        cfg = json.loads(Path(config).read_text(encoding="utf-8"))
    else:
        cfg = dict(config)
    env_var = cfg.get("env_var")
    if env_var and os.environ.get(env_var):
        cfg["vault_path"] = os.environ[env_var]
    out: dict = dict(_DEFAULTS)
    for k, v in cfg.items():
        if k in _DEFAULTS and isinstance(v, dict):
            merged = dict(_DEFAULTS[k])
            merged.update(v)
            out[k] = merged
        else:
            out[k] = v
    _validate_generate(out)
    return out


class RAGEngine:
    """绑定单库（lib）的检索内核：DB/索引/faiss 完全隔离。"""

    def __init__(self, config):
        self.cfg = load_config(config)
        self.lib = self.cfg.get("lib", "unknown")
        self.index_db = Path(self.cfg["index_db"])
        self.index_db.parent.mkdir(parents=True, exist_ok=True)
        self._emb = None
        self._rr = None
        self._faiss = None
        self._faiss_rows: list[int] = []
        self._init_lock = threading.Lock()   # 保护懒加载（_emb / _rr / _faiss）
        self._infer_lock = threading.Lock()  # 串行化 GPU 推理
        self._ensure_schema()

    # ---------------- 存储 ----------------
    def _connect(self) -> sqlite3.Connection:
        con = sqlite3.connect(str(self.index_db), timeout=30)
        con.execute("PRAGMA busy_timeout=30000")
        con.execute("PRAGMA journal_mode=WAL")
        return con

    def _ensure_schema(self) -> None:
        con = self._connect()
        con.execute("CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5("
                    "source, ref, title, category, extra, text, tokenize='trigram')")
        con.execute("CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, mtime REAL)")
        con.execute("CREATE TABLE IF NOT EXISTS vecs (rowid INTEGER PRIMARY KEY, vec BLOB)")
        con.commit()
        con.close()

    def index_docs(self, docs) -> None:
        con = self._connect()
        con.executemany(
            "INSERT INTO chunks (source, ref, title, category, extra, text) VALUES (?,?,?,?,?,?)",
            [(s, r, t, c, e, x) for (s, r, t, c, e, x) in docs])
        con.commit()
        con.close()

    @staticmethod
    def _extra_key(path: str) -> str:
        return f"file://{path}"

    @staticmethod
    def _extra_for(path: str, extra: str) -> str:
        return f"{extra} || file://{path}"

    # ---------------- 索引源 ----------------
    def iter_sources(self):
        cfg = self.cfg
        libdir = Path(cfg["workspace"])
        LIB = libdir / "library"
        chunk = lambda t: chunk_text(t, cfg["chunk"]["max_chars"], cfg["chunk"].get("overlap", 0))
        srcs = cfg["sources"]

        if srcs.get("metadata"):
            meta_dir = LIB / "metadata"
            if meta_dir.exists():
                for f in sorted(meta_dir.glob("*.json")):
                    if "test" in f.stem.lower():
                        continue
                    try:
                        papers = json.loads(f.read_text(encoding="utf-8"))
                        if isinstance(papers, dict):
                            papers = papers.get("papers") or papers.get("items") or papers.get("results") or []
                        if not isinstance(papers, list):
                            continue
                    except Exception:
                        continue
                    docs = []
                    for p in papers:
                        if not isinstance(p, dict):
                            continue
                        docs.append((
                            "metadata", str(p.get("pmid", "")), str(p.get("title", "")),
                            str(p.get("category", "")),
                            f"{p.get('journal', '')} | {p.get('pubdate', '')} | DOI:{p.get('doi', '')}",
                            f"{p.get('title', '')}\n{p.get('abstract', '')}",
                        ))
                    yield str(f), f.stat().st_mtime, docs

        if srcs.get("extracted"):
            ext_dir = LIB / "extracted"
            if ext_dir.exists():
                for f in sorted(ext_dir.glob("*.txt")):
                    try:
                        text = f.read_text(encoding="utf-8", errors="ignore")
                    except Exception:
                        continue
                    docs = [("pdf", f.name, f"{f.stem}（第{i + 1}块）", "",
                             f"library/extracted/{f.name}", c)
                            for i, c in enumerate(chunk(text))]
                    yield str(f), f.stat().st_mtime, docs

        if srcs.get("weekly_watch"):
            ww = LIB / "weekly_watch"
            if ww.exists():
                for f in sorted(ww.rglob("*.json")):
                    if f.parent == ww:
                        continue
                    try:
                        papers = json.loads(f.read_text(encoding="utf-8"))
                        if isinstance(papers, dict):
                            papers = papers.get("papers") or papers.get("items") or papers.get("results") or []
                        if not isinstance(papers, list):
                            continue
                    except Exception:
                        continue
                    docs = []
                    cat = f.parent.name
                    for p in papers:
                        if not isinstance(p, dict):
                            continue
                        docs.append((
                            "weekly", str(p.get("pmid", "")), str(p.get("title", "")), cat,
                            f"{p.get('journal', '')} | {p.get('pubdate', '')} | DOI:{p.get('doi', '')}",
                            f"{p.get('title', '')}\n{p.get('abstract', '')}",
                        ))
                    yield str(f), f.stat().st_mtime, docs

        if srcs.get("vault"):
            vault = cfg.get("vault_path") or ""
            vp = Path(vault)
            if vault and vp.exists():
                fk = cfg["folder_kind"]
                allowed = tuple(cfg.get("allowed_prefixes") or _sources.ALLOWED_PREFIXES)
                for f in sorted(vp.rglob("*.md")):
                    parts = set(f.relative_to(vp).parts)
                    if any(p.startswith(".") for p in parts):
                        continue
                    rel = str(f.relative_to(vp)).replace("\\", "/")
                    # A 案：白名单是**准入条件**（拒绝式）。folder_kind 只用来标 kind，
                    # 不再承担准入职责——否则「未列名目录默认放行」会悄悄回来。
                    # 判定必须在读文件之前：被排除是**决定**，不是读取失败后的吞掉。
                    # 04-Answer&Plan 的铁律由此自然覆盖（它不在白名单里）。
                    if not _sources.is_allowed_ref(rel, allowed):
                        continue
                    try:
                        text = f.read_text(encoding="utf-8", errors="ignore")
                    except Exception:
                        continue
                    folder = rel.split("/")[0] if "/" in rel else ""
                    kind = fk.get(folder, "note")
                    docs = [("vault:" + kind, rel, f.stem, "", f"obsidian://{rel}", c)
                            for c in chunk(text)]
                    yield str(f), f.stat().st_mtime, docs

    def sync_index(self) -> dict:
        t0 = time.time()
        con = self._connect()
        seen: set[str] = set()
        added = updated = 0
        for path, mtime, docs in self.iter_sources():
            seen.add(path)
            row = con.execute("SELECT mtime FROM files WHERE path=?", (path,)).fetchone()
            if row and abs(row[0] - mtime) < 1e-6:
                continue
            con.execute("DELETE FROM chunks WHERE extra LIKE ?", (f"%file://{path}",))
            con.execute("DELETE FROM vecs WHERE rowid NOT IN (SELECT rowid FROM chunks)")
            con.executemany(
                "INSERT INTO chunks (source, ref, title, category, extra, text) VALUES (?,?,?,?,?,?)",
                [(s, r, t, c, self._extra_for(path, e), x) for (s, r, t, c, e, x) in docs])
            con.execute("REPLACE INTO files (path, mtime) VALUES (?,?)", (path, mtime))
            if row:
                updated += 1
            else:
                added += 1
        removed = 0
        for (p,) in con.execute("SELECT path FROM files").fetchall():
            if p not in seen:
                con.execute("DELETE FROM chunks WHERE extra LIKE ?", (f"%file://{p}",))
                con.execute("DELETE FROM files WHERE path=?", (p,))
                removed += 1
        con.execute("DELETE FROM vecs WHERE rowid NOT IN (SELECT rowid FROM chunks)")
        con.commit()
        total = con.execute("SELECT count(*) FROM chunks").fetchone()[0]
        nfiles = con.execute("SELECT count(*) FROM files").fetchone()[0]
        nvecs = con.execute("SELECT count(*) FROM vecs").fetchone()[0]
        con.close()
        return {"lib": self.lib, "added": added, "updated": updated, "removed": removed,
                "chunks": total, "files": nfiles, "vecs": nvecs,
                "seconds": round(time.time() - t0, 1)}

    # ---------------- 检索 ----------------
    def bm25_search(self, query: str, topn: int | None = None,
                    source_prefix: str | None = None) -> list[dict]:
        topn = topn or self.cfg["search"]["topn"] * 3
        if not self.index_db.exists():
            return []
        con = self._connect()
        where = "chunks MATCH ?"
        params: list = [make_fts_query(query)]
        if source_prefix:
            where += " AND source LIKE ?"
            params.append(source_prefix + "%")
        sql = (f"SELECT rowid, source, ref, title, category, extra, "
               f"snippet(chunks, 5, '', '', '…', 60) AS snip, "
               f"bm25(chunks, 0.0, 0.5, 1.5, 0.3, 0.2, 1.5) AS score "
               f"FROM chunks WHERE {where} ORDER BY score LIMIT ?")
        params.append(topn)
        try:
            rows = con.execute(sql, params).fetchall()
        except sqlite3.OperationalError:
            rows = []
        con.close()
        return [{"rowid": r[0], "source": r[1], "ref": r[2], "title": r[3],
                 "category": r[4], "extra": r[5], "snippet": (r[6] or "").strip(),
                 "score": round(r[7], 2)} for r in rows]

    def _embedder(self):
        if self._emb is None:
            with self._init_lock:
                if self._emb is None:  # 双重检查：等锁期间可能已被别的线程加载好
                    try:
                        from sentence_transformers import SentenceTransformer
                        import torch
                        self._emb = SentenceTransformer(
                            self.cfg["embed"]["model"],
                            device="cuda" if torch.cuda.is_available() else "cpu")
                    except Exception:
                        logger.warning(
                            "嵌入模型加载失败（lib=%s, model=%s）："
                            "本进程内语义检索将降级为空结果且不再重试",
                            self.lib, self.cfg.get("embed", {}).get("model"),
                            exc_info=True)
                        self._emb = False
        return self._emb or None

    def encode_texts(self, texts: list[str]):
        """带推理锁的编码入口：并发请求共享同一模型，但推理串行化。"""
        emb = self._embedder()
        if not emb:
            return None
        with self._infer_lock:
            return emb.encode(texts, normalize_embeddings=True)

    def _faiss_index(self):
        if self._faiss is None:
            with self._init_lock:
                if self._faiss is None:
                    try:
                        import faiss
                        p = Path(self.cfg.get("faiss_index", ""))
                        rows_p = p.with_suffix(p.suffix + ".rows.json")
                        if p.exists() and rows_p.exists():
                            index = faiss.read_index(str(p))
                            rows = json.loads(rows_p.read_text(encoding="utf-8"))
                            # 索引与 rows.json 是**两个文件**，写入侧（`build_vectors`）先写
                            # 索引、后写 rows，故中途中断 / 手工替换其一都会留下长度不一致的
                            # 一对。两个方向都必须当**加载失败**（复审 M3）：
                            #   - rows 短：`self._faiss_rows[int(i)]` 抛 IndexError 冒出
                            #     `search()` —— 回退契约承诺的是降级，不是把降级变成 500；
                            #   - rows 长：位置映射整体错位，ANN 名次被安到**别的 rowid**
                            #     上 —— 静默给出错误证据（T16 已把这条路径接成生产读路径、
                            #     T56 又让引用标记可跳转，错的证据会一路错到读者眼前）。
                            # 判失败即走既有回退契约：`self._faiss = False` ⇒ 精确路径接手。
                            if index.ntotal != len(rows):
                                logger.warning(
                                    "faiss 索引与其 rows.json 长度不一致（lib=%s, index=%s, "
                                    "index.ntotal=%d, rows=%d）：本进程内退回全量向量扫描且"
                                    "不再重试；请重新构建向量索引",
                                    self.lib, self.cfg.get("faiss_index"),
                                    int(index.ntotal), len(rows))
                                self._faiss = False
                            else:
                                self._faiss = index
                                self._faiss_rows = rows
                        else:
                            self._faiss = False
                    except Exception:
                        logger.warning(
                            "faiss 索引加载失败（lib=%s, path=%s）："
                            "本进程内退回全量向量扫描且不再重试",
                            self.lib, self.cfg.get("faiss_index"),
                            exc_info=True)
                        self._faiss = False
        return self._faiss or None

    def semantic_search(self, query: str, topn: int | None = None,
                        source_prefix: str | None = None) -> list[dict]:
        """ANN 检索（宪法 §1.2：禁止全表暴力扫描）。

        索引不可用 / 编码器不可用时**回退到 `semantic_search_exact`**，
        而不是返回空列表：混合路径把「语义结果为空」当作信号（`search()` 会退化到
        只用 BM25），回退不成功就会静默降质。仅在**真的没有候选**时才返回空。
        索引文件存在但**为空**（`ntotal == 0`）时不属于回退分支：`k <= 0` 处直接
        返回 `[]`，不委派给精确路径（该行为是否应改成委派另案处理，此处只如实描述）。
        """
        topn = topn or self.cfg["search"]["topn"] * 3
        index = self._faiss_index()
        # 先判索引、再编码：回退分支自己会编码一次，若这里先编就会被丢弃 —— 白白多付
        # 一次 bge-m3 推理（且并发下那一次是在锁内、被丢弃的那一次也占锁）。
        if index is None:
            return self.semantic_search_exact(query, topn, source_prefix)
        qv = self.encode_texts([query])       # 走带推理锁的入口（T05 Ruling 14）
        if qv is None:
            return self.semantic_search_exact(query, topn, source_prefix)

        import numpy as np
        scfg = self.cfg["search"]
        # ① 查询期图遍历广度。实测默认 efSearch=16 时「mitochondrial DNA replication」
        #    recall@10 = 0.00，而把 k 从 30 加到全量 13806 毫无改善 —— 提高 efSearch 是
        #    达标的**必要条件**（见 .scratch/probe_t16_recall_sweep.log）。
        #    但 T58 实测它**不是充分条件**：mito 的 efSearch 从 1024 加到 4096 仍停在 0.90，
        #    上限由**建图期**参数（`build_vectors` 的 ann_hnsw_m / ann_hnsw_ef_construction）
        #    决定。故这个值只保留在「查询期能做的那一半」上，不要指望调它绕开图的质量。
        #    这是**查询期参数**，设在已加载的索引实例上，不重建、不写回索引文件。
        index.hnsw.efSearch = int(scfg.get("ann_ef_search", 1024))
        # ② 过采样：过滤后仍要够 topn 条，故带过滤时多取。
        factor = (scfg.get("ann_over_fetch_filtered", 8) if source_prefix
                  else scfg.get("ann_over_fetch", 3))
        k = min(int(index.ntotal), max(int(topn) * int(factor), int(topn)))
        if k <= 0:
            return []
        dists, idxs = index.search(np.asarray(qv, dtype=np.float32), k)

        rowids: list[int] = []
        score_by_row: dict[int, float] = {}
        for dist, i in zip(dists[0], idxs[0]):
            if i < 0:            # faiss 用 -1 填充「凑不满 k 条」的位置
                continue
            # 位置 → rowid 的映射由**加载期**保证同长（`_faiss_index` 里 ntotal != len(rows)
            # 即判加载失败），故这里不必再防越界；真正的越界只可能来自绕过加载器的调用方。
            rid = self._faiss_rows[int(i)]
            rowids.append(rid)
            # ③ 量纲对齐：索引是 metric_type=1（L2 距离），而精确路径给的是余弦；
            #    对 L2 归一化向量二者只差 cos = 1 − d/2。若不换算，`min_cos` 一旦配上
            #    正阈值，`apply_threshold(hits, min_cos, "score")` 会把语义检索**静默清空**。
            score_by_row[rid] = float(1.0 - float(dist) / 2.0)
        if not rowids:
            return []

        con = self._connect()
        marks = ",".join("?" * len(rowids))
        # 只按命中的 rowid 取行：不再把全表 1.38 万条向量连表搬出来（宪法 §1.2）。
        rows = con.execute(
            f"SELECT rowid, source, ref, title, category, extra, substr(text,1,200) "
            f"FROM chunks WHERE rowid IN ({marks})", rowids).fetchall()
        con.close()

        out = [{"rowid": r[0], "source": r[1], "ref": r[2], "title": r[3],
                "category": r[4], "extra": r[5], "snippet": (r[6] or "").strip(),
                "score": round(score_by_row.get(r[0], 0.0), 3)} for r in rows]
        if source_prefix:
            out = [h for h in out if h["source"].startswith(source_prefix)]
        out.sort(key=lambda h: -h["score"])
        return out[:topn]

    def semantic_search_exact(self, query: str, topn: int | None = None,
                              source_prefix: str | None = None) -> list[dict]:
        """全量向量精确检索（暴力扫描）。

        保留为**测试真值**与**回退路径**：ANN 是近似的，recall 需要它当分母；
        索引不可用时也靠它保证语义检索仍有结果。生产查询路径不走这里。

        查询向量同样经 `self.encode_texts` 取得（带 `_infer_lock`）：回退路径是
        生产可达的（任何 `faiss_index` 缺失/损坏的库），若在这里直接 `emb.encode`
        就绕过了推理锁，并发下会与 ANN 路径的推理并行。
        """
        topn = topn or self.cfg["search"]["topn"] * 3
        qv = self.encode_texts([query])
        if qv is None:
            return []
        import numpy as np
        con = self._connect()
        rows = con.execute(
            "SELECT c.rowid, c.source, c.ref, c.title, c.category, c.extra, "
            "substr(c.text, 1, 200), v.vec FROM chunks c JOIN vecs v ON c.rowid = v.rowid").fetchall()
        con.close()
        if not rows:
            return []
        if source_prefix:
            rows = [r for r in rows if r[1].startswith(source_prefix)]
            if not rows:
                # 过滤后没有行**是合法结果**：该来源在本库索引里可能一条都没有
                # （例：vault:reading 已注册但尚未索引到任何一篇）。必须在这里返回空，
                # 否则下面的 `np.stack([])` 抛 ValueError，被 HTTP 层兜底成 500 ——
                # 把一个空结果谎报成服务端故障（T49 验收 Defect 2 的一半）。
                # 与上面「表里一行都没有」同一语义：空就是空。
                return []
        qv = np.asarray(qv[0], dtype=np.float32)
        mat = np.stack([np.frombuffer(r[7], dtype=np.float32) for r in rows])
        sims = mat @ qv
        order = np.argsort(-sims)[:topn]
        return [{"rowid": rows[i][0], "source": rows[i][1], "ref": rows[i][2],
                 "title": rows[i][3], "category": rows[i][4], "extra": rows[i][5],
                 "snippet": (rows[i][6] or "").strip(), "score": round(float(sims[i]), 3)}
                for i in order]

    def build_vectors(self) -> dict:
        """bge-m3 嵌入 + L2 归一化存 vecs，并构建 Faiss HNSW 索引。

        只嵌入 `vecs` 里**还没有**的行（增量），随后用**全量** `vecs` 重建整张图 ——
        HNSW 没有「增量补边」的接口，改图参数就意味着整图重建。
        建图参数见 `search.ann_hnsw_m` / `search.ann_hnsw_ef_construction`。
        """
        emb = self._embedder()
        if not emb:
            return {"error": "sentence_transformers unavailable"}
        import numpy as np
        try:
            import faiss
        except Exception:
            faiss = None
        con = self._connect()
        rows = con.execute("SELECT rowid, text FROM chunks "
                           "WHERE rowid NOT IN (SELECT rowid FROM vecs)").fetchall()
        n = 0
        batch = self.cfg["embed"].get("batch", 32)
        for i in range(0, len(rows), batch):
            part = rows[i:i + batch]
            ids = [r[0] for r in part]
            texts = [r[1] for r in part]
            vecs = np.asarray(emb.encode(texts, normalize_embeddings=True), dtype=np.float32)
            for rid, vec in zip(ids, vecs):
                con.execute("INSERT OR REPLACE INTO vecs (rowid, vec) VALUES (?,?)",
                            (rid, vec.tobytes()))
            n += len(part)
            con.commit()
        con.close()
        if faiss is not None:
            con = self._connect()
            all_rows = con.execute("SELECT rowid, vec FROM vecs ORDER BY rowid").fetchall()
            con.close()
            dim = self.cfg["embed"].get("dim", 1024)
            # 建图期参数（T58）：`M` 是每节点的邻居上限、`efConstruction` 是建图时的候选
            # 队列深度，二者共同决定**图的质量**，且**建成即定局** —— 查询期的
            # `ann_ef_search` 只能在既有图上多走几步，图里没有的边走不出来。
            # 实测（本机 mito 10,020 行）：把 efSearch 从 1024 一路加到 4096，recall@10
            # 纹丝不动停在 0.90 ⇒ 瓶颈在建图而不在查询期（见 task-58-report.md §2）。
            # 故二者走 `search` 配置块（宪法 §2.6：可调项不写在代码里），默认值也**不**
            # 沿用 faiss 的默认：`efConstruction` 默认仅 40，对万级向量的库偏低。
            m = int((self.cfg.get("search") or {}).get("ann_hnsw_m", 64))
            ef_construction = int(
                (self.cfg.get("search") or {}).get("ann_hnsw_ef_construction", 200))
            index = faiss.IndexHNSWFlat(dim, m, faiss.METRIC_L2)
            # `efConstruction` 必须**在 add() 之前**设：建图读的是这一刻的值，add 之后再改
            # 对已长成的图没有任何作用。它**会**随索引写盘（faiss 的 write_HNSW 序列化
            # efConstruction 与 efSearch），故「读回落盘索引的 efConstruction」是复查一次
            # 重建是否真按配置建图的有效证据 —— 已构建的 mito/ai4s 索引读回来正是 40，
            # 即 faiss 默认值，独立佐证了它们建图期参数从未被代码设过。
            index.hnsw.efConstruction = ef_construction
            if all_rows:
                mat = np.stack([np.frombuffer(r[1], dtype=np.float32) for r in all_rows])
                index.add(mat)
                rows_map = [r[0] for r in all_rows]
            else:
                rows_map = []
            p = Path(self.cfg["faiss_index"])
            p.parent.mkdir(parents=True, exist_ok=True)
            faiss.write_index(index, str(p))
            p.with_suffix(p.suffix + ".rows.json").write_text(
                json.dumps(rows_map, ensure_ascii=False), encoding="utf-8")
        return {"embedded": n, "total_vecs": self._vec_count()}

    def _vec_count(self) -> int:
        con = self._connect()
        n = con.execute("SELECT count(*) FROM vecs").fetchone()[0]
        con.close()
        return n

    @staticmethod
    def _unusable_rerank_model(model: str) -> str | None:
        """返回「精排模型不可用」的原因；可用则返回 `None`。**只做本地判定，绝不联网。**

        为什么必须有这一关（T17）：`CrossEncoder` 对空串、或对磁盘上不存在的路径，
        会把它当成 HuggingFace 仓库 id 去 huggingface.co 找，等待时长由 hub 自己的
        重试策略决定（本机实测 **349s / 10 次重试**，WinError 10060），而这期间
        **用户侧零信号** —— 首个查询静默挂五分钟，比立刻降级糟糕得多。
        只读离线部署（宪法 §1.2）下这种取值根本没有成功可能，故直接判不可用。

        代价（有意为之）：`rerank.model` 自 T17 起**合同上就是一个本地模型路径**，
        仓库 id 一律快速降级（即便该仓库恰好在本地 HF 缓存里也不要）。原因：两个
        shipped config 都用本地目录，而「先查缓存再决定」会把查询路径重新绑回
        网络/缓存状态 —— 正是本条要根除的东西。
        """
        if not model:
            return "未配置 rerank.model（默认值为空）"
        if not Path(model).exists():
            return f"配置的路径在磁盘上不存在：{model}"
        return None

    def _reranker(self):
        if self._rr is None:
            with self._init_lock:
                if self._rr is None:
                    rcfg = self.cfg.get("rerank") or {}
                    model = str(rcfg.get("model") or "").strip()
                    reason = self._unusable_rerank_model(model)
                    if reason:
                        # 快速失败：**不尝试加载**（因此也不联网），但记录与真失败同样详细
                        # 的原因，并同样以哨兵 False 记住（本进程内不再重试）。
                        logger.warning(
                            "精排模型不可用（lib=%s, model=%r）：%s；"
                            "本进程内精排将降级且不再重试",
                            self.lib, model, reason)
                        self._rr = False
                    else:
                        try:
                            from sentence_transformers import CrossEncoder
                            import torch
                            self._rr = CrossEncoder(
                                model,
                                device="cuda" if torch.cuda.is_available() else "cpu")
                        except Exception:
                            logger.warning(
                                "精排模型加载失败（lib=%s, model=%s）："
                                "本进程内精排将降级且不再重试",
                                self.lib, model,
                                exc_info=True)
                            self._rr = False
        return self._rr or None

    def predict_pairs(self, pairs: list[tuple[str, str]]):
        """带推理锁的精排入口：并发请求共享同一交叉编码器，但推理串行化。"""
        reranker = self._reranker()
        if not reranker or not pairs:
            return None
        with self._infer_lock:
            return reranker.predict(pairs)

    def rerank(self, query: str, hits: list[dict], topn: int | None = None) -> list[dict]:
        """交叉编码器精排；模型不可用 / 推理失败时**降级返回原序**（不抛错、不返回空）。

        推理必须经 `self.predict_pairs`（T05 Ruling 14）：它是带 `_infer_lock` 的
        唯一入口。直接持有 CrossEncoder 会让精排与嵌入推理并行抢同一块 GPU ——
        这正是 T16 fix #1 在回退路径上修掉的同一类缺陷（见 `semantic_search_exact`）。

        `predict_pairs` 在「模型不可用」或「`pairs` 为空」时返回 `None`，故 None 与
        **推理抛错**必须走同一条降级路径，且都要**留下日志**（宪法 §3.3：不得静默吞掉；
        否则线上只表现为「排序莫名其妙」，与「精排没生效」无法区分）。
        """
        if not hits:
            # 先短路再取模型：没有候选时不该为一次精排去加载 2.2GB 权重。
            return hits
        topn = topn or self.cfg["rerank"].get("final_topn", 8)
        pairs = [(query, (h.get("title") or "") + " " + (h.get("snippet") or "")) for h in hits]
        try:
            scores = self.predict_pairs(pairs)
        except Exception:
            logger.warning(
                "精排推理失败（lib=%s, 候选=%d）：本轮保留融合序返回，不重试",
                self.lib, len(pairs), exc_info=True)
            return hits
        if scores is None:
            logger.warning(
                "精排不可用（lib=%s, model=%s）：本轮保留融合序返回 %d 条候选",
                self.lib, self.cfg.get("rerank", {}).get("model"), len(hits))
            return hits
        order = sorted(range(len(hits)), key=lambda i: -float(scores[i]))[:topn]
        return [hits[i] for i in order]

    @staticmethod
    def _strip(hits: list[dict]) -> list[dict]:
        for h in hits:
            h.pop("_score", None)
            if h.get("extra"):
                h["extra"] = (h["extra"] or "").split(" || ")[0]
        return hits

    def _within_whitelist(self, hits: list[dict]) -> list[dict]:
        """A 案检索期兜底：丢掉非白名单 vault 片段（旧索引残留）。

        索引期白名单（iter_sources）只保证「未来不进」；旧索引里已经躺着的
        非白名单片段仍会被 FTS/语义召回，故这里再挡一次（spec SC-17）。
        库外来源（metadata/pdf/weekly 的 ref 为 PMID 或文件名）不在白名单内，
        同样被挡——与「库外三类一并完全不读」一致。
        """
        allowed = tuple(self.cfg.get("allowed_prefixes") or _sources.ALLOWED_PREFIXES)
        out = []
        for h in hits:
            src = str(h.get("source", ""))
            if src.startswith("vault:"):
                if _sources.is_allowed_ref(str(h.get("ref", "")), allowed):
                    out.append(h)
            else:
                # 非 vault 来源一律不放行（库外三类已停读；留此分支防将来新增来源悄然混入）
                continue
        return out

    def search(self, query: str, mode: str = "hybrid", topn: int | None = None,
               source: str | None = None, rerank: bool = True) -> list[dict]:
        """BM25 / 语义 / 混合三种模式检索 + RRF 融合（默认再走精排）。

        精排**默认开启**（T17）：宪法 §1.2 把 `bge-reranker-v2-m3` 定为精排层，
        「省略精排层」是被禁止的替代方案；而在本任务之前 `rerank` 默认 `False`
        且没有任何生产调用点传 `True`，2.2GB 交叉编码器一次都没参与过真实问答。
        """
        cfg = self.cfg
        topn = topn or cfg["search"]["topn"]
        # 候选规模 = max(需求条数 × 3, rerank.topk)：`rerank.topk` 是**地板**，不是上界。
        # 注意这个算式给的是**块级**取数量：两路各要 fetch 条块，再经 aggregate_by_document
        # 去重成**文献池**才喂给精排，故精排实收的篇数**小于** fetch（实测 `线粒体自噬`：
        # fetch=50 ⇒ bm25 50 块→9 篇、语义 50 块→16 篇、RRF 并集 17 篇）。
        # `topn ≥ 17` 时 `topn×3 > topk`，`topk` 完全不参与（`topn=20` ⇒ fetch=60）——
        # 故它的角色是地板，不可写成「候选数 ≤ topk」。
        # 关掉精排时没有理由多取：仍按 topn×3（多取只会白付检索与聚合成本）。
        fetch = max(topn * 3, cfg["rerank"].get("topk", 50)) if rerank else topn * 3
        if mode == "bm25":
            hits = aggregate_by_document(self.bm25_search(query, fetch, source))
            hits = apply_threshold(hits, cfg["search"].get("min_bm25"), "score")
        elif mode == "semantic":
            s = self.semantic_search(query, fetch, source)
            hits = aggregate_by_document(s) if s else []
            hits = apply_threshold(hits, cfg["search"].get("min_cos"), "score")
        else:  # hybrid
            b = self.bm25_search(query, fetch, source)
            s = self.semantic_search(query, fetch, source)
            if not s:
                hits = apply_threshold(aggregate_by_document(b),
                                       cfg["search"].get("min_bm25"), "score")
            else:
                merged = rrf_merge(aggregate_by_document(b), aggregate_by_document(s),
                                   k=cfg["search"]["rrf_k"])
                hits = apply_threshold(merged, cfg["search"].get("min_bm25"), "rrf")
        if rerank:
            # 精排的输出上限**不得低于调用方要的条数**：`final_topn` 是配置里的默认产出量
            # （8），若直接拿它当精排的截断数，`topn=20` 会在精排这一步被砍回 8 ——
            # 调用方要 20 条、拿到 8 条且毫无提示（「证据数」滑杆会因此形同虚设）。
            # 故取二者的较大值：要多于默认就给足，要少于默认仍按默认精排后再切片。
            rerank_cap = max(topn, int(cfg["rerank"].get("final_topn", 8)))
            hits = self.rerank(query, hits, rerank_cap)
        return self._strip(self._within_whitelist(hits)[:topn])

    def ask(self, question: str, topn: int = 10, mode: str = "hybrid") -> dict:
        hits = self.search(question, mode=mode, topn=topn)
        budget = int(self.cfg["search"].get("evidence_char_budget", 4000))
        evidence = []
        used = 0
        for h in hits:
            snippet = clip_char_budget(h.get("snippet", ""), budget - used if budget else 0)
            evidence.append({**h, "snippet": snippet})
            used += len(snippet)
            if budget and used >= budget:
                break
        return {"lib": self.lib, "question": question, "hits": evidence}


def _engine_from_lib(lib: str) -> RAGEngine:
    """用**显式选定**的那份配置建引擎（T08：配置来源不再写死文件名）。

    `config.load_config` 负责「选哪一份 + 读成 dict」（`RAG_CONFIG_SUFFIX` 选的带后缀那份
    缺失时它抛 `FileNotFoundError` 且**不回落**）；这里**只取它给出的路径**，把路径原样
    交给 `RAGEngine(config)`——`RAGEngine.__init__` 自己的 `load_config` 仍要做 `env_var`
    覆盖 `vault_path`、`_DEFAULTS` 逐子键合并与 `_validate_generate`，这三件事
    **不搬进** `rag_core/config.py`（那是纯来源解析器）。
    传路径（而非传 dict）使「未设后缀时既有行为一字不变」是**结构性成立**：
    与改动前的 `RAGEngine(str(cfg_file))` 形状完全相同。代价是 JSON 被读两次，可忽略。
    """
    _cfg, cfg_path = _config.load_config(lib)
    return RAGEngine(str(cfg_path))


_ENGINES: dict[str, RAGEngine] = {}
_ENGINES_LOCK = threading.Lock()


def get_engine(lib: str) -> RAGEngine:
    """进程级引擎单例。并发首次请求只构建一次。非法 lib 抛 FileNotFoundError。"""
    engine = _ENGINES.get(lib)
    if engine is not None:
        return engine
    with _ENGINES_LOCK:
        engine = _ENGINES.get(lib)  # 双重检查：等锁期间可能已被别的线程建好
        if engine is None:
            engine = _engine_from_lib(lib)  # 失败时不写缓存，异常照常抛出
            _ENGINES[lib] = engine
    return engine


def reset_engines() -> None:
    """仅供测试：清空引擎缓存。"""
    with _ENGINES_LOCK:
        _ENGINES.clear()


def search(query: str, lib: str = "ai4s", mode: str = "hybrid",
           topn: int | None = None, source: str | None = None) -> list[dict]:
    return _engine_from_lib(lib).search(query, mode=mode, topn=topn, source=source)


def ask(question: str, lib: str = "ai4s", topn: int = 10) -> dict:
    return _engine_from_lib(lib).ask(question, topn=topn)

