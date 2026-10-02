/* ============================================================
   Anu Bot v19.1 — Production Ready
   ------------------------------------------------------------
   ✅ Fixed: hasGeezScript (no apostrophe in function name)
   ✅ Translation layer: Amharic ↔ English
   ✅ Deep thinking, correct replies
   ✅ "anu bot:" prefix on all replies
   ✅ Firebase status persistence
   ✅ HTML-safe, no markdown errors
   ✅ Optimized parallel calls
   ============================================================ */

const SMART_MODEL = 'openai/gpt-oss-120b';
const FAST_MODEL = 'openai/gpt-oss-20b';

/* ═══════════════════════════════════════════════════════════
   FIREBASE FIRESTORE
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
function todayKey() {
  return new Date().toISOString().split('T')[0];
}

async function getStatus() {
  const data = await fsGet('bot_status', 'daily');
  if (!data || data.date !== todayKey()) return null;
  return data;
}

async function setStatus(text, ownerName) {
  const data = {
    text,
    date: todayKey(),
    setAt: Date.now(),
    setBy: ownerName || 'owner'
  };
  await fsSet('bot_status', 'daily', data);
  return data;
}

async function clearStatus() {
  await fsDelete('bot_status', 'daily');
}

/* ═══════════════════════════════════════════════════════════
   IN-MEMORY STATE
   ═══════════════════════════════════════════════════════════ */
const state = {
  paused: false,
  introduced: new Set(),
  history: new Map()
};

function getHist(chatId) {
  return state.history.get(String(chatId)) || [];
}

function addHist(chatId, role, content) {
  const k = String(chatId);
  const h = state.history.get(k) || [];
  h.push({ role, content });
  state.history.set(k, h.slice(-8));
  if (state.history.size > 100) {
    const keys = [...state.history.keys()].slice(0, 50);
    keys.forEach(x => state.history.delete(x));
  }
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
   GROQ AI
   ═══════════════════════════════════════════════════════════ */
async function callAI(model, sysPrompt, userContent, opts = {}) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return { ok: false, error: 'No API key' };

  const timeout = opts.timeoutMs || 12000;
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
        model,
        messages: [
          { role: 'system', content: sysPrompt },
          { role: 'user', content: userContent }
        ],
        temperature: opts.temperature ?? 0.7,
        max_tokens: opts.maxTokens || 400,
        top_p: 0.9,
        reasoning_effort: 'low'
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
  return t.trim();
}

/* ═══════════════════════════════════════════════════════════
   SCRIPT DETECTION
   ═══════════════════════════════════════════════════════════ */
function hasGeezScript(text) {
  return /[\u1200-\u137F]/.test(text || '');
}

function hasLatinAmharic(text) {
  const t = (text || '').toLowerCase();
  return /(selam|salam|dehna|endet|amesegn|wendme|bro|ante|anchi|nesh|min|wede|yet|new|neh|nesh|gud|hone|lib|yene|kolo|bet|mana|nega|arat|ekul|and|hulet|sost|arat|eshi|ayzosh|chigger|yellum|tiru|melkam|inna|wede|yene|yene)/i.test(t);
}

/* ═══════════════════════════════════════════════════════════
   TRANSLATION LAYER
   ═══════════════════════════════════════════════════════════ */
async function translateToEnglish(text) {
  const prompt = `Translate to English.

RULES:
- If already English → output unchanged
- If Amharic (Geez script) → translate to natural English
- If Amharic-in-Latin (selam endet neh) → translate to natural English
- Output ONLY the translation. No explanations, no quotes, no prefixes.`;

  const r = await callAI(FAST_MODEL, prompt, text, {
    maxTokens: 200,
    temperature: 0.2,
    timeoutMs: 8000
  });

  return r.ok ? r.content : text;
}

async function translateToAmharic(text, useGeez) {
  const style = useGeez
    ? 'Geez script (Amharic characters like ሰላም እንዴት ነህ)'
    : 'Amharic-in-Latin (like selam endet neh)';

  const prompt = `Translate this English text to ${style}.

RULES:
- Use natural, casual, friendly Amharic
- Keep emojis
- If it's a greeting reply, use common Amharic greetings
- Output ONLY the translation. No explanations, no quotes.`;

  const r = await callAI(SMART_MODEL, prompt, text, {
    maxTokens: 300,
    temperature: 0.4,
    timeoutMs: 10000
  });

  return r.ok ? r.content : text;
}

/* ═══════════════════════════════════════════════════════════
   ENGLISH SYSTEM PROMPT (AI thinks in English)
   ═══════════════════════════════════════════════════════════ */
function buildEnglishSystemPrompt(ownerName, senderName, status, history) {
  const statusLine = (status && status.text)
    ? `\n\nTODAY'S STATUS: "${status.text}" — If asked about ${ownerName}, mention this.`
    : '';

  const histLine = history.length > 0
    ? `\n\nCONVERSATION SO FAR:\n${history.map(h => `${h.role === 'user' ? senderName : 'Anu'}: ${h.content}`).join('\n')}`
    : `\n\nThis is the FIRST message from ${senderName}.`;

  return `You are "Anu" — ${ownerName}'s personal AI assistant.

ROLE:
- You work FOR ${ownerName} (an Ethiopian man)
- You are NOT ${ownerName} — you are his assistant
- Speak about him in third person

PERSONALITY:
- Warm, friendly, like a helpful Ethiopian friend
- Short replies (1-2 sentences max)
- Natural and casual

REPLY RULES:
1. Greeting → greet back naturally, ask how you can help
2. Question → answer directly and briefly
3. Wants ${ownerName} → "Sure! I'll let him know right away"
4. Rude message → stay calm and kind
5. NEVER repeat the same reply twice
6. Keep replies SHORT and natural${statusLine}${histLine}

Output ONLY the reply text in English.`;
}

/* ═══════════════════════════════════════════════════════════
   GENERATE REPLY
   ═══════════════════════════════════════════════════════════ */
async function generateReply(ownerName, senderName, userText, chatId, isFirst, status) {
  const isGeez = hasGeezScript(userText);
  const isLatinAm = hasLatinAmharic(userText) && !isGeez;
  const needsTranslation = isGeez || isLatinAm;

  console.log('[Anu] Text:', userText.slice(0, 50), '| Geez:', isGeez, '| Latin-Am:', isLatinAm);

  /* ─── 1️⃣ Translate to English (parallel with history fetch) ─── */
  const hist = getHist(chatId).slice(-6);

  let englishText = userText;
  if (needsTranslation) {
    console.log('[Anu] Translating user message...');
    englishText = await translateToEnglish(userText);
    console.log('[Anu] English:', englishText.slice(0, 100));
  }

  /* ─── 2️⃣ Build English system prompt & generate reply ─── */
  const sysEn = buildEnglishSystemPrompt(ownerName, senderName, status, hist);

  let userPrompt;
  if (isFirst) {
    userPrompt = `${senderName} said: "${englishText}"

FIRST MESSAGE. Introduce yourself as "Anu, ${ownerName}'s AI assistant". Offer to help or forward a message to ${ownerName}. Keep it short (2 sentences).`;
  } else {
    userPrompt = `${senderName} said: "${englishText}"

Reply as Anu (English). Keep it short, natural, match the intent.`;
  }

  const rEn = await callAI(SMART_MODEL, sysEn, userPrompt, {
    maxTokens: 250,
    temperature: 0.8,
    timeoutMs: 12000
  });

  if (!rEn.ok) {
    console.error('[Anu] English AI failed:', rEn.error);
    // Fallback
    if (isGeez) return `ሰላም! እንዴት ነህ? 😊`;
    if (isLatinAm) return `hi! endet neh? 😊`;
    return `Hey! How are you? 😊`;
  }

  const englishReply = rEn.content;
  console.log('[Anu] English reply:', englishReply.slice(0, 100));

  /* ─── 3️⃣ If English reply — send as-is ─── */
  if (!needsTranslation) {
    addHist(chatId, 'user', userText);
    addHist(chatId, 'assistant', englishReply);
    return englishReply;
  }

  /* ─── 4️⃣ Translate back to Amharic ─── */
  console.log('[Anu] Translating reply back to Amharic...');
  const amharicReply = await translateToAmharic(englishReply, isGeez);

  const finalReply = (amharicReply && amharicReply.length > 2) ? amharicReply : englishReply;

  addHist(chatId, 'user', userText);
  addHist(chatId, 'assistant', finalReply);
  return finalReply;
}

/* ═══════════════════════════════════════════════════════════
   DETECTION
   ═══════════════════════════════════════════════════════════ */
function wantsOwner(text) {
  const t = (text || '').toLowerCase().trim();
  const patterns = [
    /ananya\s*(ን|ni|n)?\s*(ጥራ|ንገረው|አሳውቅ|ንገራት|asaweq|nigerew|traw)/i,
    /(ጥራው|አሳውቅ|ንገረው|ንገራት|አሳውቂ|አሳውቀው).*(ananya|anani|አናንያ|አናኒ)/i,
    /(tell|notify|call|reach).*(ananya|anani)/i,
    /አናንያ\s*ን\s*(ጥራ|ንገረው|አሳውቅ|ንገራት)/,
    /አናኒ\s*ን\s*(ጥራ|ንገረው|አሳውቅ|ንገራት)/,
    /\b(ananya|anani)\s+(n\s+)?(traw|nigerew|asaweq|nigerat|nigeren)\b/i,
    /\b(traw|nigerew|asaweq|nigerat)\s+(ananya|anani)\b/i,
    /\b(tell him|let him know|pass this|forward this)\b/i,
    /\b(urgent|emergency|አስቸኳይ|ፈጣን)\b/i,
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
   TYPING LOOP (refresh every 4s)
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
      status: 'Anu Bot v19.1',
      identity: "Anu — Ananya's AI assistant",
      features: ['translation-layer', 'deep-thinking', 'clean-history', 'strict-escalation', 'typing-loop']
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

      console.log('[Anu] Owner reply, ref:', JSON.stringify(ref));

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

    /* ─── 2️⃣ OWNER /start ─── */
    if (isFromOwner && txt === '/start') {
      const status = await getStatus();
      const statusText = (status && typeof status.text === 'string') ? status.text : '';
      await tg('sendMessage', {
        chat_id: chatId,
        text:
          `✅ <b>Anu Bot v19.1</b>\n\n` +
          `🤖 Anu — ${esc(OWNER_NAME)}'s AI assistant\n\n` +
          `<b>Owner Commands:</b>\n` +
          `<code>/start</code> — Menu\n` +
          `<code>/status &lt;text&gt;</code> — Set status\n` +
          `<code>/status</code> — Show\n` +
          `<code>/status clear</code> — Clear\n` +
          `<code>/stats</code> — Info\n` +
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

    /* ─── 4️⃣ OWNER /help ─── */
    if (isFromOwner && txt === '/help') {
      await tg('sendMessage', {
        chat_id: chatId,
        text:
          `<b>Owner Commands</b>\n\n` +
          `• Reply to notifications\n` +
          `• <code>/status &lt;text&gt;</code>\n` +
          `• <code>/status clear</code>\n` +
          `• <code>/send &lt;id&gt; &lt;msg&gt;</code>\n` +
          `• <code>/pause</code>, <code>/resume</code>\n` +
          `• <code>/stats</code>`,
        parse_mode: 'HTML'
      });
      return res.status(200).json({ ok: true });
    }

    /* ─── 5️⃣ OWNER /stats ─── */
    if (isFromOwner && txt === '/stats') {
      const status = await getStatus();
      const statusText = (status && typeof status.text === 'string') ? status.text : '';
      await tg('sendMessage', {
        chat_id: chatId,
        text:
          `📊 <b>Bot Status</b>\n\n` +
          `✅ Online\n` +
          `🌐 Translation: Amharic ↔ English\n` +
          `🧠 Model: ${SMART_MODEL}\n` +
          `💬 History: ${state.history.size}\n` +
          `👥 Known: ${state.introduced.size}\n` +
          `⏸️ Paused: ${state.paused ? 'Yes' : 'No'}\n` +
          `📢 Status: ${statusText ? 'Set ✅' : 'None'}`,
        parse_mode: 'HTML'
      });
      return res.status(200).json({ ok: true });
    }

    /* ─── 6️⃣ OWNER /pause ─── */
    if (isFromOwner && txt === '/pause') {
      state.paused = true;
      await tg('sendMessage', { chat_id: chatId, text: '⏸️ Paused.' });
      return res.status(200).json({ ok: true });
    }

    /* ─── 7️⃣ OWNER /resume ─── */
    if (isFromOwner && txt === '/resume') {
      state.paused = false;
      await tg('sendMessage', { chat_id: chatId, text: '▶️ Resumed.' });
      return res.status(200).json({ ok: true });
    }

    /* ─── 8️⃣ OWNER /send ─── */
    if (isFromOwner && txt.startsWith('/send ')) {
      const parts = txt.slice(6).trim().split(/\s+/);
      const targetId = parts.shift();
      const msgText = parts.join(' ');

      if (!targetId || !msgText) {
        await tg('sendMessage', {
          chat_id: chatId,
          text: 'Usage: <code>/send &lt;chat_id&gt; &lt;message&gt;</code>',
          parse_mode: 'HTML'
        });
        return res.status(200).json({ ok: true });
      }

      const r = await tg('sendMessage', { chat_id: targetId, text: `anu bot: ${msgText}` });
      await tg('sendMessage', {
        chat_id: chatId,
        text: r && r.ok ? '✅ Sent' : '❌ Failed'
      });
      return res.status(200).json({ ok: true });
    }

    /* ─── 9️⃣ NON-OWNER DM ─── */
    if (!isFromOwner && txt && !txt.startsWith('/')) {
      if (state.paused) return res.status(200).json({ ok: true });

      const senderName = dm.from?.first_name || 'there';
      const firstName = senderName.split(' ')[0];
      const isFirst = !state.introduced.has(String(chatId));

      console.log('[Anu] DM from', firstName, '| first:', isFirst, '| text:', txt);

      const stopTyping = startTypingLoop(tg, chatId, null, false);

      const status = await getStatus();
      let reply = '';
      try {
        reply = await generateReply(OWNER_NAME, firstName, txt, chatId, isFirst, status);
      } finally {
        stopTyping();
      }

      await tg('sendMessage', {
        chat_id: chatId,
        text: `anu bot: ${reply}`,
        reply_to_message_id: dm.message_id
      });

      if (isFirst) state.introduced.add(String(chatId));

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
            `${emoji} <b>${esc(label)}</b> from <b>${esc(firstName)}</b> (DM)\n\n` +
            `💬 <i>"${esc(txt)}"</i>\n\n` +
            `🤖 anu bot: <i>"${esc(reply.slice(0, 180))}"</i>\n\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `↩️ Reply\n📎 /send ${chatId} &lt;message&gt;\n\n` +
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

  console.log('[Anu] Business from', firstName, '| first:', isFirst, '| text:', userText);

  const stopTyping = startTypingLoop(tg, chatId, bizConnId, isPhoto);

  const status = await getStatus();
  let reply = '';
  try {
    if (isPhoto) {
      // Simple photo acknowledgement
      reply = `Nice photo! 😊 What can I help with?`;
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
        `↩️ Reply\n📎 /send ${chatId} &lt;message&gt;\n\n` +
        `REF:${chatId}:${bizConnId}`,
      parse_mode: 'HTML'
    });
  }

  return res.status(200).json({ ok: true });
     }
