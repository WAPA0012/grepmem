# grepmem adapter for MemoryAgentBench (reference extraction).
#
# These methods are added to MAB's agent.AgentWrapper to register the "gpm"
# agent type (agent_name containing "gpm"), together with these two dispatch
# hooks in the existing code paths:
#
#   _initialize_agent_by_type:  elif self._is_agent_type("gpm"):
#                                   self._initialize_gpm_agent(agent_config, dataset_config)
#   send_message:               elif self._is_agent_type("gpm"):
#                                   return self._handle_gpm_agent(message, memorizing, query_id, context_id)
#
# Agent yaml (configs/agent_conf/Memory_Agents/*-gpm.yaml):
#   agent_name: Agentic_memory_gpm
#   model: step-3.7-flash          # any OpenAI-compatible generator
#   temperature: 0.0
#   input_length_limit: 10000000
#   buffer_length: 5000
#   output_dir: ./outputs/<name>
#   retrieve_num: 10
#   gpm_max_turns: 10
#
# Environment: GPM_API_URL (default http://127.0.0.1:18235), OPENAI_BASE_URL, OPENAI_API_KEY.
# Requires the grepmem server on this branch (/grep, /read endpoints, GREPMEM_DEDUP_THRESHOLD=1.01).
# See eval/memoryagentbench/README.md for the full evaluation report.

class GpmAgentMixin:
    """Drop-in mixin for MemoryAgentBench agent.AgentWrapper.
    Final form: v2g content-gated stack + 451-aware retry + two-tier thinking-rescue
    (reasoning_effort=low, then temperature 0.7). See README §Generator failure modes."""

    # ── grepmem agent-as-retriever loop (ported from eval/longmemeval-s-agent.mjs) ──

    GPM_TYPE_TIPS = {
        'single-session-user': 'TIP: The answer is in ONE session where the USER said it directly. Search for the topic noun (e.g. "marathon", "allergy", "company"). The user may have mentioned it casually — broaden with synonyms if exact match misses.',
        'single-session-assistant': 'TIP: The answer is in ONE session where the ASSISTANT (AI) said it. The user asked something, AI responded with the answer. Search the user\'s question keywords, then read the AI reply.',
        'single-session-preference': 'TIP: The answer is a preference/like/dislike the user expressed. Search for the topic noun AND preference verbs: "love", "like", "favorite", "enjoy", "hate", "prefer", "want", "wish".',
        'multi-session': 'TIP: The answer requires info from MULTIPLE sessions (often 2-3). Each session has part of the story. Don\'t stop after one verified hit — collect 3+ sessions that each contain a piece. Common pattern: "what\'s the difference between X and Y" → one session per topic.',
        'temporal-reasoning': 'TIP: The answer requires TIMELINE reasoning — order of events, latest/earliest, "what changed". Use memory_grep with date tokens ("2023", "January", "last month", "yesterday", "Spring"). When verifying, pay attention to timestamps. The CORRECT session may not be the most recent — re-read the question to know which time period it asks about.',
        'knowledge-update': 'TIP: The user\'s preference/answer CHANGED OVER TIME. The question asks for the CURRENT (latest) value. Find ALL sessions mentioning the topic, then verify which has the LATEST timestamp. Don\'t pick the first match — pick the most recent.',
    }

    GPM_TOOLS = [
        {"type": "function", "function": {
            "name": "memory_recall",
            "description": 'Semantic search via scored multi-pass grep. Returns ranked hits. Each summary is a chunk label like "chunk 7".',
            "parameters": {"type": "object", "properties": {
                "query": {"type": "string", "description": "Natural-language search query."},
                "typeFilter": {"type": "string", "enum": ["conversation", "knowledge"]},
                "limit": {"type": "integer", "description": "Max results (default 5)."},
            }, "required": ["query"]},
        }},
        {"type": "function", "function": {
            "name": "memory_grep",
            "description": 'Raw regex grep over the memory HTML. Returns line-level matches with their chunk labels. Use when memory_recall misses because your query uses a specific token (name, date, IP, error code, exact phrase). Use memory_read on a hit to verify.',
            "parameters": {"type": "object", "properties": {
                "pattern": {"type": "string", "description": 'Regex pattern. Examples: "Sarah", "Spring 2023", "Boston", " hiking".'},
                "limit": {"type": "integer", "description": "Max matches (default 15)."},
            }, "required": ["pattern"]},
        }},
        {"type": "function", "function": {
            "name": "memory_read",
            "description": "Read the FULL content of one memory chunk by its label (e.g. \"chunk 7\"). Use to verify a candidate actually contains the answer before promoting it to your final list. The conversation field has verbatim chat transcripts.",
            "parameters": {"type": "object", "properties": {
                "sessionId": {"type": "string", "description": 'The chunk label, e.g. "chunk 7".'},
            }, "required": ["sessionId"]},
        }},
    ]

    def _gpm_classify_question(self, question):
        """6-way LongMemEval question-type classification for the dynamic tip.
        Non-LME datasets or classification failure → '' (generic prompt)."""
        try:
            r = self._gpm_llm_call(
                model=self.model,
                messages=[
                    {"role": "system", "content": "你是 LongMemEval 问题类型分类器。严格返回 JSON。"},
                    {"role": "user", "content":
                     "将问题分类为以下六类之一：\n"
                     "- single-session-user: 答案是用户在某一轮直接说过的内容\n"
                     "- single-session-assistant: 答案是AI助手在某轮回复中给出的\n"
                     "- single-session-preference: 答案是用户表达的偏好/喜好\n"
                     "- multi-session: 需要综合多个会话的信息\n"
                     "- temporal-reasoning: 需要时间线推理（先后/最近/多久以前）\n"
                     "- knowledge-update: 用户的信息随时间变化，问当前最新值\n\n"
                     f"问题: {question}\n\n"
                     '返回 JSON: {"type": "类别名"}'},
                ],
                temperature=0.0,
                max_tokens=2000,
                response_format={"type": "json_object"},
                extra_body={"enable_thinking": False},
            )
            c = r.choices[0].message.content or ""
            if "{" in c:
                c = c[c.index("{"):c.rindex("}") + 1]
                t = json.loads(c).get("type", "")
                return t if t in self.GPM_TYPE_TIPS else ""
        except Exception as e:
            print(f"\n(gpm类型分类失败: {str(e)[:60]}, 无tip)\n")
        return ""

    def _gpm_build_system_prompt(self, question_type):
        tip = self.GPM_TYPE_TIPS.get(question_type, "")
        return f"""You are a retrieval agent searching chat-history memory for the answer to a user question.

You have THREE tools. Use them in this workflow:

1. **memory_recall(query, typeFilter, limit)** — primary discovery. Multi-pass grep with scoring. Returns ranked hits. Each summary is a chunk label like "chunk 7".

2. **memory_grep(pattern, limit)** — raw regex grep. Use when recall misses or you want to find an exact token (name, date, place). Returns matching lines + their chunk labels.

3. **memory_read(sessionId)** — read the FULL content of one memory chunk. Use to VERIFY a candidate. Reading a chunk that contains the answer is the strongest signal you can give.

STRATEGY (HARD RULES):
- Rule 1: First 3 turns MUST include AT LEAST 2 distinct memory_recall queries. Do NOT spend the first 5 turns only reading.
- Rule 2: Never read more than 3 chunks before issuing another recall/grep with a DIFFERENT query. If recall top-5 don't contain an obvious answer, RECALL AGAIN with synonyms/paraphrases — don't blindly read all 5.
- Rule 3: Diversify. If "marathon" gave no answer, try "race", "running", "5K", "training". If a date didn't work, try the place. If the noun didn't work, try the verb.
- Rule 4: Stop early. Once you've VERIFIED a chunk that clearly contains the answer, output the final JSON immediately. Don't keep searching for "more".
- Rule 5: Budget is up to {self.gpm_max_turns} tool calls. Spend ≥4 of them on recall/grep, ≤{min(6, self.gpm_max_turns - 2)} on read.

{tip}

OUTPUT (final turn only): Reply with ONLY a JSON array of chunk labels.
Format: ["chunk 7", "chunk 12"]
List the ones you've verified first, then unverified candidates."""

    def _gpm_agent_loop(self, question):
        """Run the tool-calling retrieval loop. Returns ranked chunk labels
        (verified > grep-hit > recall-count > agent-list order)."""
        collected = {}  # sid -> {verified, grepHit, recallCount, score}

        def record(sid, verified=False, grep_hit=False, recall=False):
            rec = collected.get(sid)
            if rec is not None:
                if verified: rec["verified"] = True
                if grep_hit: rec["grepHit"] = True
                rec["score"] = (100 if rec["verified"] else 0) + (10 if rec["grepHit"] else 0) + rec["recallCount"]
                if recall: rec["recallCount"] += 1
            else:
                rec = {"verified": verified, "grepHit": grep_hit,
                       "recallCount": 1 if recall else 0}
                rec["score"] = (100 if rec["verified"] else 0) + (10 if rec["grepHit"] else 0) + rec["recallCount"]
                collected[sid] = rec

        qtype = self._gpm_classify_question(question)
        messages = [
            {"role": "system", "content": self._gpm_build_system_prompt(qtype)},
            {"role": "user", "content": f"QUESTION: {question}\n\nStart searching. Call memory_recall NOW."},
        ]
        for turn in range(self.gpm_max_turns):
            try:
                # harness-faithful loop params: reasoning on, temperature 0.2,
                # no max_tokens cap (thinking needs headroom here)
                resp = self._gpm_llm_call(
                    model=self.model,
                    messages=messages,
                    temperature=0.2,
                    tools=self.GPM_TOOLS,
                    timeout=240,
                    extra_body={"reasoning_effort": "high"},
                )
            except Exception as e:
                # transient API failure / censorship: answer from what we have
                print(f"\n(gpm loop turn {turn} failed: {type(e).__name__}: {str(e)[:60]}; stopping loop)\n")
                break
            msg = resp.choices[0].message
            tool_calls = getattr(msg, "tool_calls", None) or []
            if tool_calls:
                messages.append({
                    "role": "assistant",
                    "content": msg.content,
                    "tool_calls": [
                        {"id": tc.id, "type": "function",
                         "function": {"name": tc.function.name, "arguments": tc.function.arguments}}
                        for tc in tool_calls
                    ],
                })
                for tc in tool_calls:
                    try:
                        args = json.loads(tc.function.arguments or "{}")
                    except Exception:
                        args = {}
                    name = tc.function.name
                    if name == "memory_recall":
                        r = self._gpm_api_call("/recall", body={
                            "query": args.get("query", ""), "spreadDepth": 0,
                            "typeFilter": args.get("typeFilter") or None}, timeout=300)
                        top = ((r or {}).get("results") or [])[:args.get("limit") or 5]
                        if top:
                            lines = "\n".join(
                                f"{i+1}. [{res.get('summary','')}] score={res.get('match')}\n"
                                f"   {(res.get('summary') or '')[:200]}"
                                for i, res in enumerate(top))
                            tool_result = (f'Recall results for "{args.get("query","")}":\n{lines}\n\n'
                                           "Call memory_read on a candidate to verify, or memory_grep for specific tokens.")
                            for res in top:
                                record(res.get("summary", ""), recall=True)
                        else:
                            tool_result = f'No recall matches for "{args.get("query","")}". Try memory_grep with specific tokens.'
                    elif name == "memory_grep":
                        r = self._gpm_api_call("/grep", body={
                            "pattern": args.get("pattern", ""), "limit": args.get("limit") or 15}, timeout=60)
                        matches = (r or {}).get("matches") or []
                        if not matches:
                            tool_result = f"No lines matched /{args.get('pattern','')}/."
                        else:
                            lines = "\n".join(
                                f"{i+1}. [{m.get('sessionId')}] line {m.get('line')}:\n   {m.get('text','')}"
                                for i, m in enumerate(matches))
                            tool_result = f"{len(matches)} grep match(es) for /{args.get('pattern','')}/:\n{lines}"
                            for m in matches:
                                record(m.get("sessionId", ""), grep_hit=True)
                    elif name == "memory_read":
                        sid = args.get("sessionId", "")
                        node = self._gpm_api_call("/read", body={"sessionId": sid}, timeout=120)
                        if not node or node.get("error"):
                            tool_result = f"Session {sid} not found."
                        else:
                            conv = node.get("conversation") or "(no conversation text)"
                            # chunks are ~16K chars (vs ~1.5K sessions upstream);
                            # scale the in-loop read window proportionally
                            trimmed = conv[:3000] + "...[truncated]" if len(conv) > 3000 else conv
                            tool_result = f"{node.get('summary','')} full content:\n{trimmed}"
                            record(sid, verified=True)
                    else:
                        tool_result = f"Unknown tool {name}"
                    messages.append({"role": "tool", "tool_call_id": tc.id, "content": tool_result})
                continue
            # no tool call → check for the final JSON array of chunk labels
            content = msg.content or ""
            final_match = re.search(r'\[\s*"[^"]+"(?:\s*,\s*"[^"]+")*\s*\]', content)
            if final_match:
                ids = re.findall(r'"([^"]+)"', final_match.group(0))
                for i, sid in enumerate(ids):
                    if sid not in collected:
                        collected[sid] = {"verified": False, "grepHit": False,
                                          "recallCount": 0, "score": 50 - i}
                break
            # nudge
            messages.append({"role": "assistant", "content": content})
            n_verified = sum(1 for c in collected.values() if c["verified"])
            messages.append({"role": "user", "content":
                             "Continue. Use memory_recall/grep to find more, OR output your final JSON array. "
                             f"{len(collected)} candidates so far ({n_verified} verified)."})
        ranked = [sid for sid, _ in sorted(collected.items(), key=lambda kv: -kv[1]["score"])]
        return ranked

    # ── gpm_v2 helpers (literature-backed upgrades; see eval report) ──
    # Layer 1: reconstruct whole-session nodes from 'Chat Time:' markers with
    #   parsed timestamps (LongMemEval-native granularity; Zep/MemOS-style
    #   temporal binding). Content-triggered: >=3 markers in the accumulated
    #   stream, no dataset labels. Non-conversational corpora fall back to the
    #   v1 chunk path with identical behavior.
    # Layer 2: RRF-fuse the agent loop's ranking with BM25 over the same
    #   nodes (hybrid retrieval standard; measured BM25 top-10 gold coverage
    #   is +20pt over single-pass grep on conversational text).

    def _gpm_v2_reset_state(self):
        self.gpm_v2_buf = ""
        self.gpm_v2_raw = []
        self.gpm_v2_texts = []          # [(sid, text)] mirror for BM25
        self.gpm_v2_session_mode = False
        self.gpm_v2_finalized = False
        self.gpm_v2_bm25 = None

    def _gpm_v2_add_session(self, text, date):
        sid = f"sess {len(self.gpm_v2_texts) + 1}"
        self._gpm_api_call("/addBatch", body={"items": [{
            "type": "conversation", "summary": sid,
            "conversation": text, "timestamp": date, "author": "mab",
        }]}, timeout=600)
        self.gpm_v2_texts.append((sid, text))

    def _gpm_v2_ingest(self, message):
        self.gpm_v2_raw.append(message)
        self.gpm_v2_buf += "\n" + message
        marks = list(re.finditer(r"Chat Time: ?(\d{4}/\d{1,2}/\d{1,2})", self.gpm_v2_buf))
        if not self.gpm_v2_session_mode and len(marks) >= 3:
            self.gpm_v2_session_mode = True
        if self.gpm_v2_session_mode and marks:
            cuts = [0] + [m.start() for m in marks]
            for i in range(len(cuts) - 1):
                seg = self.gpm_v2_buf[cuts[i]:cuts[i + 1]]
                date = marks[i - 1].group(1) if i > 0 else ""
                if len(seg.strip()) > 50:
                    self._gpm_v2_add_session(seg, date)
            self.gpm_v2_buf = self.gpm_v2_buf[cuts[-1]:]

    def _gpm_v2_finalize(self):
        """Flush the trailing session (or replay raw chunks when no session
        markers ever appeared), then build the BM25 index over the nodes."""
        if self.gpm_v2_finalized:
            return
        if self.gpm_v2_session_mode:
            if len(self.gpm_v2_buf.strip()) > 50:
                m = re.search(r"Chat Time: ?(\d{4}/\d{1,2}/\d{1,2})", self.gpm_v2_buf)
                self._gpm_v2_add_session(self.gpm_v2_buf, m.group(1) if m else "")
                self.gpm_v2_buf = ""
        else:
            for i, msg in enumerate(self.gpm_v2_raw):
                sid = f"chunk {i + 1}"
                self._gpm_api_call("/addBatch", body={"items": [{
                    "type": "conversation", "summary": sid,
                    "conversation": msg, "author": "mab",
                }]}, timeout=600)
                self.gpm_v2_texts.append((sid, msg))
        if self.gpm_v2_session_mode:
            # fusion stack is conversational-only: on synthetic/needle corpora
            # (RULER, factconsolidation) BM25 tf-idf dilutes grep's exact-hit
            # channels and costs 3-23pt (measured); keep the proven v1 ranking
            from langchain_community.retrievers import BM25Retriever
            from langchain_core.documents import Document
            self.gpm_v2_bm25 = BM25Retriever.from_documents(
                [Document(page_content=t[:20000], metadata={"sid": s}) for s, t in self.gpm_v2_texts])
        self.gpm_v2_finalized = True

    def _gpm_v2_rrf(self, loop_ranked, query):
        bm25_ids = []
        if self.gpm_v2_bm25 is not None:
            try:
                k = self.retrieve_num
                self.gpm_v2_bm25.k = k
                docs = (self.gpm_v2_bm25.invoke(query) if hasattr(self.gpm_v2_bm25, 'invoke')
                        else self.gpm_v2_bm25.get_relevant_documents(query))
                bm25_ids = [d.metadata["sid"] for d in docs[:k]]
            except Exception as e:
                print(f"\n(gpm_v2 BM25失败: {str(e)[:60]}, 只用循环结果)\n")
        scores = {}
        for ranking in (loop_ranked, bm25_ids):
            for r, sid in enumerate(ranking):
                scores[sid] = scores.get(sid, 0.0) + 1.0 / (60 + r + 1)
        return [sid for sid, _ in sorted(scores.items(), key=lambda kv: -kv[1])]

    def _initialize_gpm_agent(self, agent_config, dataset_config):
        """Initialize grepmem agent (HTML store + multi-pass grep retrieval, HTTP backend)."""
        self.retrieve_num = agent_config['retrieve_num']
        self.gpm_max_turns = agent_config.get('gpm_max_turns', 10)
        self.gpm_api = os.environ.get('GPM_API_URL', 'http://127.0.0.1:18235').rstrip('/')
        self.gpm_context_id = -1
        self.gpm_chunk_counter = 0
        self._gpm_v2_reset_state()
        self.client = self._create_oai_client()  # for answer generation
        self.agent_start_time = time.time()

    def _gpm_api_call(self, path, method="POST", body=None, timeout=300):
        """Call grepmem HTTP API."""
        import urllib.request
        url = f"{self.gpm_api}{path}"
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(url, data=data, method=method,
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:
            print(f"\n\nGPM API error {path}: {e}\n\n")
            return None

    def _gpm_llm_call(self, **kw):
        """LLM call with 451-aware retry. The step endpoint returns a misleading
        451 ("content you provided...") under concurrent load — the same payload
        passes on retry (verified by probe), so back off and retry instead of
        treating it as censorship."""
        last = None
        for attempt in range(4):
            try:
                return self.client.chat.completions.create(**kw)
            except Exception as e:
                if getattr(e, "status_code", None) == 451 and attempt < 3:
                    time.sleep(2 + attempt * 3)  # 2s, 5s, 8s
                    last = e
                    continue
                raise
        raise last

    def _handle_gpm_agent(self, message, memorizing, query_id, context_id):
        """Handle grepmem agent: addBatch on memorize, agentic grep loop + LLM on query.

        The query path replicates grepmem's published high-score configuration
        (eval/longmemeval-s-agent.mjs: MAX_TURNS=10, tools memory_recall /
        memory_grep / memory_read, hard-rules system prompt, per-type tip,
        verified>grep>recall ranking). Single-shot recall only reaches ~24%
        R@5; the multi-pass agent loop is the system's real capability."""
        if memorizing:
            # reset memory at each new context (fresh haystack per question set)
            if self.gpm_context_id != context_id:
                self._gpm_api_call("/reset", timeout=120)
                self.gpm_context_id = context_id
                self.gpm_chunk_counter = 0
                self._gpm_v2_reset_state()
            if "gpm_v2" in self.agent_name:
                # Layer 1: buffered session reconstruction (content-triggered)
                self._gpm_v2_ingest(message)
                return "Memorized"
            # one conversation node per chunk; unique summary (id = hash(summary))
            self.gpm_chunk_counter += 1
            self._gpm_api_call("/addBatch", body={"items": [{
                "type": "conversation",
                "summary": f"chunk {self.gpm_chunk_counter}",
                "conversation": message,
                "author": "mab",
            }]}, timeout=600)
            return "Memorized"
        else:
            memory_construction_time = time.time() - self.agent_start_time
            retrieval_query = self._extract_retrieval_query(message)
            is_v2 = "gpm_v2" in self.agent_name
            if is_v2:
                # flush trailing session / fallback chunks, build BM25 index
                self._gpm_v2_finalize()
            ranked = self._gpm_agent_loop(retrieval_query)
            if is_v2 and self.gpm_v2_session_mode:
                # Layer 2: RRF-fuse loop ranking with BM25 over the same nodes
                ranked = self._gpm_v2_rrf(ranked, retrieval_query)
            # fetch FULL chunk bodies for the ranked hits (in-loop reads are
            # truncated; the answer needs the whole chunk)
            recalled = []
            for sid in ranked[:self.retrieve_num]:
                node = self._gpm_api_call("/read", body={"sessionId": sid}, timeout=120)
                if node and not node.get("error"):
                    recalled.append(node)
            if is_v2 and self.gpm_v2_session_mode:
                # Layer 3: date-prefixed blocks (sessions carry timestamps) +
                # Chain-of-Note / quote-recency answering prompt (LongMemEval
                # authors report +10pt from structured reading prompts)
                blocks = []
                for i, r in enumerate(recalled):
                    date = (r.get("timestamp") or "").strip()
                    body = (r.get("conversation") or r.get("detail") or "").strip()
                    if len(body) > 16000:
                        body = body[:16000] + "...[truncated]"
                    blocks.append(f"[{i+1}] ({date or 'date unknown'}) {body}")
                retrieval_memory_string = "\n\n".join(blocks) or "No memories found."
                system_message = (
                    "You are a helpful AI. Answer the question based on the query and the "
                    "retrieved memories, each prefixed with its session date.\n\n"
                    + retrieval_memory_string + "\n\n"
                    "Guidelines:\n"
                    "1. First write brief notes: for each memory relevant to the question, "
                    "one short line (max 8 words) with its date.\n"
                    "2. End with exactly one final line in the format: Answer: <answer>\n"
                    "3. Use the memory's own wording. For questions about the user's "
                    "preferences, feelings or attitudes, quote the user's original "
                    "statement verbatim as the answer.\n"
                    "4. If memories conflict or something changed over time, use the value "
                    "from the memory with the LATEST date.\n"
                    "5. Be concise (a single phrase if possible). If no memory contains "
                    "the answer: Answer: unknown")
                format_message = [
                    {"role": "system", "content": system_message},
                    {"role": "user", "content": message},
                ]
            else:
                # BM25-shaped prompt (same system template + "Memory N:" blocks) so the
                # retriever is the only variable vs the rag_bm25 baseline
                retrieval_context = [
                    f"{(r.get('conversation') or r.get('detail') or r.get('summary', '') or '').strip()}\n"
                    for r in recalled
                ] or ["No memories found.\n"]
                retrieval_memory_string = "\n".join([f"Memory {i+1}:\n{text}" for i, text in enumerate(retrieval_context)])
                ask_llm_message = retrieval_memory_string + "\n" + message
                system_message = get_template(self.sub_dataset, 'system', self.agent_name)
                format_message = format_chat(message=ask_llm_message, system_message=system_message)
            response = None
            try:
                response = self._gpm_llm_call(
                    model=self.model,
                    messages=format_message,
                    temperature=self.temperature,
                    # step-3.7 reasoning_content eats small max_tokens budgets
                    max_tokens=max(self.max_tokens, 2000),
                    timeout=240,
                    extra_body={"enable_thinking": False},
                )
            except Exception:
                # transient failure / censorship (451): one large-budget retry
                try:
                    response = self.client.chat.completions.create(
                        model=self.model,
                        messages=format_message,
                        temperature=self.temperature,
                        max_tokens=16000,
                        timeout=480,
                        extra_body={"enable_thinking": False},
                    )
                except Exception as e:
                    print(f"\nGPM answer generation failed ({type(e).__name__}: {str(e)[:80]}); marking as miss\n")
            if response is not None:
                answer = response.choices[0].message.content
                if not answer:
                    # enable_thinking=False is IGNORED by the endpoint on large
                    # contexts: the model enters a deterministic thinking loop
                    # (>64k tokens, content never starts). Tier A: bound the
                    # reasoning with reasoning_effort=low. Tier B: sampling
                    # (temp 0.7) breaks the loop attractor. Both verified to
                    # return correct answers on rescued queries.
                    try:
                        retry = self._gpm_llm_call(
                            model=self.model,
                            messages=format_message,
                            temperature=self.temperature,
                            max_tokens=16000,
                            timeout=480,
                            extra_body={"enable_thinking": False, "reasoning_effort": "low"},
                        )
                        answer = retry.choices[0].message.content or ""
                    except Exception:
                        answer = ""
                    if not answer:
                        try:
                            retry2 = self._gpm_llm_call(
                                model=self.model,
                                messages=format_message,
                                temperature=0.7,
                                max_tokens=16000,
                                timeout=480,
                                extra_body={"enable_thinking": False, "reasoning_effort": "low"},
                            )
                            answer = retry2.choices[0].message.content or ""
                        except Exception:
                            answer = ""
                in_tok, out_tok = response.usage.prompt_tokens, response.usage.completion_tokens
            else:
                answer, in_tok, out_tok = "", 0, 0
            # TTL/ICL queries instruct "Only output label: {label}"; rewrite to the
            # parseable form (same convention as the dlm handler)
            m = re.match(r"^\s*label:\s*(.+?)\s*$", (answer or "").strip(), re.I | re.S)
            if m:
                answer = "Answer: " + m.group(1).strip().split("\n")[0]
            query_time_len = time.time() - self.agent_start_time - memory_construction_time
            output = self._create_standard_response(
                answer,
                in_tok,
                out_tok,
                memory_construction_time,
                query_time_len
            )
            self.agent_start_time = time.time()
            return output
