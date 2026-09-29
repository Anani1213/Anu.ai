/* ============================================================
   Anu Assistant Bot v14.0
   ------------------------------------------------------------
   ✅ Single file, no Firebase (Upstash Redis for state)
   ✅ Master AI (openai/gpt-oss-120b)
   ✅ Always identifies as "Anu, Ananya's assistant"
   ✅ Daily status — resets automatically at midnight
   ✅ Owner commands work
   ✅ Reply-to-notification works
   ✅ Amharic + English + Latin matching
   ============================================================ */

const SMART_MODEL = 'openai/gpt-oss-120b';

/* ═══════════════════════════════════════════════════════════
   UPSTASH REDIS — REST API
   ═══════════════════════════════════════════════════════════ */
const UP_URL = process.env.UPSTASH_REDIS_REST_URL;
const UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function kvGet(key) {
  if (!UP_URL || !UP_TOKEN) return null;
  try {
    const r = await fetch(`${UP_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${UP_TOKEN}` }
    });
    const data = await r.json();
    return data.result || null;
  } catch (e) { return null; }
}

async function kvSet(key, value, ttlSec) {
  if (!UP_URL || !UP_TOKEN) return false;
  try {
    let url = `${UP_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}`;
    if (ttlSec) url += `/ex/${ttlSec}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${UP_TOKEN}` } });
    return r.ok;
  } catch (e) { return false; }
}

async function kvDel(key) {
  if (!UP_URL || !UP_TOKEN) return;
  try {
    await fetch(`${UP_URL}/del/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${UP_TOKEN}` }
    });
  } catch (e) {}
}

/* Seconds until local midnight */
function secondsUntilMidnight() {
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
  return Math.floor((midnight.getTime() - now.getTime()) / 1000);
}

function todayKey() {
  return new Date().toISOString().split('T')[0];
}

/* ═══════════════════════════════════════════════════════════
   IN-MEMORY HISTORY (per warm instance)
   ═══════════════════════════════════════════════════════════ */
const history = new Map();

function getHist(chatId) {
  return history.get(String(chatId)) || [];
}

function addHist(chatId, role, content) {
  const k = String(chatId);
  const h = history.get(k) || [];
  h.push({ role, content });
  history.set(k, h.slice(-10));
  if (history.size > 100) {
    const keys = [...history.keys()].slice(0, 50);
    keys.forEach(x => history.delete(x));
  }
}

/* ═══════════════════════════════════════════════════════════
   STATUS HELPERS
   ═══════════════════════════════════════════════════════════ */
async function getStatus() {
  const raw = await kvGet('bot_status');
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    if (data.date !== todayKey()) return null; // expired
    return data;
  } catch (e) { return null; }
}

async function setStatus(text, setBy) {
  const data = { text, date: todayKey(), setBy, setAt: Date.now() };
  const ttl = secondsUntilMidnight();
  await kvSet('bot_status', JSON.stringify(data), ttl);
  return data;
}

async function clearStatus() {
  await kvDel('bot_status');
}

/* ═══════════════════════════════════════════════════════════
   GROQ AI
   ═══════════════════════════════════════════════════════════ */
async function callAI(sysPrompt, messages, opts = {}) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return { ok: false, error: 'No API key' };

  const controller = new AbortController();
  const tId = setTimeout(() => controller.abort(), opts.timeoutMs || 8000);

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
        temperature: opts.temperature ?? 0.8,
        max_tokens: opts.maxTokens || 350,
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
  const draftMatch = t.match(/draft:\s*"([^"]+)"/i);
  if (draftMatch && t.length < 300) t = draftMatch[1];
  return t.trim();
}

/* ═══════════════════════════════════════════════════════════
   SYSTEM PROMPT
   ═══════════════════════════════════════════════════════════ */
function sysPrompt(ownerName, senderName, status) {
  const statusBlock = status
    ? `\n\n═══════════════════════════════════════════\n📢 TODAY'S STATUS FROM ${ownerName.toUpperCase()}\n═══════════════════════════════════════════\n${status.text}\n\nIf the sender asks about ${ownerName} or where he is, mention this status naturally.`
    : '';

  return `You are **Anu** — the AI assistant of **${ownerName}**, a warm Ethiopian man.

═══════════════════════════════════════════
🎯 IDENTITY (NEVER FORGET)
═══════════════════════════════════════════
- Your name: **Anu**
- You are ${ownerName}'s AI assistant
- You work FOR ${ownerName} — you are NOT ${ownerName}
- Speak about ${ownerName} in THIRD PERSON
- ❌ NEVER: "I am ${ownerName}"
- ✅ YES: "${ownerName} is my boss", "I'll tell ${ownerName}"

═══════════════════════════════════════════
🚨 CRITICAL RULES FOR EVERY REPLY
═══════════════════════════════════════════
1. ALWAYS identify as "Anu, ${ownerName}'s assistant" — especially on greetings
2. Be brief and warm — 2 short sentences
3. Match the sender's EXACT language style
4. NEVER echo their words
5. NEVER reply with just 1 word
6. NEVER reveal AI model names
7. NEVER show reasoning
8. If they want ${ownerName} → "I'll let ${ownerName} know 🙏"
9. If they ask a question → answer helpfully
10. If unsure → "Let me check with ${ownerName} 🙏"

═══════════════════════════════════════════
🌍 LANGUAGE MATCHING
═══════════════════════════════════════════
Match the EXACT style:

1. **Amharic (Ge'ez)**:
   "ሰላም" → "ሰላም! እኔ Anu ነኝ — የ ${ownerName} ረዳት 😊 ምን ልርዳህ?"
   "እንደምን ነህ?" → "ደህና ነኝ! አንተስ? እኔ Anu ነኝ — የ ${ownerName} ረዳት 😊"

2. **English**:
   "Hi" → "Hi! I'm Anu, ${ownerName}'s AI assistant 😊 How can I help you?"
   "How are you?" → "I'm great, thanks! I'm Anu, ${ownerName}'s assistant. What can I help with? 💛"

3. **Amharic-in-Latin**:
   "selam" → "selam! ene Anu negn — ye ${ownerName} redat 😊 min lirdah?"
   "salam" → "salam! ene Anu negn, ye ${ownerName} redat. endet liredah? 😊"
   "dehna neh?" → "dehna negn, amesegnalehu! ene Anu negn — ye ${ownerName} redat 😊"
   "man neh?" → "ene Anu negn — ye ${ownerName} redat 😊 antes?"
   "hi" → "Hi! ene Anu negn, ye ${ownerName} redat. endet liredah? 😊"

4. Match emojis naturally.

═══════════════════════════════════════════
🇪🇹 ETHIOPIAN WORD CHOICE
═══════════════════════════════════════════
- ደህና ነህ? / ደህና ነሽ?
- እንዴት ነህ? / እንዴት ነሽ?
- ጤና ይስጥልኝ
- አመሰግናለሁ / amesegnalehu
- እሺ
- ምን ልርዳህ?

═══════════════════════════════════════════
📸 PHOTOS
═══════════════════════════════════════════
Warm genuine reaction, 1-2 short sentences:
"Nice photo! I'm Anu, ${ownerName}'s assistant. What can I help with? 😊"

═══════════════════════════════════════════
😠 INSULTS
═══════════════════════════════════════════
NEVER insult back: "ምንም አይደለም፣ እንዴት ልርዳህ እችላለሁ?"

═══════════════════════════════════════════
🚨 OUTPUT FORMAT
═══════════════════════════════════════════
Output ONLY the reply. No reasoning, no drafts, no meta.${statusBlock}`;
}

/* ═══════════════════════════════════════════════════════════
   WEAK REPLY DETECTOR
   ═══════════════════════════════════════════════════════════ */
function isWeak(reply, userText) {
  if (!reply) return true;
  const r = reply.toLowerCase().trim();
  const u = (userText || '').toLowerCase().trim();

  if (r.length < 20) return true;
  if (r === u) return true;
  if (/^(hi|hello|hey|selam|salam|ሰላም|hi!|hello!|ሰላም!)[\s!?.😊🙏😄]*$/i.test(r)) return true;

  // Greeting should include "Anu"
  const isGreeting = /^(hi|hello|hey|selam|salam|ሰላም|man neh|who are you|who r u)/i.test(u);
  if (isGreeting && !/anu/i.test(r)) return true;

  return false;
}

/* ═══════════════════════════════════════════════════════════
   GENERATE REPLY
   ═══════════════════════════════════════════════════════════ */
async function generateReply(ownerName, senderName, userText, chatId, isFirst, status) {
  const sys = sysPrompt(ownerName, senderName, status);
  const hist = getHist(chatId).slice(-6).map(h => ({ role: h.role, content: h.content }));

  // First contact — force intro
  if (isFirst) {
    const introPrompt = `${sys}

═══════════════════════════════════════════
🎯 FIRST CONTACT — SPECIAL
═══════════════════════════════════════════
This is the FIRST message from "${senderName}".
- Introduce yourself as "Anu, ${ownerName}'s AI assistant"
- Give them TWO options:
  1. Send a message to ${ownerName} (you'll forward it)
  2. Get help from you directly
- Ask which they'd prefer
- Match their language EXACTLY
- Keep it short (2-3 sentences)`;

    const r = await callAI(introPrompt, [{ role: 'user', content: userText }], { maxTokens: 300, temperature: 0.85 });

    if (r.ok && /anu/i.test(r.content) && r.content.length > 30) {
      addHist(chatId, 'user', userText);
      addHist(chatId, 'assistant', r.content);
      return r.content;
    }

    const isAmharic = /[\u1200-\u137F]/.test(userText);
    const isLatin = /(selam|salam|dehna|endet|amesegn)/i.test(userText);
    let fallback;
    if (isAmharic) fallback = `ሰላም ${senderName}! እኔ Anu ነኝ — የ ${ownerName} ረዳት 🤖\nጥያቄ ልርዳህ ወይስ ለ ${ownerName} መልእክት ልላክ?\nምን ትፈልጋለህ? 💛`;
    else if (isLatin) fallback = `selam ${senderName}! ene Anu negn — ye ${ownerName} redat 🤖\nQuestion lirdah weys le ${ownerName} message lilak?\nMin tefelgalh? 💛`;
    else fallback = `Hi ${senderName}! I'm Anu, ${ownerName}'s AI assistant 🤖\nI can help with questions or forward a message to ${ownerName}.\nWhat would you like? 💛`;

    addHist(chatId, 'user', userText);
    addHist(chatId, 'assistant', fallback);
    return fallback;
  }

  // Regular
  const userContent = `${senderName}: "${userText}"`;
  const r = await callAI(sys, [...hist, { role: 'user', content: userContent }], { maxTokens: 300, temperature: 0.8 });

  if (r.ok && !isWeak(r.content, userText)) {
    addHist(chatId, 'user', userText);
    addHist(chatId, 'assistant', r.content);
    return r.content;
  }

  // Retry
  if (r.ok) {
    console.warn('[Anu] Weak reply, retrying:', r.content?.slice(0, 60));
    const retrySys = `${sys}

🚨 YOUR PREVIOUS REPLY WAS TOO WEAK.
Requirements:
- Include "Anu" and "${ownerName}'s assistant"
- At least 2 short sentences
- Match sender's exact language
- Warm and helpful`;

    const retry = await callAI(retrySys, [{ role: 'user', content: userContent }], { maxTokens: 300, temperature: 0.9 });

    if (retry.ok && retry.content.length > 20 && !isWeak(retry.content, userText)) {
      addHist(chatId, 'user', userText);
      addHist(chatId, 'assistant', retry.content);
      return retry.content;
    }
  }

  // Guaranteed fallback
  const isAmharic = /[\u1200-\u137F]/.test(userText);
  const isLatin = /(selam|salam|dehna|endet|amesegn)/i.test(userText);
  let fb;
  if (isAmharic) fb = `ሰላም! እኔ Anu ነኝ — የ ${ownerName} ረዳት 😊 ምን ልርዳህ?`;
  else if (isLatin) fb = `selam! ene Anu negn — ye ${ownerName} redat 😊 min lirdah?`;
  else fb = `Hi! I'm Anu, ${ownerName}'s assistant 😊 How can I help?`;

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
    ? `${ctx}\n\nAcknowledge the photo AND introduce yourself as "Anu, ${ownerName}'s assistant". Offer to help or forward.`
    : `${ctx}\n\nReact warmly — 1-2 sentences. If greeting, include your identity.`;

  const r = await callAI(sys, [{ role: 'user', content: instruction }], { maxTokens: 250, temperature: 0.85 });

  if (r.ok && r.content && r.content.length > 15) {
    if (isFirst && !/anu/i.test(r.content)) {
      return `Nice photo! I'm Anu, ${ownerName}'s assistant 😊 What can I help with?`;
    }
    return r.content;
  }
  return `Nice photo! I'm Anu, ${ownerName}'s assistant 😊 How can I help?`;
}

/* ═══════════════════════════════════════════════════════════
   DETECTION
   ═══════════════════════════════════════════════════════════ */
function wantsOwner(text) {
  const t = (text || '').toLowerCase();
  return /(ananya|anani|አናንያ|አናኒ|owner|boss|speak to|talk to|important|urgent|meet|meeting|business|tell her|tell him|notify|reach her|reach him|contact her|contact him|let her know|let him know|pass this|forward this|ባለቤት|አስቸኳይ|አስፈላጊ|ንግድ|ጉዳይ|ስብሰባ|ቀጠሮ|ንገረው|ንገራት|ንገረኝ|አሳውቅ|አሳውቂ|አሳውቀው|አስታውቅ|ጥራው|ጥራት|ጥሪው|ደውል|ደውልለት|ደውልላት|አግኝ|አግኚ|ተናገር|ልናገር|ልናገራት|ልናገረው|nigerew|nigerat|nigeren|asawq|asekayi|asfelagi|guday|sbsba|qetro|traw|tirat|dewil|agen|nager|lenager|lenagrat|lenagerew)/i.test(t);
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
   MAIN HANDLER
   ═══════════════════════════════════════════════════════════ */
export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'Anu Assistant Bot v14.0',
      identity: 'Anu — Ananya\'s AI assistant',
      storage: UP_URL ? 'Upstash Redis' : 'memory-only'
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
        const payload = { chat_id: ref.chatId, text: txt };
        if (ref.bizConnId) payload.business_connection_id = ref.bizConnId;

        const sr = await tg('sendMessage', payload);
        await tg('sendMessage', {
          chat_id: chatId,
          text: sr && sr.ok ? '✅ Sent' : `❌ Failed: \`${JSON.stringify(sr).slice(0, 100)}\``,
          parse_mode: 'Markdown',
          reply_to_message_id: dm.message_id
        });
      } else {
        await tg('sendMessage', {
          chat_id: chatId,
          text: '⚠️ Could not find target.\nUse: `/send <chat_id> <message>`',
          parse_mode: 'Markdown',
          reply_to_message_id: dm.message_id
        });
      }
      return res.status(200).json({ ok: true });
    }

    /* ─── 2️⃣ OWNER /start ─── */
    if (isFromOwner && txt === '/start') {
      const status = await getStatus();
      await tg('sendMessage', {
        chat_id: chatId,
        text:
          `✅ *Anu Assistant Bot v14.0*\n\n` +
          `🤖 Anu — ${OWNER_NAME}'s AI assistant\n\n` +
          `*Commands:*\n` +
          `/start — This menu\n` +
          `/status <text> — Set today's status (e.g. "ዛሬ አሞኛል")\n` +
          `/status — Show current status\n` +
          `/status clear — Clear status\n` +
          `/stats — Bot info\n` +
          `/pause — Pause AI\n` +
          `/resume — Resume AI\n` +
          `/send <chat_id> <text> — Direct message\n` +
          `/help — Help\n\n` +
          (status
            ? `📢 *Current status:*\n_"${status.text}"_\n_(Auto-resets at midnight)_`
            : `_No status set for today._`),
        parse_mode: 'Markdown'
      });
      return res.status(200).json({ ok: true });
    }

    /* ─── 3️⃣ OWNER /status ─── */
    if (isFromOwner && (txt === '/status' || txt.startsWith('/status '))) {
      const arg = txt.slice(8).trim();

      // Show current
      if (!arg) {
        const status = await getStatus();
        await tg('sendMessage', {
          chat_id: chatId,
          text: status
            ? `📢 *Today's status:*\n_"${status.text}"_\n\n_Set at ${new Date(status.setAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}_\n_Auto-clears at midnight_`
            : `ℹ️ No status set for today.\n\nUse: \`/status ዛሬ አሞኛል\``,
          parse_mode: 'Markdown'
        });
        return res.status(200).json({ ok: true });
      }

      // Clear
      if (arg === 'clear' || arg === 'delete' || arg === 'off') {
        await clearStatus();
        await tg('sendMessage', {
          chat_id: chatId,
          text: '✅ Status cleared for today.',
          parse_mode: 'Markdown'
        });
        return res.status(200).json({ ok: true });
      }

      // Set
      const newStatus = await setStatus(arg, OWNER_NAME);
      const hrs = Math.round(secondsUntilMidnight() / 3600 * 10) / 10;
      await tg('sendMessage', {
        chat_id: chatId,
        text:
          `✅ *Status set!*\n\n` +
          `📢 _"${arg}"_\n\n` +
          `⏰ Auto-clears in ~${hrs} hours (at midnight)\n` +
          `💬 Bot will tell senders this when they ask about you.`,
        parse_mode: 'Markdown'
      });
      return res.status(200).json({ ok: true });
    }

    /* ─── 4️⃣ OWNER /help ─── */
    if (isFromOwner && txt === '/help') {
      await tg('sendMessage', {
        chat_id: chatId,
        text:
          `*Owner Commands*\n\n` +
          `• Reply to notifications → direct reply\n` +
          `• /status <text> — Set today's status\n` +
          `• /status clear — Remove status\n` +
          `• /send <chat_id> <text> — Direct message\n` +
          `• /pause, /resume — Control AI\n` +
          `• /stats — Bot info`,
        parse_mode: 'Markdown'
      });
      return res.status(200).json({ ok: true });
    }

    /* ─── 5️⃣ OWNER /stats ─── */
    if (isFromOwner && txt === '/stats') {
      const status = await getStatus();
      const paused = await kvGet('bot_paused');
      await tg('sendMessage', {
        chat_id: chatId,
        text:
          `📊 *Bot Status*\n\n` +
          `✅ Online\n` +
          `🧠 Model: Master AI (gpt-oss-120b)\n` +
          `💾 Storage: ${UP_URL ? 'Upstash Redis' : 'Memory'}\n` +
          `💬 History entries: ${history.size}\n` +
          `⏸️ Paused: ${paused === '1' ? 'Yes' : 'No'}\n` +
          `📢 Today status: ${status ? 'Set ✅' : 'None'}`,
        parse_mode: 'Markdown'
      });
      return res.status(200).json({ ok: true });
    }

    /* ─── 6️⃣ OWNER /pause ─── */
    if (isFromOwner && txt === '/pause') {
      await kvSet('bot_paused', '1');
      await tg('sendMessage', { chat_id: chatId, text: '⏸️ AI paused. Send /resume to restart.' });
      return res.status(200).json({ ok: true });
    }

    /* ─── 7️⃣ OWNER /resume ─── */
    if (isFromOwner && txt === '/resume') {
      await kvSet('bot_paused', '0');
      await tg('sendMessage', { chat_id: chatId, text: '▶️ AI resumed.' });
      return res.status(200).json({ ok: true });
    }

    /* ─── 8️⃣ OWNER /send ─── */
    if (isFromOwner && txt.startsWith('/send ')) {
      const parts = txt.slice(6).trim().split(/\s+/);
      const targetId = parts.shift();
      const msgText = parts.join(' ');

      if (!targetId || !msgText) {
        await tg('sendMessage', { chat_id: chatId, text: 'Usage: `/send <chat_id> <message>`', parse_mode: 'Markdown' });
        return res.status(200).json({ ok: true });
      }

      const r = await tg('sendMessage', { chat_id: targetId, text: msgText });
      await tg('sendMessage', {
        chat_id: chatId,
        text: r && r.ok ? '✅ Sent' : '❌ Failed (may need business connection)'
      });
      return res.status(200).json({ ok: true });
    }

    /* ─── 9️⃣ NON-OWNER — REGULAR USER ─── */
    if (!isFromOwner && txt && !txt.startsWith('/')) {
      const paused = await kvGet('bot_paused');
      if (paused === '1') return res.status(200).json({ ok: true });

      const senderName = dm.from?.first_name || 'there';
      const firstName = senderName.split(' ')[0];

      const introducedKey = `introduced:${chatId}`;
      const wasIntroduced = await kvGet(introducedKey);
      const isFirst = !wasIntroduced;

      console.log('[Anu] DM from', firstName, '| first:', isFirst);

      const status = await getStatus();
      const reply = await generateReply(OWNER_NAME, firstName, txt, chatId, isFirst, status);

      await tg('sendMessage', {
        chat_id: chatId,
        text: reply,
        reply_to_message_id: dm.message_id
      });

      if (isFirst) {
        await kvSet(introducedKey, '1', 60 * 60 * 24 * 30); // 30 days
      }

      // Escalation
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
            `${emoji} *${label}* from *${firstName}* (DM)\n\n` +
            `💬 _"${txt}"_\n\n` +
            `🤖 Anu: _"${reply.slice(0, 180)}${reply.length > 180 ? '…' : ''}"_\n\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `↩️ Reply to this message to send your own reply\n` +
            `📎 Or use: /send ${chatId} <message>\n\n` +
            `REF:${chatId}:direct`,
          parse_mode: 'Markdown'
        });
      }

      return res.status(200).json({ ok: true });
    }

    /* Non-owner /start */
    if (!isFromOwner && txt === '/start') {
      const senderName = dm.from?.first_name || 'there';
      const firstName = senderName.split(' ')[0];
      const introducedKey = `introduced:${chatId}`;
      const wasIntroduced = await kvGet(introducedKey);
      const isFirst = !wasIntroduced;

      const status = await getStatus();
      const reply = await generateReply(OWNER_NAME, firstName, '/start', chatId, isFirst, status);

      await tg('sendMessage', { chat_id: chatId, text: reply });
      if (isFirst) await kvSet(introducedKey, '1', 60 * 60 * 24 * 30);
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

  const paused = await kvGet('bot_paused');
  if (paused === '1') return res.status(200).json({ ok: true });

  let userText = '';
  let isPhoto = false;

  if (message.text) userText = message.text.trim();
  else if (message.caption) userText = message.caption.trim();
  if (message.photo && message.photo.length > 0) isPhoto = true;

  if (!userText && !isPhoto) return res.status(200).json({ ok: true });
  if (userText.startsWith('/')) return res.status(200).json({ ok: true });

  const firstName = senderName.split(' ')[0];
  const introducedKey = `introduced:${chatId}`;
  const wasIntroduced = await kvGet(introducedKey);
  const isFirst = !wasIntroduced;

  console.log('[Anu] Business from', firstName, '| first:', isFirst);

  tg('sendChatAction', {
    chat_id: chatId,
    action: isPhoto ? 'upload_photo' : 'typing',
    business_connection_id: bizConnId
  }).catch(() => {});

  const status = await getStatus();
  let reply = '';
  if (isPhoto) {
    reply = await analyzePhoto(OWNER_NAME, firstName, userText, isFirst, status);
  } else {
    reply = await generateReply(OWNER_NAME, firstName, userText, chatId, isFirst, status);
  }

  if (!reply) reply = `Hi! I'm Anu, ${OWNER_NAME}'s assistant 😊 How can I help?`;

  await new Promise(r => setTimeout(r, Math.min(reply.length * 15, 1200)));

  await tg('sendMessage', {
    chat_id: chatId,
    text: reply,
    business_connection_id: bizConnId,
    reply_to_message_id: msgId
  });

  if (isFirst) await kvSet(introducedKey, '1', 60 * 60 * 24 * 30);

  // Escalation
  const sentiment = detectSentiment(userText);
  const needsOwner = wantsOwner(userText);

  if ((needsOwner || sentiment === 'urgent' || sentiment === 'angry') && OWNER_CHAT_ID) {
    let emoji = '🔔', label = 'Message';
    if (sentiment === 'urgent') { emoji = '🚨'; label = 'URGENT'; }
    else if (sentiment === 'angry') { emoji = '😠'; label = 'Angry'; }
    else if (needsOwner) { emoji = '📩'; label = 'Wants your attention'; }

    await tg('sendMessage', {
      chat_id: OWNER_CHAT_ID,
      text:
        `${emoji} *${label}* from *${firstName}*\n\n` +
        `💬 _"${userText || '[photo]'}"_\n\n` +
        `🤖 Anu: _"${reply.slice(0, 180)}${reply.length > 180 ? '…' : ''}"_\n\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `↩️ Reply to this message to send your own reply\n` +
        `📎 Or use: /send ${chatId} <message>\n\n` +
        `REF:${chatId}:${bizConnId}`,
      parse_mode: 'Markdown'
    });
  }

  return res.status(200).json({ ok: true });
}
