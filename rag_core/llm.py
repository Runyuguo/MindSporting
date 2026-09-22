"""阿里云百炼 qwen LLM 客户端（OpenAI 兼容模式，凭据读 .env，不落日志）。"""
from __future__ import annotations

import logging
import re
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FuturesTimeout
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator


def load_env() -> dict:
    env: dict = {}
    p = Path(__file__).resolve().parent.parent / ".env"
    if p.exists():
        for line in p.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
    return env


logger = logging.getLogger(__name__)


# SDK 请求超时默认值（秒）。它是**兜底**，不是唯一来源：
# `_request_timeout_s()` 优先读各库 config_*.json 的 "llm": {"request_timeout_s": ...}。
# 存在的理由：SDK 未显式给 timeout 时默认 read=600s 且 max_retries=2，而
# `rewrite_query` 的 timeout_s 只是「不等」，杀不掉已阻塞的 worker 线程——
# 每次改写都新建线程池，挂死的 provider 会把 worker 逐个占住约 30 分钟。
# 取 120s：完全缓冲的长答案足够，又远小于 600s。
_DEFAULT_REQUEST_TIMEOUT_S = 120.0


def _request_timeout_s(lib: str | None = None) -> float:
    """解析 SDK 请求超时：优先取该库配置，任何异常都退回模块默认值。

    只读本仓库内的 config_*.json（不进 vault），且不缓存——改配置即改行为。
    """
    if lib:
        try:
            from rag_core import rag_engine
            value = rag_engine.get_engine(lib).cfg.get("llm", {}).get("request_timeout_s")
            seconds = float(value)
            if seconds > 0:
                return seconds
            logger.warning("配置 request_timeout_s=%r 非正，回退默认 %.0fs", value,
                           _DEFAULT_REQUEST_TIMEOUT_S)
        except Exception as exc:  # noqa: BLE001
            logger.warning("读取 llm.request_timeout_s 失败（lib=%s: %s），回退默认 %.0fs",
                           lib, exc, _DEFAULT_REQUEST_TIMEOUT_S)
    return _DEFAULT_REQUEST_TIMEOUT_S


def stream_deltas(messages: list[dict], timeout_s: float | None = None,
                  lib: str | None = None, **sampling):
    """流式调用 qwen，逐段 yield delta 文本。

    `timeout_s` 会显式传给 OpenAI SDK 客户端（SDK 未设时默认 read=600s 且
    max_retries=2，挂死的 provider 会长期占住 worker）。为 None 时取
    `_request_timeout_s(lib)`，即该库 config_*.json 的 `llm.request_timeout_s`。

    `**sampling` 原样透传给 SDK 的 `chat.completions.create(...)`，供 003 的
    发散（temperature/top_p）与篇幅（max_tokens）使用。**返回形状与既有行为不变**
    （仍是「逐段 yield content 文本」），故 12 处以
    `mock.patch.object(llm, "stream_deltas", return_value=iter([...]))` 驱动的
    测试不受影响；只是**参数不再被丢弃**——不加这一步，调用方传 temperature
    会在第一轮就抛 TypeError（曾被 MagicMock 掩盖成假绿）。
    """
    from openai import OpenAI
    env = load_env()
    client = OpenAI(base_url=env.get("ALIYUN_LLM_URL"),
                    api_key=env.get("ALIYUN_LLM_API_KEY"),
                    timeout=_request_timeout_s(lib) if timeout_s is None else timeout_s)
    model = env.get("ALIYUN_LLM_MODEL") or "qwen3.8-max"
    stream = client.chat.completions.create(
        model=model, messages=messages, stream=True, **sampling)
    for chunk in stream:
        delta = chunk.choices[0].delta.content if chunk.choices else None
        if delta:
            yield delta


def _part_of(delta: object) -> tuple[str, str] | None:
    """从一个流式 delta 中取出「思考」或「内容」。

    思考字段名在不同兼容实现下可能是 `reasoning_content`（阿里云百炼实测如此）或
    `reasoning`，故两者都探；同一 delta 同时带两者时**先出思考**（顺序即语义）。
    任何异常都返回 None —— 上游换形状不该让整条流崩掉（但上层仍会因
    「没有思考」而产出可见的不可用信号，见 /ask/stream）。
    """
    try:
        rc = getattr(delta, "reasoning_content", None) or getattr(delta, "reasoning", None)
        if rc:
            return ("reasoning", str(rc))
        content = getattr(delta, "content", None)
        if content:
            return ("content", str(content))
    except Exception:  # noqa: BLE001
        return None
    return None


def stream_parts(messages: list[dict], timeout_s: float | None = None,
                 lib: str | None = None, **sampling) -> "Iterator[tuple[str, str]]":
    """流式调用，逐段 yield ("reasoning"|"content", 文本)。

    **不改 `stream_deltas`**：它的返回形状被多处测试 mock 依赖。本函数是并列的旁路，
    `stream_deltas` 可视为「只取 content」的窄化版本。
    `sampling` 透传采样参数（temperature / top_p / max_tokens），供 003 的发散与篇幅使用。
    思考文本**不得写入日志**（可能含模型自述，且体量大）。
    """
    from openai import OpenAI
    env = load_env()
    client = OpenAI(base_url=env.get("ALIYUN_LLM_URL"),
                    api_key=env.get("ALIYUN_LLM_API_KEY"),
                    timeout=_request_timeout_s(lib) if timeout_s is None else timeout_s)
    model = env.get("ALIYUN_LLM_MODEL") or "qwen3.8-max"
    stream = client.chat.completions.create(
        model=model, messages=messages, stream=True, **sampling)
    for chunk in stream:
        if not chunk.choices:
            continue
        part = _part_of(chunk.choices[0].delta)
        if part is not None:
            yield part


def stream_chat(messages: list[dict], on_delta=None, *, timeout_s: float | None = None,
                lib: str | None = None) -> str:
    full = ""
    for delta in stream_deltas(messages, timeout_s=timeout_s, lib=lib):
        full += delta
        if on_delta:
            on_delta(delta)
    return full


def ask(prompt: str, system: str | None = None) -> str:
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})
    return stream_chat(messages)

_REWRITE_SYSTEM = (
    "你是检索查询改写器。把用户在多轮对话中的最新提问，改写成一条**自足**的检索查询："
    "补全所有代词（它/这个/那个/上述）所指的实体，使其脱离上下文也能独立表达完整意图。"
    "只输出改写后的查询本身，不要解释、不要编号、不要引号、不要前缀。"
    "若最新提问本身已自足，原样输出。"
)

_PREFIX_RE = re.compile(r'^(查询|检索|query|Query)\s*[:：]\s*')

# 为 system 提示词与消息结构预留的空间（max_chars 约束的是送进 LLM 的整体预算）。
_SYSTEM_RESERVE = 150


@dataclass(frozen=True)
class RewriteResult:
    query: str
    degraded: bool


def _last_user(messages: list[dict]) -> str:
    for m in reversed(messages):
        if m.get("role") == "user":
            return str(m.get("content", ""))
    return ""


# 参与「对话历史」的角色。system（提示词）/tool（工具返回）不是对话轮次：
# 它们既不能进改写 prompt（挤占预算且带偏改写），也不能冒充「有上文」。
_CONVERSATION_ROLES = ("user", "assistant")


def _conversation_history(messages: list[dict]) -> list[dict]:
    """只保留 user/assistant 历史消息——过滤角色的唯一出口。"""
    return [m for m in messages if m.get("role") in _CONVERSATION_ROLES]


def _trim_history(messages: list[dict], rounds: int, max_chars: int) -> list[dict]:
    """取最近 rounds 轮（每轮含 user+assistant），再按字符预算整轮从旧到新丢弃。

    裁剪以「轮」为单位：预算装不下时丢整轮，绝不只保留半轮
    （只留下 assistant 回复、却丢掉它所回答的 user 提问会让上下文失义）。

    内部先按 user/assistant 过滤：system/tool 消息既不进 prompt 也不占预算，
    同时 `messages` 保持原样（预算分母仍取真正的当前问句）。
    """
    history = _conversation_history(messages[:-1])
    window = history[-(rounds * 2):] if rounds > 0 else []
    budget = max_chars - len(_last_user(messages)) - _SYSTEM_RESERVE
    return _pack_rounds(window, budget)


def _pack_rounds(window: list[dict], budget: int) -> list[dict]:
    """窗口内消息按轮分组，预算装不下就整轮丢弃（从旧到新）。"""
    # 按轮分组：遇到 user 起新的一轮（连续 user 各自成组）。
    groups: list[list[dict]] = []
    for m in window:
        if not groups or m.get("role") == "user":
            groups.append([m])
        else:
            groups[-1].append(m)
    kept: list[dict] = []
    used = 0
    for group in reversed(groups):
        cost = sum(len(str(m.get("content", ""))) for m in group)
        if used + cost > budget:
            break
        kept = group + kept
        used += cost
    return kept


def rewrite_query(
    messages: list[dict],
    *,
    history_rounds: int = 3,
    max_chars: int = 6000,
    timeout_s: float = 8.0,
) -> RewriteResult:
    """把多轮上文 + 最新提问压成一条自足检索查询。

    单轮（无上文）时直接返回原问题，不调用 LLM。
    任何失败都降级为原始问句，并以 degraded=True 标注。
    """
    question = _last_user(messages).strip()
    if not question:
        return RewriteResult(query="", degraded=False)

    history = _conversation_history(messages[:-1])
    if not history:
        return RewriteResult(query=question, degraded=False)

    # 已过滤的 history 直接复用（keep），避免 _trim_history 二次过滤；
    # question_len 传入当前问句长度，保证预算分母仍是当前问句。
    payload = _trim_history(messages, history_rounds, max_chars)
    prompt_messages = (
        [{"role": "system", "content": _REWRITE_SYSTEM}]
        + payload
        + [{"role": "user", "content": question}]
    )

    # 超时必须真实生效。注意：不能用 `with ThreadPoolExecutor(...)`——
    # 上下文管理器退出时会 shutdown(wait=True)，反而会等慢调用跑完，超时形同虚设。
    pool = ThreadPoolExecutor(max_workers=1)
    try:
        # 同时给 SDK 层一个界：timeout_s 只保证调用方不等待，杀不掉已阻塞的 worker。
        future = pool.submit(stream_chat, prompt_messages, timeout_s=timeout_s)
        try:
            raw = future.result(timeout=timeout_s)
        except FuturesTimeout:
            future.cancel()
            logger.warning("rewrite_query 超时（%.1fs），降级为原始问句", timeout_s)
            return RewriteResult(query=question, degraded=True)
        except Exception as exc:
            logger.warning("rewrite_query 调用失败，降级为原始问句：%s", exc,
                           exc_info=True)
            return RewriteResult(query=question, degraded=True)
    finally:
        # wait=False：绝不因等待超时线程而阻塞返回（宪法 §3.3 可见降级 + 不拖垮请求）
        pool.shutdown(wait=False, cancel_futures=True)

    # 先剥前缀再剥引号：模型可能回成 `查询："线粒体自噬"`，
    # 前缀在引号内，若先剥外层引号，残留引号会粘在查询词上。
    text = (raw or "").strip()
    for _ in range(2):
        text = _PREFIX_RE.sub("", text)
        text = text.strip().strip('"').strip("'").strip()
    if not text:
        return RewriteResult(query=question, degraded=True)
    return RewriteResult(query=text, degraded=False)
