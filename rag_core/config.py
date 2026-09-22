"""配置来源解析器：由**显式环境变量**选定生效的那一份配置文件。

为什么需要这个模块
------------------
既有代码（`rag_core/rag_engine.py` 的 `_engine_from_lib`）把配置文件名写死成
`config_{lib}.json`，而仓库里那两份配置的内容是**开发机的绝对路径**（vault、索引、
reranker 模型都指向本机 D 盘）。规范 004 要把本服务部署到另一台机器
（Linux/aarch64），那里同样是绝对路径、但指向别的位置，于是必须存在**第二份**
配置；而在改动之前，**没有任何代码路径会去读它**——部署机上的 `RAG_CONFIG_SUFFIX`
设了也无人理睬，最终仍会读到开发机的那份，表现为「配置静默失效」。

本模块就是那个读第二份的代码路径：用 `RAG_CONFIG_SUFFIX` 显式选定。

**失败必须大声**（回落次数 = 0）
--------------------------------
`RAG_CONFIG_SUFFIX` 一旦被显式设成非空值，它就是一个**意图声明**：调用方要的是那一份。
此时若该文件不存在，**绝不回落**到 `config_{lib}.json`——回落会把「配错了」伪装成
「部署机恰好能跑」，而那台机器上的路径值全部指向不存在的位置，故障会推迟到真正使用
索引/模型时才炸，且现场看不出原因。所以这里直接抛 `FileNotFoundError`，并把排查所需
的三样东西一次说完：**选定的后缀 · 期望的完整路径 · 当前工作目录**（相对路径的 cwd
歧义是这类故障最常见的成因）。

未设（或空串 / 纯空白）后缀时行为**一字不变**：仍是 `config_{lib}.json`。
空串按「未设」处理，是因为 `RAG_CONFIG_SUFFIX=`（例如容器里传了个空变量）表达的是
「不覆盖」，把它当成「选了一个空后缀」只会得到一份必然不存在的文件名。

本模块的 `load_config` 在返回前还要做**四键路径存在性核对**（`check_paths_exist`：
index_db / faiss_index / vault_path / rerank.model），理由见该函数的 docstring。
"""
from __future__ import annotations

import json
import os
from collections.abc import Mapping
from pathlib import Path

#: 选定配置来源的环境变量名。值为配置文件名里 `config_{lib}` 与 `.json` 之间的后缀，
#: 例如 `_linux` ⇒ `config_ai4s_linux.json`。
ENV_SUFFIX = "RAG_CONFIG_SUFFIX"

#: 未设后缀时的文件名模板（既有行为）。
LEGACY_TEMPLATE = "config_{lib}.json"

#: 设了后缀时的文件名模板。
SUFFIXED_TEMPLATE = "config_{lib}{suffix}.json"


def _default_base_dir() -> Path:
    """默认基准目录 = `rag_core/` 自身目录（用 `__file__` 推导的运行期绝对路径）。

    仓库宪法禁止代码里出现写死的绝对路径；`__file__` 推导是**允许且被鼓励**的写法，
    与 `rag_core/rag_engine.py` 的 `_engine_from_lib` 保持同一套口径。
    """
    return Path(__file__).resolve().parent


def resolve_config_path(lib: str, base_dir: Path | None = None) -> Path:
    """解析出 `lib` 生效的配置文件的绝对路径。

    `RAG_CONFIG_SUFFIX` strip 后非空 ⇒ `config_{lib}{后缀}.json`；该文件不存在
    **抛 `FileNotFoundError`**（信息含：选定的后缀 · 期望的完整路径 · 当前工作目录），
    **不回落**。未设 / 空串 / 纯空白 ⇒ `config_{lib}.json`。

    `base_dir` 仅为可测性而设（测试把它指向临时目录，从而绝不写真实的 `rag_core/`）；
    生产调用只传 `lib`。
    """
    base = _default_base_dir() if base_dir is None else Path(base_dir)
    suffix = os.environ.get(ENV_SUFFIX, "").strip()
    if suffix:
        path = base / SUFFIXED_TEMPLATE.format(lib=lib, suffix=suffix)
        if not path.exists():
            raise FileNotFoundError(
                f"已选定配置后缀 {suffix!r}（来自环境变量 {ENV_SUFFIX}），"
                f"但期望的配置文件不存在，且**不回落**到 {LEGACY_TEMPLATE.format(lib=lib)}：\n"
                f"  期望的完整路径：{path}\n"
                f"  当前工作目录：{os.getcwd()}\n"
                f"部署机上请确认该后缀对应的配置已随部署一起搬运，"
                f"或清除 {ENV_SUFFIX} 以使用不带后缀的既有配置。")
        return path
    return base / LEGACY_TEMPLATE.format(lib=lib)


class ConfigPathError(RuntimeError):
    """四键路径存在性核对失败（键缺失，或键的值指向不存在的位置）。

    用专门的异常类型（而不是裸 `RuntimeError`）是为了让「配置指向的位置不存在」这件事
    在调用栈上层**可被单独识别**——它和「文件读不出来」「JSON 坏了」是不同的故障。
    """


#: 需要做存在性核对的四键。`rerank.model` 是**点分键**（实际是 `cfg["rerank"]["model"]`），
#: 另三个是顶层键。顺序固定，便于异常信息稳定排序。
REQUIRED_PATH_KEYS: tuple[str, ...] = ("index_db", "faiss_index", "vault_path", "rerank.model")

#: 点分键分隔符。
_DOTTED = "."


def _dotted_get(cfg: Mapping, dotted: str):
    """按点分键取值；任一层缺失即返回 `None`（「缺失」由调用方按同一套口径报出）。"""
    node = cfg
    for part in dotted.split(_DOTTED):
        if not isinstance(node, Mapping) or part not in node:
            return None
        node = node[part]
    return node


def check_paths_exist(cfg: Mapping, source: Path) -> None:
    """核对四键的值在**本机**是否存在；任一不存在或整个缺失 ⇒ 抛 `ConfigPathError`。

    为什么这是铁律而不是「顺手的健壮性检查」
    ----------------------------------------
    这两种「配置存在、但值指向部署机上不存在的位置」的后果都**会伪装成正常**：

    ① `index_db` 指错 ⇒ SQLite 打开时**新建一个空库**。现场表现是「库里没有相关内容」，
       而不是「配置错了」——使用者会去怀疑资料、怀疑检索词，唯独不会怀疑配置。
    ② `faiss_index` 指错 ⇒ 检索**退回精确检索**。而精确检索本身**更准**，质量指标
       不降反升，「语义检索根本没生效」被数字彻底掩盖。

    两者都是宪法 §4.3 明令禁止的静默失败。唯一的拦法就是在配置被使用的**入口**把
    「值存在吗」问一遍并当场抛出——故障必须在读取配置的那一刻爆，而不是推迟到查询时。

    为什么挂在 `load_config` 上
    --------------------------
    四个读者（`rag_engine`、两个脚本、测试）都经由 `load_config` 拿配置，核对放在这里
    ⇒ **服务路径自动全覆盖**。放到 `resolve_config_path` 里则只覆盖「选文件」这一步，
    任何直接读 JSON 的路径都会漏掉。

    核对口径（控制器明文规定）
    --------------------------
    - **只验存在性**：`Path(value).exists()`，**不用** `is_dir()` / `is_file()`。
      真实配置里 `vault_path` 与 `rerank.model` 是**目录**、`index_db` 与 `faiss_index`
      是**文件**，把类型也钉死会引入 plan 没有要求的更严校验。
    - **异常信息含键名与值的原文**：用 `f"{value}"` 而不是 `{value!r}`，
      免得 Windows 路径里的反斜杠被 repr 转义成 `\\\\`，现场照抄路径时对不上。
    - **键整个缺失也要抛**（防御性分支）：真实两份配置四键齐全，但「键缺失」与
      「值不存在」对使用者是同一类事故——配置与部署机不匹配。
    """
    if not isinstance(cfg, Mapping):
        raise ConfigPathError(
            f"配置文件 {source} 的顶层不是 JSON 对象（实际类型：{type(cfg).__name__}），"
            f"无法核对四键路径。")

    missing: list[str] = []
    for key in REQUIRED_PATH_KEYS:
        value = _dotted_get(cfg, key)
        if value is None:
            missing.append(f"  键 {key}：**缺失**（该键在 {source.name} 里不存在）")
            continue
        # 值的原文（不转义）；非字符串值也照原样显示，便于现场核对配置本身。
        text = value if isinstance(value, str) else str(value)
        if not Path(text).exists():
            missing.append(f"  键 {key}：值 {text}（该位置在本机不存在）")

    if missing:
        raise ConfigPathError(
            "配置里的路径值指向本机不存在的位置，**不回落、不新建、不退回精确检索**：\n"
            + "\n".join(missing)
            + f"\n  配置文件：{source}\n"
            + "请确认该配置是为**本机**准备的（部署机上应使用随部署搬运的那一份，"
              f"或用环境变量 {ENV_SUFFIX} 选定对应后缀的配置）。")


def load_config(lib: str, base_dir: Path | None = None) -> tuple[dict, Path]:
    """读入 `lib` 生效的配置，返回 `(cfg, path)`；`path` 是实际生效的那一份。

    流程是「选定来源 → 读 JSON → **四键路径存在性核对**」，核对失败即抛
    `ConfigPathError`（**在返回前**，见 `check_paths_exist` 的 `为什么` 一节：
    放过它会让「SQLite 新建空库」「faiss 退回精确检索」伪装成正常）。
    """
    path = resolve_config_path(lib, base_dir)
    cfg = json.loads(path.read_text(encoding="utf-8"))
    check_paths_exist(cfg, path)
    return cfg, path
