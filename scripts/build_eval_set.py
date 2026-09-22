"""评测集校验与统计。

**不生成**问答对——按 spec 澄清 C-1，问答对由人工编写并标注。
本脚本只负责：格式校验、ref 落盘校验、覆盖度统计、重复 query/id 检测。

**它也不检索。** ground truth 必须来自人对「哪些笔记回答了这个问题」的判定，
不得由任何检索实现（新内核或旧系统）产出——否则评测的是「与检索器一致」而不是「正确」，
并把该实现的缺陷固化成标准。本模块没有、也不得有任何检索调用。

两类失败的报告方式（有意不同，勿统一）：
- `validate()` **抛 ValueError**——schema 是二值的，但一次报全所有坏条目再挡（brief 指定的接口）；
- `check_refs()` / `check_antecedents()` **返回全部问题清单**——落盘问题与先行词问题常见于批量改动，
  一次看全才能一次改完。

退出码即闸门：`main()` 在任何一类问题存在时以非零码退出。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from collections.abc import Sequence
from pathlib import Path, PurePosixPath, PureWindowsPath

# 直跑 `python scripts/build_eval_set.py` 时 sys.path[0] 是 scripts/，仓库根不在其中。
# 与 scripts/rag_cli.py 同一处置（不硬编码绝对路径，从 __file__ 推导）。
_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))

from rag_core import config as _config  # noqa: E402
from rag_core import sources  # noqa: E402

REQUIRED = ("id", "query", "relevant")
FOLLOWUP = "followup"
DOC_SUFFIX = ".md"
_DRIVE = re.compile(r"^[A-Za-z]:")


def load(path: str | Path) -> list[dict]:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def validate(items: list[dict]) -> None:
    """schema 校验：非空数组、必需字段、非空 query/relevant、id 唯一。

    只查**形状**，不碰磁盘（落盘校验在 `check_refs`）。
    """
    if not isinstance(items, list) or not items:
        raise ValueError("评测集必须是非空数组")
    problems: list[str] = []
    seen_ids: dict[str, int] = {}
    for i, item in enumerate(items):
        if not isinstance(item, dict):
            problems.append(f"[{i}] 不是对象")
            continue
        missing = [f for f in REQUIRED if f not in item]
        if missing:
            problems.append(f"[{i}] 缺少字段 {', '.join(missing)}")
            continue  # 字段不全，后续取值无意义
        if not isinstance(item["id"], str) or not item["id"].strip():
            problems.append(f"[{i}] id 必须是非空字符串")
        elif item["id"] in seen_ids:
            problems.append(f"[{i}] id 重复：{item['id']}（首次出现于 [{seen_ids[item['id']]}]）")
        else:
            seen_ids[item["id"]] = i
        if not isinstance(item["query"], str) or not item["query"].strip():
            problems.append(f"[{i}] query 必须是非空字符串")
        rel = item["relevant"]
        if not isinstance(rel, list) or not rel:
            problems.append(f"[{i}] relevant 必须是非空数组")
        elif not all(isinstance(r, str) and r.strip() for r in rel):
            problems.append(f"[{i}] relevant 元素必须是非空字符串")
        if "note" in item and (not isinstance(item["note"], str) or not item["note"].strip()):
            problems.append(f"[{i}] note 若存在必须是非空字符串")
            continue
        note = item.get("note")
        if note == FOLLOWUP:
            # 指代型追问离开先行词就无法解析，故 antecedent 是**必需字段**而非可选注释。
            ant = item.get("antecedent")
            if not isinstance(ant, str) or not ant.strip():
                problems.append(
                    f"[{i}] note={FOLLOWUP} 必须带非空 antecedent（指代型追问需要机器可读的先行词）")
        elif "antecedent" in item:
            problems.append(
                f"[{i}] 只有 note={FOLLOWUP} 的条目才可带 antecedent（本条 note={note!r}）")
    if problems:
        raise ValueError("\n".join(problems))


def duplicate_queries(items: list[dict]) -> list[str]:
    counts = Counter(i["query"] for i in items)
    return sorted(q for q, n in counts.items() if n > 1)


def duplicate_ids(items: list[dict]) -> list[str]:
    counts = Counter(i["id"] for i in items)
    return sorted(i for i, n in counts.items() if n > 1)


def check_antecedents(items: list[dict]) -> list[str]:
    """逐条追问检查先行词：必须指向**本集内、位于其前、且本身不是追问**的条目。

    返回**全部**问题（空列表 = 通过），与 `check_refs` 同一报告风格。
    与 `validate` 的分工：validate 管「字段在不在、空不空」，这里管「指向成不成立」。
    """
    index = {i.get("id"): n for n, i in enumerate(items)}
    problems: list[str] = []
    for n, item in enumerate(items):
        if item.get("note") != FOLLOWUP:
            continue
        iid = item.get("id", "?")
        ant = item.get("antecedent")
        if not isinstance(ant, str) or not ant.strip():
            problems.append(f"[{iid}] 缺少 antecedent")
        elif ant == iid:
            problems.append(f"[{iid}] antecedent 指向自身")
        elif ant not in index:
            problems.append(f"[{iid}] antecedent={ant!r} 在本集内不存在")
        elif index[ant] >= n:
            problems.append(f"[{iid}] antecedent={ant!r} 位于追问之后（先行词必须先于追问）")
        elif items[index[ant]].get("note") == FOLLOWUP:
            problems.append(f"[{iid}] antecedent={ant!r} 本身也是追问（指代链，消解目标不唯一）")
    return problems


def stats(items: list[dict]) -> dict:
    refs = [r for i in items for r in i["relevant"]]
    return {
        "count": len(items),
        "unique_queries": len({i["query"] for i in items}),
        "relevant_total": len(refs),
        "relevant_avg": round(len(refs) / max(len(items), 1), 2),
        "followup": sum(1 for i in items if i.get("note") == FOLLOWUP),
        "by_source_dir": dict(sorted(Counter(
            r.split("/")[0] for r in refs if "/" in r).items())),
        "distinct_refs": len({r for r in refs}),
    }


def ref_problem(ref: object, vault: Path, allowed: tuple[str, ...]) -> str | None:
    """单个 ref 的问题描述；合法返回 None。

    判据与 `/doc` 端点同源：`sources.is_allowed_ref` 是线上白名单谓词，
    此处复用而非重写——重写一份规则就会与线上漂移。
    """
    if not isinstance(ref, str) or not ref.strip():
        return "ref 必须是非空字符串"
    if "\\" in ref:
        return "ref 必须是 POSIX 相对路径（索引里的 ref 用 / 分隔，反斜杠形态永不匹配）"
    if ref.startswith("/") or _DRIVE.match(ref) or PureWindowsPath(ref).is_absolute():
        return "ref 必须是 vault 相对路径，不得是绝对路径"
    if PurePosixPath(ref).suffix.lower() != DOC_SUFFIX:
        return f"ref 必须指向 {DOC_SUFFIX} 文件"
    if not sources.is_allowed_ref(ref, allowed):
        return f"ref 不在白名单目录内（或含穿越段）：allowed={list(allowed)}"
    root = vault.resolve()
    target = root / PurePosixPath(ref)
    if not target.is_file():
        return "ref 在 vault 内不存在（或不是文件）"
    if not target.resolve().is_relative_to(root):
        return "ref 解析后越出 vault"
    return None


def check_refs(items: list[dict], vault: str | Path,
               allowed_prefixes: Sequence[str]) -> list[str]:
    """逐条 ref 检查存在性/白名单/形态，返回**全部**问题（空列表 = 通过）。"""
    root = Path(vault)
    allowed = tuple(allowed_prefixes)
    problems: list[str] = []
    for item in items:
        iid = item.get("id", "?")
        for ref in item.get("relevant") or []:
            why = ref_problem(ref, root, allowed)
            if why:
                problems.append(f"[{iid}] {ref!r}: {why}")
    return problems


def vault_of(lib: str) -> tuple[Path, tuple[str, ...]]:
    """取 `lib` **生效**那份配置里的 vault 根与白名单目录（代码内不出现绝对路径）。

    走 `rag_core.config.load_config` 而不是自己拼配置文件名：
    部署机上生效的是 `RAG_CONFIG_SUFFIX` 选定的那份，写死文件名会让本脚本
    拿开发机的配置去校验部署机的评测集（"能用"与"对"是两件事）。
    """
    cfg, _path = _config.load_config(lib)
    return Path(cfg["vault_path"]), tuple(cfg.get("allowed_prefixes")
                                         or sources.ALLOWED_PREFIXES)


def report(lib: str, path: Path, items: list[dict], problems: list[str]) -> dict:
    return {
        "lib": lib,
        "path": str(path),
        "stats": stats(items),
        "duplicate_queries": duplicate_queries(items),
        "duplicate_ids": duplicate_ids(items),
        "problems": problems,
        "ok": not problems,
    }


def main(argv: list[str] | None = None) -> None:
    """校验并打印报告；任何一类问题存在即以非零码退出。

    `argv` 为**不含程序名**的参数列表（同 `parse_args` 语义）；None 时读 `sys.argv[1:]`。
    """
    ap = argparse.ArgumentParser(description="评测集校验与统计（不生成、不检索）")
    ap.add_argument("--lib", required=True, choices=["ai4s", "mito"])
    ap.add_argument("--path", default=None)
    ap.add_argument("--vault", default=None,
                    help="覆盖 vault 根（仅供测试指向临时目录；默认取该库 config）")
    args = ap.parse_args(argv)

    path = Path(args.path) if args.path else \
        _ROOT / "tests" / "eval_set" / f"{args.lib}.json"
    vault, allowed = vault_of(args.lib)
    if args.vault:
        vault = Path(args.vault)

    items = load(path)

    problems: list[str] = []
    try:
        validate(items)
    except ValueError as exc:
        problems.extend(str(exc).splitlines())
        # schema 不成立时，后续检查的结论不可信（可能 AttributeError），只报 schema。
        payload = {"lib": args.lib, "path": str(path), "stats": None,
                   "duplicate_queries": [], "duplicate_ids": [],
                   "problems": problems, "ok": False}
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        raise SystemExit(1)

    problems.extend(f"重复 query：{q}" for q in duplicate_queries(items))
    problems.extend(f"重复 id：{i}" for i in duplicate_ids(items))
    problems.extend(check_refs(items, vault, allowed))
    problems.extend(check_antecedents(items))

    print(json.dumps(report(args.lib, path, items, problems),
                     ensure_ascii=False, indent=2))
    if problems:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
