/* ============================================================
   Anu Council — Multi-AI Orchestration
   4 AIs think in parallel → Coordinator synthesizes ONE answer
   ============================================================ */

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

const COUNCIL_MODELS = [
  {
    id: 'openai/gpt-oss-120b',
    name: 'Master Reasoning',
    short: 'Master',
    icon: '🧠',
    role: 'Deep logical analysis and comprehensive reasoning'
  },
  {
    id: 'openai/gpt-oss-20b',
    name: 'Fast Core',
    short: 'Fast',
    icon: '⚡',
    role: 'Quick, direct answers and practical solutions'
  },
  {
    id: 'qwen/qwen3.6-27b',
    name: 'Logic Analyst',
    short: 'Logic',
    icon: '📊',
    role: 'Structured thinking and step-by-step analysis'
  },
  {
    id: 'meta-llama/llama-4-scout-17b-16e-instruct',
    name: 'Vision Scout',
    short: 'Scout',
    icon: '🌐',
    role: 'Broad knowledge and creative perspectives'
  }
];

const COORDINATOR_MODEL = 'openai/gpt-oss-120b';

const COUNCIL_SYSTEM_PROMPT = `You are a member of the Anu Council — a multi-AI system.
Your job: Provide your BEST possible answer to the user's question.
Be:
- Accurate and thoughtful
- Concise but complete
- Honest about uncertainties
- Match the user's language (Amharic → Amharic, English → English)
- Format with Markdown when helpful`;

const COORDINATOR_PROMPT = `You are the Anu Council Coordinator — the final synthesizer.

Multiple AI models have each answered the SAME question. Your task: produce ONE unified, superior answer.

RULES:
1. Combine the STRONGEST points from all responses
2. Resolve any contradictions — pick the most accurate
3. Remove redundancy and repetition
4. Structure clearly with Markdown (headings, bullets, code)
5. Be DIRECT — no meta-commentary like "based on the responses..."
6. Match the user's language
7. If models disagree, present the most likely correct answer with brief alternative if relevant
8. Length: comprehensive but not bloated

Output ONLY the final answer — nothing about the process.`;

/* ─── Call a single AI model ─── */
async function callModel(modelId, systemPrompt, userMessage, options = {}) {
  const key = process.env.GROQ_API_KEY;
  const maxTokens = options.maxTokens || 1200;
  const temperature = options.temperature ?? 0.7;
  const timeoutMs = options.timeoutMs || 8000;

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
      return { ok: false, error: `HTTP ${r.status}`, detail: errText.slice(0, 200) };
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

/* ─── Main Handler ─── */
export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'Anu Council is running',
      models: COUNCIL_MODELS.map(m => m.name),
      coordinator: 'Master Reasoning'
    });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

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

  console.log('[Council] Question:', userQuestion.slice(0, 80));
  console.log('[Council] Launching', COUNCIL_MODELS.length, 'AIs in parallel');

  /* ═══════════════════════════════════════
     PHASE 1 — All AIs think in parallel
     ═══════════════════════════════════════ */
  const phase1Start = Date.now();

  const modelPromises = COUNCIL_MODELS.map(async (model) => {
    const t0 = Date.now();
    const result = await callModel(
      model.id,
      COUNCIL_SYSTEM_PROMPT,
      userQuestion,
      { maxTokens: 900, temperature: 0.7, timeoutMs: 8000 }
    );
    const elapsed = Date.now() - t0;
    console.log(`[Council] ${model.name}: ${result.ok ? 'OK' : 'FAIL'} (${elapsed}ms)`);

    return {
      ...model,
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
      finalAnswer: '⚠️ All council members failed to respond. Please try again.',
      error: 'no_valid_responses',
      timing: { phase1: phase1Time, total: Date.now() - startTime }
    });
  }

  /* ═══════════════════════════════════════
     PHASE 2 — Coordinator synthesizes
     ═══════════════════════════════════════ */
  const phase2Start = Date.now();

  const synthesisInput = `USER QUESTION:
${userQuestion}

═══════════════════════════════════════
COUNCIL RESPONSES (${validResponses.length} models):
═══════════════════════════════════════
${validResponses.map((r, i) => `
─── ${r.icon} ${r.name} (${r.short}) ───
${r.response}
`).join('\n')}

═══════════════════════════════════════
Now synthesize ONE unified, superior answer to the question.`; 

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
    // Fallback: use the best single response
    finalAnswer = validResponses[0].response;
    console.warn('[Council] Synthesis failed, using fallback');
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
