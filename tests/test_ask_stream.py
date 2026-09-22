import json
import unittest
from pathlib import Path
from unittest import mock

from fastapi.testclient import TestClient

from rag_core import llm
from rag_core import params as gen_params
from server import http_server


def events(text: str) -> list[tuple[str, dict]]:
    out = []
    for block in text.split("\n\n"):
        if not block.strip():
            continue
        name, data = None, None
        for line in block.splitlines():
            if line.startswith("event: "):
                name = line[7:]
            elif line.startswith("data: "):
                data = json.loads(line[6:])
        if name:
            out.append((name, data))
    return out


class TestAskStreamContract(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(http_server.app)

    def test_single_turn_emits_evidence_then_answer_then_done(self):
        with mock.patch.object(llm, "stream_parts",
                               return_value=iter([("content", "答"), ("content", "案")])):
            r = self.client.post(
                "/ask/stream",
                json={"lib": "ai4s", "messages": [{"role": "user", "content": "线粒体"}], "topn": 2},
            )
        self.assertEqual(r.status_code, 200)
        self.assertIn("charset=utf-8", r.headers["content-type"].lower())
        # charset 由 Starlette 对任意 text/* 自动补全，单靠它锁不住「这确实是 SSE」；
        # 媒体类型本身必须被断言，否则 media_type 改成 text/plain 也照样绿。
        self.assertIn("text/event-stream", r.headers["content-type"].lower())
        names = [n for n, _ in events(r.text)]
        self.assertEqual(names[-1], "done")
        self.assertEqual(names.count("done"), 1)
        self.assertIn("evidence", names)
        self.assertNotIn("rewrite", names, "单轮无上文，不应触发改写事件")
        self.assertEqual(
            "".join(d["delta"] for n, d in events(r.text) if n == "answer"), "答案"
        )

    def test_multi_turn_emits_rewrite_event(self):
        with mock.patch.object(
            llm, "rewrite_query", return_value=llm.RewriteResult("线粒体自噬 调控因子", False)
        ), mock.patch.object(llm, "stream_parts", return_value=iter([("content", "ok")])):
            r = self.client.post(
                "/ask/stream",
                json={
                    "lib": "ai4s",
                    "messages": [
                        {"role": "user", "content": "线粒体自噬的机制"},
                        {"role": "assistant", "content": "……"},
                        {"role": "user", "content": "那它的调控因子呢"},
                    ],
                },
            )
        evs = events(r.text)
        self.assertEqual(evs[0][0], "rewrite")
        self.assertEqual(evs[0][1]["query"], "线粒体自噬 调控因子")
        self.assertFalse(evs[0][1]["degraded"])

    def test_system_prompt_pins_the_output_format_the_ui_renders(self):
        """答案由前端当 Markdown 渲染（react-markdown + rehype-katex）。

        这里显式约定输出格式，否则模型时用时不用 Markdown，同一段答案里粗体时有时无
        （曾实测到同一条回答里 `**` 只加粗了一部分）。断言「约定真的发给了模型」，
        而不是只断言常量存在 —— 少传 system 消息时这条必须红。
        """
        captured = {}

        def fake(messages, **kwargs):
            captured["messages"] = messages
            return iter([("content", "ok")])

        with mock.patch.object(llm, "stream_parts", side_effect=fake):
            self.client.post(
                "/ask/stream",
                json={"lib": "ai4s", "messages": [{"role": "user", "content": "x"}]},
            )

        system = [m for m in captured["messages"] if m["role"] == "system"]
        self.assertEqual(len(system), 1, "必须恰好一条 system 提示词")
        text = system[0]["content"]
        self.assertIn("Markdown", text, "未约定 Markdown，前端会渲染出字面 `**`")
        self.assertIn("$", text, "未约定数学定界符，KaTeX 不会生效")
        # 既定约束不能被新加的格式约定挤掉
        self.assertIn("[编号]", text)
        self.assertIn("不参考历史问答记录", text)

    def test_llm_failure_still_emits_done(self):
        with mock.patch.object(llm, "stream_parts", side_effect=RuntimeError("boom")):
            r = self.client.post(
                "/ask/stream",
                json={"lib": "ai4s", "messages": [{"role": "user", "content": "x"}]},
            )
        names = [n for n, _ in events(r.text)]
        self.assertIn("error", names)
        self.assertEqual(names[-1], "done")
        self.assertEqual(names.count("done"), 1)

    def test_invalid_lib_is_rejected_not_defaulted(self):
        r = self.client.post(
            "/ask/stream",
            json={"lib": "nope", "messages": [{"role": "user", "content": "x"}]},
        )
        self.assertEqual(r.status_code, 400)

    def test_system_only_context_does_not_trigger_rewrite(self):
        """`messages=[system, user]` 长度 >1，但**没有真实对话历史**。

        门若用「len(messages) > 1」，就会把一条 system 提示词当成上文去调用改写 LLM。
        正确门是「存在已过滤的历史」。"""
        with mock.patch.object(llm, "rewrite_query") as rq, \
                mock.patch.object(llm, "stream_parts", return_value=iter([("content", "ok")])):
            r = self.client.post(
                "/ask/stream",
                json={
                    "lib": "ai4s",
                    "messages": [
                        {"role": "system", "content": "你是科研助手"},
                        {"role": "user", "content": "线粒体"},
                    ],
                },
            )
        self.assertEqual(r.status_code, 200)
        rq.assert_not_called()
        self.assertNotIn("rewrite", [n for n, _ in events(r.text)])

    def test_conversation_history_still_triggers_rewrite_alongside_system(self):
        """上一条门的补集：真有 user/assistant 历史时，混入 system 也要照常触发改写。"""
        with mock.patch.object(
            llm, "rewrite_query", return_value=llm.RewriteResult("线粒体自噬 调控因子", False)
        ) as rq, mock.patch.object(llm, "stream_parts", return_value=iter([("content", "ok")])):
            r = self.client.post(
                "/ask/stream",
                json={
                    "lib": "ai4s",
                    "messages": [
                        {"role": "system", "content": "你是科研助手"},
                        {"role": "user", "content": "线粒体自噬的机制"},
                        {"role": "assistant", "content": "……"},
                        {"role": "user", "content": "那它的调控因子呢"},
                    ],
                },
            )
        self.assertEqual([n for n, _ in events(r.text)][0], "rewrite")
        # 送进改写的 messages 里不得出现 system（那是提示词，不是对话轮次）
        sent = rq.call_args.args[0]
        self.assertEqual([m["role"] for m in sent], ["user", "assistant", "user"])
        self.assertEqual(sent[-1]["content"], "那它的调控因子呢")

    def test_invalid_topn_is_rejected_with_400(self):
        """旧 GET 端点有 Query(10, ge=1, le=50)；改 POST 后必须显式校验，
        否则 "abc"/null -> 500，0/999 -> 静默越界。"""
        with mock.patch.object(llm, "stream_parts", return_value=iter([("content", "ok")])):
            for bad in ("abc", None, 0, 999, -1, 3.7, True, [1]):
                with self.subTest(topn=bad):
                    r = self.client.post(
                        "/ask/stream",
                        json={"lib": "ai4s",
                              "messages": [{"role": "user", "content": "x"}],
                              "topn": bad},
                    )
                    self.assertEqual(r.status_code, 400)
                    self.assertIn("topn", r.json()["error"])

    def test_valid_topn_boundaries_are_accepted(self):
        with mock.patch.object(llm, "stream_parts", return_value=iter([("content", "ok")])):
            for good in (1, 50, "7"):
                with self.subTest(topn=good):
                    r = self.client.post(
                        "/ask/stream",
                        json={"lib": "ai4s",
                              "messages": [{"role": "user", "content": "x"}],
                              "topn": good},
                    )
                    self.assertEqual(r.status_code, 200)

    def test_omitted_topn_uses_default(self):
        with mock.patch.object(llm, "stream_parts", return_value=iter([("content", "ok")])):
            r = self.client.post(
                "/ask/stream",
                json={"lib": "ai4s", "messages": [{"role": "user", "content": "x"}]},
            )
        self.assertEqual(r.status_code, 200)

    def test_empty_messages_does_not_call_llm(self):
        with mock.patch.object(llm, "stream_parts") as sd:
            r = self.client.post("/ask/stream", json={"lib": "ai4s", "messages": []})
        names = [n for n, _ in events(r.text)]
        self.assertEqual(names[-1], "done")
        sd.assert_not_called()

    def test_lib_is_threaded_to_stream_parts_for_config_timeout(self):
        """`lib` 必须传到 stream_parts（生成路径的实际调用点）——SDK 请求超时由该库 config 解析，
        若端点不传 lib，则配置键永远读不到，超时只能是代码兜底值。"""
        with mock.patch.object(llm, "stream_parts", return_value=iter([("content", "ok")])) as sd:
            r = self.client.post(
                "/ask/stream",
                json={"lib": "mito", "messages": [{"role": "user", "content": "x"}]},
            )
        self.assertEqual(r.status_code, 200)
        self.assertEqual(sd.call_args.kwargs.get("lib"), "mito")


class TestLlmRequestTimeout(unittest.TestCase):
    """T06 复审遗留（Important）：已装的 OpenAI SDK 默认 read=600s 且 max_retries=2，
    而每次 rewrite 调用都新建线程池；`rewrite_query` 的 timeout_s 只能限制调用方等待，
    杀不掉已阻塞的 worker 线程。故必须给 SDK 客户端本身一个显式且可配置的请求超时。"""

    def _client_kwargs(self, **call_kwargs):
        client = mock.MagicMock()
        client.chat.completions.create.return_value = iter(())
        with mock.patch("openai.OpenAI", return_value=client) as ctor:
            list(llm.stream_deltas([{"role": "user", "content": "hi"}], **call_kwargs))
        ctor.assert_called_once()
        return ctor.call_args.kwargs

    def test_stream_deltas_passes_a_bounded_timeout_to_sdk_client(self):
        """核心：`timeout=` 必须真的出现在 openai.OpenAI(...) 上，且是有界的正数。

        去掉这个 timeout= 参数，本测试立即在 assertIn("timeout", kwargs) 失败；
        若改成 SDK 默认（600s）或更大，则在 assertLessEqual 失败。"""
        kwargs = self._client_kwargs()

        self.assertIn(
            "timeout", kwargs,
            "stream_deltas 必须把请求超时传给 openai.OpenAI(timeout=...)；缺失即回落 "
            "SDK 默认 read=600s，挂死的 provider 会把线程池 worker 占住约 30 分钟",
        )
        timeout = kwargs["timeout"]
        self.assertFalse(isinstance(timeout, bool), "timeout 不能是 bool")
        self.assertIsInstance(timeout, (int, float), "timeout 必须是数值")
        self.assertGreater(timeout, 0, "timeout 必须为正数")
        self.assertLessEqual(timeout, 600, "timeout 必须显著小于 SDK 默认的 600s，否则等于没设")

    def test_timeout_default_is_the_module_constant(self):
        timeout = self._client_kwargs()["timeout"]
        self.assertEqual(timeout, llm._DEFAULT_REQUEST_TIMEOUT_S)

    def test_explicit_timeout_overrides_the_default(self):
        """显式传入的界必须被尊重——rewrite_query 靠它把改写调用一并框住。"""
        self.assertEqual(self._client_kwargs(timeout_s=8.0)["timeout"], 8.0)

    def test_timeout_is_sourced_from_config_not_a_hardcoded_number(self):
        """真正读配置：把 lib 换成另一个库，解析出的超时随之改变。

        若 `_request_timeout_s` 不读配置（只返回常量），本测试在 assertNotEqual 失败。"""
        real = llm._request_timeout_s("ai4s")
        with mock.patch.object(
            llm, "_request_timeout_s", side_effect=lambda lib=None: 7.5 if lib == "mito" else real
        ) as resolver:
            timeout = self._client_kwargs(lib="mito")["timeout"]

        self.assertEqual(resolver.call_args.args, ("mito",))
        self.assertNotEqual(timeout, real)
        self.assertEqual(timeout, 7.5)

    def test_request_timeout_s_reads_the_lib_config(self):
        """`_request_timeout_s(lib)` 必须返回**该库 config 里声明的那个值**。

        两库取值互不相同、且至少一个 ≠ 回退常量（ai4s=120、mito=90），
        否则「总是回退默认」与「真的读到了配置」在观测上无法区分（复审 ①）。"""
        core_dir = Path(llm.__file__).resolve().parent
        declared = {}
        for lib in ("ai4s", "mito"):
            cfg = json.loads((core_dir / f"config_{lib}.json").read_text(encoding="utf-8"))
            value = cfg.get("llm", {}).get("request_timeout_s")
            self.assertIsNotNone(value, f"config_{lib}.json 缺少 llm.request_timeout_s")
            declared[lib] = float(value)
            self.assertEqual(llm._request_timeout_s(lib), declared[lib])
            self.assertGreater(declared[lib], 0)
            self.assertLessEqual(declared[lib], 600)

        self.assertNotEqual(declared["ai4s"], declared["mito"],
                            "两库取值若相同，本测试无法区分「读配置」与「回退默认」")
        self.assertTrue(any(v != llm._DEFAULT_REQUEST_TIMEOUT_S for v in declared.values()),
                        "至少一个库的值必须 ≠ 回退常量，否则测试空转")

        # 反向验证（已实测）：把 llm.py 里读的键名拼错，上面这条 assertEqual 立即变红
        # （解析回退到常量，与 mito 的 90 不等）。故本正向测试不是空转。

    def _probe_resolver(self, mutate_cfg, lib="ai4s"):
        """在子进程里改配置后再解析：隔离 get_engine 的进程级缓存。"""
        import subprocess
        import sys

        root = Path(llm.__file__).resolve().parent.parent
        script = (
            "import json, sys\n"
            "from rag_core import llm\n"
            "p = sys.argv[1]\n"
            "cfg = json.loads(open(p, encoding='utf-8').read())\n"
            + mutate_cfg + "\n"
            "open(p, 'w', encoding='utf-8', newline='\\n').write("
            "json.dumps(cfg, ensure_ascii=False, indent=2))\n"
            "print(llm._request_timeout_s(sys.argv[2]))\n"
        )
        cfg_path = root / "rag_core" / f"config_{lib}.json"
        backup = cfg_path.read_text(encoding="utf-8")
        try:
            proc = subprocess.run([sys.executable, "-c", script, str(cfg_path), lib],
                                  cwd=str(root), capture_output=True, text=True,
                                  encoding="utf-8", errors="replace")
        finally:
            cfg_path.write_text(backup, encoding="utf-8", newline="\n")
        return proc

    def test_config_read_is_real_not_a_permanent_fallback(self):
        """负向证明：读得到配置时返回配置值；**读不到时**才回退常量。

        两条探针分别覆盖复审 ① 指出的两种静默失效：键名写错、键被整体移除。
        两者都必须回退到常量——与上面那条正向测试（断言各库声明值）合起来，
        才排除了「解析器总是返回常量」这种空转。"""
        core_dir = Path(llm.__file__).resolve().parent
        declared = float(json.loads(
            (core_dir / "config_mito.json").read_text(encoding="utf-8")
        )["llm"]["request_timeout_s"])
        self.assertNotEqual(declared, llm._DEFAULT_REQUEST_TIMEOUT_S,
                            "本测试前提：所选库的配置值必须 ≠ 回退常量，否则区分不出来")

        # 键名写错 -> 读不到 -> 回退常量
        wrong_key = self._probe_resolver(
            "cfg['llm']['request_timeout_seconds'] = cfg['llm'].pop('request_timeout_s')",
            lib="mito")
        self.assertNotIn("Traceback", wrong_key.stderr, wrong_key.stderr)
        observed = (wrong_key.stdout or "").strip()
        self.assertEqual(
            float(observed), llm._DEFAULT_REQUEST_TIMEOUT_S,
            "键名写错后必须回退常量——若这里返回了配置值，说明解析器根本没按这个键读",
        )
        self.assertNotEqual(float(observed), declared,
                            "若写错键名后仍返回 90，说明解析器读的不是这个键")

        # `llm` 键整体移除 -> 同样回退常量
        absent = self._probe_resolver("cfg.pop('llm')", lib="mito")
        self.assertNotIn("Traceback", absent.stderr, absent.stderr)
        self.assertEqual(float((absent.stdout or "").strip()), llm._DEFAULT_REQUEST_TIMEOUT_S)

        # 对照：不改配置时，同一探针返回的是**配置值**而不是常量
        intact = self._probe_resolver("pass", lib="mito")
        self.assertNotIn("Traceback", intact.stderr, intact.stderr)
        self.assertEqual(float((intact.stdout or "").strip()), declared)

    def test_unknown_lib_falls_back_to_default_without_raising(self):
        self.assertEqual(llm._request_timeout_s("ghost-lib"), llm._DEFAULT_REQUEST_TIMEOUT_S)


class TestGenerateParams(unittest.TestCase):
    """/ask/stream 必须真正读取 params 并影响生成（003 第 7 条）。"""

    def setUp(self):
        self.client = TestClient(http_server.app)

    def test_divergence_reaches_the_model_call(self):
        with mock.patch.object(llm, "stream_parts", return_value=iter([("content", "答")])) as sd:
            self.client.post("/ask/stream", json={
                "lib": "ai4s",
                "messages": [{"role": "user", "content": "线粒体"}],
                "params": {"divergence": 2.0, "length": 800},
            })
        kwargs = sd.call_args.kwargs
        self.assertIn("temperature", kwargs, "发散必须传到生成调用")
        self.assertAlmostEqual(kwargs["temperature"], 1.2, places=2)

    def test_low_divergence_lowers_temperature(self):
        with mock.patch.object(llm, "stream_parts", return_value=iter([("content", "答")])) as sd:
            self.client.post("/ask/stream", json={
                "lib": "ai4s",
                "messages": [{"role": "user", "content": "线粒体"}],
                "params": {"divergence": 0.0, "length": 800},
            })
        self.assertAlmostEqual(sd.call_args.kwargs["temperature"], 0.1, places=2)

    def test_missing_params_still_works(self):
        # 既有客户端不传 params 时必须照常工作（向后兼容）
        with mock.patch.object(llm, "stream_parts", return_value=iter([("content", "答")])) as sd:
            r = self.client.post("/ask/stream", json={
                "lib": "ai4s",
                "messages": [{"role": "user", "content": "线粒体"}],
            })
        self.assertEqual(r.status_code, 200)
        self.assertIn("done", [n for n, _ in events(r.text)])

    def test_short_answer_outside_tolerance_is_reported(self):
        # 目标 3000 字，模型只给 2 字 ⇒ 必须如实告知未达标（零静默失败）
        with mock.patch.object(
            llm, "stream_parts",
            return_value=iter([("reasoning", "想"), ("content", "太短")]),
        ):
            r = self.client.post("/ask/stream", json={
                "lib": "ai4s",
                "messages": [{"role": "user", "content": "线粒体"}],
                "params": {"divergence": 1.0, "length": 3000},
            })
        payloads = [d for n, d in events(r.text) if n == "notice"]
        self.assertTrue(payloads, "篇幅未达标必须产出可见信号")
        # brief 写的 `assertIn("篇幅", ...)` 与 brief 自己的实现文案（"本轮字数 … 容差内"）
        # 互相矛盾 ⇒ 按**实际文案**断言，并连带钉住 payload 形状（message/chars/target）。
        blob = json.dumps(payloads, ensure_ascii=False)
        self.assertIn("字数", blob)
        self.assertIn("容差", blob)
        self.assertIn("已重试 1 次", blob, "补救一次后才如实告知（max_retry=1）")
        # 注意：`return_value=iter([...])` 是一次性迭代器，重试那一轮取到的是**空流**
        # ⇒ chars 报 0 而非 2。这是如实计数（不是缺陷），故只钉形状与目标值。
        self.assertIsInstance(payloads[0]["chars"], int)
        self.assertGreaterEqual(payloads[0]["chars"], 0)
        self.assertEqual(payloads[0]["target"], 3000)
        self.assertIn("已重试 1 次", blob, "补救一次后才如实告知（max_retry=1）")

    def test_in_tolerance_answer_streams_once_and_needs_no_retry(self):
        """篇幅合规时：answer 事件恰好出现一次、且**只调一次**生成。

        这条钉住「重试循环不得把首轮 delta 重发」——若把核对写成「先发一轮、再无条件重发」，
        answer 会重复、生成调用会变成 2 次，而上面 4 条用例全绿。
        """
        body = "线" * 500                      # target=500 ⇒ 容差 [450, 550]
        # 流里带上思考片段：本用例的 `assertNotIn("notice")` 要钉的是「合规就没有篇幅告知」，
        # 若流里没有思考，T42 的「思考不可用」告知会**合法地**出现，把这条钉错。
        with mock.patch.object(llm, "stream_parts",
                               return_value=iter([("reasoning", "想"), ("content", body)])) as sd:
            r = self.client.post("/ask/stream", json={
                "lib": "ai4s",
                "messages": [{"role": "user", "content": "线粒体"}],
                "params": {"divergence": 1.0, "length": 500},
            })
        self.assertEqual(sd.call_count, 1, "已合规就不该再生成一轮")
        names = [n for n, _ in events(r.text)]
        self.assertEqual(names.count("answer"), 1)
        self.assertNotIn("notice", names)
        self.assertEqual(
            "".join(d["delta"] for n, d in events(r.text) if n == "answer"), body)

    def test_sampling_params_reach_the_sdk_create_call(self):
        """端到端：采样参数必须一路走到 `client.chat.completions.create(...)`。

        为什么需要这条（brief 未写）：上面三条用例把 `llm.stream_parts` **整个换成
        MagicMock**——MagicMock 容忍任意 kwargs，于是「参数真的被这个函数接受」这一点
        无人验证。若 `stream_parts` 不接受采样参数（它的签名为
        `(messages, timeout_s=None, lib=None)`），生产路径会在第一轮就抛 TypeError、
        被 /ask/stream 兜成 `error` 事件，而上述用例**全绿**。故这里只替换 OpenAI
        客户端，让真实的 `stream_parts` 跑起来，检查 SDK 收到的温度与 max_tokens。
        """
        captured = {}

        class _Completions:
            def create(self, **kwargs):
                captured["sdk"] = kwargs
                return iter(())

        class _Client:
            def __init__(self, **kwargs):
                captured["client"] = kwargs
                self.chat = type("C", (), {"completions": _Completions()})()

        real = llm.stream_parts

        def _spy(messages, timeout_s=None, lib=None, **sampling):
            captured["sampling"] = sampling
            return real(messages, timeout_s=timeout_s, lib=lib, **sampling)

        with mock.patch("openai.OpenAI", _Client), \
                mock.patch.object(llm, "stream_parts", side_effect=_spy):
            r = self.client.post("/ask/stream", json={
                "lib": "ai4s",
                "messages": [{"role": "user", "content": "线粒体"}],
                "params": {"divergence": 1.0, "length": 800},
            })

        self.assertEqual(captured.get("sampling"), {"temperature": 0.65, "top_p": 0.725},
                         "生成路径必须把 sampling 交给 llm.stream_parts；"
                         "**不含 max_tokens** —— 上限会连思考一起管住并把正文砍断")
        sdk = captured.get("sdk")
        self.assertIsNotNone(sdk, "SDK 的 create() 必须被调用到，否则本用例空转")
        self.assertEqual(captured["client"]["timeout"], 120.0,
                         "`lib` 仍须一路带到 SDK 客户端超时（ai4s=120s）")
        self.assertAlmostEqual(sdk["temperature"], 0.65, places=2)
        self.assertAlmostEqual(sdk["top_p"], 0.725, places=2)
        # 即使**显式给了篇幅**也不得设 max_tokens（使用者 2026-09-19）：
        # 该上限同时管住思考与正文，长思考会把正文从中间砍断，补救重试也救不回来。
        self.assertNotIn("max_tokens", sdk, "篇幅是范围而非硬上限，不得据此设 max_tokens")
        self.assertNotIn("error", [n for n, _ in events(r.text)])

    def test_client_without_params_is_not_given_an_undisclosed_token_cap(self):
        """不传 `params` 的客户端**不得**被默默加上限（整支审查 I6）。

        此前 `max_tokens = max_tokens_for(target or 1200)` 对 `target is None` 也照算，
        于是不传 `length` 的调用方被硬塞一个约 1184 的上限：**没有测试、没有告知**，
        回答被砍断时界面上看起来像"模型自己停了"。而改动前这一路径**根本不发**
        `max_tokens`（连 temperature/top_p 也不发），旁边的注释却写着
        「保证既有客户端行为不变」——与事实不符。

        现约定：客户端没要字数，就**不替它设上限**（spec「仅设置生成上限不构成本条的
        实现」）。`divergence` 缺失仍按中性默认发（那是它一直以来的语义），
        故这里只断言 `max_tokens` 不在场。
        """
        captured = {}

        class _Completions:
            def create(self, **kwargs):
                captured["sdk"] = kwargs
                return iter(())

        class _Client:
            def __init__(self, **kwargs):
                self.chat = type("C", (), {"completions": _Completions()})()

        real = llm.stream_parts

        def _spy(messages, timeout_s=None, lib=None, **sampling):
            captured["sampling"] = sampling
            return real(messages, timeout_s=timeout_s, lib=lib, **sampling)

        with mock.patch("openai.OpenAI", _Client), \
                mock.patch.object(llm, "stream_parts", side_effect=_spy):
            r = self.client.post("/ask/stream", json={
                "lib": "ai4s",
                "messages": [{"role": "user", "content": "线粒体"}],
                # 刻意**不带** params
            })

        sampling = captured.get("sampling")
        self.assertIsNotNone(sampling, "生成路径必须被走到，否则本用例空转")
        self.assertNotIn("max_tokens", sampling,
                         "客户端未指定篇幅时不得替它设上限")
        sdk = captured.get("sdk")
        self.assertIsNotNone(sdk, "SDK 的 create() 必须被调用到，否则下面断言空转")
        self.assertNotIn("max_tokens", sdk,
                         "上限不得透传到 provider —— 这才是「行为不变」的字面意思")

    def test_params_topn_drives_the_number_of_evidence_hits(self):
        """「证据数」滑杆真的决定检索条数（2026-09-19 使用者新增：8 条太少，要可调）。

        判据取 `evidence` 事件里的 `hits` 长度 —— 那是这一步的**直接产物**，
        不是中间变量。用两个不同值各跑一次，避免"恰好等于默认值"这种巧合通过。
        """
        def hits_for(params: dict) -> int:
            with mock.patch.object(llm, "stream_parts",
                                   side_effect=lambda *a, **kw: iter([("content", "答")])):
                r = self.client.post("/ask/stream", json={
                    "lib": "ai4s",
                    "messages": [{"role": "user", "content": "虚拟细胞与 AI 建模"}],
                    "params": params,
                })
            evs = events(r.text)
            evidence = [d for n, d in evs if n == "evidence"]
            self.assertTrue(evidence, "必须发出 evidence 事件，否则本用例空转")
            return len(evidence[0]["hits"])

        small = hits_for({"divergence": 1, "length": 1500, "topn": 3})
        large = hits_for({"divergence": 1, "length": 1500, "topn": 12})
        self.assertEqual(small, 3, "证据数必须恰好等于请求的 topn")
        self.assertEqual(large, 12, "换一个值也必须跟着变（否则参数没被读）")
        self.assertGreater(large, small, "条数必须随 topn 单调增长")

    def test_legacy_toplevel_topn_still_honoured(self):
        """顶层 `topn` 是本端点自 001 起的既有字段，老调用方仍在用 —— 不得静默失效。"""
        with mock.patch.object(llm, "stream_parts",
                               side_effect=lambda *a, **kw: iter([("content", "答")])):
            r = self.client.post("/ask/stream", json={
                "lib": "ai4s", "messages": [{"role": "user", "content": "虚拟细胞与 AI 建模"}],
                "topn": 4,
            })
        evidence = [d for n, d in events(r.text) if n == "evidence"]
        self.assertTrue(evidence, "必须发出 evidence 事件，否则本用例空转")
        self.assertEqual(len(evidence[0]["hits"]), 4, "顶层 topn 必须仍然生效")

    def test_params_topn_takes_precedence_over_toplevel(self):
        """两者同时给时以 `params.topn` 为准（滑杆是使用者的显式意图）。"""
        with mock.patch.object(llm, "stream_parts",
                               side_effect=lambda *a, **kw: iter([("content", "答")])):
            r = self.client.post("/ask/stream", json={
                "lib": "ai4s", "messages": [{"role": "user", "content": "虚拟细胞与 AI 建模"}],
                "topn": 4,
                "params": {"divergence": 1, "length": 1500, "topn": 9},
            })
        evidence = [d for n, d in events(r.text) if n == "evidence"]
        self.assertTrue(evidence, "必须发出 evidence 事件，否则本用例空转")
        self.assertEqual(len(evidence[0]["hits"]), 9, "params.topn 优先于顶层 topn")
        self.assertNotIn("error", [n for n, _ in events(r.text)])


class TestReflectiveRemedy(unittest.TestCase):
    """反思式补救（控制器 Ruling，修复 T40 审查 Critical 1）。

    不变量：**交付的文本 == 被核对的文本**。早先边流边核对时，第一稿的 delta 已到浏览器，
    而重试的第二稿会被前端**追加**到同一条消息上 ⇒ 用户看到两份拼接答案、字数却只量了第二稿
    ⇒ 一个交付约两倍目标字数的轮次被报成完全合规（spec 禁止「把不合规的结果直接交付」）。
    """

    def setUp(self):
        self.client = TestClient(http_server.app)

    def _post(self, params, side_effect):
        # 迁移到 stream_parts（T42 起生成路径的调用点）：返回形状随之变成
        # ("reasoning"|"content", 文本) 二元组。
        with mock.patch.object(llm, "stream_parts", side_effect=side_effect):
            return self.client.post("/ask/stream", json={
                "lib": "ai4s",
                "messages": [{"role": "user", "content": "线粒体"}],
                "params": params,
            })

    def test_retry_delivers_only_the_second_attempt(self):
        """首轮不合规 ⇒ 交付的是**第二稿**，而不是两稿拼接。"""
        first = "短" * 10       # 远低于 3000 的 ±10%
        second = "足" * 3000    # 落在容差内
        # 每轮都带思考片段：本用例断言 `assertNotIn("notice")`（不该有未达标告知），
        # 而**没有**思考的流会合法地产生 T42 的「思考不可用」告知，把这条钉错。
        r = self._post({"divergence": 1.0, "length": 3000},
                       side_effect=[iter([("reasoning", "想"), ("content", first)]),
                                    iter([("reasoning", "想"), ("content", second)])])
        answers = "".join(d["delta"] for n, d in events(r.text) if n == "answer")
        self.assertEqual(answers, second, "重试后交付的必须是第二稿，不得与第一稿拼接")
        self.assertNotIn(first, answers)
        self.assertNotIn("notice", [n for n, _ in events(r.text)],
                         "第二稿合规 ⇒ 不该有未达标告知")

    def test_delivered_text_is_exactly_what_was_counted(self):
        """两轮都不合规 ⇒ 交付最后一稿，且 notice 报的字数就是**该稿**的字数。"""
        first = "短" * 10
        last = "中" * 500
        r = self._post({"divergence": 1.0, "length": 3000},
                       side_effect=[iter([("reasoning", "想"), ("content", first)]),
                                    iter([("reasoning", "想"), ("content", last)])])
        answers = "".join(d["delta"] for n, d in events(r.text) if n == "answer")
        self.assertEqual(answers, last)
        notices = [d for n, d in events(r.text) if n == "notice"]
        self.assertTrue(notices, "补救后仍不合规必须如实告知")
        self.assertEqual(notices[0]["chars"], gen_params.count_answer_chars(answers),
                         "notice 报的字数必须等于实际交付文本的字数")

    def test_no_answer_is_streamed_before_verification(self):
        """**次序**不变量：`answer` 必须出现在 `notice` **之后**（即在核对之后才交付）。

        前面两条用 filter-then-join 收集 answer，对**位置**不敏感 —— 一个「同一轮内部边流边发」
        的变异仍会通过。这条按事件**顺序**钉住新设计的核心主张（plan §2.2：核对通过前一个 delta 都不流）。
        """
        first = "短" * 10
        last = "中" * 500
        r = self._post({"divergence": 1.0, "length": 3000},
                       side_effect=[iter([("reasoning", "想"), ("content", first)]),
                                    iter([("reasoning", "想"), ("content", last)])])
        names = [n for n, _ in events(r.text)]
        self.assertIn("notice", names)
        self.assertIn("answer", names)
        self.assertLess(names.index("notice"), names.index("answer"),
                        "正文必须在核对（notice）之后才交付")

    def test_failed_retry_delivers_the_first_attempt_instead_of_erroring(self):
        """补救轮抛错 ⇒ **不得**翻成 error，照常交付上一轮文本并如实告知（Ruling 2）。"""
        first = "短" * 10

        def side_effect(*a, **kw):
            if side_effect.calls == 0:
                side_effect.calls += 1
                return iter([("reasoning", "想"), ("content", first)])
            side_effect.calls += 1
            raise RuntimeError("provider down")

        side_effect.calls = 0
        r = self._post({"divergence": 1.0, "length": 3000}, side_effect)
        names = [n for n, _ in events(r.text)]
        self.assertNotIn("error", names, "补救轮失败不该把整轮推向失败态")
        self.assertIn("notice", names)
        self.assertEqual(
            "".join(d["delta"] for n, d in events(r.text) if n == "answer"),
            first, "已得的文本必须照常交付，不能因补救失败而丢弃")

    def test_legacy_client_without_length_is_not_retried(self):
        """不传 params 的老客户端：既不核对也不重试（不该被套上没要求过的字数契约）。"""
        with mock.patch.object(
            llm, "stream_parts",
            return_value=iter([("reasoning", "想"), ("content", "很短的答案")]),
        ) as sd:
            r = self.client.post("/ask/stream", json={
                "lib": "ai4s", "messages": [{"role": "user", "content": "线粒体"}]})
        self.assertEqual(sd.call_count, 1, "未给 length 时不得因篇幅重试")
        self.assertNotIn("notice", [n for n, _ in events(r.text)])
        self.assertEqual(
            "".join(d["delta"] for n, d in events(r.text) if n == "answer"), "很短的答案")


class TestSystemPromptContract(unittest.TestCase):
    """提示词是本条的实现载体，必须防误删（用测试钉住）。"""

    def test_prompt_requires_analysis_not_recitation(self):
        p = http_server._build_system_prompt()
        self.assertIn("综合", p, "必须要求跨证据综合")
        self.assertIn("矛盾", p, "必须要求指出证据间矛盾")

    def test_prompt_requires_speculation_marker(self):
        p = http_server._build_system_prompt()
        self.assertIn("[推测]", p, "外推必须统一标记为 [推测]")
        self.assertIn("缺口", p, "外推必须说明所缺依据")

    def test_prompt_keeps_existing_constraints(self):
        p = http_server._build_system_prompt()
        # 001 既有约束不得被新要求挤掉
        self.assertIn("[编号]", p)
        self.assertIn("通用知识", p)
        self.assertIn("Markdown", p)
        self.assertIn("$", p)  # KaTeX 公式约定


class TestReasoningEvent(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(http_server.app)

    def test_reasoning_precedes_answer(self):
        def fake(*a, **kw):
            yield ("reasoning", "先想")
            yield ("content", "再答")

        with mock.patch.object(llm, "stream_parts", side_effect=fake):
            r = self.client.post("/ask/stream", json={
                "lib": "ai4s", "messages": [{"role": "user", "content": "线粒体"}]})
        names = [n for n, _ in events(r.text)]
        self.assertIn("reasoning", names)
        self.assertLess(names.index("reasoning"), names.index("answer"))
        self.assertEqual(
            "".join(d["delta"] for n, d in events(r.text) if n == "reasoning"), "先想")

    def test_absent_reasoning_yields_visible_notice(self):
        # 上游没给思考 ⇒ 必须明确告知「思考不可用」，不得静默留白
        with mock.patch.object(llm, "stream_parts",
                               side_effect=lambda *a, **kw: iter([("content", "答")])):
            r = self.client.post("/ask/stream", json={
                "lib": "ai4s", "messages": [{"role": "user", "content": "线粒体"}]})
        notices = [d for n, d in events(r.text) if n == "notice"]
        self.assertTrue(notices, "思考不可用必须产出可见信号")
        self.assertIn("思考", json.dumps(notices, ensure_ascii=False))


class TestStageEvents(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(http_server.app)

    def test_stage_events_carry_server_side_elapsed(self):
        with mock.patch.object(llm, "stream_parts",
                               side_effect=lambda *a, **kw: iter([("content", "答")])):
            r = self.client.post("/ask/stream", json={
                "lib": "ai4s", "messages": [{"role": "user", "content": "线粒体"}]})
        stages = [d for n, d in events(r.text) if n == "stage"]
        names = [s["name"] for s in stages]
        self.assertIn("evidence", names)
        for s in stages:
            self.assertIsInstance(s["elapsed_ms"], int)
            self.assertGreaterEqual(s["elapsed_ms"], 0)

    def test_no_rewrite_stage_for_single_turn(self):
        # spec 边界 Scenario：未发生改写时不得显示改写阶段
        with mock.patch.object(llm, "stream_parts",
                               side_effect=lambda *a, **kw: iter([("content", "答")])):
            r = self.client.post("/ask/stream", json={
                "lib": "ai4s", "messages": [{"role": "user", "content": "线粒体"}]})
        names = [d["name"] for n, d in events(r.text) if n == "stage"]
        # 先钉「阶段事件本身在场」：否则一条 stage 都不发时，下面的 assertNotIn 会空转通过
        # （本用例首轮运行就是这样空转绿的，故补上这一行）。
        self.assertIn("evidence", names, "阶段事件必须真的发出，否则本断言空转")
        self.assertNotIn("rewrite", names)

    def test_reasoning_is_forwarded_in_full_with_no_cap_and_no_truncation_notice(self):
        """思考**不设上限**：整段转发，且不再有「已截断」这类告知。

        使用者 2026-09-19 明确要求「去掉这个限制，把所有思考过程都打印出来」，
        故本用例钉的是**相反**的性质：无论思考多长都**不得**被掐掉，也不得再出现
        截断告知（无上限时那套机制不可能触发，留着即死代码）。
        """
        chunks = 50
        def fake(*a, **kw):
            for _ in range(chunks):
                yield ("reasoning", "想" * 1000)   # 合计 5 万字，远超原先的 12000 上限
            yield ("content", "答")

        with mock.patch.object(llm, "stream_parts", side_effect=fake):
            r = self.client.post("/ask/stream", json={
                "lib": "ai4s", "messages": [{"role": "user", "content": "线粒体"}]})
        evs = events(r.text)
        forwarded = "".join(d["delta"] for n, d in evs if n == "reasoning")
        self.assertEqual(len(forwarded), chunks * 1000, "整段思考都必须转发，一个字数都不能少")
        notices = [d for n, d in evs if n == "notice"]
        self.assertFalse(any("截断" in str(n) for n in notices),
                         "无上限即不得再声称截断")
        self.assertNotIn("reasoning_truncated", [n.get("kind") for n in notices],
                         "无上限即不得再发截断分类")
        # 配置里也不该再留 `max_chars`（留着会让人以为还有上限）
        cfg = json.loads(
            (Path(llm.__file__).resolve().parent / "config_ai4s.json").read_text(encoding="utf-8"))
        self.assertNotIn("max_chars", cfg["generate"]["thinking"],
                         "思考上限已取消，配置里不应再有 max_chars")
        # 正文不受影响（思考与篇幅核对互不干扰）
        self.assertEqual("".join(d["delta"] for n, d in evs if n == "answer"), "答")

    def test_reasoning_text_is_never_logged(self):
        """思考文本**不得**进入任何日志（宪法 §2.3 / 计划 §8 的硬要求）。

        现状是正确的（全仓没有把 reasoning 传给 logger），但**没有任何测试守着它**——
        将来谁在转发循环里加一行 `logger.debug`，这条约束就静默失守。故在此钉死。
        手法参照 `tests/test_mcp_surface.py` 的「不落日志」用例：用 `assertLogs` 让
        任何一条日志都可见，并断言思考正文不出现在其中。
        """
        secret = "内部盘算的独特内容ABCDEF"
        def fake(*a, **kw):
            yield ("reasoning", secret)
            yield ("content", "答")

        with mock.patch.object(llm, "stream_parts", side_effect=fake):
            with self.assertLogs(level="DEBUG") as captured:
                self.client.post("/ask/stream", json={
                    "lib": "ai4s", "messages": [{"role": "user", "content": "线粒体"}]})
        joined = "\n".join(captured.output)
        self.assertNotIn(secret, joined, "思考正文不得出现在日志里")


class TestZeroSilentFailureGuards(unittest.TestCase):
    """两处「零静默失败」守卫的回归钉（整支审查 I2）。

    这两条守卫是 T41–T43 复审重要修复的产物，但**此前没有任何测试守着它们**：
    把它们改回旧写法，整套测试仍然全绿。故各自钉一条。
    """

    def setUp(self):
        self.client = TestClient(http_server.app)

    def test_reasoning_only_stream_tells_the_user_no_answer_was_produced(self):
        """模型只思考、不产出正文且客户端未指定篇幅 ⇒ 必须明确告知「没有正文」。

        可达路径（见 `http_server.py` 的 `if not delivered` 分支）：思考占满
        `max_tokens` 时内容全是 reasoning；而「思考不可用」那条 notice 被
        `delivered` 挡住（本条本来就有思考），篇幅告知又因未指定 length 而不触发。
        三条路都不发 ⇒ 用户对着一条空消息干等。这条 notice 是唯一的出口。
        """
        def fake(*a, **kw):
            yield ("reasoning", "想了很久但一个字正文都没写")
            # 注意：**不产出任何 content**，这正是本用例的前提

        with mock.patch.object(llm, "stream_parts", side_effect=fake):
            r = self.client.post("/ask/stream", json={
                "lib": "ai4s", "messages": [{"role": "user", "content": "线粒体"}]})

        evs = events(r.text)
        names = [n for n, _ in evs]
        # 先钉前提真的成立：没有 answer 事件，否则下面的断言可能因别的原因通过
        self.assertNotIn("answer", names, "本用例前提是模型没产出正文")
        notices = [d for n, d in evs if n == "notice"]
        self.assertTrue(notices, "什么都没交付时必须给出可见告知，不得静默")
        self.assertIn("正文", json.dumps(notices, ensure_ascii=False),
                      "必须明说「没有正文」，而不是只说思考不可用")
        # 空交付不是错误：它必须能被正常走到 done
        self.assertEqual(names[-1], "done")

    def test_generation_failure_is_not_misattributed_to_missing_reasoning(self):
        """首轮生成就失败时，**不得**报「上游没给思考」。

        这是 `if not saw_reasoning and delivered` 里 `delivered` 那一半的存在理由：
        首轮抛错时 `saw_reasoning` 仍为 False，若照发就把一个「生成失败」错误归因成
        「上游没给思考」（T41–T43 复审 Minor 8）。旧写法 `if not saw_reasoning:`
        在本用例下会同时发出两条 notice，故这条断言对旧写法**必红**。
        """
        with mock.patch.object(llm, "stream_parts", side_effect=RuntimeError("boom")):
            r = self.client.post("/ask/stream", json={
                "lib": "ai4s", "messages": [{"role": "user", "content": "x"}]})

        evs = events(r.text)
        notices = [d for n, d in evs if n == "notice"]
        blob = json.dumps(notices, ensure_ascii=False)
        # 同时钉在场与缺席：只断言缺席会因「一条 notice 都不发」而空转通过
        self.assertNotIn("思考", blob, "生成失败不得被归因为「上游没给思考」")
        self.assertIn("正文", blob, "确实没交付正文，该说的是这个")
        self.assertIn("error", [n for n, _ in evs], "失败本身仍要作为 error 报出")


if __name__ == "__main__":
    unittest.main()
