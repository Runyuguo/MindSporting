"""端到端延迟测量（spec §5 · SC-2 / SC-3 / SC-4）。

测量条件与 spec §5 脚注一致：**单客户端顺序请求**。
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 直跑 `python scripts/measure_latency.py` 时 sys.path[0] 是 scripts/，仓库根不在其中。
# 与 scripts/build_eval_set.py、scripts/rag_cli.py 同一处置（不硬编码绝对路径）。
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from rag_core import config as _config  # noqa: E402

# 三个延迟阈值的**唯一真值源是宪法**：`.specify/memory/constitution.md` 第 421 行
# （质量闸门清单末条）与 `specs/001-rag-qa-multiturn/spec.md` §5 的 SC-2 / SC-3 / SC-4。
# 本常量只是那三个数的**执行副本**，不得自成一档：
#
# - `first_feedback` 2s = SC-2（首个 SSE 事件 / 首个可见反馈）
# - `first_answer`   4s = SC-3（答案首字）——**当前 FAIL 且预算未下调**：
#   实测 P95 304.6s / 372.5s，成因是服务端攒齐整篇正文才发第一个 `answer` 帧，
#   属**可工程修复**，故保留 4s 作为待达成目标（见 spec §8 C-22）。
# - `complete` **380s** = SC-4（单轮完整答案）。**v1.1.2 由 20s 改定**：
#   20s 是 v1.0.0 的**暂定值**，实测在思考保持开启的单客户端顺序条件下
#   P95 为 ai4s 304.6s / mito 372.5s（约原预算的 15–19 倍，且 ~99% 是模型生成耗时、
#   检索+精排仅 0.356s ⇒ 属模型速率/硬件预算，改管道够不着），
#   遂按实测上界向上取整到 10 秒档定档。依据见 spec §8 **C-22**。
#
# ⚠️ **改这三个数 = 改闸门口径**，须走宪法 PATCH（授权顺序见 AGENTS.md §1），
# 不得为了「让某次测量变绿」而就地调它——那样闸门就不再是闸门。
# 本文件与宪法的一致性由 `tests/test_latency.py::TestBudgetFollowsTheConstitution`
# 守住：该测试从宪法现文解析出三个数再比对，不一致即红。
BUDGET = {"first_feedback": 2.0, "first_answer": 4.0, "complete": 380.0}
# 与 SC-2 对应的**事件**：证据到达（`evidence`）。
#
# ⚠️ 此处与 T22 brief 的示例实现有一处**必须记录的出入**：brief 里该常量写作
# `("rewrite", "evidence")`，但它同时给出的 `test_timeline_marks_the_three_moments`
# 用 `rewrite@0.40 / evidence@0.55` 断言 `first_feedback == 0.55` —— 二者**不可同时成立**
# （含 `rewrite` 时该帧就是首个命中，结果必为 0.40，实测即 0.40）。任务书明确要求测试
# **逐字使用**、示例实现仅供参考，故以测试为准，把 `rewrite` 移出该集合。
#
# 代价是**保守**：改写完成（多轮才发生的 `rewrite`）同样是可见反馈（前端
# `useChat.ts` 收到它即 `setStatus('retrieving')`、`liveStatus.ts` 给出
# 「正在结合上下文改写问句…」），不计入只会**低估**首个可见反馈的时刻，
# 不会把不达标测成达标。反过来若把 `rewrite` 计入，则必须改测试断言 —— 那是改判定口径。
FIRST_FEEDBACK_EVENTS = ("evidence",)


def percentile(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    if len(ordered) == 1:
        return float(ordered[0])
    k = (len(ordered) - 1) * (p / 100.0)
    lo, hi = int(k), min(int(k) + 1, len(ordered) - 1)
    return float(ordered[lo] + (ordered[hi] - ordered[lo]) * (k - lo))


def timeline(frames: list[tuple[str, float]]) -> dict:
    out = {"first_feedback": 0.0, "first_answer": 0.0, "complete": 0.0}
    for name, t in frames:
        if not out["first_feedback"] and name in FIRST_FEEDBACK_EVENTS:
            out["first_feedback"] = t
        if not out["first_answer"] and name == "answer":
            out["first_answer"] = t
        if name == "done":
            out["complete"] = t
    return out


def collect(url: str, lib: str, question: str, n: int, progress=None) -> list[dict]:
    """顺序发出 n 次**单轮**请求（无历史，故不会触发改写），返回每轮的三段耗时。

    `progress(i, run)` 可选：每轮结束后回调一次，用于长测量的进度留痕
    （实测单轮可达 250s，n=20 是小时级；没有进度输出就无法判断它卡住了还是在跑）。
    """
    runs: list[dict] = []
    for i in range(n):
        payload = json.dumps(
            {"lib": lib, "messages": [{"role": "user", "content": question}]}
        ).encode()
        req = urllib.request.Request(
            url, data=payload, headers={"content-type": "application/json"})
        started = time.monotonic()
        frames: list[tuple[str, float]] = []
        current = None
        with urllib.request.urlopen(req, timeout=120) as resp:
            for raw in resp:
                line = raw.decode("utf-8").strip()
                if line.startswith("event: "):
                    current = line[7:]
                elif line == "" and current:
                    frames.append((current, time.monotonic() - started))
                    current = None
        runs.append(timeline(frames))
        if progress is not None:
            progress(i, runs[-1])
    return runs


def _write_json(path: str, payload: dict) -> None:
    """按仓库约定落盘：UTF-8 / **无 BOM** / **LF** / `ensure_ascii=False`。

    必须显式 `newline="\\n"`：`Path.write_text` 在 Windows 上会把 `\\n` 翻成 `\\r\\n`，
    产物就会带 CRLF（实测踩到过）。`encoding="utf-8"` 本身不写 BOM，这一半无需额外处理。
    """
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(json.dumps(payload, ensure_ascii=False, indent=2))


# 只按**值本身的形态**判「是不是绝对路径」，**不按键名**判。
# 早先的写法里有 `key == "model"` 与 `key.endswith(("_path", "_dir"))` 两支，
# 于是 Hub 风格的模型 id `"BAAI/bge-m3"` 被当成路径、在产物里被改写成 `"bge-m3"`
# —— 快照因此**有损**：它声称记录了配置，却悄悄改了配置（复审 Fix B）。
# 脱敏器的职责是**去掉绝对路径与凭据**，不是改写标识符。
_SECRET_KEYS = ("api_key", "apikey", "token", "secret", "password", "passwd")

REDACTED = "<redacted>"


def _is_absolute_path(value: str) -> bool:
    """Windows 盘符（`D:\\...` / `D:foo`）、UNC（`\\\\server\\share`）、POSIX 根（`/...`）。

    相对路径（`./x`、`library/models/x`、`BAAI/bge-m3`）**不是**绝对路径，不泄露本机目录结构，
    故一律原样保留 —— 判据宽一点就会开始改标识符。
    """
    if not value:
        return False
    if value.startswith(("/", "\\\\")):
        return True
    return len(value) > 1 and value[1] == ":" and value[0].isalpha()


def _redact(value, key: str = ""):
    """递归去掉配置快照里的**绝对路径**（只留文件名）与**疑似凭据**（整值打码）。

    理由与「代码内不出现绝对路径」同源：产物要能外发、能被复核，
    不该把本机目录结构（`D:\\KnowledgeBase\\...`）或任何凭据带进 git。
    凭据那一支是**防御性**的：当前 `config_*.json` 里没有这类键（密钥在 `.env`），
    但产物是要入库的，配置将来多一个 `api_key` 就晚了。
    """
    if isinstance(value, dict):
        return {
            k: (REDACTED if k.lower() in _SECRET_KEYS and v else _redact(v, k))
            for k, v in value.items()
        }
    if isinstance(value, list):
        return [_redact(v, key) for v in value]
    if isinstance(value, str) and _is_absolute_path(value):
        return Path(value).name or REDACTED
    return value


def config_snapshot(lib: str) -> dict:
    """被测配置的快照（脱敏），让产物**自述**它是在什么配置下测的。

    读的是 `config.load_config` 给出的**生效那份文件**，不是任何写死的固定名：
    部署机上生效的是 `RAG_CONFIG_SUFFIX` 选定的那份，固定名会让快照自述成另一份配置。
    产物要能外发，故 `source` 只留文件名（`path.name`），不带本机目录。
    """
    try:
        raw, path = _config.load_config(lib)
    except (OSError, ValueError) as exc:
        # 三条失败路径都落在这里，且都**不吞**原因：
        # - 未选定后缀、但仓库里不带后缀的那份缺失 ⇒ FileNotFoundError（OSError 子类）；
        # - 已选定后缀、而那份文件不存在 ⇒ 解析器抛 FileNotFoundError 且**不回落**；
        # - 文件在、JSON 坏 ⇒ JSONDecodeError（ValueError 子类）。
        # 此时连「生效的那份」都无从谈起，故 source 不指名文件，只记类型名供排查。
        return {"available": False, "source": "<unresolved>",
                "reason": type(exc).__name__}
    return {"available": True, "source": path.name, "values": _redact(raw)}


def git_revision() -> dict:
    """记录测量时的代码版本，让产物可追溯到具体提交。"""
    def run(*argv: str):
        try:
            done = subprocess.run(["git", *argv], cwd=ROOT, capture_output=True,
                                  text=True, timeout=15)
        except (OSError, subprocess.SubprocessError):
            return None
        return done.stdout.strip() if done.returncode == 0 else None

    dirty = run("status", "--porcelain", "--untracked-files=no")
    return {"commit": run("rev-parse", "--short", "HEAD"),
            "dirty": None if dirty is None else bool(dirty)}


def summarize(runs: list[dict], lib: str, question: str, url: str | None = None,
              n_requested: int | None = None) -> dict:
    """把逐轮结果汇总成报告。**没有拿到某个时刻的轮次不得当作达标**。

    三个时刻用 `0.0` 表示「这一轮没发生过」（`timeline` 的既有语义，
    由 `test_percentile_empty_is_zero` 钉住）。服务端的失败路径会发 `error`
    而**不发 `answer`**，但 `done` 仍照发，于是那一轮留下 `first_answer = 0.0`。
    若把它当数值喂进 percentile，0.0 会被算成「答案来得极快」——
    **整轮失败反而变成 SC-3 通过**，而且全轮失败时脚本会打印
    `all_within_budget: true` 并 **退出 0**。这正是任务书里
    `test_timeline_missing_done_is_zero_not_silent_pass` 要挡的那类「静默通过」，
    只是被抬高了一层（从 `timeline` 抬到了 `summarize`）。故此处：

    - 每一刻的总体**只收该刻真实发生过的轮次**（`> 0.0`），缺的轮次不进分母；
    - 缺任一刻的轮次记进 `incomplete.rounds`（逐轮列出缺哪个时刻）；
    - 任一时刻**一个轮次都没有** ⇒ 该刻判 `UNMEASURED`（不是 PASS）；
    - 只要存在不完整轮次或任一判定不是 PASS，`all_within_budget` 即为假 ⇒ `main` 非零退出。
    """
    keys = list(BUDGET)
    populations = {k: [r[k] for r in runs if r.get(k, 0.0) > 0.0] for k in keys}
    incomplete = [
        {"round": i, "missing": [k for k in keys if r.get(k, 0.0) <= 0.0]}
        for i, r in enumerate(runs)
        if any(r.get(k, 0.0) <= 0.0 for k in keys)
    ]

    p95 = {k: percentile(populations[k], 95) for k in keys}
    verdict = {}
    for k in keys:
        if not populations[k]:
            verdict[k] = "UNMEASURED"
        elif p95[k] <= BUDGET[k]:
            verdict[k] = "PASS"
        else:
            verdict[k] = "FAIL"

    report = {
        "n": len(runs),
        "n_requested": n_requested if n_requested is not None else len(runs),
        "condition": "单客户端顺序请求",
        "lib": lib,
        "question": question,
        "url": url,
        "measured_rounds": {k: len(populations[k]) for k in keys},
        "incomplete": {"count": len(incomplete), "rounds": incomplete},
        **{f"{k}_p95": round(p95[k], 3) for k in keys},
        **{f"{k}_verdict": verdict[k] for k in keys},
        "budget": BUDGET,
        "measured_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "revision": git_revision(),
        "config": config_snapshot(lib),
        # 原始分布一并留档：只报一个 P95 无法复核，也看不出离群轮次。
        "runs": runs,
    }
    report["all_within_budget"] = (not incomplete) and all(
        v == "PASS" for v in verdict.values())
    return report


def main() -> None:
    ap = argparse.ArgumentParser(description="端到端延迟测量")
    ap.add_argument("--url", default="http://127.0.0.1:8000/ask/stream")
    ap.add_argument("--lib", default="ai4s")
    ap.add_argument("--question", default="线粒体自噬的调控机制")
    ap.add_argument("--n", type=int, default=20)
    ap.add_argument("--out", default=None)
    ap.add_argument("--partial-out", default=None,
                    help="每轮结束覆盖写一次**累计**结果（长测量留痕；"
                         "实测单轮 4 分钟量级，被中断时不至于一个数都不剩）")
    ap.add_argument("--progress", action="store_true",
                    help="每轮结束打印一行三段耗时（长测量时判断进度用）")
    args = ap.parse_args()

    runs_so_far: list[dict] = []

    def current_report() -> dict:
        return summarize(runs_so_far, args.lib, args.question, args.url, args.n)

    def progress(i: int, run: dict) -> None:
        flag = "" if all(run[k] > 0.0 for k in BUDGET) else "  <-- 本轮不完整"
        print(f"[round {i + 1}/{args.n}] first_feedback={run['first_feedback']:.3f}s "
              f"first_answer={run['first_answer']:.3f}s complete={run['complete']:.3f}s"
              f"{flag}", flush=True)
        if args.partial_out:
            _write_json(args.partial_out, current_report())

    def on_round(i: int, run: dict) -> None:
        runs_so_far.append(run)
        progress(i, run)

    runs = collect(args.url, args.lib, args.question, args.n,
                   progress=on_round if (args.progress or args.partial_out) else None)
    report = summarize(runs, args.lib, args.question, args.url, args.n)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if args.out:
        _write_json(args.out, report)
    if not report["all_within_budget"]:
        bad = [f"{k}={report[f'{k}_verdict']}" for k in BUDGET]
        raise SystemExit(
            f"延迟测量未通过（spec §5 SC-2/3/4）：判定 {' '.join(bad)}；"
            f"不完整轮次 {report['incomplete']['count']}/{report['n']}")


if __name__ == "__main__":
    main()
