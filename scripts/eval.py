r"""检索质量评测：同一评测集上对比新内核与旧系统实现。

用法（控制台是 GBK，含中文的输出必须置 `PYTHONIOENCODING=utf-8`）：

    $env:PYTHONIOENCODING="utf-8"
    .\.venv\Scripts\python.exe scripts\eval.py --impl new    --lib ai4s --out output\eval-new-ai4s.json
    .\.venv\Scripts\python.exe scripts\eval.py --impl legacy --lib mito --out output\eval-legacy-mito.json

**三个口径必须分清**（控制器 Ruling 1/2，写进输出 JSON 的 `scopes`）：

| 键 | 口径 | 用途 |
|---|---|---|
| `metrics` | **排除** `note=followup` 的条目 | SC-1 的取值口径 |
| `metrics_all_items` | 全集（追问按其先行词消解后检索） | 参考 |
| `metrics_followups` | 仅 `note=followup` 条目，**按先行词消解**后检索 | SC-6 的取值口径 |
| `metrics_followups_standalone` | 同一追问子集，**不消解**（单轮） | 诊断对照（仅 `--impl new`） |

为什么 SC-1 必须排除追问：评测集里的追问是**故意写成非自足**的（指代型，见 T19 与
spec SC-6）——它离开先行词就无法解析，拿它去算单轮检索指标会系统性压低 SC-1 的数值，
测的也不是 SC-1 想说的那件事。

为什么追问要带先行词跑：`note=followup` 的条目**不是**普通检索题。生产路径
（`server/http_server.py` 的 `/ask/stream`）先 `llm.rewrite_query(history)` 把多轮压成一条
自足查询再检索；故这里复用**同一条路径**与**同一份配置**（`config_*.json` 的 `rewrite` 块），
而不是自己拼一个线上不存在的「先行词 + 追问」土办法。消解结果逐条记在
`resolved_queries` 里（含 `changed` / `degraded`），便于核对 SC-6 的数值是否建立在
真的消解之上。若改写降级，该条退回原句即为单轮 —— 这种条目会以 `degraded: true` 显式暴露。

只读：新旧两套实现都不得写 vault（宪法 §2.1）。`main()` 在排序前后各取一次 vault 快照，
有任何新增/删除/mtime 变化就以非零码拒绝出数 —— 宁可不出数，也不出一份来源可疑的数。
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import math
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from scripts import build_eval_set  # noqa: E402

FOLLOWUP = build_eval_set.FOLLOWUP

# vault 快照的排除项。理由与 `tests/test_no_vault_write.py` 同：`.obsidian` 由 Obsidian
# 自身随时重写（如 workspace.json），`.trash` 是它的回收站 —— 二者都不是我们的写入。
# 排除项按 **vault 相对路径的组成部分**匹配，绝不用绝对路径片段（否则若 vault 恰好坐落于
# 某个叫 `.obsidian` 的祖先目录下，整个 vault 会被排除干净、闸门恒真而静默失效）。
_VAULT_EXCLUDE = {".obsidian", ".trash"}

# 旧实现的模块名按库固定（brief 指定的两个文件），路径仍从 __file__ 推导，不写绝对路径。
_LEGACY_FILES = {"ai4s": ("AI4S", "ai4s_rag_server.py"),
                 "mito": ("Mitochondria", "mito_rag_server.py")}

# 消解缓存的落盘名与格式版本（版本号让它能安全演进：读到不认识的版本仍可当空缓存重建）。
RESOLUTIONS_NAME = "followup_resolutions.json"
RESOLUTIONS_VERSION = 1


def compute_metrics(ranked_ids: list[list[str]], relevant: list[set[str]],
                    ks: list[int]) -> dict:
    """Recall@k / MRR / NDCG@k 的宏平均。**纯函数**：不需要模型，也不需要索引。

    - Recall@k = |前 k 条 ∩ 相关集| / |相关集|，按条目平均；
    - MRR = 第一条相关命中的名次倒数，按条目平均；
    - NDCG@k 用二元增益（命中记 1），理想序取 min(|相关集|, k) 条。

    `n` 是**参与平均的条目数**（= len(ranked_ids)）；相关集为空的条目贡献 0，
    不影响分母 —— 这样它不会把别的条目「补」上去。
    """
    recalls = {k: 0.0 for k in ks}
    rr_total = 0.0
    ndcg = {k: 0.0 for k in ks}

    for ranked, rel in zip(ranked_ids, relevant):
        if not rel:
            continue
        for k in ks:
            hit = len(set(ranked[:k]) & rel)
            recalls[k] += hit / len(rel)

        rank = next((i + 1 for i, d in enumerate(ranked) if d in rel), None)
        rr_total += (1.0 / rank) if rank else 0.0

        for k in ks:
            dcg = sum(
                (1.0 if d in rel else 0.0) / math.log2(i + 2)
                for i, d in enumerate(ranked[:k])
            )
            ideal = sum(1.0 / math.log2(i + 2) for i in range(min(len(rel), k)))
            ndcg[k] += (dcg / ideal) if ideal else 0.0

    n = max(len(ranked_ids), 1)
    out = {f"recall@{k}": round(recalls[k] / n, 4) for k in ks}
    out["mrr"] = round(rr_total / n, 4)
    for k in ks:
        out[f"ndcg@{k}"] = round(ndcg[k] / n, 4)
    out["n"] = len(ranked_ids)
    return out


def eval_set_path(lib: str) -> Path:
    return ROOT / "tests" / "eval_set" / f"{lib}.json"


def summarize(impl: str, lib: str, topn: int, items: list[dict],
              ranked: list[list[str]], ks: list[int], **extra) -> dict:
    """把一次排序结果汇总成三口径指标 + 口径标注。**纯函数**（不检索、不落盘）。

    见模块文档字符串的表格：`metrics` 是 SC-1 口径（排除追问），`metrics_followups`
    是 SC-6 口径（仅追问）。两库**各出一份**，绝不合并成一个数。
    """
    fu = [n for n, i in enumerate(items) if i.get("note") == FOLLOWUP]
    other = [n for n, i in enumerate(items) if i.get("note") != FOLLOWUP]

    def scoped(idx: list[int]) -> dict:
        return compute_metrics([ranked[n] for n in idx],
                               [set(items[n]["relevant"]) for n in idx], ks)

    scopes = {
        "metrics": "SC-1：排除 note=followup 条目（指代型追问依赖多轮上下文，"
                   "会系统性压低单轮检索指标）",
        "metrics_all_items": "全集：含追问条目（追问按其先行词消解后检索）",
        "metrics_followups": "SC-6：仅 note=followup 条目，按先行词消解后检索",
    }
    if impl == "legacy":
        # 旧实现**没有**改写前置：`rank_legacy` 按单轮原句检索（见其文档字符串）。
        # 同一个 scope 名下不得装两次不同的测量（复审 I3）—— 两份产物若都写「按先行词
        # 消解后检索」，而 C-20 的表格又把它们并排印在同一行，读者无从分辨哪一栏真消解过。
        scopes["metrics_all_items"] = ("全集：含追问条目（旧实现无先行词消解这一步，"
                                       "追问按**单轮原句**检索）")
        scopes["metrics_followups"] = ("仅 note=followup 条目，**单轮原句**检索"
                                       "（旧实现没有先行词消解这一步；这不是 SC-6 的口径，"
                                       "只是与 SC-6 同键以便并排对照）")
    if "metrics_followups_standalone" in extra:
        scopes["metrics_followups_standalone"] = (
            "诊断对照：同一追问子集，不做消解（单轮检索）——用于量化「先行词那一轮」值多少分")

    out = {
        "impl": impl,
        "lib": lib,
        "topn": topn,
        "ks": list(ks),
        "counts": {"all": len(items), "followups": len(fu), "non_followups": len(other)},
        "metrics": scoped(other),
        "metrics_scope": "excluding_followups",
        "metrics_all_items": scoped(list(range(len(items)))),
        "metrics_followups": scoped(fu),
        "scopes": scopes,
    }
    out.update(extra)
    return out


# --------------------------------------------------------------- 追问（多轮）协议

def prior_of(items: list[dict]) -> dict[str, str]:
    """`{追问 id: 先行词条目自己的问句}` —— 追问要当成「接在谁后面」的那一轮。

    先行词不成立时**响亮失败**（SystemExit）：那意味着该追问只能按单轮检索，
    而单轮测的是别的东西 —— 静默退回去会把一个错误测量的数值写进 SC-6。
    前置条件是 `build_eval_set.check_antecedents(items)` 已通过（`main` 里先跑它）。
    """
    by_id = {i["id"]: i for i in items}
    prior: dict[str, str] = {}
    for item in items:
        if item.get("note") != FOLLOWUP:
            continue
        ant = item.get("antecedent")
        if ant not in by_id:
            raise SystemExit(
                f"评测集先行词不成立：{item['id']} -> {ant!r}（不在本集内）。"
                f"SC-6 无法按先行词协议测量，拒绝按单轮出数。")
        prior[item["id"]] = by_id[ant]["query"]
    return prior


def resolve_followup(item: dict, prior_query: str, *, history_rounds: int = 3,
                     max_chars: int = 6000, timeout_s: float = 8.0
                     ) -> tuple[str, bool]:
    """把「先行词条目的问句」当作上一轮，用**生产同一条路径**消解本条的指代。

    返回 `(检索用查询, 是否降级)`。降级时 `llm.rewrite_query` 会退回原句，
    故该条实际退化为单轮 —— 调用方必须把 `degraded` 记录下来，否则 SC-6 的数值会被
    当成「消解过了」来读。

    助手回合用一句话占位：评测集里不存历史答案文本（宪法：「历史问答记录不得作为检索证据」），
    而改写器只依据 user 文本与角色序列工作，故这里不伪造一个看起来像答案的字符串。
    """
    from rag_core import llm  # 延迟导入：纯度量与离线测试不该拉进 LLM 依赖
    messages = [
        {"role": "user", "content": prior_query},
        {"role": "assistant", "content": "（上一轮回答略）"},
        {"role": "user", "content": item["query"]},
    ]
    result = llm.rewrite_query(messages, history_rounds=history_rounds,
                               max_chars=max_chars, timeout_s=timeout_s)
    return result.query, bool(result.degraded)


def followup_resolver(lib: str):
    """返回绑定该库 `rewrite` 配置的消解函数（与 `/ask/stream` 取同一份配置）。

    不在这里写死 3/6000/8：改了 `config_*.json` 的 `rewrite` 块就该改评测行为，
    否则评测测的是一套线上不存在的参数。
    """
    from rag_core import rag_engine
    cfg = rag_engine.get_engine(lib).cfg.get("rewrite") or {}
    settings = {
        "history_rounds": int(cfg.get("history_rounds", 3)),
        "max_chars": int(cfg.get("max_chars", 6000)),
        "timeout_s": float(cfg.get("timeout_s", 8.0)),
    }
    return lambda item, prior_query: resolve_followup(item, prior_query, **settings)


# --------------------------------------------------------------- 消解缓存

def resolutions_cache_path() -> Path:
    """消解缓存的**仓库内**位置（相对 `ROOT` 推导，代码里不出现绝对路径）。

    与评测集同目录，因为它就是评测集的一部分输入：换个路径就等于换了一份评测依据。
    """
    return ROOT / "tests" / "eval_set" / RESOLUTIONS_NAME


class ResolutionCache:
    """追问消解的确定性缓存：`{lib: {item_id: {prior, query, changed, degraded}}}`。

    **为什么必须有它**：SC-6 口径（`metrics_followups`）此前跑一次一个样 —— 消解走
    `llm.rewrite_query`，而改写预算 `timeout_s = 8` 恰卡在实测耗时（4.9–11.0s）分布
    中部，同一条追问会随机落在「消解成功」与「降级退回原句」两侧。一个每次给出不同
    数字的评测**不能用来定闸门**。把「用过的消解结果」冻结进受版本管理的 JSON 后，
    重跑不再调用 LLM，数字可复现（从 git 就能复现，不依赖网络或模型的当时状态）。

    两条纪律：
    - **不得洗白降级**：缓存冻结的是「用了哪一次消解」，`degraded: true` 存进去、
      读回来**仍是 true**，产物照旧如实标注。缓存绝不把一次坏消解变成好消解。
    - **先行词对不上就不采信**：`prior` 变了说明上下文换了，旧消解不该再被当成这一轮的
      结果用（否则会把另一个问题的答案安在当前追问上）—— 此时视为未命中，重新消解。
    - **落盘只动自己那一栏**：`--refresh-resolutions` 一次只刷一个库，另一库的条目必须
      逐字留存（否则下一轮它找不到缓存、六条追问现场消解，SC-6 又开始随改写可用率抖动，
      缓存存在的意义被一次刷新抹掉）。见 `save`。
    """

    def __init__(self, path: str | Path | None = None, *, refresh: bool = False):
        self.path = Path(path) if path is not None else resolutions_cache_path()
        # refresh=True 时**既不读也不采信**已有条目（save 只覆写本库那一栏，别的库不动）。
        self.refresh = refresh
        self.data: dict[str, dict] = {} if refresh else self._load()
        # 本次写过哪些库。落盘时**只有**这些栏会被替换，其余（另一个 lib、或另一个进程
        # 刚写下的）逐字保留 —— 见 `save`。
        self._written: set[str] = set()
        self._stats = {"cached": 0, "live": 0, "degraded": 0}

    def _read(self, path: Path) -> dict[str, dict]:
        """读一个缓存文件的分栏；不存在 / 坏掉都当**空缓存**（并留下警告）。"""
        if not path.is_file():
            return {}          # 首次运行没有缓存文件：空缓存，不是错误
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            # 缓存是**可重建的派生物**，不是唯一事实源：坏掉就响亮地说出来并当作空缓存，
            # 让本轮现场消解、重新写一份，而不是让整个评测跑不起来。
            print(f"警告：消解缓存无法读取（{path}）：{exc}；"
                  f"本轮按无缓存处理并重写该文件", file=sys.stderr)
            return {}
        libs = payload.get("libraries")
        return libs if isinstance(libs, dict) else {}

    def _load(self) -> dict[str, dict]:
        return self._read(self.path)

    def get(self, lib: str, item_id: str, prior: str | None = None) -> dict | None:
        """命中返回条目副本；`prior` 给定时还要求先行词一致（见类文档）。"""
        if self.refresh:
            return None
        entry = (self.data.get(lib) or {}).get(item_id)
        if not isinstance(entry, dict):
            return None
        if prior is not None and entry.get("prior") != prior:
            return None
        return dict(entry)

    def set(self, lib: str, item_id: str, entry: dict) -> None:
        self.data.setdefault(lib, {})[item_id] = dict(entry)
        self._written.add(lib)

    def note(self, origin: str, entry: dict) -> None:
        self._stats[origin] += 1
        if entry.get("degraded"):
            self._stats["degraded"] += 1

    def stats(self) -> dict:
        cached, live = self._stats["cached"], self._stats["live"]
        total = cached + live
        modality = "cached" if live == 0 and total else ("live" if cached == 0 and total
                                                          else "mixed")
        return {"modality": modality, "cached": cached, "live": live,
                "degraded": self._stats["degraded"], "total": total}

    def to_payload(self, libraries: dict[str, dict] | None = None) -> dict:
        """产物形态 `{version, libraries}`；`libraries` 省略时用本实例持有的那一份。"""
        return {"version": RESOLUTIONS_VERSION,
                "libraries": self.data if libraries is None else libraries}

    def save(self, path: str | Path | None = None) -> None:
        """落盘：与评测集/产物**同一条编码契约**（UTF-8 / 无 BOM / LF / 非 ASCII 原样）。

        **只替换本次写过的库那一栏**，其余库逐字保留（复审 I2）：两库各跑各的进程，
        `--refresh-resolutions` 一次只刷一个库 —— 若把 `self.data` 整个写下去，刷新 mito
        就会把 ai4s 整栏抹掉（反之亦然），下一轮 ai4s 找不到缓存、六条追问现场消解，
        而改写预算 `timeout_s=8` 正卡在实测 4.9–11.0s 分布中部：SC-6 又开始随改写可用率
        抖动 —— 缓存存在的全部意义（可复现）被一次刷新抹掉。
        """
        target = Path(path) if path is not None else self.path
        libs = self._read(target)      # 盘上已有的分栏（可能是**别的进程**写下的）
        for lib in self._written:
            if lib in self.data:
                libs[lib] = self.data[lib]   # 本库整栏替换；其余库原样不动
        write_json(target, self.to_payload(libs))


def resolve_followups(items: list[dict], prior: dict[str, str], *,
                      resolve=resolve_followup,
                      cache: "ResolutionCache | None" = None,
                      lib: str | None = None) -> tuple[list[str], dict]:
    """逐条给出「检索该用哪条查询」，并留下消解记录。

    返回 `(查询列表, 记录)`；记录只含**有先行词**的条目，字段见 Ruling 2 的报告要求：
    `prior`（喂进去的先行词问句）、`query`（消解后的查询）、`changed`、`degraded`。

    传入 `cache` 时先查缓存：命中即**不再调用 `resolve`**（这是本评测可复现的关键 ——
    改写预算卡在实测耗时分布中部，同一条追问会在成功/降级之间翻转）；未命中才现场
    消解，并把结果写回缓存。**缓存不得洗白降级**：存进去的 `degraded` 原样带出。

    `lib` 只在带 `cache` 时必需（缓存按库分栏，两库绝不混用）。
    """
    if cache is not None and lib is None:
        raise ValueError("带 cache 调用 resolve_followups 时必须给出 lib（缓存按库分栏）")
    queries: list[str] = []
    record: dict[str, dict] = {}
    for item in items:
        ant = prior.get(item["id"])
        if ant is None:
            queries.append(item["query"])
            continue
        hit = cache.get(lib, item["id"], ant) if cache is not None else None
        origin = "cached"
        if hit is None:
            query, degraded = resolve(item, ant)
            entry = {"prior": ant, "query": query,
                     "changed": query != item["query"], "degraded": bool(degraded)}
            origin = "live"
            if cache is not None:
                cache.set(lib, item["id"], entry)
        else:
            entry = hit
            query = entry["query"]
        if cache is not None:
            cache.note(origin, entry)
        queries.append(query)
        record[item["id"]] = entry
    return queries, record


# --------------------------------------------------------------- 新内核

def rank_queries(lib: str, queries: list[str], topn: int, *, rerank: bool = True
                 ) -> list[list[str]]:
    """跑新内核：每条查询返回命中的 `ref` 列表（与评测集 `relevant` 同形）。

    `rerank` **显式**向下传（而不是靠 `search` 的默认值）：产物要能自述它测的是哪一种，
    否则「开了精排」与「没开精排」两份 JSON 会长得一模一样。
    """
    from rag_core import rag_engine
    engine = rag_engine.get_engine(lib)
    return [[h["ref"] for h in engine.search(q, topn=topn, rerank=rerank)]
            for q in queries]


def rank_new(lib: str, items: list[dict], topn: int, prior: dict[str, str] | None = None,
             *, resolve=None, rerank: bool = True) -> list[list[str]]:
    """新内核排序。`prior` 非空时，其中的条目先按先行词消解再检索。

    三参调用（`prior=None`）等价于全部按单轮检索 —— 这是 brief 指定的接口形态，
    评测本体（`main`）总是把先行词传进来。
    """
    prior = prior or {}
    if resolve is None:
        resolve = followup_resolver(lib) if prior else resolve_followup
    queries, _ = resolve_followups(items, prior, resolve=resolve)
    return rank_queries(lib, queries, topn, rerank=rerank)


# --------------------------------------------------------------- 旧系统基线

def legacy_module_path(lib: str) -> Path:
    """旧实现的模块文件路径。旧代码与旧索引都保留在盘上（brief Step 5），可复跑。"""
    workspace, filename = _LEGACY_FILES[lib]
    return ROOT.parent / workspace / "rag_mcp" / filename


def load_legacy_search(path: str | Path):
    """按文件路径导入旧实现，返回 `(module, search_fn)`。

    **失败一律抛出，绝不吞掉**（控制器 Ruling 3）：一个 NaN/半截的基线比没有基线更糟。
    - 导入期异常（缺依赖、ABI 不匹配、模块自身报错）原样向上抛，保留原始信息；
    - 模块存在但没有可调用的检索函数 ⇒ `SystemExit`，并把文件路径写进消息。
    """
    path = Path(path)
    spec = importlib.util.spec_from_file_location(f"legacy_{path.stem}", path)
    if spec is None or spec.loader is None:
        raise SystemExit(f"无法为旧实现建立模块 spec：{path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    fn = getattr(mod, "search", None) or getattr(mod, "rag_search", None)
    if fn is None:
        raise SystemExit(f"旧实现未暴露可调用的检索函数：{path}")
    return mod, fn


def rank_legacy(lib: str, items: list[dict], topn: int, *, search_fn=None
                ) -> list[list[str]]:
    """旧系统基线（按单轮检索）。

    旧实现**没有多轮消解机制**：它的 MCP 工具只接受一条 query，没有 `/ask/stream`
    那样的 `rewrite_query` 前置。故它的追问条目只能按单轮跑 —— 这不是我们偷懒，
    而是被测量的对象本身如此；两种实现跑的不是同一套协议，比对时须记住。
    `search_fn` 由 `main` 复用已导入的模块传入，避免重复导入（旧模块导入期会拉
    fastembed/numpy）。
    """
    if search_fn is None:
        _, search_fn = load_legacy_search(legacy_module_path(lib))
    ranked: list[list[str]] = []
    for item in items:
        hits = search_fn(item["query"], topn=topn)
        ranked.append([(h.get("ref") or h.get("path") or "") for h in hits])
    return ranked


def legacy_gt_coverage(mod, items: list[dict]) -> dict:
    """旧索引里**根本没有**的 ground-truth 文档（只读打开旧库，不写、不改）。

    为什么必须报这个数：旧索引是某个时间点的快照，若评测集的目标笔记晚于它，
    旧实现无论多好都召不回来 —— 那份基线会被结构性地压住。T21 要拿它定 T1，
    故这里把「基线为何低」与「基线本身弱」区分开，并留下可核对的清单。
    """
    db = getattr(mod, "DB", None)
    refs = sorted({r for i in items for r in i["relevant"]})
    if db is None or not Path(db).exists():
        return {"index_db": str(db), "available": False, "gt_refs": len(refs),
                "missing": refs, "missing_count": len(refs)}
    # `mode=ro`：确认性地只读打开（不建 -wal/-shm、不改 journal mode）。
    con = sqlite3.connect(Path(db).as_uri() + "?mode=ro", uri=True)
    try:
        have = {r for (r,) in con.execute(
            "SELECT DISTINCT ref FROM chunks WHERE source LIKE 'vault:%'")}
    finally:
        con.close()
    missing = [r for r in refs if r not in have]
    return {"index_db": str(db), "available": True, "gt_refs": len(refs),
            "missing": missing, "missing_count": len(missing)}


# --------------------------------------------------------------- 只读闸门

def vault_snapshot(root: str | Path) -> dict[str, int]:
    """vault 内所有文件的 `{相对路径: mtime_ns}`（排除项见 `_VAULT_EXCLUDE`）。"""
    root = Path(root)
    out: dict[str, int] = {}
    for p in root.rglob("*"):
        if not p.is_file():
            continue
        rel = p.relative_to(root)
        if _VAULT_EXCLUDE & set(rel.parts):
            continue
        out[rel.as_posix()] = p.stat().st_mtime_ns
    return out


def assert_vault_unchanged(root: str | Path, before: dict[str, int]) -> None:
    """快照有变即拒绝出数（SystemExit）。宁可不给数，也不给一份来路可疑的数。"""
    after = vault_snapshot(root)
    added = sorted(set(after) - set(before))
    removed = sorted(set(before) - set(after))
    changed = sorted(k for k in before.keys() & after.keys() if before[k] != after[k])
    if added or removed or changed:
        raise SystemExit(
            f"评测过程改动了 vault（只读约束被破坏）：新增={added[:5]} "
            f"删除={removed[:5]} 改动={changed[:5]}")


def assert_library_index_nonempty(lib: str) -> dict:
    """排序前确认该库索引**真的有内容**；空索引 ⇒ 响亮拒绝出数（`SystemExit`）。

    为什么必须挡（复审 I4）：`RAGEngine._ensure_schema()` 会**建库**，所以把 `index_db`
    指错（或指到一个刚被建出来的空库）不会报任何错 —— 排序照跑，出来的是一份
    「全 0 指标 + `vault_unchanged: true` + 退出码 0」的产物，而 T1 正是从这些产物推导的
    （C-20）。全 0 看起来像一次成功的测量，这是最坏的一种失败：没有一道闸门会响。

    向量侧与 FTS 侧**都要非空**：只有一边非空时 `search()` 的混合路径会静默退化成单路
    检索（纯 BM25 / 纯语义），指标照样出得来，测的却不是同一件事。

    返回计数（供调用方/测试核对）；它只读，不建表、不写入。
    """
    from rag_core import rag_engine
    engine = rag_engine.get_engine(lib)
    db = Path(engine.index_db)
    con = engine._connect()          # 用引擎自己的连接工厂：WAL / busy_timeout 与检索一致
    try:
        chunks = con.execute("SELECT count(*) FROM chunks").fetchone()[0]
        vecs = con.execute("SELECT count(*) FROM vecs").fetchone()[0]
    finally:
        con.close()
    if chunks <= 0 or vecs <= 0:
        raise SystemExit(
            f"库 {lib} 的索引是空的（{db}：chunks={chunks}, vecs={vecs}）—— 拒绝出数。\n"
            f"空索引下排序只会产出一份「全 0 指标 + vault_unchanged: true」的产物，"
            f"它看起来像一次成功的测量，而 T1 正是从这些产物推导的（spec §8 C-20）。\n"
            f"请确认当前生效那份配置的 `index_db` 指向正确的索引，"
            f"并先完成索引同步与向量构建。")
    return {"lib": lib, "db": str(db), "chunks": chunks, "vecs": vecs}


def write_json(path: str | Path, payload: dict) -> None:
    """写 JSON 产物：UTF-8、无 BOM、**LF**（同 T19 的评测集）。

    `newline="\\n"` 不能省：Windows 上文本模式默认把 `\\n` 翻成 `\\r\\n`。
    """
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
                 encoding="utf-8", newline="\n")


# --------------------------------------------------------------- CLI

def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description="检索质量评测（新内核 vs 旧系统基线）")
    ap.add_argument("--impl", required=True, choices=["new", "legacy"])
    ap.add_argument("--lib", required=True, choices=["ai4s", "mito"],
                    help="两库各出一份，绝不合并")
    ap.add_argument("--topn", type=int, default=10)
    ap.add_argument("--no-rerank", dest="rerank", action="store_false",
                    help="诊断用：关掉新内核的精排层（默认与生产一致，开启）。"
                         "旧系统没有精排层，故对比两者时需要能把这一层单独拿掉再测一次。")
    ap.add_argument("--refresh-resolutions", action="store_true",
                    help="有意重新消解追问并覆写消解缓存（默认复用缓存，保证重跑可复现）。"
                         "只在确实要更新消解结果时使用 —— 平时不要开，否则 SC-6 又会随"
                         "改写可用率抖动。")
    ap.add_argument("--resolutions", default=None,
                    help="覆盖消解缓存路径（仅供测试指向临时文件；默认 "
                         "tests/eval_set/followup_resolutions.json）")
    ap.add_argument("--out", default=None)
    return ap.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)

    items = build_eval_set.load(eval_set_path(args.lib))
    build_eval_set.validate(items)
    # 先行词不成立时 check_antecedents 会给出全部问题；此时 SC-6 无测量依据，不出数。
    problems = build_eval_set.check_antecedents(items)
    if problems:
        raise SystemExit("评测集先行词不成立，SC-6 无法按先行词协议测量：\n"
                         + "\n".join(problems))

    ks = [1, 5, 10]
    fu = [n for n, i in enumerate(items) if i.get("note") == FOLLOWUP]
    vault, allowed = build_eval_set.vault_of(args.lib)

    # 落盘闸门：ground-truth ref 陈旧（如 vault 改名）时**拒绝出数**。
    # 与 `build_eval_set.main()` 的 `--lib` 路径跑同一道检查。不是洁癖：两侧实现
    # 都按 ref 判命中，一个不存在的 ref **永不命中**，于是这种损伤不分实现地同时
    # 压低双方的 recall —— 出来的是一份看着正常、实则被静默削过的数，而不是一次
    # 能看出问题的失败。宁可不出数，也不出一份静默偏低的数（同只读闸门的理由）。
    stale = build_eval_set.check_refs(items, vault, allowed)
    if stale:
        raise SystemExit("评测集 ground-truth ref 不成立（该 ref 永不命中，"
                         "会静默压低两种实现的 recall），拒绝出数：\n"
                         + "\n".join(stale))

    before = vault_snapshot(vault)
    extra: dict = {}
    rcache = None

    if args.impl == "new":
        # 排序之前先确认索引**不是空的**：空索引不会报错，只会安静地产出一份全 0 的
        # 「成功」产物（见 `assert_library_index_nonempty`）。
        assert_library_index_nonempty(args.lib)
        prior = prior_of(items)
        # 消解缓存（见 `ResolutionCache`）：默认复用，`--refresh-resolutions` 才有意重算。
        # 只用于 `--impl new`：旧实现没有消解这一步。
        rcache = ResolutionCache(args.resolutions, refresh=args.refresh_resolutions)
        queries, record = resolve_followups(items, prior,
                                            resolve=followup_resolver(args.lib),
                                            cache=rcache, lib=args.lib)
        # 缓存**不在这里落盘**：先让只读闸门过（见下面的 `assert_vault_unchanged`）。
        ranked = rank_queries(args.lib, queries, args.topn, rerank=args.rerank)
        extra["rerank"] = bool(args.rerank)
        extra["resolved_queries"] = record
        # 产出自述：这份数用的是缓存还是现场消解（否则「开了精排/没开」之外又多一个
        # 说不清的维度）。degraded 计数照旧如实带出 —— 缓存不洗白降级。
        extra["resolutions"] = rcache.stats()["modality"]
        extra["resolution_counts"] = rcache.stats()
        # 诊断对照：同一追问子集不消解（单轮）。量化「先行词那一轮」值多少分，
        # 也让新内核能与「旧实现只能单轮」这件事在同一条基准上对齐。
        standalone = rank_queries(args.lib, [items[n]["query"] for n in fu],
                                  args.topn, rerank=args.rerank)
        extra["metrics_followups_standalone"] = compute_metrics(
            standalone, [set(items[n]["relevant"]) for n in fu], ks)
    else:
        mod, fn = load_legacy_search(legacy_module_path(args.lib))
        ranked = rank_legacy(args.lib, items, args.topn, search_fn=fn)
        # 旧系统没有精排层，也没有多轮消解；如实记 None，而不是记一个假的分层。
        extra["rerank"] = None
        extra["legacy_index"] = legacy_gt_coverage(mod, items)

    assert_vault_unchanged(vault, before)
    extra["vault_unchanged"] = True

    # 只读闸门**过了**才落盘消解缓存：一次因改动 vault 而被拒的运行，不该把它的消解结果
    # 留在受版本管理的缓存里（产物被拒了，产物背后的输入却留了下来）。
    if rcache is not None:
        rcache.save()

    result = summarize(args.impl, args.lib, args.topn, items, ranked, ks, **extra)
    # 先落盘再打印：控制台若是 GBK，含中文的 print 会抛 UnicodeEncodeError，
    # 而那时数据已经安全写进 --out 了（本机默认控制台正是 GBK）。
    if args.out:
        write_json(args.out, result)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
