/* ============================================================
   Anu Bot v18.0 — Final Production
   ------------------------------------------------------------
   ✅ Deep thinking (reasoning_effort: medium)
   ✅ Clean history (no escalation spam)
   ✅ Correct language matching (always)
   ✅ Proper escalation (only on current message)
   ✅ Natural delay before reply
   ✅ HTML-safe
   ============================================================ */

const SMART_MODEL = 'openai/gpt-oss-120b';

/* ═══════════════════════════════════════════════════════════
   FIREBASE
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
  } catch (e) { return null; }
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
  } catch (e) { return false; }
}

async function fsDelete(col, id) {
  try {
    const r = await fetch(`${FIRESTORE_BASE}/${col}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    return r.ok;
  } catch (e) { return false; }
}

/* ═══════════════════════════════════════════════════════════
   STATUS
   ═══════════════════════════════════════════════════════════ */
function todayKey() { return new Date().toISOString().split('T')[0]; }

async function getStatus() {
  const data = await fsGet('bot_status', 'daily');
  if (!data || data.date !== todayKey()) return null;
  return data;
}

async function setStatus(text, ownerName) {
  const data = { text, date: todayKey(), setAt: Date.now(), setBy: ownerName || 'owner' };
  await fsSet('bot_status', 'daily', data);
  return data;
}

async function clearStatus() { await fsDelete('bot_status', 'daily'); }

/* ═══════════════════════════════════════════════════════════
   IN-MEMORY STATE
   ═══════════════════════════════════════════════════════════ */
const state = { paused: false, introduced: new Set(), history: new Map() };

function getHist(chatId) {
  return state.history.get(String(chatId)) || [];
}

function addHist(chatId, role, content) {
  const k = String(chatId);
  const h = state.history.get(k) || [];
  // Only store actual conversation — skip escalation-only messages
  h.push({ role, content });
  state.history.set(k, h.slice(-6)); // keep only last 6
  if (state.history.size > 100) {
    const keys = [...state.history.keys()].slice(0, 50);
    keys.forEach(x => state.history.delete(x));
  }
}

function clearHist(chatId) {
  state.history.delete(String(chatId));
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
   GROQ AI — Deep thinking, no rush
   ═══════════════════════════════════════════════════════════ */
async function callAI(sysPrompt, messages, opts = {}) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return { ok: false, error: 'No API key' };

  const timeout = opts.timeoutMs || 20000;
  const controller = new AbortController();
  const tId = setTimeout(() => controller.abort(), timeout);

  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: SMART_MODEL,
        messages: [{ role: 'system', content: sysPrompt }, ...messages],
        temperature: opts.temperature ?? 0.7,
        max_tokens: opts.maxTokens || 300,
        top_p: 0.9,
        reasoning_effort: 'medium' // DEEP thinking, not too slow
      }),
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
  t = t.replace(/^(#{1,6}\s*)?(thinking|reasoning|chain of thought|analysis|my thought process|let me think|draft|tone|language):[\s\S]*?(?=\n\n[A-Z\u1200-\u137F]|\n#{1,6}\s|$)/gim, '');
  const draftMatch = t.match(/draft:\s*"([^"]+)"/i);
  if (draftMatch && t.length < 400) t = draftMatch[1];
  return t.trim();
}

/* ═══════════════════════════════════════════════════════════
   SYSTEM PROMPT — Crystal clear
   ═══════════════════════════════════════════════════════════ */
function sysPrompt(ownerName, senderName, status) {
  const statusText = (status && typeof status.text === 'string') ? status.text.trim() : '';
  const statusBlock = statusText
    ? `\n\n📢 TODAY'S STATUS (${ownerName}): "${statusText}"\nIf anyone asks where ${ownerName} is, tell them this.`
    : '';

  return `You are Anu — ${ownerName}'s AI assistant.

═══════════════════════════════════════════
🎯 IDENTITY
═══════════════════════════════════════════
- You are Anu
- You work FOR ${ownerName}
- You are NOT ${ownerName} — you are his assistant
- Speak about ${ownerName} in THIRD PERSON

═══════════════════════════════════════════
🧠 THINK FIRST, THEN REPLY
═══════════════════════════════════════════
Before replying, silently analyze:
1. What LANGUAGE did they use? (Amharic Ge'ez? English? Latin-Amharic?)
2. Is it a GREETING, QUESTION, or about ${ownerName}?
3. What is the CORRECT natural reply?

═══════════════════════════════════════════
🚨 REPLY RULES — READ CAREFULLY
═══════════════════════════════════════════

**RULE 1: Match language EXACTLY.**
If they wrote in Latin-Amharic, YOU write in Latin-Amharic.
If they wrote in Ge'ez, YOU write in Ge'ez.
If they wrote in English, YOU write in English.
NEVER mix.

**RULE 2: Just greet when greeted.**
- "hi" → "hi! endet neh? 😊" (Latin-Amharic) or "Hi! How are you? 😊" (English)
- "selam" → "selam! endet neh? 😊"
- "wendme" → "wendme! endet neh? 😊"
- "ሰላም" → "ሰላም! እንዴት ነህ? 😊"
NEVER escalate a simple greeting.

**RULE 3: Only escalate to ${ownerName} when the CURRENT message asks.**
Escalate ONLY if the message contains:
- "${ownerName}" as the MAIN subject (e.g., "${ownerName} ይኖራል?", "Where is ${ownerName}?")
- Or clear intent: "ጥራው", "አሳውቅ", "Tell ${ownerName}", "let him know"
Do NOT escalate just because "${ownerName}" is mentioned in passing.

**RULE 4: Reply naturally.**
- Short (1-2 sentences)
- Warm and human
- NO templates
- NO "I'll pass this along" for simple messages
- Natural emojis (😊 🙏 ✨ 💛)

═══════════════════════════════════════════
📋 SPECIFIC RESPONSES
═══════════════════════════════════════════

**Greeting:**
- "hi" / "hey" → "hi! endet neh? min lirdah? 😊"
- "selam" / "salam" → "selam! endet neh? 😊"
- "wendme" → "wendme! endet neh? 😊"
- "bro" → "bro! endet neh? 😊"
- "ሰላም" → "ሰላም! እንዴት ነህ? 😊"
- "dehna neh?" → "dehna negn! antes? 😊"

**About ${ownerName}:**
- "${ownerName} ይኖራል?" → "${ownerName} አለ! ለምን እንደሚፈልጉት ከነገሩኝ አሳውቀዋለሁ 🙏"
- "Where is ${ownerName}?" → "${ownerName} አለ! ለምን እንደሚፈልጉት ከነገሩኝ አሳውቀዋለሁ 🙏"
- With status: "${ownerName} ${statusText}. ለምን እንደሚፈልጉት ከነገሩኝ አሳውቀዋለሁ 🙏"

**Call/notify:**
- "ጥራው" / "አሳውቅ" / "Tell ${ownerName}" → "እሺ! ${ownerName} ን አሳውቀዋለሁ 🙏"

**Identity:**
- "who are you?" / "ማን ነህ?" → "እኔ Anu ነኝ — የ ${ownerName} AI ረዳት 😊"

═══════════════════════════════════════════
🚫 FORBIDDEN
═══════════════════════════════════════════
- NEVER reply with escalation for simple greetings
- NEVER say "I'll pass this along" unless they asked
- NEVER reveal AI model names
- NEVER show thinking
- NEVER write long paragraphs
- NEVER mix languages
- NEVER say "I am ${ownerName}"

═══════════════════════════════════════════
📝 OUTPUT
═══════════════════════════════════════════
Output ONLY the reply text. No reasoning, no drafts, no meta.${statusBlock}`;
}

/* ═══════════════════════════════════════════════════════════
   DETECTION — STRICT
   ═══════════════════════════════════════════════════════════ */
function wantsOwner(text) {
  const t = (text || '').toLowerCase().trim();

  // MUST be more specific — avoid false positives
  const patterns = [
    // Direct Ananya mention with intent
    /ananya\s*(ን|ni|n)?\s*(ጥራ|ንገረው|አሳውቅ|ንገራት|asaweq|nigerew|traw)/i,
    /(ጥራው|አሳውቅ|ንገረው|ንገራት|አሳውቂ|አሳውቀው).*(ananya|anani|አናንያ|አናኒ)/i,
    /(tell|notify|call|reach).*(ananya|anani)/i,
    // Amharic only
    /አናንያ\s*ን\s*(ጥራ|ንገረው|አሳውቅ|ንገራት)/,
    /አናኒ\s*ን\s*(ጥራ|ንገረው|አሳውቅ|ንገራት)/,
    // Latin-Amharic
    /\b(ananya|anani)\s+(n\s+)?(traw|nigerew|asaweq|nigerat|nigeren)\b/i,
    /\b(traw|nigerew|asaweq|nigerat)\s+(ananya|anani)\b/i,
    // Explicit "tell him" / "notify"
    /\b(tell him|tell her|let him know|let her know|pass this|forward this)\b/i,
    /\b(urgent|emergency|አስቸኳይ|ፈጣን)\b/i,
    /\b(balew|aschekayi|asfelagi|guday|sbsba|qetro)\b/i,
    /ባለቤት|አስቸኳይ|አስፈላጊ|ንግድ|ጉዳይ|ስብሰባ|ቀጠሮ/
  ];

  return patterns.some(p => p.test(t));
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
   WEAK REPLY CHECK
   ═══════════════════════════════════════════════════════════ */
function isWeak(reply, userText) {
  if (!reply) return true;
  const r = reply.toLowerCase().trim();
  const u = (userText || '').toLowerCase().trim();

  if (r.length < 8) return true;
  if (r === u) return true;

  // If sender's message is a simple greeting, reply shouldn't be escalation
  if (/^(hi|hey|hello|selam|salam|wendme|bro|ante|ሰላም|dehna)/i.test(u)) {
    if (/(asawq|አሳውቅ|እአሳውቅ|niger|ንገረው|notify|pass this|forward)/i.test(r)) {
      return true; // wrong — escalate on greeting
    }
  }

  return false;
}

/* ═══════════════════════════════════════════════════════════
   GENERATE REPLY
   ═══════════════════════════════════════════════════════════ */
async function generateReply(ownerName, senderName, userText, chatId, isFirst, status) {
  const sys = sysPrompt(ownerName, senderName, status);
  const hist = getHist(chatId).slice(-4).map(h => ({ role: h.role, content: h.content }));

  /* FIRST CONTACT */
  if (isFirst) {
    const introPrompt = `${sys}

🎯 FIRST CONTACT from "${senderName}".
- Introduce as "Anu, ${ownerName}'s AI assistant"
- Offer: (1) leave message for ${ownerName} OR (2) help directly
- Match their exact language
- 2-3 sentences max
- MUST include "Anu"`;

    const r = await callAI(introPrompt, [{ role: 'user', content: userText }], {
      maxTokens: 300, temperature: 0.85, timeoutMs: 15000
    });

    if (r.ok && /anu/i.test(r.content) && r.content.length > 30) {
      addHist(chatId, 'user', userText);
      addHist(chatId, 'assistant', r.content);
      return r.content;
    }

    const isAmharic = /[\u1200-\u137F]/.test(userText);
    const isLatin = /(selam|salam|dehna|endet|wendme|bro|ante|hi|hey)/i.test(userText);
    let fb;
    if (isAmharic) fb = `ሰላም ${senderName}! እኔ Anu ነኝ — የ ${ownerName} AI ረዳት 🤖\nለ ${ownerName} መልእክት ልላክ ወይስ ጥያቄ ልርዳህ? 💛`;
    else if (isLatin) fb = `selam ${senderName}! ene Anu negn — ye ${ownerName} AI redat 🤖\nLe ${ownerName} message lilak weys question lirdah? 💛`;
    else fb = `Hi ${senderName}! I'm Anu, ${ownerName}'s AI assistant 🤖\nI can help, or forward a message to ${ownerName}.\nWhat would you like? 💛`;

    addHist(chatId, 'user', userText);
    addHist(chatId, 'assistant', fb);
    return fb;
  }

  /* REGULAR */
  const userContent = `${senderName}: "${userText}"`;
  const r = await callAI(sys, [...hist, { role: 'user', content: userContent }], {
    maxTokens: 250, temperature: 0.8, timeoutMs: 15000
  });

  if (r.ok && !isWeak(r.content, userText)) {
    addHist(chatId, 'user', userText);
    addHist(chatId, 'assistant', r.content);
    return r.content;
  }

  /* Retry */
  if (r.ok) {
    console.warn('[Anu] Weak, retrying:', r.content?.slice(0, 60));
    const retrySys = `${sys}

🚨 RETRY:
- Match language EXACTLY (Latin-Amharic → Latin-Amharic)
- If greeting → just greet back naturally
- If about ${ownerName} → say "እሺ! ${ownerName} ን አሳውቀዋለሁ 🙏"
- NO templates, NO "I'll pass along" unless asked
- 1-2 sentences`;

    const retry = await callAI(retrySys, [{ role: 'user', content: userContent }], {
      maxTokens: 250, temperature: 0.85, timeoutMs: 12000
    });

    if (retry.ok && !isWeak(retry.content, userText)) {
      addHist(chatId, 'user', userText);
      addHist(chatId, 'assistant', retry.content);
      return retry.content;
    }
  }

  /* Fallback */
  const isAmharic = /[\u1200-\u137F]/.test(userText);
  const isLatin = /(selam|salam|dehna|endet|wendme|bro|ante|hi|hey)/i.test(userText);
  let fb;
  if (isAmharic) fb = `ሰላም! እንዴት ነህ? 😊`;
  else if (isLatin) fb = `hi! endet neh? min lirdah? 😊`;
  else fb = `Hey! How are you? 😊`;

  addHist(chatId, 'user', userText);
  addHist(chatId, 'assistant', fb);
  return fb;
}

/* ═══════════════════════════════════════════════════════════
   PHOTO
   ═══════════════════════════════════════════════════════════ */
async function analyzePhoto(ownerName, senderName, userText, isFirst, status) {
  const sys = sysPrompt(ownerName, senderName, status);
  const ctx = userText
    ? `[${senderName} sent a photo with caption: "${userText}"]`
    : `[${senderName} sent a photo]`;

  const instruction = isFirst
    ? `${ctx}\n\nAcknowledge photo AND introduce yourself as "Anu, ${ownerName}'s assistant".`
    : `${ctx}\n\nReact warmly — 1-2 sentences.`;

  const r = await callAI(sys, [{ role: 'user', content: instruction }], {
    maxTokens: 200, temperature: 0.85, timeoutMs: 12000
  });

  if (r.ok && r.content && r.content.length > 10) {
    if (isFirst && !/anu/i.test(r.content)) {
      return `Nice photo! I'm Anu, ${ownerName}'s assistant 😊 What can I help with?`;
    }
    return r.content;
  }
  return `Nice photo! 😊`;
}

/* ═══════════════════════════════════════════════════════════
   TYPING — Refresh every 4s
   ═══════════════════════════════════════════════════════════ */
function startTypingLoop(tg, chatId, bizConnId, isPhoto) {
  const payload = { chat_id: chatId, action: isPhoto ? 'upload_photo' : 'typing' };
  if (bizConnId) payload.business_connection_id = bizConnId;

  tg('sendChatAction', payload).catch(() => {});
  const interval = setInterval(() => {
    tg('sendChatAction', payload).catch(() => {});
  }, 4000);

  return () => clearInterval(interval);
}

/* ═══════════════════════════════════════════════════════════
   MAIN HANDLER
   ═══════════════════════════════════════════════════════════ */
export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'Anu Bot v18.0',
      identity: "Anu — Ananya's AI assistant",
      features: ['deep-thinking', 'clean-history', 'strict-escalation', 'typing-loop']
    });
  }
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');

  const BOT_TOKEN = process.env.BUSINESS_BOT_TOKEN;
  const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID;
  const OWNER_NAME = process.env.OWNER_NAME || 'Ananya';

  if (!BOT_TOKEN || !process.env.GROQ_API_KEY) {
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

  /* ══════════════ DIRECT MESSAGES ══════════════ */
  const dm = update.message;
  if (dm) {
    const fromId = dm.from?.id;
    const chatId = dm.chat.id;
    const txt = (dm.text || dm.caption || '').trim();
    const isFromOwner = isOwner(fromId);

    /* OWNER REPLY */
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
      } else {
        await tg('sendMessage', {
          chat_id: chatId,
          text: '⚠️ Use: /send <chat_id> <message>',
          reply_to_message_id: dm.message_id
        });
      }
      return res.status(200).json({ ok: true });
    }

    /* /start owner */
    if (isFromOwner && txt === '/start') {
      const status = await getStatus();
      const statusText = (status && typeof status.text === 'string') ? status.text : '';
      await tg('sendMessage', {
        chat_id: chatId,
        text:
          `✅ <b>Anu Bot v18.0</b>\n\n` +
          `🤖 Anu — ${esc(OWNER_NAME)}'s AI assistant\n\n` +
          `<b>Owner Commands:</b>\n` +
          `<code>/start</code> — This menu\n` +
          `<code>/status &lt;text&gt;</code> — Set status\n` +
          `<code>/status</code> — Show status\n` +
          `<code>/status clear</code> — Clear\n` +
          `<code>/stats</code> — Bot info\n` +
          `<code>/pause</code> / <code>/resume</code>\n` +
          `<code>/send &lt;chat_id&gt; &lt;text&gt;</code>\n` +
          `<code>/help</code>\n\n` +
          (statusText
            ? `📢 <b>Current:</b> <i>"${esc(statusText)}"</i>`
            : `<i>No status set.</i>`),
        parse_mode: 'HTML'
      });
      return res.status(200).json({ ok: true });
    }

    /* /status */
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
        await tg('sendMessage', { chat_id: chatId, text: '✅ Cleared.' });
        return res.status(200).json({ ok: true });
      }
      await setStatus(arg, OWNER_NAME);
      await tg('sendMessage', {
        chat_id: chatId,
        text: `✅ <b>Status set!</b>\n📢 <i>"${esc(arg)}"</i>`,
        parse_mode: 'HTML'
      });
      return res.status(200).json({ ok: true });
    }

    /* /help */
    if (isFromOwner && txt === '/help') {
      await tg('sendMessage', {
        chat_id: chatId,
        text: `<b>Owner Commands</b>\n\n• Reply to notifications\n• /status &lt;text&gt;\n• /status clear\n• /send &lt;id&gt; &lt;msg&gt;\n• /pause, /resume\n• /stats`,
        parse_mode: 'HTML'
      });
      return res.status(200).json({ ok: true });
    }

    /* /stats */
    if (isFromOwner && txt === '/stats') {
      const status = await getStatus();
      const statusText = (status && typeof status.text === 'string') ? status.text : '';
      await tg('sendMessage', {
        chat_id: chatId,
        text:
          `📊 <b>Bot Status</b>\n\n` +
          `✅ Online\n` +
          `🧠 Deep thinking model\n` +
          `💬 History: ${state.history.size}\n` +
          `👥 Known: ${state.introduced.size}\n` +
          `⏸️ Paused: ${state.paused ? 'Yes' : 'No'}\n` +
          `📢 Status: ${statusText ? 'Set ✅' : 'None'}`,
        parse_mode: 'HTML'
      });
      return res.status(200).json({ ok: true });
    }

    /* /pause, /resume */
    if (isFromOwner && txt === '/pause') {
      state.paused = true;
      await tg('sendMessage', { chat_id: chatId, text: '⏸️ Paused.' });
      return res.status(200).json({ ok: true });
    }
    if (isFromOwner && txt === '/resume') {
      state.paused = false;
      await tg('sendMessage', { chat_id: chatId, text: '▶️ Resumed.' });
      return res.status(200).json({ ok: true });
    }

    /* /send */
    if (isFromOwner && txt.startsWith('/send ')) {
      const parts = txt.slice(6).trim().split(/\s+/);
      const targetId = parts.shift();
      const msgText = parts.join(' ');
      if (!targetId || !msgText) {
        await tg('sendMessage', { chat_id: chatId, text: 'Usage: /send &lt;chat_id&gt; &lt;message&gt;', parse_mode: 'HTML' });
        return res.status(200).json({ ok: true });
      }
      const r = await tg('sendMessage', { chat_id: targetId, text: `anu bot: ${msgText}` });
      await tg('sendMessage', { chat_id: chatId, text: r && r.ok ? '✅ Sent' : '❌ Failed' });
      return res.status(200).json({ ok: true });
    }

    /* NON-OWNER */
    if (!isFromOwner && txt && !txt.startsWith('/')) {
      if (state.paused) return res.status(200).json({ ok: true });

      const senderName = dm.from?.first_name || 'there';
      const firstName = senderName.split(' ')[0];
      const isFirst = !state.introduced.has(String(chatId));

      console.log('[Anu] DM from', firstName, '| first:', isFirst, '| text:', txt);

      const status = await getStatus();
      const reply = await generateReply(OWNER_NAME, firstName, txt, chatId, isFirst, status);

      await tg('sendMessage', {
        chat_id: chatId,
        text: `anu bot: ${reply}`,
        reply_to_message_id: dm.message_id
      });

      if (isFirst) state.introduced.add(String(chatId));

      /* Escalation - strict */
      const sentiment = detectSentiment(txt);
      const needsOwner = wantsOwner(txt);

      console.log('[Anu] wantsOwner:', needsOwner, '| sentiment:', sentiment);

      if ((needsOwner || sentiment === 'urgent' || sentiment === 'angry') && OWNER_CHAT_ID) {
        let emoji = '🔔', label = 'Message';
        if (sentiment === 'urgent') { emoji = '🚨'; label = 'URGENT'; }
        else if (sentiment === 'angry') { emoji = '😠'; label = 'Angry'; }
        else if (needsOwner) { emoji = '📩'; label = 'Wants attention'; }

        await tg('sendMessage', {
          chat_id: OWNER_CHAT_ID,
          text:
            `${emoji} <b>${esc(label)}</b> from <b>${esc(firstName)}</b> (DM)\n\n` +
            `💬 <i>"${esc(txt)}"</i>\n\n` +
            `🤖 anu bot: <i>"${esc(reply.slice(0, 180))}${reply.length > 180 ? '…' : ''}"</i>\n\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `↩️ Reply to this message\n` +
            `📎 Or: <code>/send ${chatId} &lt;message&gt;</code>\n\n` +
            `REF:${chatId}:direct`,
          parse_mode: 'HTML'
        });
      }

      return res.status(200).json({ ok: true });
    }

    /* Non-owner /start */
    if (!isFromOwner && txt === '/start') {
      const senderName = dm.from?.first_name || 'there';
      const firstName = senderName.split(' ')[0];
      const isFirst = !state.introduced.has(String(chatId));
      const status = await getStatus();
      const reply = await generateReply(OWNER_NAME, firstName, '/start', chatId, isFirst, status);
      await tg('sendMessage', { chat_id: chatId, text: `anu bot: ${reply}` });
      if (isFirst) state.introduced.add(String(chatId));
      return res.status(200).json({ ok: true });
    }

    return res.status(200).json({ ok: true });
  }

  /* ══════════════ BUSINESS MESSAGES ══════════════ */
  const message = update.business_message || update.edited_business_message;
  if (!message) return res.status(200).json({ ok: true });

  const bizConnId = message.business_connection_id;
  const chatId = message.chat.id;
  const senderName = message.from?.first_name || 'there';
  const msgId = message.message_id;

  if (!bizConnId) return res.status(200).json({ ok: true });
  if (state.paused) return res.status(200).json({ ok: true });

  let userText = '';
  let isPhoto = false;
  if (message.text) userText = message.text.trim();
  else if (message.caption) userText = message.caption.trim();
  if (message.photo && message.photo.length > 0) isPhoto = true;

  if (!userText && !isPhoto) return res.status(200).json({ ok: true });
  if (userText.startsWith('/')) return res.status(200).json({ ok: true });

  const firstName = senderName.split(' ')[0];
  const isFirst = !state.introduced.has(String(chatId));

  console.log('[Anu] Business:', firstName, '| first:', isFirst, '| text:', userText);

  const stopTyping = startTypingLoop(tg, chatId, bizConnId, isPhoto);
  const status = await getStatus();
  let reply = '';
  try {
    if (isPhoto) {
      reply = await analyzePhoto(OWNER_NAME, firstName, userText, isFirst, status);
    } else {
      reply = await generateReply(OWNER_NAME, firstName, userText, chatId, isFirst, status);
    }
  } finally {
    stopTyping();
  }

  if (!reply) reply = `hi! endet neh? 😊`;

  await tg('sendMessage', {
    chat_id: chatId,
    text: `anu bot: ${reply}`,
    business_connection_id: bizConnId,
    reply_to_message_id: msgId
  });

  if (isFirst) state.introduced.add(String(chatId));

  const sentiment = detectSentiment(userText);
  const needsOwner = wantsOwner(userText);

  console.log('[Anu] wantsOwner:', needsOwner);

  if ((needsOwner || sentiment === 'urgent' || sentiment === 'angry') && OWNER_CHAT_ID) {
    let emoji = '🔔', label = 'Message';
    if (sentiment === 'urgent') { emoji = '🚨'; label = 'URGENT'; }
    else if (sentiment === 'angry') { emoji = '😠'; label = 'Angry'; }
    else if (needsOwner) { emoji = '📩'; label = 'Wants attention'; }

    await tg('sendMessage', {
      chat_id: OWNER_CHAT_ID,
      text:
        `${emoji} <b>${esc(label)}</b> from <b>${esc(firstName)}</b>\n\n` +
        `💬 <i>"${esc(userText || '[photo]')}"</i>\n\n` +
        `🤖 anu bot: <i>"${esc(reply.slice(0, 180))}"</i>\n\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `↩️ Reply to this message\n` +
        `📎 Or: <code>/send ${chatId} &lt;message&gt;</code>\n\n` +
        `REF:${chatId}:${bizConnId}`,
      parse_mode: 'HTML'
    });
  }

  return res.status(200).json({ ok: true });
}
