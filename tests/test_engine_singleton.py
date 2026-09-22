import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

# 模型只能从本地缓存加载（测试进程不比服务端，没有别处设定离线标志）。
# 不强制离线时，首次语义检索会在 huggingface.co 的连接上长时间挂起——
# 见 task-5-report.md「环境事实」。必须在导入 rag_engine 之前设定。
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
# 关闭权重加载进度条，保持测试输出干净（纯展示，不影响加载行为）。
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")

import numpy as np  # noqa: E402

from rag_core import rag_engine  # noqa: E402


class _BarrierInsideLockProbe:
    """把 `threading.Barrier` 注入临界区内部的探针锁：观测「临界区内同时有几个线程」。

    这不是「加个超时看看会不会挂」，而是一条明确的蕴含链，断言的是整条链的结论：

        推理锁真互斥 ⇒ 任一时刻临界区内至多 1 个线程
                    ⇒ Barrier(2) 永远凑不齐第 2 方
                    ⇒ 先到者超时、barrier 进入 BROKEN 态
                    ⇒ 每个进入临界区的线程都收到 BrokenBarrierError
        推理锁缺失或形同虚设 ⇒ 2 个线程同时进入临界区
                    ⇒ barrier 立即放行 ⇒ 无异常、max_inside == 2

    故「broken == entered == 2 且 max_inside == 1」⇔「互斥为真」。
    最后一步是删锁情形的判据：`with self._infer_lock` 被删掉后探针**根本不会被进入**
    （entered == 0、broken == 0、max_inside == 0），上面的等式随即失败。

    只放 2 个参与方，且 barrier 超时给足裕度：互斥成立时测试必然白等一次超时，
    故超时值就是本测试耗时；而在「锁已删」的情形下，2 个线程都已启动、只差一次
    模型调用，超时值相对所需裕度是上千倍，普通调度延迟不会让 barrier 假破裂
    （假破裂会把「锁被删」误判成「互斥成立」，那才是真正危险的误报）。
    """

    def __init__(self, real_lock, barrier):
        self._real = real_lock
        self._barrier = barrier
        self._stat = threading.Lock()
        self.entered = 0     # 进入 `with self._infer_lock` 的线程数（取锁前就计数）
        self.inside = 0      # 当前临界区内线程数
        self.max_inside = 0  # 临界区内线程数的历史峰值
        self.broken = 0      # 在锁内收到 BrokenBarrierError 的线程数

    def __enter__(self):
        with self._stat:
            self.entered += 1
        self._real.acquire()
        with self._stat:
            self.inside += 1
            self.max_inside = max(self.max_inside, self.inside)
        try:
            self._barrier.wait()
        except threading.BrokenBarrierError:
            with self._stat:
                self.inside -= 1
                self.broken += 1
            # __enter__ 抛异常时 with 语句不会调用 __exit__，这里必须自己放锁，
            # 否则等在真锁上的线程会永久阻塞、把测试进程挂死。
            self._real.release()
            raise
        with self._stat:
            self.inside -= 1
        return self

    def __exit__(self, *exc):
        self._real.release()
        return False


class TestEngineSingleton(unittest.TestCase):
    """spec「多客户端并发」：实例唯一（构建次数）与结果正确（无串扰）分别断言。

    前半句由 test_concurrent_first_request_builds_exactly_once 断言——
    8 线程抢首次请求，构建次数必须是 1（不是 ≤2）。
    后半句由 test_concurrent_distinct_queries_do_not_cross_contaminate 断言——
    实例唯一不蕴含并发正确，故必须独立验证。

    注：本文件每次运行会真实加载 bge-m3（约 9s，仅一次），
    以确保并发断言真的覆盖了共享模型的推理路径。
    """

    def setUp(self):
        rag_engine.reset_engines()

    def tearDown(self):
        rag_engine.reset_engines()

    def test_same_instance_per_lib(self):
        self.assertIs(rag_engine.get_engine("ai4s"), rag_engine.get_engine("ai4s"))

    def test_distinct_instances_across_libs(self):
        self.assertIsNot(
            rag_engine.get_engine("ai4s"), rag_engine.get_engine("mito")
        )

    def test_invalid_lib_raises(self):
        with self.assertRaises(FileNotFoundError):
            rag_engine.get_engine("nope")

    def test_concurrent_first_request_builds_exactly_once(self):
        built: list[int] = []
        original = rag_engine.RAGEngine.__init__

        def counting(self, *args, **kwargs):
            built.append(1)
            original(self, *args, **kwargs)

        rag_engine.RAGEngine.__init__ = counting
        try:
            threads = [
                threading.Thread(target=lambda: rag_engine.get_engine("ai4s"))
                for _ in range(8)
            ]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
        finally:
            rag_engine.RAGEngine.__init__ = original

        self.assertEqual(len(built), 1, "并发首次请求只应构建一个引擎实例")

    def test_concurrent_distinct_queries_do_not_cross_contaminate(self):
        """spec「多客户端并发」后半句：各请求必须拿到**各自正确**的证据包。

        与上一个测试的分工：那个只数构建次数（实例唯一），这个断言并发下的**结果正确性**——
        案例唯一不蕴含并发正确，必须分别断言。

        路径说明（review 指出，T16 后已更新）：`engine.search()` 内部走 `semantic_search`，
        该路径（ANN 分支与索引不可用时的 `semantic_search_exact` 回退分支）一律经
        `encode_texts` 编码、受 `_infer_lock` 保护，**不再绕过**推理锁；因此本测试的并发
        结果现在确实经过锁，但它检验的仍是「共享模型 + 共享 engine 下无串扰」，
        而不是「推理锁生效」。锁生效的证据在 `test_encode_texts_lock_is_mutually_exclusive`；
        锁定路径的并发一致性在 `test_encode_texts_concurrent_distinct_texts_match_serial`。
        """
        # 模型未加载成功时，语义检索会静默降级为空结果，下面的并发一致性断言
        # 会「两边都是空列表」而**空洞通过**——那等于这条 spec 场景根本没被测到。
        # 故先加载并断言它确实可用（这里用 _embedder() 而非 encode_texts()：
        # 后者语义上「模型不可用则返回 None」，会把加载失败掩盖过去）。
        self.assertIsNotNone(
            rag_engine.get_engine("ai4s")._embedder(),
            "bge-m3 未能从本地缓存加载：本测试将退化为空洞通过，故先在此失败",
        )

        engine = rag_engine.get_engine("ai4s")
        # 查询集必须落在**白名单三个目录**里有证据的主题上（T36 检索期白名单之后）：
        # 命中的候选窗口被库外长文占满、或该主题在三个目录里根本没有内容时，串行基线
        # 会（正确地）为空，本测试随即退化为比较空列表。下面这两条即因此被替换：
        # - "mitochondrial DNA replication"：三个目录里有 324 个匹配，但 bm25 前 9 名
        #   全是库外 `pdf` 长文（旧索引残留，T48 重建后消失），窗口被占满 → 兜底后为空；
        # - "oxidative phosphorylation"：三个目录里 **0** 个匹配（重建也救不回来）。
        queries = [
            "conversational agent",
            "线粒体自噬",
            "NAD+",
            "PINK1 Parkin pathway",
        ]
        serial = {q: [h["rowid"] for h in engine.search(q, topn=3)] for q in queries}

        collected: dict[str, list[list[int]]] = {q: [] for q in queries}
        lock = threading.Lock()

        def run(q: str) -> None:
            got = [h["rowid"] for h in rag_engine.get_engine("ai4s").search(q, topn=3)]
            with lock:
                collected[q].append(got)

        threads = [
            threading.Thread(target=run, args=(q,))
            for q in queries
            for _ in range(3)
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        for q in queries:
            with self.subTest(query=q):
                # 串行基线必须非空：否则 `assertEqual([], [])` 会让本测试在
                # 「语义路径根本没跑」（模型不可用等）时空洞通过。
                self.assertTrue(
                    serial[q], f"{q}: 串行基线为空——本测试退化为比较两个空列表"
                )
                self.assertEqual(len(collected[q]), 3, f"{q} 未跑满 3 次")
                for got in collected[q]:
                    self.assertEqual(
                        got, serial[q],
                        f"{q}: 并发结果与串行不一致——存在串扰或共享状态竞态",
                    )


class TestEngineInferenceHelpers(unittest.TestCase):
    """T05 交付的两个推理入口（`encode_texts` / `predict_pairs`）的直接测试。

    为什么要直接测：这两个方法在 T05 交付时**没有任何生产调用点**（T16/T17 才接线）。
    「定义了却没人调用、也没人测」正是本项目要消灭的缺陷类型
    （`_faiss_index()` 零调用点、`rerank=` 从未出现），故在 T05 内直接断言其行为。
    接线进度（2026-09-20）：`encode_texts` 已有生产调用点（T16 起，`semantic_search` /
    `semantic_search_exact` 都经它编码）；`predict_pairs` 自 T17 起由 `RAGEngine.rerank`
    调用，同样是生产路径。本类的直接测试继续保留 —— 它们钉的是入口自身的契约
    （形状/确定性/锁互斥/空输入），改由「有没有人调用」来覆盖会丢掉这些。

    本类全部打真模型，不 mock：
    - `encode_texts` → bge-m3（1024 维）
    - `predict_pairs` → bge-reranker-v2-m3 交叉编码器
    模型不可用时 `_embedder()` / `_reranker()` 会**静默返回 None**，入口随之返回 None；
    故每个测试先做非 None 前置断言，把「空洞通过」变成显式失败。
    """

    def setUp(self):
        rag_engine.reset_engines()

    def tearDown(self):
        rag_engine.reset_engines()

    def _engine(self):
        engine = rag_engine.get_engine("ai4s")
        self.assertIsNotNone(
            engine._embedder(),
            "bge-m3 未能从本地缓存加载：本测试会退化为空洞通过，故先在此失败",
        )
        return engine

    def test_encode_texts_shape_matches_configured_dim(self):
        """形状必须是 (len(texts), cfg['embed']['dim'])，不是硬编码的某个数。"""
        engine = self._engine()
        vecs = engine.encode_texts(["mitochondrial autophagy", "线粒体自噬"])
        self.assertIsNotNone(vecs, "encode_texts 返回 None：模型路径未生效")
        dim = engine.cfg["embed"]["dim"]
        self.assertEqual(tuple(vecs.shape), (2, dim), f"形状应为 (2, {dim})")

    def test_encode_texts_is_deterministic_for_same_text(self):
        engine = self._engine()
        first = engine.encode_texts(["线粒体自噬"])
        second = engine.encode_texts(["线粒体自噬"])
        self.assertIsNotNone(first, "encode_texts 返回 None：模型路径未生效")
        self.assertIsNotNone(second, "encode_texts 返回 None：模型路径未生效")
        self.assertTrue(
            np.array_equal(first, second), "同一文本两次编码结果不一致——不可复现"
        )

    def test_encode_texts_empty_list_returns_empty_result(self):
        engine = self._engine()
        vecs = engine.encode_texts([])
        self.assertIsNotNone(vecs, "encode_texts([]) 返回 None：下游会直接崩")
        self.assertEqual(len(vecs), 0, "空输入应得空结果")

    def test_predict_pairs_length_matches_input(self):
        engine = self._engine()
        pairs = [("线粒体自噬", "线粒体自噬受 PINK1 调控")]
        scores = engine.predict_pairs(pairs)
        self.assertIsNotNone(scores, "predict_pairs 返回 None：精排路径未生效")
        self.assertEqual(len(scores), len(pairs), "返回条数应等于输入对数")

    def test_predict_pairs_empty_list_returns_empty_result(self):
        """契约（controller 裁决）：`predict_pairs([])` 返回 `None`。

        实现里是 `if not reranker or not pairs: return None`——空输入在**取模型之前**
        就短路返回，故与模型是否可用无关。此处断言精确取值 `None`，不再用
        `x is None or len(x) == 0` 这种析取式：那种写法等价于「只要不抛异常就算过」，
        是典型的空洞通过。
        """
        engine = self._engine()
        self.assertIsNone(
            engine.predict_pairs([]), "空输入契约：应精确返回 None（不是空列表）"
        )

    def test_predict_pairs_ranks_matching_pair_above_unrelated_one(self):
        """这条断言才证明入口真的在打分排序，而不是返回常数。"""
        engine = self._engine()
        self.assertIsNotNone(engine._reranker(), "bge-reranker-v2-m3 未能加载")
        query = "mitochondrial autophagy"
        scores = engine.predict_pairs([
            (query, "mitochondrial autophagy is regulated by PINK1"),
            (query, "the history of Renaissance painting"),
        ])
        self.assertIsNotNone(scores, "predict_pairs 返回 None：精排路径未生效")
        self.assertEqual(len(scores), 2, "返回条数应等于输入对数")
        self.assertGreater(
            float(scores[0]), float(scores[1]),
            f"同主题对未排在无关对之前：{list(map(float, scores))}",
        )

    def test_encode_texts_concurrent_matches_serial(self):
        """并发边界：多线程对**同一 engine** 并发编码，每个结果必须等于串行结果。

        这条测试要证伪的是「推理入口允许并发进入模型」——那正是 _infer_lock 存在的理由。
        """
        engine = self._engine()
        text = "oxidative phosphorylation"
        serial = engine.encode_texts([text])
        self.assertIsNotNone(serial, "encode_texts 返回 None：模型路径未生效")

        n = 8
        barrier = threading.Barrier(n)
        results: list = [None] * n
        errors: list = []

        def work(i: int) -> None:
            try:
                barrier.wait(timeout=30)  # 让 n 个线程尽可能同时冲进推理入口
                results[i] = rag_engine.get_engine("ai4s").encode_texts([text])
            except Exception as exc:  # noqa: BLE001 —— 记下来在断言里暴露
                errors.append(exc)

        threads = [threading.Thread(target=work, args=(i,)) for i in range(n)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=120)

        self.assertEqual(errors, [], f"并发推理抛异常：{errors}")
        # 注意：不能用 assertNotIn(None, results)——results 里是 ndarray，
        # 成员判断会触发数组真值歧义（ValueError）。逐元素判 None。
        for i, got in enumerate(results):
            with self.subTest(thread=i):
                self.assertIsNotNone(got, f"线程 {i} 未拿到结果（超时或路径未生效）")
                self.assertTrue(
                    np.array_equal(got, serial),
                    f"线程 {i} 的编码结果与串行不一致——推理入口存在并发竞态",
                )

    def test_encode_texts_lock_is_mutually_exclusive(self):
        """证明 `_infer_lock` 提供的是**真互斥**，而不是「恰好可重入所以看着没事」。

        背景（review finding 1）：删掉 `with self._infer_lock` 后整套测试仍然全绿——
        因为 `emb.encode` 在小批量下本身可重入，删锁不产生可观测差异。
        故必须直接观测临界区：探针锁把 Barrier(2) 注入锁内，只有「同时 2 个线程在
        临界区内」才会放行。互斥成立 ⇒ barrier 必然超时破裂；不成立 ⇒ 放行且无异常。
        蕴含链与本测试为何对「删锁」敏感，见 `_BarrierInsideLockProbe` docstring。
        """
        engine = self._engine()
        real_lock = engine._infer_lock
        # 2 个参与方 + 超时给足裕度（互斥成立时本测试就是白等这一个超时，故超时值=耗时）。
        probe = _BarrierInsideLockProbe(real_lock, threading.Barrier(2, timeout=10))
        engine._infer_lock = probe
        texts = ["oxidative phosphorylation", "线粒体自噬"]
        errors: list = []
        err_lock = threading.Lock()

        def work(i: int) -> None:
            try:
                engine.encode_texts([texts[i]])
            except threading.BrokenBarrierError:
                pass  # 预期结果，由探针计数
            except Exception as exc:  # noqa: BLE001 —— 非预期异常记下来在断言里暴露
                with err_lock:
                    errors.append(exc)

        try:
            threads = [threading.Thread(target=work, args=(i,)) for i in range(2)]
            for t in threads:
                t.start()
            for t in threads:
                t.join(timeout=120)
        finally:
            engine._infer_lock = real_lock

        self.assertEqual(
            probe.entered, 2,
            "encode_texts 未走到推理锁：`with self._infer_lock` 被绕过或未被使用",
        )
        self.assertEqual(
            probe.max_inside, 1,
            f"临界区内同时出现 {probe.max_inside} 个线程——_infer_lock 未互斥",
        )
        self.assertEqual(
            probe.broken, 2,
            "锁内 barrier 未破裂：只有「2 个线程同时进入临界区」才会放行，"
            "故这正说明互斥不成立（见 _BarrierInsideLockProbe docstring 的蕴含链）",
        )
        self.assertEqual(errors, [], f"并发进入推理锁抛出非预期异常：{errors}")

    def test_encode_texts_concurrent_distinct_texts_match_serial(self):
        """**锁定路径**上的并发一致性：K 线程经 `encode_texts` 并发编码**各自不同**的文本，
        每个线程的结果必须等于该文本的单线程编码结果。

        与既有 `test_encode_texts_concurrent_matches_serial` 的分工：那条所有线程编码
        同一段文本，只能发现「结果整体被污染」；这条每条线程文本不同，还能发现
        「线程间输入/输出串台」（真实并发场景里各请求查询本来就不同）。
        也与 `TestEngineSingleton.test_concurrent_distinct_queries_do_not_cross_contaminate`
        互补：后者走 `engine.search()` → `semantic_search`（T16 后亦经 `encode_texts`，
        同样受锁保护），本测试则直接以 `encode_texts` 为入口、只盯推理锁本身。
        """
        engine = self._engine()
        self.assertIs(
            rag_engine.get_engine("ai4s"), engine, "并发一致性必须在同一 engine 上验证"
        )
        texts = [f"{i}: 线粒体自噬与氧化磷酸化 PINK1 Parkin {i}" for i in range(6)]
        serial = {t: engine.encode_texts([t]) for t in texts}
        for t in texts:
            self.assertIsNotNone(serial[t], f"串行基线为空（{t!r}）：模型路径未生效")

        n = len(texts)
        start = threading.Barrier(n)  # 让 K 个线程尽可能同时冲进推理入口
        results: list = [None] * n
        errors: list = []
        err_lock = threading.Lock()

        def work(i: int) -> None:
            try:
                start.wait(timeout=30)
                results[i] = rag_engine.get_engine("ai4s").encode_texts([texts[i]])
            except Exception as exc:  # noqa: BLE001 —— 记下来在断言里暴露
                with err_lock:
                    errors.append(exc)

        threads = [threading.Thread(target=work, args=(i,)) for i in range(n)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=120)

        self.assertEqual(errors, [], f"并发推理抛异常：{errors}")
        for i, t in enumerate(texts):
            with self.subTest(thread=i, text=t):
                self.assertIsNotNone(results[i], f"线程 {i} 未拿到结果（超时或路径未生效）")
                self.assertTrue(
                    np.array_equal(results[i], serial[t]),
                    f"线程 {i} 的结果与串行基线不一致（{t!r}）——推理入口存在并发串台",
                )


class TestLazyLoadFailureIsDiagnosed(unittest.TestCase):
    """懒加载失败必须**留下诊断**（宪法「`except` 至少记录到服务日志」）。

    T05 把引擎改成进程级单例后，一次临时失败（OOM / 缓存缺失 / 索引损坏）会被哨兵
    `False` 记住**整个进程**；此前每请求重建引擎还能自愈，现在只剩日志这一条线索，
    否则服务端只会表现为「语义检索恒为空」而毫无头绪。

    这里强制加载失败，断言：WARNING 有、异常本身（`exc_info`）有、失败对象与 lib 有；
    并断言哨兵记忆化**保留**（第二次调用不再重试，也不再重复告警）——那是 T05 的既有设计，
    本任务只补日志，不改回每请求重试（会重新引入约 9s 加载）。
    """

    def setUp(self):
        rag_engine.reset_engines()

    def tearDown(self):
        rag_engine.reset_engines()

    def test_embedder_load_failure_is_logged_with_exception(self):
        engine = rag_engine.get_engine("ai4s")
        # sys.modules 里置 None ⇒ `import sentence_transformers` 抛 ImportError，
        # 精确复现「模型加载失败」，且不需要真的去破坏本地缓存。
        with mock.patch.dict(sys.modules, {"sentence_transformers": None}):
            with self.assertLogs("rag_core.rag_engine", level="WARNING") as cm:
                self.assertIsNone(engine._embedder(), "加载失败时 _embedder() 应返回 None")
                self.assertIsNone(
                    engine._embedder(), "哨兵记忆化后第二次调用仍应返回 None"
                )
        self.assertEqual(len(cm.output), 1, f"应恰好告警一次（记忆化生效）：{cm.output}")
        self.assertIn("lib=ai4s", cm.output[0], "告警必须写明是哪个 lib 失败")
        self.assertIn("BAAI/bge-m3", cm.output[0], "告警必须写明哪个模型失败")
        self.assertIsNotNone(
            cm.records[0].exc_info, "except 必须带 exc_info 记录异常本身，否则无法定位原因"
        )

    def test_reranker_load_failure_is_logged_with_exception(self):
        engine = rag_engine.get_engine("ai4s")
        with mock.patch.dict(sys.modules, {"sentence_transformers": None}):
            with self.assertLogs("rag_core.rag_engine", level="WARNING") as cm:
                self.assertIsNone(engine._reranker(), "加载失败时 _reranker() 应返回 None")
        self.assertEqual(len(cm.output), 1, f"应恰好告警一次：{cm.output}")
        self.assertIn("lib=ai4s", cm.output[0], "告警必须写明是哪个 lib 失败")
        self.assertIn("bge-reranker-v2-m3", cm.output[0], "告警必须写明哪个模型失败")
        self.assertIsNotNone(cm.records[0].exc_info, "except 必须带 exc_info")

    def test_unusable_rerank_model_fails_fast_without_attempting_load(self):
        """配置不可用时 `_reranker()` 必须**快速失败**：不尝试加载、不联网、可观测。

        与 `test_reranker_load_failure_is_logged_with_exception` 的分工：那条覆盖
        「**真的去加载**、加载本身失败」（`sentence_transformers` 不可导入）；本条覆盖
        「**从未尝试加载**」的路径 —— `rerank.model` 为空（T17 起的默认值），
        或给了一个磁盘上不存在的取值。

        为什么必须快速失败：这类取值会被 `CrossEncoder` 当成 HuggingFace 仓库 id 去
        huggingface.co 找，等待时长由 hub 自己的重试策略决定（实测 **349s / 10 次重试**，
        见 task-17-report.md §7.1），期间**用户侧零信号** —— 与宪法 §3.3「可见地降级」
        正相反。只读离线部署（宪法 §1.2）下更不该让一次查询去联网。

        反面无空洞：真实本地路径仍必须真的加载出模型，由同文件的
        `TestEngineInferenceHelpers.test_predict_pairs_ranks_matching_pair_above_unrelated_one`
        与 `tests/test_rerank_wiring.py` 的 `setUpClass` 守着，故本用例不必再付一次加载。
        """
        cases = [
            ("empty", "", "未配置"),
            ("missing-path", str(Path(tempfile.gettempdir()) / "no-such-reranker-dir-t17"), "不存在"),
            ("hub-id-shaped", "BAAI/no-such-reranker-t17", "不存在"),
        ]
        for name, model, reason_hint in cases:
            with self.subTest(case=name, model=model):
                if model:
                    self.assertFalse(
                        Path(model).exists(), "本用例前提：该取值不是磁盘上已存在的路径")
                else:
                    # 空取值的前提就是「没配」。**不能**用 `Path(model).exists()` 判空串：
                    # `Path("")` 就是当前目录、`exists()` 为 True —— 实现里也因此必须
                    # 先判空再判路径，否则空配置会一路走到加载器去。
                    self.assertEqual(model, "", "空取值的语义：没配 rerank.model")
                rag_engine.reset_engines()   # 每个 case 要一个新的实例（哨兵 False 会被记住）
                engine = rag_engine.get_engine("ai4s")
                engine.cfg["rerank"]["model"] = model   # 只改本实例，不动配置文件
                # 断言的是「**从未尝试**加载」，不是「尝试了但失败」：构造器换成会炸的
                # mock，实现若真去构造 CrossEncoder，就会在这里留下调用记录。
                with mock.patch("sentence_transformers.CrossEncoder") as ctor:
                    ctor.side_effect = AssertionError("不得尝试加载不可用的精排模型")
                    with self.assertLogs("rag_core.rag_engine", level="WARNING") as cm:
                        t0 = time.perf_counter()
                        got = engine._reranker()
                        elapsed = time.perf_counter() - t0
                    ctor.assert_not_called()
                    self.assertIsNone(got, f"model={model!r} 时应降级为 None")
                    self.assertEqual(len(cm.output), 1, f"应恰好告警一次：{cm.output}")
                    self.assertIn("lib=ai4s", cm.output[0], "告警必须写明是哪个 lib")
                    self.assertIn("精排", cm.output[0], "告警必须写明是精排层失败")
                    self.assertIn(
                        reason_hint, cm.output[0],
                        f"告警必须写明**原因**（{reason_hint}），否则只剩「模型加载失败」"
                        f"这一句，无法区分「没配」与「配了但不存在」：{cm.output[0]}")
                    self.assertLess(
                        elapsed, 1.0,
                        f"耗时 {elapsed:.2f}s —— 快速失败路径不得去联网重试")
                    # 哨兵记忆化：第二次不再重试、不再告警、也不再尝试构造
                    with self.assertNoLogs("rag_core.rag_engine", level="WARNING"):
                        self.assertIsNone(
                            engine._reranker(), "哨兵记忆化后第二次调用仍应返回 None")
                    ctor.assert_not_called()

    def test_faiss_index_load_failure_is_logged_with_exception(self):
        engine = rag_engine.get_engine("ai4s")
        with tempfile.TemporaryDirectory() as td:
            bad = Path(td) / "broken.faiss"
            bad.write_bytes(b"this is not a faiss index")  # 损坏的索引文件
            Path(str(bad) + ".rows.json").write_text("[]", encoding="utf-8")
            engine.cfg["faiss_index"] = str(bad)  # 只改本实例，不动配置文件
            with self.assertLogs("rag_core.rag_engine", level="WARNING") as cm:
                self.assertIsNone(engine._faiss_index(), "索引不可用时应降级为 None")
        self.assertEqual(len(cm.output), 1, f"应恰好告警一次：{cm.output}")
        self.assertIn("lib=ai4s", cm.output[0], "告警必须写明是哪个 lib 失败")
        self.assertIn("broken.faiss", cm.output[0], "告警必须写明是哪个索引失败")
        self.assertIsNotNone(cm.records[0].exc_info, "except 必须带 exc_info")


if __name__ == "__main__":
    unittest.main()
