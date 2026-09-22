"""来源白名单（A 案：只读三个目录）。

**与 `config.folder_kind` 的语义区别（务必保持）**：
- `folder_kind` 是**接受式**映射：`kind = fk.get(folder, "note")` —— 未列名目录会被当成 `note` 收进来；
- 本模块是**拒绝式**白名单：未列名目录（含将来新增的）**一律不放行**。

把两者混用会让「默认放行」悄悄回来，这正是 A 案要根除的行为。
"""
from __future__ import annotations

ALLOWED_PREFIXES: tuple[str, ...] = ("01-Literature", "02-Surveys", "03-Reading")

# 允许目录 → 既有 kind 标注（仍由 folder_kind 决定 kind，这里只为检索期前缀兜底）
_KIND_BY_PREFIX: dict[str, str] = {
    "01-Literature": "note",
    "02-Surveys": "survey",
    "03-Reading": "reading",
}


def is_allowed_ref(ref: str, allowed: tuple[str, ...] = ALLOWED_PREFIXES) -> bool:
    """ref 是否为允许目录内的 vault 相对路径。

    只认「首段**恰好等于**某个允许目录名」——用严格相等而非前缀包含，
    以免 `01-LiteratureX/` 这类同名开头目录被误放行。

    **拒绝以下一切形态**（安全边界，2026-09-19 审查后加固）：
    - 空串、非 vault 相对路径（如 `extracted/xx.txt`）；
    - **任何含 `..`、`.` 或空段的路径** —— `01-Literature/../OCR/x.md` 的首段虽合法，
      但解析后落在**被排除目录**内。`/doc` 的 `ref` 由客户端提供且无鉴权，
      故这里必须拒绝穿越，而不能指望调用方去 resolve；
    - 以 `/` 开头的绝对形态。
    """
    if not isinstance(ref, str) or not ref:
        return False
    parts = ref.replace("\\", "/").split("/")
    # 穿越/相对段/空段一律拒（`01-Literature//a.md` 这类双斜杠也在内）
    if any(p in ("", ".", "..") for p in parts):
        return False
    return parts[0] in allowed


def source_prefixes(allowed: tuple[str, ...] = ALLOWED_PREFIXES) -> list[str]:
    """白名单目录对应的 `source` 前缀，供检索期兜底使用。

    **未映射的目录必须报错，不得静默丢弃**（宪法 §4.3）：
    静默过滤会让调用方拿到一个**更短的前缀列表**而毫无察觉——
    正是本模块要防的「静默漂移」。新增白名单目录时，未同步补 `_KIND_BY_PREFIX` 会立刻炸出来。
    """
    missing = [p for p in allowed if p not in _KIND_BY_PREFIX]
    if missing:
        raise ValueError(
            f"allowed 含未映射的目录 {missing}；请同步更新 _KIND_BY_PREFIX（或改由 config 派生）")
    return [f"vault:{_KIND_BY_PREFIX[p]}" for p in allowed]
