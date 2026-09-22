"""生成参数的纯逻辑：发散→采样参数、篇幅→目标与容差、正文字数统计。

与 HTTP 层解耦：便于独立单测，也便于将来复用（例如评测脚本）。
"""
from __future__ import annotations

import re

DIVERGENCE_MIN = 0.0
DIVERGENCE_MAX = 2.0

LENGTH_MIN = 500
LENGTH_MAX = 3000


def _lerp(value: float, lo: float, hi: float, out_lo: float, out_hi: float) -> float:
    ratio = (value - lo) / (hi - lo)
    return out_lo + ratio * (out_hi - out_lo)


def divergence_to_sampling(divergence: float, spec: dict) -> dict:
    """把发散取值线性映射到采样参数。

    端点取值夹紧而**不报错**：spec 的「参数边界」Scenario 要求端点取值下生成正常完成。
    """
    d = max(DIVERGENCE_MIN, min(DIVERGENCE_MAX, float(divergence)))
    return {
        "temperature": round(_lerp(d, DIVERGENCE_MIN, DIVERGENCE_MAX,
                                   float(spec["temperature_min"]),
                                   float(spec["temperature_max"])), 4),
        "top_p": round(_lerp(d, DIVERGENCE_MIN, DIVERGENCE_MAX,
                             float(spec["top_p_min"]),
                             float(spec["top_p_max"])), 4),
    }


# 计数口径（必须固定，否则「±10%」判定会随实现漂移）。**以下描述与实现逐条对齐**，
# 改实现必须同步改这里（T40 复审 Minor 4 指出过一处注释与实现不符）：
# - 去掉**围栏行**（``` 那一行本身）、Markdown 强调/标题/列表标记（`#*_>` 与 `~`）、
#   引用编号 `[1]`、以及全部空白；
# - **保留**围栏代码块的正文、行内代码的**反引号**、KaTeX 的 `$…$`、以及汉字与标点。
#   即：反引号与 `$` 都计入字数（它们也算回答占的版面），只去掉装饰性标记与空白。
_MD_FENCE_RE = re.compile(r"^\s*```.*$", re.MULTILINE)
_MD_MARKERS_RE = re.compile(r"[#*_>`~]+")
_CITATION_RE = re.compile(r"\[\d+\]")
_WHITESPACE_RE = re.compile(r"\s+")


def count_answer_chars(text: str) -> int:
    """统计回答的可见正文字数（spec 的 ±10% 判定基准）。"""
    if not text:
        return 0
    t = _MD_FENCE_RE.sub("", text)
    t = _CITATION_RE.sub("", t)
    t = _MD_MARKERS_RE.sub("", t)
    t = _WHITESPACE_RE.sub("", t)
    return len(t)


def length_bounds(target: int, tolerance: float = 0.10) -> tuple[int, int]:
    """目标字数的允许区间（闭区间）。"""
    return (int(target * (1 - tolerance)), int(target * (1 + tolerance)))


def within_tolerance(chars: int, target: int, tolerance: float = 0.10) -> bool:
    lo, hi = length_bounds(target, tolerance)
    return lo <= chars <= hi


def max_tokens_for(target: int, chars_per_token: float = 1.5) -> int:
    """目标字数 → max_tokens 上限（留 40% 余量，避免正文被硬截断）。"""
    return int(target / chars_per_token * 1.4) + 64


def is_supported(cfg: dict) -> dict[str, bool]:
    """各生成参数在该库配置下是否**真的**会被采纳。

    供界面如实标注用（spec「参数不被支持时的如实性」）：
    当配置缺失或关闭时，界面不得继续声称参数已生效。

    ⚠️ 每一条都**必须**对应一条真实读取路径，否则界面会替后端许下做不到的承诺：
    - `divergence` → `divergence_to_sampling`（采样温度/top_p）
    - `length` → 目标字数 + ±容差核对 + 补救重试
    - `topn` → `/ask/stream` 的 `_parse_topn` → 检索条数
    """
    g = cfg.get("generate") or {}
    return {
        "divergence": bool(g.get("divergence")),
        "length": bool(g.get("length")),
        "topn": bool(g.get("topn")),
    }
