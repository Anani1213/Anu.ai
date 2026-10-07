/* ============================================================
   Anu Bot v22.0 — Multi-AI with Gemini
   ────────────────────────────────────────────────────────────
   ✅ Gemini 2.5 Flash (native Amharic + Latin Amharic + Vision)
   ✅ Multi-AI Chain: Draft → Verify (Gemini + Groq)
   ✅ 100% AI-generated replies (no hardcoded templates)
   ✅ Identity: "Anu, Ananya's assistant, created by Anany's"
   ✅ "anu bot:" prefix on every reply
   ✅ Firebase: memory, status, analytics
   ✅ Delayed typing (5-9s only)
   ✅ Owner dashboard + notifications
   ✅ Manual reply system
   ✅ HTML parse mode
   ============================================================ */

/* ═══════════════════════════════════════════════════════════
   CONFIG
   ═══════════════════════════════════════════════════════════ */
const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

const MODELS = {
  geminiFlash: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  geminiPro: 'gemini-2.5-pro',
  groqMaster: 'openai/gpt-oss-120b',
  groqFast: 'openai/gpt-oss-20b'
};

const MAX_MEMORY = 20;
const TYPING_MIN_MS = 5000;
const TYPING_MAX_MS = 9000;

/* ═══════════════════════════════════════════════════════════
   FIREBASE FIRESTORE REST
   ═══════════════════════════════════════════════════════════ */
const FIREBASE_PROJECT_ID = 'my-ai-eaf27';
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;

function toFS(val) {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'string') return { stringValue: val };
  if (typeof val === 'number') {
    return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
  }
  if (typeof val === 'boolean') return { booleanValue: val };
  if (Array.isArray(val)) return { arrayValue: { values: val.map(toFS) } };
  if (typeof val === 'object') {
    const fields = {};
    for (const k in val) fields[k] = toFS(val[k]);
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

function fromFS(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return parseInt(v.integerValue, 10);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFS);
  if ('mapValue' in v) {
    const o = {};
    for (const k in (v.mapValue.fields || {})) o[k] = fromFS(v.mapValue.fields[k]);
    return o;
  }
  return null;
}

function fromFSDoc(doc) {
  if (!doc || !doc.fields) return null;
  const o = {};
  for (const k in doc.fields) o[k] = fromFS(doc.fields[k]);
  return o;
}

async function fsGet(col, id) {
  try {
    const r = await fetch(`${FIRESTORE_BASE}/${col}/${encodeURIComponent(id)}`);
    if (!r.ok) return null;
    return fromFSDoc(await r.json());
  } catch (e) {
    return null;
  }
}

async function fsSet(col, id, data) {
  try {
    const fields = {};
    for (const k in data) fields[k] = toFS(data[k]);
    const mask = Object.keys(data).map(k => `updateMask.fieldPaths=${k}`).join('&');
    const r = await fetch(`${FIRESTORE_BASE}/${col}/${encodeURIComponent(id)}?${mask}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields })
    });
    return r.ok;
  } catch (e) {
    return false;
  }
}

async function fsDelete(col, id) {
  try {
    const r = await fetch(`${FIRESTORE_BASE}/${col}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    return r.ok;
  } catch (e) { return false; }
}

/* ═══════════════════════════════════════════════════════════
   MEMORY
   ═══════════════════════════════════════════════════════════ */
async function getMemory(chatId) {
  const data = await fsGet('bot_memory', String(chatId));
  return (data && Array.isArray(data.messages)) ? data.messages : [];
}

async function addToMemory(chatId, role, content, meta = {}) {
  try {
    const messages = await getMemory(chatId);
    messages.push({ role, content, ts: Date.now(), ...meta });
    await fsSet('bot_memory', String(chatId), {
      messages: messages.slice(-MAX_MEMORY),
      updatedAt: Date.now()
    });
  } catch (e) {}
}

async function clearMemory(chatId) {
  await fsDelete('bot_memory', String(chatId));
}

/* ═══════════════════════════════════════════════════════════
   DAILY STATUS
   ═══════════════════════════════════════════════════════════ */
function todayKey() {
  return new Date().toISOString().split('T')[0];
}

async function getStatus() {
  const data = await fsGet('bot_status', 'daily');
  if (!data || data.date !== todayKey()) return null;
  return data;
}

async function setStatus(text, ownerName) {
  const data = { text, date: todayKey(), setAt: Date.now(), setBy: ownerName };
  await fsSet('bot_status', 'daily', data);
  return data;
}

async function clearStatus() {
  await fsDelete('bot_status', 'daily');
}

/* ═══════════════════════════════════════════════════════════
   INTRODUCED
   ═══════════════════════════════════════════════════════════ */
async function isIntroduced(chatId) {
  const data = await fsGet('bot_introduced', String(chatId));
  return !!(data && data.introduced === true);
}

async function markIntroduced(chatId, senderName) {
  await fsSet('bot_introduced', String(chatId), {
    introduced: true,
    senderName,
    introducedAt: Date.now()
  });
}

/* ═══════════════════════════════════════════════════════════
   ANALYTICS
   ═══════════════════════════════════════════════════════════ */
async function track(event, amount = 1) {
  try {
    const day = todayKey();
    const data = await fsGet('bot_analytics', day);
    const count = (data && data[event]) ? data[event] : 0;
    await fsSet('bot_analytics', day, { [event]: count + amount, lastUpdate: Date.now() });
  } catch (e) {}
}

/* ═══════════════════════════════════════════════════════════
   PAUSED
   ═══════════════════════════════════════════════════════════ */
async function isPaused() {
  const data = await fsGet('bot_settings', 'global');
  return !!(data && data.paused === true);
}

async function setPaused(v) {
  await fsSet('bot_settings', 'global', { paused: v, changedAt: Date.now() });
}

/* ═══════════════════════════════════════════════════════════
   HTML ESCAPE
   ═══════════════════════════════════════════════════════════ */
function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/* ═══════════════════════════════════════════════════════════
   AI CALLER — Unified for Gemini & Groq
   ═══════════════════════════════════════════════════════════ */
async function callAI(provider, model, messages, opts = {}) {
  const timeout = opts.timeoutMs || 25000;
  const controller = new AbortController();
  const tId = setTimeout(() => controller.abort(), timeout);

  try {
    let endpoint, headers, payload;

    if (provider === 'gemini') {
      const key = process.env.GEMINI_API_KEY;
      if (!key) return { ok: false, error: 'No Gemini API key' };

      endpoint = GEMINI_ENDPOINT;
      headers = {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json'
      };
      payload = {
        model,
        messages,
        temperature: opts.temperature ?? 0.8,
        max_tokens: opts.maxTokens || 500,
        top_p: 0.95
      };
    } else if (provider === 'groq') {
      const key = process.env.GROQ_API_KEY;
      if (!key) return { ok: false, error: 'No Groq API key' };

      endpoint = GROQ_ENDPOINT;
      headers = {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json'
      };
      payload = {
        model,
        messages,
        temperature: opts.temperature ?? 0.8,
        max_tokens: opts.maxTokens || 500,
        top_p: 0.9,
        reasoning_effort: 'low'
      };
    } else {
      return { ok: false, error: 'Unknown provider' };
    }

    const r = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    clearTimeout(tId);

    if (!r.ok) {
      const t = await r.text();
      let reason = `HTTP ${r.status}`;
      try { reason = JSON.parse(t).error?.message || reason; } catch (e) {}
      return { ok: false, error: reason };
    }

    const data = await r.json();
    let content = data.choices?.[0]?.message?.content?.trim() || '';
    if (!content) return { ok: false, error: 'Empty' };

    content = cleanResp(content);
    return { ok: true, content };
  } catch (e) {
    clearTimeout(tId);
    return { ok: false, error: e.name === 'AbortError' ? 'Timeout' : e.message };
  }
}

function cleanResp(text) {
  if (!text) return text;
  let t = text;
  t = t.replace(/ thinking[\s\S]*?<\/think>/gi, '');
  t = t.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '');
  t = t.replace(/^(#{1,6}\s*)?(thinking|reasoning|analysis|let me think|draft):[\s\S]*?(?=\n\n[A-Z\u1200-\u137F]|\n#{1,6}\s|$)/gim, '');
  return t.trim();
}

/* ═══════════════════════════════════════════════════════════
   TELEGRAM PHOTO
   ═══════════════════════════════════════════════════════════ */
async function fetchPhotoBase64(botToken, fileId) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`);
    const data = await r.json();
    if (!data.ok) return null;
    const url = `https://api.telegram.org/file/bot${botToken}/${data.result.file_path}`;
    const img = await fetch(url);
    const buf = await img.arrayBuffer();
    if (buf.byteLength > 4000000) return null;
    return Buffer.from(buf).toString('base64');
  } catch (e) { return null; }
}

/* ═══════════════════════════════════════════════════════════
   SYSTEM PROMPT — AI generates everything
   ═══════════════════════════════════════════════════════════ */
function buildSystemPrompt(ownerName, senderName, status, isFirst, history) {
  const statusLine = (status && status.text)
    ? `\n\n📢 TODAY'S STATUS FROM ${ownerName.toUpperCase()}: "${status.text}"\nIf asked about ${ownerName}, mention this naturally.`
    : '';

  const firstLine = isFirst
    ? `\n\n🆕 FIRST MESSAGE from "${senderName}". Introduce yourself warmly as "Anu, ${ownerName}'s AI assistant".`
    : `\n\n💬 Continuing conversation with "${senderName}". Do NOT re-introduce yourself.`;

  return `You are **Anu** — the personal AI assistant of **${ownerName}**, an Ethiopian man.

═══════════════════════════════════════════
🎯 YOUR IDENTITY
═══════════════════════════════════════════
- Name: Anu
- Role: ${ownerName}'s AI assistant
- You work FOR ${ownerName} (you are NOT ${ownerName})
- Speak about ${ownerName} in third person
- If asked "who are you?" → "I'm Anu, ${ownerName}'s AI assistant"
- If asked "who created you?" / "who made you?" → "Created by Anany's"
- If asked "who is ${ownerName}?" → "${ownerName} is my boss — a wonderful Ethiopian man"

═══════════════════════════════════════════
🌍 LANGUAGE — YOU UNDERSTAND ALL
═══════════════════════════════════════════
You understand perfectly:
1. **Amharic** (Ge'ez script: ሰላም)
2. **Amharic-in-Latin** (selam, wendme, ante, endet neh, min adregnalh, etc.)
3. **English**
4. **Mixed**

**CRITICAL: Reply in the EXACT SAME language style they used.**
- If they wrote in Latin-Amharic → reply in Latin-Amharic
- If they wrote in Ge'ez → reply in Ge'ez  
- If they wrote in English → reply in English
- NEVER mix languages

═══════════════════════════════════════════
🇪🇹 LATIN-AMHARIC UNDERSTANDING
═══════════════════════════════════════════
You understand ALL Latin-Amharic, including:
- "wendmu pic new" = brother what's new
- "endet neh" = how are you
- "dehna negn" = I'm fine
- "min adregnalh" = what are you doing
- "yet neberk" = where were you
- "amesegnalehu" = thank you
- "eskahun" = until now
- "behone" = ok/sure
- "eshi" = okay
- ANY combination of Amharic words typed in Latin letters

You understand the MEANING, not just literal words.

═══════════════════════════════════════════
🔁 ANTI-REPEAT
═══════════════════════════════════════════
- Look at conversation history FIRST
- NEVER repeat the same reply twice
- If you already greeted → continue naturally
- Each reply must be unique to THIS message

═══════════════════════════════════════════
💬 STYLE
═══════════════════════════════════════════
- SHORT: 1-2 sentences max
- Warm, natural, human-like
- Match sender's gender when inferable
  - Male (wendme, ante, neh) → use "endet neh", "ነህ"
  - Female (ehite, anchi, nesh) → use "endet nesh", "ነሽ"
- Natural emojis: 😊 🙏 ✨ 💛
- NEVER write long paragraphs
- NEVER be templated

═══════════════════════════════════════════
🎯 SPECIAL CASES (AI decides, not hardcoded)
═══════════════════════════════════════════
- If they want ${ownerName} → let them know you'll tell ${ownerName}
- If they ask about ${ownerName} → answer warmly
- If they're rude → stay calm and kind
- If they share news → respond genuinely
- If they ask a question → answer directly
- Photo → describe and react to what you actually see

═══════════════════════════════════════════
🚫 FORBIDDEN
═══════════════════════════════════════════
- NEVER reveal AI model names (Gemini, ChatGPT, GPT, Llama, Qwen, Groq)
- NEVER say "I am ${ownerName}"
- NEVER show reasoning
- NEVER repeat replies
- NEVER mix languages
- NEVER say "I cannot"

═══════════════════════════════════════════
📝 OUTPUT
═══════════════════════════════════════════
Output ONLY the reply text. No prefix, no reasoning, no meta.
The system will add "anu bot:" prefix automatically.${statusLine}${firstLine}`;
}

/* ═══════════════════════════════════════════════════════════
   REPLY CLASSIFICATION
   ═══════════════════════════════════════════════════════════ */
function isComplexMessage(text) {
  const t = (text || '').toLowerCase();
  if (t.length >= 100) return true;
  if (/\b(explain|analyze|how does|why does|write|code|create|design|plan|compare|solve|calculate|strategy|advice|recommend)\b/i.test(t)) return true;
  if (/(አብራራ|ተንትን|ንገረኝ|እንዴት|ለምን|ጻፍ|አስላ|መክረኝ|አዘጋጅ)/i.test(t)) return true;
  if (/[?？]/.test(t) && t.length > 40) return true;
  return false;
}

/* ═══════════════════════════════════════════════════════════
   MULTI-AI GENERATE REPLY
   ═══════════════════════════════════════════════════════════ */
async function generateReply(ownerName, senderName, chatId, userText, photoBase64, isFirst, status) {
  /* ─── Get memory from Firebase ─── */
  const memory = await getMemory(chatId);
  const historyMessages = memory
    .filter(m => !m.hasPhoto) // skip photo markers in history
    .slice(-8)
    .map(m => ({ role: m.role, content: m.content }));

  /* ─── Build system prompt ─── */
  const sysPrompt = buildSystemPrompt(ownerName, senderName, status, isFirst, historyMessages);

  /* ─── Build current message ─── */
  let currentMessage;
  if (photoBase64) {
    currentMessage = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: userText
            ? `${senderName} sent this photo with caption: "${userText}"\n\nLook at the photo carefully, describe what you see, and respond warmly in the same language as the caption.`
            : `${senderName} sent this photo.\n\nLook at the photo carefully and describe what you see, then respond warmly.`
        },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${photoBase64}` } }
      ]
    };
  } else {
    currentMessage = { role: 'user', content: `${senderName}: "${userText}"` };
  }

  const messages = [
    { role: 'system', content: sysPrompt },
    ...historyMessages,
    currentMessage
  ];

  /* ═══════════════════════════════════════════════
     PHOTO → Gemini Vision (single call)
     ═══════════════════════════════════════════════ */
  if (photoBase64) {
    console.log('[Anu] Photo mode — Gemini Vision');

    const r = await callAI('gemini', MODELS.geminiFlash, messages, {
      maxTokens: 400,
      temperature: 0.85,
      timeoutMs: 25000
    });

    if (r.ok && r.content) {
      await addToMemory(chatId, 'user', userText || '[photo]', { hasPhoto: true, caption: userText || '' });
      await addToMemory(chatId, 'assistant', r.content, { photoDesc: true });
      return r.content;
    }

    console.error('[Anu] Vision failed:', r.error);
    return 'Nice photo! 😊';
  }

  /* ═══════════════════════════════════════════════
     COMPLEX → Multi-AI Chain
     ═══════════════════════════════════════════════ */
  if (isComplexMessage(userText)) {
    console.log('[Anu] COMPLEX mode — Multi-AI');

    /* Stage 1: Gemini drafts */
    const geminiPromise = callAI('gemini', MODELS.geminiFlash, messages, {
      maxTokens: 400,
      temperature: 0.85,
      timeoutMs: 18000
    });

    /* Stage 2: Groq Master drafts (parallel) */
    const groqPromise = callAI('groq', MODELS.groqMaster, messages, {
      maxTokens: 400,
      temperature: 0.85,
      timeoutMs: 18000
    });

    const [geminiRes, groqRes] = await Promise.all([geminiPromise, groqPromise]);

    const drafts = [];
    if (geminiRes.ok) drafts.push({ source: 'gemini', text: geminiRes.content });
    if (groqRes.ok) drafts.push({ source: 'groq', text: groqRes.content });

    console.log('[Anu] Drafts:', drafts.length);

    if (drafts.length === 0) {
      return /[\u1200-\u137F]/.test(userText) ? 'ሰላም! እንዴት ነህ? 😊' : 'Hey! How are you? 😊';
    }

    if (drafts.length === 1) {
      await addToMemory(chatId, 'user', userText);
      await addToMemory(chatId, 'assistant', drafts[0].text);
      return drafts[0].text;
    }

    /* Stage 3: Gemini verifies & synthesizes */
    const verifyPrompt = `You are Anu — ${ownerName}'s AI assistant. You're speaking with "${senderName}".

TWO AI DRAFTS have been created for this reply. Your job: produce ONE final, superior reply.

═══════════════════════════════════════════
📨 MESSAGE: "${userText}"

📝 DRAFT A (Gemini):
"${geminiRes.content}"

📝 DRAFT B (Groq):
"${groqRes.content}"

═══════════════════════════════════════════
🎯 YOUR TASK
═══════════════════════════════════════════
Combine the best elements. Produce ONE final reply as Anu.

REQUIREMENTS:
- Same language as their message
- Short (1-2 sentences)
- Warm, natural, human-like
- Unique (not repeating)
- If they asked about ${ownerName}, answer warmly
- NEVER mention "drafts", "models", or "AIs"
- Output ONLY the final reply text
- Just be Anu`;

    const finalRes = await callAI('gemini', MODELS.geminiFlash,
      [{ role: 'user', content: verifyPrompt }],
      { maxTokens: 400, temperature: 0.7, timeoutMs: 15000 }
    );

    let finalText = finalRes.ok && finalRes.content
      ? finalRes.content
      : geminiRes.content;

    finalText = finalText
      .replace(/^(final|reply|answer)\s*[:：]\s*/i, '')
      .replace(/^["']|["']$/g, '')
      .trim();

    await addToMemory(chatId, 'user', userText);
    await addToMemory(chatId, 'assistant', finalText);

    return finalText;
  }

  /* ═══════════════════════════════════════════════
     SIMPLE → Gemini Flash (single call, fast)
     ═══════════════════════════════════════════════ */
  console.log('[Anu] SIMPLE mode — Gemini Flash');

  const r = await callAI('gemini', MODELS.geminiFlash, messages, {
    maxTokens: 300,
    temperature: 0.85,
    timeoutMs: 15000
  });

  let finalText = r.ok && r.content ? r.content : '';

  if (!finalText) {
    // Fallback to Groq
    const gr = await callAI('groq', MODELS.groqMaster, messages, {
      maxTokens: 300,
      temperature: 0.85,
      timeoutMs: 15000
    });
    finalText = gr.ok && gr.content ? gr.content : '';
  }

  if (!finalText) {
    return /[\u1200-\u137F]/.test(userText) ? 'ሰላም! 😊' : 'Hey! 😊';
  }

  await addToMemory(chatId, 'user', userText);
  await addToMemory(chatId, 'assistant', finalText);

  return finalText;
}

/* ═══════════════════════════════════════════════════════════
   DETECTION
   ═══════════════════════════════════════════════════════════ */
function wantsOwner(text) {
  const t = (text || '').toLowerCase().trim();
  return /(ananya|anani|አናንያ|አናኒ|owner|boss|speak to|talk to|tell him|tell her|notify|reach her|reach him|contact her|contact him|let her know|let him know|pass this|forward this|ንገረው|ንገራት|ንገረኝ|አሳውቅ|አሳውቂ|አሳውቀው|አስታውቅ|ጥራው|ጥራት|ጥሪው|ደውል|ደውልለት|ደውልላት|አግኝ|አግኚ|ተናገር|ልናገር|ልናገራት|ልናገረው|nigerew|nigerat|nigeren|asawq|asekayi|asfelagi|guday|qetro|traw|tirat|dewil|agen|nager|lenager|balew|aschekayi)/i.test(t);
}

function detectSentiment(text) {
  const t = (text || '').toLowerCase();
  if (/(urgent|asap|emergency|አስቸኳይ|ፈጣን)/i.test(t)) return 'urgent';
  if (/(angry|upset|furious|mad|hate|😡|🤬|ተናደድኩ|ደደብ)/i.test(t)) return 'angry';
  if (/(sad|cry|😢|😭|አዘንኩ|ተቸገርኩ)/i.test(t)) return 'sad';
  if (/(happy|great|love|😊|😄|❤|ደስ|ጥሩ)/i.test(t)) return 'happy';
  return 'neutral';
}

function parseRef(text) {
  if (!text) return null;
  const m = text.match(/REF:([0-9-]+):([a-zA-Z0-9_-]+)/);
  if (!m) return null;
  return { chatId: m[1], bizConnId: m[2] === 'direct' ? null : m[2] };
}

/* ═══════════════════════════════════════════════════════════
   SEND WITH TYPING
   ═══════════════════════════════════════════════════════════ */
function calcTypingDelay(reply) {
  const len = (reply || '').length;
  const base = Math.min(len * 30, TYPING_MAX_MS);
  return Math.max(TYPING_MIN_MS, base);
}

async function sendWithTyping(tg, payload, replyText) {
  const delay = calcTypingDelay(replyText);
  const typingPayload = { chat_id: payload.chat_id, action: 'typing' };
  if (payload.business_connection_id) typingPayload.business_connection_id = payload.business_connection_id;

  await tg('sendChatAction', typingPayload).catch(() => {});

  const refreshAt = Math.floor(delay / 2);
  const refreshTimer = setTimeout(() => {
    tg('sendChatAction', typingPayload).catch(() => {});
  }, refreshAt);

  await new Promise(r => setTimeout(r, delay));
  clearTimeout(refreshTimer);

  return tg('sendMessage', payload);
}

/* ═══════════════════════════════════════════════════════════
   MAIN HANDLER
   ═══════════════════════════════════════════════════════════ */
export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'Anu Bot v22.0 — Multi-AI',
      identity: "Anu — Ananya's AI assistant",
      creator: "Created by Anany's",
      providers: {
        gemini: !!process.env.GEMINI_API_KEY,
        groq: !!process.env.GROQ_API_KEY
      },
      models: MODELS,
      features: [
        'gemini-native',
        'latin-amharic',
        'multi-ai-chain',
        'vision',
        'persistent-memory',
        'delayed-typing',
        'owner-dashboard'
      ]
    });
  }
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');

  const BOT_TOKEN = process.env.BUSINESS_BOT_TOKEN;
  const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID;
  const OWNER_NAME = process.env.OWNER_NAME || 'Ananya';

  if (!BOT_TOKEN || !process.env.GROQ_API_KEY || !process.env.GEMINI_API_KEY) {
    console.error('[Anu] Missing env vars');
    return res.status(200).end();
  }

  const update = req.body || {};
  const tAPI = (m) => `https://api.telegram.org/bot${BOT_TOKEN}/${m}`;

  async function tg(method, payload) {
    try {
      const r = await fetch(tAPI(method), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await r.json();
      if (!data.ok) console.error(`[Anu] ${method} FAILED:`, JSON.stringify(data).slice(0, 200));
      return data;
    } catch (e) {
      console.error(`${method}:`, e.message);
      return null;
    }
  }

  const isOwner = (fromId) => OWNER_CHAT_ID && String(fromId) === String(OWNER_CHAT_ID);

  /* ══════════════════════════════════════════════════════════
     DIRECT MESSAGES
     ══════════════════════════════════════════════════════════ */
  const dm = update.message;
  if (dm) {
    const fromId = dm.from?.id;
    const chatId = dm.chat.id;
    const txt = (dm.text || dm.caption || '').trim();
    const isFromOwner = isOwner(fromId);

    /* ─── 1️⃣ OWNER REPLY TO NOTIFICATION ─── */
    if (isFromOwner && dm.reply_to_message && txt) {
      const repliedText = dm.reply_to_message.text || dm.reply_to_message.caption || '';
      const ref = parseRef(repliedText);

      if (ref) {
        const payload = { chat_id: ref.chatId, text: `anu bot: ${txt}` };
        if (ref.bizConnId) payload.business_connection_id = ref.bizConnId;

        const sr = await tg('sendMessage', payload);
        await tg('sendMessage', {
          chat_id: chatId,
          text: sr && sr.ok ? '✅ Sent' : `❌ Failed`,
          reply_to_message_id: dm.message_id
        });
        if (sr && sr.ok) await track('manual_replies');
      } else {
        await tg('sendMessage', {
          chat_id: chatId,
          text: '⚠️ Use: <code>/send &lt;chat_id&gt; &lt;message&gt;</code>',
          parse_mode: 'HTML',
          reply_to_message_id: dm.message_id
        });
      }
      return res.status(200).json({ ok: true });
    }

    /* ─── 2️⃣ OWNER /start ─── */
    if (isFromOwner && txt === '/start') {
      const status = await getStatus();
      const statusText = (status && typeof status.text === 'string') ? status.text : '';
      await tg('sendMessage', {
        chat_id: chatId,
        text:
          `👑 <b>Anu Bot v22.0 — Admin Panel</b>\n` +
          `🎨 Created by Anany's\n` +
          `🧠 Providers: Gemini + Groq\n\n` +
          `<b>━━━ COMMANDS ━━━</b>\n` +
          `<b>📊 Dashboard</b>\n` +
          `<code>/stats</code> — Full dashboard\n` +
          `<code>/memory &lt;id&gt;</code> — View memory\n` +
          `<code>/forget &lt;id&gt;</code> — Clear memory\n\n` +
          `<b>💬 Messaging</b>\n` +
          `<code>/send &lt;id&gt; &lt;msg&gt;</code>\n` +
          `↩️ <i>Reply to notification</i>\n\n` +
          `<b>📢 Status</b>\n` +
          `<code>/status &lt;text&gt;</code>\n` +
          `<code>/status clear</code>\n\n` +
          `<b>⚙️ Control</b>\n` +
          `<code>/pause</code> / <code>/resume</code>\n\n` +
          (statusText ? `📢 <b>Today:</b> <i>"${esc(statusText)}"</i>` : `<i>No status set.</i>`),
        parse_mode: 'HTML'
      });
      return res.status(200).json({ ok: true });
    }

    /* ─── 3️⃣ OWNER /status ─── */
    if (isFromOwner && (txt === '/status' || txt.startsWith('/status '))) {
      const arg = txt.slice(8).trim();
      if (!arg) {
        const status = await getStatus();
        const statusText = (status && typeof status.text === 'string') ? status.text : '';
        await tg('sendMessage', {
          chat_id: chatId,
          text: statusText
            ? `📢 <b>Today:</b> <i>"${esc(statusText)}"</i>`
            : `ℹ️ Use: <code>/status ዛሬ አሞኛል</code>`,
          parse_mode: 'HTML'
        });
        return res.status(200).json({ ok: true });
      }
      if (arg === 'clear' || arg === 'delete' || arg === 'off') {
        await clearStatus();
        await tg('sendMessage', { chat_id: chatId, text: '🗑️ Cleared.' });
        return res.status(200).json({ ok: true });
      }
      await setStatus(arg, OWNER_NAME);
      await tg('sendMessage', {
        chat_id: chatId,
        text: `✅ <b>Status set!</b>\n\n📢 <i>"${esc(arg)}"</i>`,
        parse_mode: 'HTML'
      });
      return res.status(200).json({ ok: true });
    }

    /* ─── 4️⃣ OWNER /stats ─── */
    if (isFromOwner && txt === '/stats') {
      const status = await getStatus();
      const statusText = (status && typeof status.text === 'string') ? status.text : '';
      const paused = await isPaused();
      const today = await fsGet('bot_analytics', todayKey()) || {};

      const geminiStatus = process.env.GEMINI_API_KEY ? '✅' : '❌';
      const groqStatus = process.env.GROQ_API_KEY ? '✅' : '❌';

      await tg('sendMessage', {
        chat_id: chatId,
        text:
          `📊 <b>Anu Bot — Admin Dashboard</b>\n` +
          `🎨 Created by Anany's\n\n` +
          `<b>━━━ STATUS ━━━</b>\n` +
          `🟢 Bot: <b>Online</b>\n` +
          `⏸️ Paused: <b>${paused ? 'YES' : 'No'}</b>\n` +
          `📢 Daily Status: <b>${statusText ? 'Set ✅' : 'None'}</b>\n\n` +
          `<b>━━━ PROVIDERS ━━━</b>\n` +
          `${geminiStatus} Gemini API\n` +
          `${groqStatus} Groq API\n\n` +
          `<b>━━━ MODELS ━━━</b>\n` +
          `🌟 Gemini: <code>${MODELS.geminiFlash}</code>\n` +
          `🧠 Groq Master: <code>${MODELS.groqMaster}</code>\n` +
          `👁️ Vision: <code>${MODELS.geminiFlash}</code>\n\n` +
          `<b>━━━ TODAY ━━━</b>\n` +
          `💬 Messages: <b>${today.messages || 0}</b>\n` +
          `👥 Conversations: <b>${today.conversations || 0}</b>\n` +
          `📸 Photos: <b>${today.photos || 0}</b>\n` +
          `🔔 Escalations: <b>${today.escalations || 0}</b>\n` +
          `✍️ Manual replies: <b>${today.manual_replies || 0}</b>\n\n` +
          `<b>━━━ SYSTEM ━━━</b>\n` +
          `💾 Memory: Firebase (${MAX_MEMORY}/chat)\n` +
          `⏱️ Typing delay: 5-9s\n` +
          `🔗 Chain: Gemini + Groq → Verify`,
        parse_mode: 'HTML'
      });
      return res.status(200).json({ ok: true });
    }

    /* ─── 5️⃣ OWNER /memory ─── */
    if (isFromOwner && txt.startsWith('/memory ')) {
      const targetId = txt.slice(8).trim();
      if (!targetId) {
        await tg('sendMessage', { chat_id: chatId, text: 'Usage: <code>/memory &lt;chat_id&gt;</code>', parse_mode: 'HTML' });
        return res.status(200).json({ ok: true });
      }
      const memory = await getMemory(targetId);
      if (!memory.length) {
        await tg('sendMessage', { chat_id: chatId, text: `📭 No memory for <code>${esc(targetId)}</code>`, parse_mode: 'HTML' });
        return res.status(200).json({ ok: true });
      }
      const summary = memory.slice(-10).map(m => {
        const who = m.role === 'user' ? '👤' : '🤖';
        const time = new Date(m.ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        return `${who} [${time}] ${esc((m.content || '').slice(0, 60))}`;
      }).join('\n');
      await tg('sendMessage', {
        chat_id: chatId,
        text: `🧠 <b>Memory:</b> <code>${esc(targetId)}</code>\n<i>Last ${Math.min(10, memory.length)} of ${memory.length}</i>\n\n${summary}`,
        parse_mode: 'HTML'
      });
      return res.status(200).json({ ok: true });
    }

    /* ─── 6️⃣ OWNER /forget ─── */
    if (isFromOwner && txt.startsWith('/forget ')) {
      const targetId = txt.slice(8).trim();
      if (!targetId) {
        await tg('sendMessage', { chat_id: chatId, text: 'Usage: <code>/forget &lt;chat_id&gt;</code>', parse_mode: 'HTML' });
        return res.status(200).json({ ok: true });
      }
      await clearMemory(targetId);
      await tg('sendMessage', { chat_id: chatId, text: `🗑️ Cleared <code>${esc(targetId)}</code>`, parse_mode: 'HTML' });
      return res.status(200).json({ ok: true });
    }

    /* ─── 7️⃣ OWNER /pause ─── */
    if (isFromOwner && txt === '/pause') {
      await setPaused(true);
      await tg('sendMessage', { chat_id: chatId, text: '⏸️ <b>AI paused</b>', parse_mode: 'HTML' });
      return res.status(200).json({ ok: true });
    }

    /* ─── 8️⃣ OWNER /resume ─── */
    if (isFromOwner && txt === '/resume') {
      await setPaused(false);
      await tg('sendMessage', { chat_id: chatId, text: '▶️ <b>AI resumed</b>', parse_mode: 'HTML' });
      return res.status(200).json({ ok: true });
    }

    /* ─── 9️⃣ OWNER /send ─── */
    if (isFromOwner && txt.startsWith('/send ')) {
      const parts = txt.slice(6).trim().split(/\s+/);
      const targetId = parts.shift();
      const msgText = parts.join(' ');
      if (!targetId || !msgText) {
        await tg('sendMessage', { chat_id: chatId, text: 'Usage: <code>/send &lt;id&gt; &lt;msg&gt;</code>', parse_mode: 'HTML' });
        return res.status(200).json({ ok: true });
      }
      const r = await tg('sendMessage', { chat_id: targetId, text: `anu bot: ${msgText}` });
      await tg('sendMessage', { chat_id: chatId, text: r && r.ok ? '✅ Sent' : '❌ Failed' });
      if (r && r.ok) await track('manual_replies');
      return res.status(200).json({ ok: true });
    }

    /* ─── 🔟 NON-OWNER DIRECT MESSAGE ─── */
    if (!isFromOwner && txt && !txt.startsWith('/')) {
      if (await isPaused()) return res.status(200).json({ ok: true });

      const senderName = dm.from?.first_name || 'there';
      const firstName = senderName.split(' ')[0];
      const isFirst = !(await isIntroduced(chatId));

      console.log('[Anu] DM from', firstName, '| first:', isFirst, '| text:', txt.slice(0, 60));

      const status = await getStatus();
      let reply = '';
      try {
        reply = await generateReply(OWNER_NAME, firstName, chatId, txt, null, isFirst, status);
      } catch (e) {
        console.error('[Anu] Error:', e.message);
        reply = /[\u1200-\u137F]/.test(txt) ? 'ሰላም! እንዴት ነህ? 😊' : 'Hey! How are you? 😊';
      }

      await sendWithTyping(tg, {
        chat_id: chatId,
        text: `anu bot: ${reply}`,
        reply_to_message_id: dm.message_id
      }, reply);

      if (isFirst) {
        await markIntroduced(chatId, firstName);
        await track('conversations');
      }
      await track('messages');

      /* Escalation */
      const sentiment = detectSentiment(txt);
      const needsOwner = wantsOwner(txt);

      if ((needsOwner || sentiment === 'urgent' || sentiment === 'angry') && OWNER_CHAT_ID) {
        let emoji = '🔔', label = 'Message';
        if (sentiment === 'urgent') { emoji = '🚨'; label = 'URGENT'; }
        else if (sentiment === 'angry') { emoji = '😠'; label = 'Angry'; }
        else if (needsOwner) { emoji = '📩'; label = 'Wants attention'; }

        await tg('sendMessage', {
          chat_id: OWNER_CHAT_ID,
          text:
            `${emoji} <b>${esc(label)}</b>\n` +
            `👤 <b>From:</b> ${esc(firstName)}\n` +
            `🆔 <b>Chat:</b> <code>${chatId}</code>\n\n` +
            `<b>💬 Message:</b>\n<i>"${esc(txt)}"</i>\n\n` +
            `<b>🤖 Anu replied:</b>\n<i>"${esc(reply.slice(0, 200))}"</i>\n\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `↩️ <b>Reply to this message</b>\n` +
            `📎 Or: <code>/send ${chatId} &lt;message&gt;</code>\n\n` +
            `<code>REF:${chatId}:direct</code>`,
          parse_mode: 'HTML'
        });
        await track('escalations');
      }

      return res.status(200).json({ ok: true });
    }

    /* ─── Non-owner /start ─── */
    if (!isFromOwner && txt === '/start') {
      const senderName = dm.from?.first_name || 'there';
      const firstName = senderName.split(' ')[0];
      const isFirst = !(await isIntroduced(chatId));

      const status = await getStatus();
      let reply = '';
      try {
        reply = await generateReply(OWNER_NAME, firstName, chatId, 'Hi, I just started the bot', null, isFirst, status);
      } catch (e) {
        reply = `Hi! I'm Anu, ${OWNER_NAME}'s AI assistant 😊 How can I help?`;
      }

      await sendWithTyping(tg, {
        chat_id: chatId,
        text: `anu bot: ${reply}`
      }, reply);

      if (isFirst) {
        await markIntroduced(chatId, firstName);
        await track('conversations');
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(200).json({ ok: true });
  }

  /* ══════════════════════════════════════════════════════════
     BUSINESS MESSAGES
     ══════════════════════════════════════════════════════════ */
  const message = update.business_message || update.edited_business_message;
  if (!message) return res.status(200).json({ ok: true });

  const bizConnId = message.business_connection_id;
  const chatId = message.chat.id;
  const senderName = message.from?.first_name || 'there';
  const msgId = message.message_id;

  if (!bizConnId) {
    console.error('[Anu] Missing business_connection_id');
    return res.status(200).json({ ok: true });
  }

  if (await isPaused()) return res.status(200).json({ ok: true });

  let userText = '';
  let photoBase64 = null;
  let isPhoto = false;

  if (message.text) userText = message.text.trim();
  else if (message.caption) userText = message.caption.trim();

  if (message.photo && message.photo.length > 0) {
    isPhoto = true;
    const largest = message.photo[message.photo.length - 1];
    photoBase64 = await fetchPhotoBase64(BOT_TOKEN, largest.file_id);
    if (photoBase64) {
      console.log('[Anu] Photo fetched:', Math.round(photoBase64.length / 1024), 'KB');
    }
  }

  if (!userText && !isPhoto) return res.status(200).json({ ok: true });
  if (userText.startsWith('/')) return res.status(200).json({ ok: true });

  const firstName = senderName.split(' ')[0];
  const isFirst = !(await isIntroduced(chatId));

  console.log('[Anu] Business:', firstName, '| first:', isFirst, '| photo:', isPhoto, '| text:', (userText || '').slice(0, 60));

  const status = await getStatus();
  let reply = '';
  try {
    reply = await generateReply(OWNER_NAME, firstName, chatId, userText, photoBase64, isFirst, status);
  } catch (e) {
    console.error('[Anu] Error:', e.message);
    reply = /[\u1200-\u137F]/.test(userText) ? 'ሰላም! እንዴት ነህ? 😊' : 'Hey! How are you? 😊';
  }

  if (!reply) reply = /[\u1200-\u137F]/.test(userText) ? 'ሰላም! 😊' : 'Hey! 😊';

  await sendWithTyping(tg, {
    chat_id: chatId,
    text: `anu bot: ${reply}`,
    business_connection_id: bizConnId,
    reply_to_message_id: msgId
  }, reply);

  if (isFirst) {
    await markIntroduced(chatId, firstName);
    await track('conversations');
  }
  await track('messages');
  if (isPhoto) await track('photos');

  /* Escalation */
  const sentiment = detectSentiment(userText);
  const needsOwner = wantsOwner(userText);

  if ((needsOwner || sentiment === 'urgent' || sentiment === 'angry') && OWNER_CHAT_ID) {
    let emoji = '🔔', label = 'Message';
    if (sentiment === 'urgent') { emoji = '🚨'; label = 'URGENT'; }
    else if (sentiment === 'angry') { emoji = '😠'; label = 'Angry'; }
    else if (needsOwner) { emoji = '📩'; label = 'Wants attention'; }

    await tg('sendMessage', {
      chat_id: OWNER_CHAT_ID,
      text:
        `${emoji} <b>${esc(label)}</b>\n` +
        `👤 <b>From:</b> ${esc(firstName)}\n` +
        `🆔 <b>Chat:</b> <code>${chatId}</code>\n\n` +
        `<b>💬 Message:</b>\n<i>"${esc(userText || '[photo]')}"</i>\n\n` +
        `<b>🤖 Anu replied:</b>\n<i>"${esc(reply.slice(0, 200))}"</i>\n\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `↩️ <b>Reply to this message</b>\n` +
        `📎 Or: <code>/send ${chatId} &lt;message&gt;</code>\n\n` +
        `<code>REF:${chatId}:${bizConnId}</code>`,
      parse_mode: 'HTML'
    });
    await track('escalations');
  }

  return res.status(200).json({ ok: true });
}
