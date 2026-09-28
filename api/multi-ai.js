/* ============================================================
   Anu Council — Multi-AI Orchestration v3
   Uses ONLY verified working Groq models:
   • openai/gpt-oss-120b
   • openai/gpt-oss-20b
   • qwen/qwen3.8-27b
   ============================================================ */

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

/* ═══════════════════════════════════════════════════════════
   COUNCIL MEMBERS
   4 distinct personalities using 3 verified models:
   • GPT OSS 120B  → Master Reasoning (deep analysis)
   • GPT OSS 20B   → Fast Core (quick & practical)
   • Qwen 3.8 27B  → Logic Analyst (structured thinking)
   • GPT OSS 120B  → Vision Scout (creative perspectives)
   ═══════════════════════════════════════════════════════════ */
const COUNCIL_MODELS = [
  {
    id: 'openai/gpt-oss-120b',
    name: 'Master Reasoning',
    short: 'Master',
    icon: '🧠',
    role: 'Deep logical analysis and comprehensive reasoning',
    systemPrompt: `You are the MASTER REASONING member of the Anu Council.

YOUR STRENGTH: Deep, thorough analysis with attention to nuance and complexity.

APPROACH:
- Analyze the question from multiple angles
- Consider edge cases and contradictions
- Provide comprehensive reasoning
- Be precise and detailed
- Match the user's language (Amharic → Amharic, English → English)

Give your BEST answer. Be thorough but not verbose. Use Markdown.`
  },
  {
    id: 'openai/gpt-oss-20b',
    name: 'Fast Core',
    short: 'Fast',
    icon: '⚡',
    role: 'Quick, direct answers and practical solutions',
    systemPrompt: `You are the FAST CORE member of the Anu Council.

YOUR STRENGTH: Speed, directness, practical value.

APPROACH:
- Give the most DIRECT and USEFUL answer
- Skip fluff and preamble
- Focus on what actually works
- Be concise but complete
- Match the user's language (Amharic → Amharic, English → English)

Give your BEST answer. Be practical, not theoretical. Use Markdown when helpful.`
  },
  {
    id: 'qwen/qwen3.8-27b',
    name: 'Logic Analyst',
    short: 'Logic',
    icon: '📊',
    role: 'Structured thinking and step-by-step analysis',
    systemPrompt: `You are the LOGIC ANALYST member of the Anu Council.

YOUR STRENGTH: Structured, step-by-step, logical decomposition.

APPROACH:
- Break the problem into clear steps
- Use numbered lists and structured format
- Show your reasoning process
- Verify your logic before answering
- Match the user's language (Amharic → Amharic, English → English)

Give your BEST answer. Be systematic and clear. Use Markdown with headings/lists.`
  },
  {
    id: 'openai/gpt-oss-120b',
    name: 'Vision Scout',
    short: 'Scout',
    icon: '🌐',
    role: 'Broad knowledge and creative perspectives',
    systemPrompt: `You are the VISION SCOUT member of the Anu Council.

YOUR STRENGTH: Creative thinking, alternative perspectives, out-of-the-box ideas.

APPROACH:
- Explore unconventional angles
- Bring in analogies and examples
- Consider long-term or big-picture implications
- Offer creative alternatives
- Match the user's language (Amharic → Amharic, English → English)

Give your BEST answer. Be insightful and creative but still accurate. Use Markdown.`
  }
];

const COORDINATOR_MODEL = 'openai/gpt-oss-120b';

/* ─── Coordinator prompt ─── */
const COORDINATOR_PROMPT = `You are the Anu Council Coordinator — the final synthesizer.

Multiple AI members have each answered the SAME question from different angles. Your task: produce ONE unified, superior answer.

RULES:
1. Combine the STRONGEST points from all responses
2. Resolve any contradictions — pick the most accurate
3. Remove redundancy and repetition
4. Structure clearly with Markdown (headings, bullets, code)
5. Be DIRECT — no meta-commentary like "based on the responses..."
6. Match the user's language (Amharic → Amharic, English → English)
7. If models disagree, present the most likely correct answer with brief alternative if relevant
8. Length: comprehensive but not bloated

CRITICAL: Output ONLY the final answer — nothing about the council process, no mentions of "models said", no meta-commentary. Just the answer the user needs.`;

/* ═══════════════════════════════════════════════════════════
   SINGLE MODEL CALL
   ═══════════════════════════════════════════════════════════ */
async function callModel(modelId, systemPrompt, userMessage, options = {}) {
  const key = process.env.GROQ_API_KEY;
  const maxTokens = options.maxTokens || 1200;
  const temperature = options.temperature ?? 0.7;
  const timeoutMs = options.timeoutMs || 8000;

  if (!key) return { ok: false, error: 'API key not set' };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const r = await fetch(GROQ_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: modelId,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage }
        ],
        temperature,
        max_tokens: maxTokens
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!r.ok) {
      const errText = await r.text();
      let reason = `HTTP ${r.status}`;
      try {
        const parsed = JSON.parse(errText);
        if (parsed.error?.message) reason = parsed.error.message;
      } catch (e) {}
      return { ok: false, error: reason, status: r.status };
    }

    const data = await r.json();
    const content = data.choices?.[0]?.message?.content?.trim() || '';
    if (!content) return { ok: false, error: 'Empty response' };

    return { ok: true, content };
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === 'AbortError') return { ok: false, error: 'Timeout' };
    return { ok: false, error: e.message };
  }
}

/* ═══════════════════════════════════════════════════════════
   MAIN HANDLER
   ═══════════════════════════════════════════════════════════ */
export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'Anu Council v3 is running',
      models: COUNCIL_MODELS.map(m => ({ name: m.name, id: m.id })),
      coordinator: COORDINATOR_MODEL
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const GROQ_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_KEY) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  const { question } = req.body || {};
  if (!question || !question.trim()) {
    return res.status(400).json({ error: 'Question is required' });
  }

  const userQuestion = question.trim().slice(0, 4000);
  const startTime = Date.now();

  console.log('[Council] Q:', userQuestion.slice(0, 80));
  console.log('[Council] Launching', COUNCIL_MODELS.length, 'AIs in parallel');

  /* ═══════════════════════════════════════
     PHASE 1 — All AIs think in parallel
     ═══════════════════════════════════════ */
  const phase1Start = Date.now();

  const modelPromises = COUNCIL_MODELS.map(async (model) => {
    const t0 = Date.now();
    const result = await callModel(
      model.id,
      model.systemPrompt,
      userQuestion,
      { maxTokens: 900, temperature: 0.7, timeoutMs: 8000 }
    );
    const elapsed = Date.now() - t0;
    console.log(`[Council] ${model.name} (${model.id}): ${result.ok ? 'OK' : 'FAIL: ' + result.error} (${elapsed}ms)`);

    return {
      id: model.id,
      name: model.name,
      short: model.short,
      icon: model.icon,
      role: model.role,
      response: result.ok ? result.content : null,
      error: result.ok ? null : result.error,
      elapsed,
      ok: result.ok
    };
  });

  const councilResults = await Promise.all(modelPromises);
  const phase1Time = Date.now() - phase1Start;

  const validResponses = councilResults.filter(r => r.ok && r.response);
  console.log('[Council] Phase 1 done:', validResponses.length, '/', COUNCIL_MODELS.length, 'succeeded in', phase1Time, 'ms');

  if (validResponses.length === 0) {
    return res.status(200).json({
      question: userQuestion,
      responses: councilResults,
      finalAnswer: '⚠️ All council members failed. Please check Vercel logs and try again.',
      error: 'no_valid_responses',
      timing: { phase1: phase1Time, phase2: 0, total: Date.now() - startTime }
    });
  }

  /* ═══════════════════════════════════════
     PHASE 2 — Coordinator synthesizes
     ═══════════════════════════════════════ */
  const phase2Start = Date.now();

  const synthesisInput = `USER QUESTION:
${userQuestion}

═══════════════════════════════════════
COUNCIL RESPONSES (${validResponses.length} members):
═══════════════════════════════════════
${validResponses.map((r) => `
─── ${r.icon} ${r.name} ───
${r.response}
`).join('\n')}

═══════════════════════════════════════
Now synthesize ONE unified, superior answer to the question. Output ONLY the final answer.`;

  const synthesisResult = await callModel(
    COORDINATOR_MODEL,
    COORDINATOR_PROMPT,
    synthesisInput,
    { maxTokens: 2000, temperature: 0.4, timeoutMs: 9000 }
  );

  const phase2Time = Date.now() - phase2Start;

  let finalAnswer;
  if (synthesisResult.ok) {
    finalAnswer = synthesisResult.content;
    console.log('[Council] Synthesis OK in', phase2Time, 'ms');
  } else {
    finalAnswer = validResponses[0].response;
    console.warn('[Council] Synthesis failed:', synthesisResult.error, '→ using fallback');
  }

  const totalTime = Date.now() - startTime;
  console.log('[Council] Total:', totalTime, 'ms');

  return res.status(200).json({
    question: userQuestion,
    responses: councilResults,
    finalAnswer,
    synthesisOk: synthesisResult.ok,
    timing: {
      phase1: phase1Time,
      phase2: phase2Time,
      total: totalTime
    },
    timestamp: Date.now()
  });
}
