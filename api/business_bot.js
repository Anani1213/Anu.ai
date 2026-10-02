/* ============================================================
   Anu Bot v19.0 — Amharic Translation Layer
   ------------------------------------------------------------
   ✅ Amharic → English → AI thinks → English → Amharic
   ✅ Correct Amharic grammar
   ✅ No repeated replies
   ✅ Context understanding
   ✅ "anu bot:" prefix
   ============================================================ */

const SMART_MODEL = 'openai/gpt-oss-120b';
const FAST_MODEL = 'openai/gpt-oss-20b';

/* ═══════════════════════════════════════════════════════════
   FIREBASE
   ═══════════════════════════════════════════════════════════ */
const FIREBASE_PROJECT_ID = 'my-ai-eaf27';
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;

function toFS(val) {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'string') return { stringValue: val };
  if (typeof val === 'number') return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
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
   IN-MEMORY
   ═══════════════════════════════════════════════════════════ */
const state = { paused: false, introduced: new Set(), history: new Map() };

function getHist(chatId) { return state.history.get(String(chatId)) || []; }

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
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ═══════════════════════════════════════════════════════════
   GROQ AI — Basic call
   ═══════════════════════════════════════════════════════════ */
async function callAI(model, sysPrompt, userContent, opts = {}) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return { ok: false, error: 'No API key' };

  const timeout = opts.timeoutMs || 15000;
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
  return t.trim();
}

/* ═══════════════════════════════════════════════════════════
   DETECT SCRIPT
   ═══════════════════════════════════════════════════════════ */
function hasGe'ezScript(text) {
  return /[\u1200-\u137F]/.test(text || '');
}

function hasLatinAmharic(text) {
  const t = (text || '').toLowerCase();
  return /(selam|salam|dehna|endet|amesegn|wendme|bro|ante|anchi|nesh|min|wede|yet|new|neh|nesh|gud|hone|lib|yene|yene|kolo|bet|mana|nega|arat|ekul|and|hulet|sost|arat)/i.test(t);
}

/* ═══════════════════════════════════════════════════════════
   🌐 TRANSLATION LAYER
   ═══════════════════════════════════════════════════════════ */

/* Translate Amharic (Ge'ez or Latin) to English */
async function translateToEnglish(text) {
  const prompt = `Translate the following text to English. 

RULES:
- If it's already English, output it unchanged
- If it's Amharic (Ge'ez script like ሰላም) → translate to natural English
- If it's Amharic-in-Latin (like "selam endet neh") → translate to natural English
- Output ONLY the English translation
- Nothing else — no explanation, no quotes, no prefixes

Text to translate:
"${text}"`;

  const r = await callAI(FAST_MODEL, prompt, text, {
    maxTokens: 200,
    temperature: 0.3,
    timeoutMs: 10000
  });

  return r.ok ? r.content : text;
}

/* Translate English reply back to Amharic */
async function translateToAmharic(text, style) {
  const styleGuide = style === 'geez'
    ? 'Ge\'ez script (like ሰላም እንዴት ነህ)'
    : 'Amharic-in-Latin (like selam endet neh)';

  const prompt = `Translate the following English text to ${styleGuide}.

RULES:
- Use natural, casual conversational Amharic
- Keep emojis and punctuation
- If the text is a greeting reply → use common Amharic phrases
- Output ONLY the translation
- Nothing else — no explanation, no quotes, no prefixes

English text:
"${text}"`;

  const r = await callAI(SMART_MODEL, prompt, text, {
    maxTokens: 300,
    temperature: 0.4,
    timeoutMs: 12000
  });

  return r.ok ? r.content : text;
}

/* ═══════════════════════════════════════════════════════════
   MAIN REPLY LOGIC (English thinking)
   ═══════════════════════════════════════════════════════════ */
function buildEnglishSystemPrompt(ownerName, senderName, status, conversationHistory) {
  const statusLine = (status && status.text)
    ? `\n\nTODAY'S STATUS: "${status.text}" — If asked about ${ownerName}, mention this.`
    : '';

  const histLine = conversationHistory.length > 0
    ? `\n\nCONVERSATION SO FAR:\n${conversationHistory.map(h => `${h.role === 'user' ? senderName : 'Anu'}: ${h.content}`).join('\n')}`
    : '\n\nThis is the FIRST message from ' + senderName + '.';

  return `You are "Anu" — ${ownerName}'s personal AI assistant.

ROLE:
- You work FOR ${ownerName} (an Ethiopian man)
- You are NOT ${ownerName} — you are his assistant
- Speak about him in 3rd person

PERSONALITY:
- Warm, friendly, like a helpful Ethiopian friend
- Short replies (1-2 sentences max)
- Natural and casual — no formal language

REPLY RULES:
1. If they greet you → greet back naturally, ask how you can help
2. If they ask a question → answer directly and briefly
3. If they want ${ownerName} → "Sure! I'll let him know right away"
4. If they're rude → stay calm and kind
5. NEVER repeat the same reply twice
6. Keep replies SHORT and natural${statusLine}${histLine}

Reply to the user's message below. Output ONLY the reply text in English.`;
}

/* ═══════════════════════════════════════════════════════════
   GENERATE REPLY (with translation)
   ═══════════════════════════════════════════════════════════ */
async function generateReply(ownerName, senderName, userText, chatId, isFirst, status) {
  const isAmharicScript = hasGe'ezScript(userText);
  const isLatinAmharic = hasLatinAmharic(userText) && !isAmharicScript;

  console.log('[Anu] Script: Geez=', isAmharicScript, 'Latin=', isLatinAmharic);

  /* ─── 1️⃣ TRANSLATE USER MESSAGE TO ENGLISH ─── */
  let englishText = userText;
  if (isAmharicScript || isLatinAmharic) {
    console.log('[Anu] Translating to English...');
    englishText = await translateToEnglish(userText);
    console.log('[Anu] English:', englishText);
  }

  /* ─── 2️⃣ GET HISTORY ─── */
  const hist = getHist(chatId).slice(-6);

  /* ─── 3️⃣ GENERATE REPLY IN ENGLISH ─── */
  const sysEn = buildEnglishSystemPrompt(ownerName, senderName, status, hist);

  let userPrompt;
  if (isFirst) {
    userPrompt = `${senderName} said: "${englishText}"

THIS IS THE FIRST MESSAGE. Introduce yourself as "Anu, ${ownerName}'s AI assistant". Offer to help or forward a message to ${ownerName}. Keep it short (2 sentences).`;
  } else {
    userPrompt = `${senderName} said: "${englishText}"

Reply as Anu (English). Keep it short, natural, and match the intent.`;
  }

  const rEn = await callAI(SMART_MODEL, sysEn, userPrompt, {
    maxTokens: 250,
    temperature: 0.8,
    timeoutMs: 15000
  });

  if (!rEn.ok) {
    console.error('[Anu] English reply failed:', rEn.error);
    // Fallback
    if (isAmharicScript) return `ሰላም! እንዴት ነህ? 😊`;
    if (isLatinAmharic) return `hi! endet neh? 😊`;
    return `Hey! How are you? 😊`;
  }

  let englishReply = rEn.content;
  console.log('[Anu] English reply:', englishReply);

  /* ─── 4️⃣ TRANSLATE REPLY BACK TO AMHARIC ─── */
  if (isAmharicScript || isLatinAmharic) {
    console.log('[Anu] Translating reply back to Amharic...');
    const style = isAmharicScript ? 'geez' : 'latin';
    const amharicReply = await translateToAmharic(englishReply, style);

    if (amharicReply && amharicReply.length > 2) {
      addHist(chatId, 'user', userText);
      addHist(chatId, 'assistant', amharicReply);
      return amharicReply;
    }
  }

  /* English-only reply */
  addHist(chatId, 'user', userText);
  addHist(chatId, 'assistant', englishReply);
  return englishReply;
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
   TYPING LOOP
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
      status: 'Anu Bot v19.0',
      identity: "Anu — Ananya's AI assistant",
      features: ['translation-layer', 'deep-thinking', 'clean-history', 'strict-escalation']
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
          text: sr && sr.ok ? '✅ Sent' : '❌ Failed',
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
          `✅ <b>Anu Bot v19.0</b>\n\n` +
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
          (statusText ? `📢 <b>Current:</b> <i>"${esc(statusText)}"</i>` : `<i>No status set.</i>`),
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
          text: statusText ? `📢 <b>Today:</b> <i>"${esc(statusText)}"</i>` : `ℹ️ Use: <code>/status ዛሬ አሞኛል</code>`,
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

    if (isFromOwner && txt === '/help') {
      await tg('sendMessage', { chat_id: chatId, text: `<b>Owner Commands</b>\n\n• Reply to notifications\n• /status &lt;text&gt;\n• /status clear\n• /send &lt;id&gt; &lt;msg&gt;\n• /pause, /resume\n• /stats`, parse_mode: 'HTML' });
      return res.status(200).json({ ok: true });
    }

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
    reply = await generateReply(OWNER_NAME, firstName, userText, chatId, isFirst, status);
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
