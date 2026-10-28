# Malcolm /v1/chat reliability patch — PREPARED ONLY, NOT DEPLOYED

Target: malcolmai-live, live version 147276d8 (`/workspace/aichef/malcolm_backup/malcolmai-live.v147276d8.deployed.js`, ~line 990).
Not applied: changing Malcolm requires a new Malcolm version and Oliver's explicit YES. AIChef works without it
(AIChef now caps a Malcolm attempt at 18 s and falls back to Workers AI, with a 60 s circuit breaker).

Why: when Gemini lite returns 503 / hangs, members currently wait up to 20 s before Malcolm tries Gemini (25 s) and then Groq.

```diff
-    chain.push(["gemini-lite", () => callGemini(env, sys, convo, fetch, { model: env.CHAT_MODEL || "gemini-3.5-flash-lite", timeoutMs: 20000 })]);
-    chain.push(["gemini", () => callGemini(env, sys, convo, fetch, { timeoutMs: 25000 })]);
-  }
-  if (env.GROQ_API_KEY) chain.push(["groq", () => callGroq(env, sys, convo, fetch, { timeoutMs: 15000 })]);
+    chain.push(["gemini-lite", () => callGemini(env, sys, convo, fetch, { model: env.CHAT_MODEL || "gemini-3.5-flash-lite", timeoutMs: 8000 })]);
+  }
+  // Groq (free tier) before full Gemini: fast and independent of Gemini's 503s.
+  if (env.GROQ_API_KEY) chain.push(["groq", () => callGroq(env, sys, convo, fetch, { timeoutMs: 8000 })]);
+  if (env.GEMINI_API_KEY) chain.push(["gemini", () => callGemini(env, sys, convo, fetch, { timeoutMs: 12000 })]);
```

Optional later: true token streaming (`"stream": true` -> SSE from Gemini `streamGenerateContent`), which AIChef's SSE endpoint could pass straight through.
