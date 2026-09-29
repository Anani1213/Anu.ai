/* ============================================================
   Anu Assistant Bot v15.1 — HTML Mode (Fixes Markdown Errors)
   ============================================================ */

const SMART_MODEL = 'openai/gpt-oss-120b';

/* ═══════════════════════════════════════════════════════════
   HTML ESCAPE — for user-generated content
   ═══════════════════════════════════════════════════════════ */
function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/* ═══════════════════════════════════════════════════════════
   IN-MEMORY STATE
   ═══════════════════════════════════════════════════════════ */
const state = {
  status: null,
  paused: false,
  introduced: new Set(),
  history: new Map()
};

function todayKey() {
  return new Date().toISOString().split('T')[0];
}

function getStatus() {
  if (!state.status) return null;
  if (state.status.date !== todayKey()) {
    state.status = null;
    return null;
  }
  return state.status;
}

function setStatus(text) {
  state.status = { text, date: todayKey(), setAt: Date.now() };
  return state.status;
}

function clearStatus() {
  state.status = null;
}

function getHist(chatId) {
  return state.history.get(String(chatId)) || [];
}

function addHist(chatId, role, content) {
  const k = String(chatId);
  const h = state.history.get(k) || [];
  h.push({ role, content });
  state.history.set(k, h.slice(-10));
  if (state.history.size > 200) {
    const keys = [...state.history.keys()].slice(0, 100);
    keys.forEach(x => state.history.delete(x));
  }
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

2. **English**:
   "Hi" → "Hi! I'm Anu, ${ownerName}'s AI assistant 😊 How can I help you?"

3. **Amharic-in-Latin**:
   "selam" → "selam! ene Anu negn — ye ${ownerName} redat 😊 min lirdah?"
   "salam" → "salam! ene Anu negn, ye ${ownerName} redat. endet liredah? 😊"

4. Match emojis naturally.

═══════════════════════════════════════════
🇪🇹 ETHIOPIAN WORD CHOICE
═══════════════════════════════════════════
- ደህና ነህ? / ደህና ነሽ?
- እንዴት ነህ? / እንዴት ነሽ?
- ጤና ይስጥልኝ
- አመሰግናለሁ / amesegnalehu

═══════════════════════════════════════════
📸 PHOTOS
═══════════════════════════════════════════
Warm genuine reaction, 1-2 short sentences.

═══════════════════════════════════════════
😠 INSULTS
═══════════════════════════════════════════
NEVER insult back.

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
    let fb;
    if (isAmharic) fb = `ሰላም ${senderName}! እኔ Anu ነኝ — የ ${ownerName} ረዳት 🤖\nጥያቄ ልርዳህ ወይስ ለ ${ownerName} መልእክት ልላክ?\nምን ትፈልጋለህ? 💛`;
    else if (isLatin) fb = `selam ${senderName}! ene Anu negn — ye ${ownerName} redat 🤖\nQuestion lirdah weys le ${ownerName} message lilak?\nMin tefelgalh? 💛`;
    else fb = `Hi ${senderName}! I'm Anu, ${ownerName}'s AI assistant 🤖\nI can help with questions or forward a message to ${ownerName}.\nWhat would you like? 💛`;

    addHist(chatId, 'user', userText);
    addHist(chatId, 'assistant', fb);
    return fb;
  }

  const userContent = `${senderName}: "${userText}"`;
  const r = await callAI(sys, [...hist, { role: 'user', content: userContent }], { maxTokens: 300, temperature: 0.8 });

  if (r.ok && !isWeak(r.content, userText)) {
    addHist(chatId, 'user', userText);
    addHist(chatId, 'assistant', r.content);
    return r.content;
  }

  if (r.ok) {
    const retrySys = `${sys}

🚨 YOUR PREVIOUS REPLY WAS TOO WEAK.
Requirements:
- Include "Anu" and "${ownerName}'s assistant"
- At least 2 short sentences
- Match sender's exact language`;

    const retry = await callAI(retrySys, [{ role: 'user', content: userContent }], { maxTokens: 300, temperature: 0.9 });

    if (retry.ok && retry.content.length > 20 && !isWeak(retry.content, userText)) {
      addHist(chatId, 'user', userText);
      addHist(chatId, 'assistant', retry.content);
      return retry.content;
    }
  }

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
      status: 'Anu Assistant Bot v15.1',
      identity: 'Anu — Ananya\'s AI assistant',
      storage: 'memory',
      markdown: 'HTML-safe'
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
          text: sr && sr.ok ? '✅ Sent' : `❌ Failed: ${JSON.stringify(sr).slice(0, 100)}`,
          reply_to_message_id: dm.message_id
        });
      } else {
        await tg('sendMessage', {
          chat_id: chatId,
          text: '⚠️ Could not find target.\n\nUse: /send <chat_id> <message>',
          reply_to_message_id: dm.message_id
        });
      }
      return res.status(200).json({ ok: true });
    }

    /* ─── 2️⃣ OWNER /start ─── */
    if (isFromOwner && txt === '/start') {
      const status = getStatus();
      await tg('sendMessage', {
        chat_id: chatId,
        text:
          `✅ <b>Anu Assistant Bot v15.1</b>\n\n` +
          `🤖 Anu — ${esc(OWNER_NAME)}'s AI assistant\n\n` +
          `<b>Owner Commands:</b>\n` +
          `<code>/start</code> — This menu\n` +
          `<code>/status &lt;text&gt;</code> — Set today's status\n` +
          `<code>/status</code> — Show status\n` +
          `<code>/status clear</code> — Clear status\n` +
          `<code>/stats</code> — Bot info\n` +
          `<code>/pause</code> — Pause AI\n` +
          `<code>/resume</code> — Resume AI\n` +
          `<code>/send &lt;chat_id&gt; &lt;text&gt;</code> — Direct message\n` +
          `<code>/help</code> — Help\n\n` +
          (status
            ? `📢 <b>Current status:</b>\n<i>"${esc(status.text)}"</i>`
            : `<i>No status set for today.</i>`),
        parse_mode: 'HTML'
      });
      return res.status(200).json({ ok: true });
    }

    /* ─── 3️⃣ OWNER /status ─── */
    if (isFromOwner && (txt === '/status' || txt.startsWith('/status '))) {
      const arg = txt.slice(8).trim();

      if (!arg) {
        const status = getStatus();
        await tg('sendMessage', {
          chat_id: chatId,
          text: status
            ? `📢 <b>Today's status:</b>\n<i>"${esc(status.text)}"</i>\n\n<i>Auto-clears at midnight</i>`
            : `ℹ️ No status set.\n\nUse: <code>/status ዛሬ አሞኛል</code>`,
          parse_mode: 'HTML'
        });
        return res.status(200).json({ ok: true });
      }

      if (arg === 'clear' || arg === 'delete' || arg === 'off') {
        clearStatus();
        await tg('sendMessage', {
          chat_id: chatId,
          text: '✅ Status cleared for today.'
        });
        return res.status(200).json({ ok: true });
      }

      setStatus(arg);
      await tg('sendMessage', {
        chat_id: chatId,
        text:
          `✅ <b>Status set!</b>\n\n` +
          `📢 <i>"${esc(arg)}"</i>\n\n` +
          `⏰ Auto-clears at midnight\n` +
          `💬 Bot will tell senders this when they ask about you.`,
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
          `• Reply to notifications → direct reply\n` +
          `• <code>/status &lt;text&gt;</code> — Set today's status\n` +
          `• <code>/status clear</code> — Remove status\n` +
          `• <code>/send &lt;chat_id&gt; &lt;text&gt;</code> — Direct message\n` +
          `• <code>/pause</code>, <code>/resume</code> — Control AI\n` +
          `• <code>/stats</code> — Bot info`,
        parse_mode: 'HTML'
      });
      return res.status(200).json({ ok: true });
    }

    /* ─── 5️⃣ OWNER /stats ─── */
    if (isFromOwner && txt === '/stats') {
      const status = getStatus();
      await tg('sendMessage', {
        chat_id: chatId,
        text:
          `📊 <b>Bot Status</b>\n\n` +
          `✅ Online\n` +
          `🧠 Model: Master AI\n` +
          `💾 Storage: Memory\n` +
          `💬 History entries: ${state.history.size}\n` +
          `👥 Known chats: ${state.introduced.size}\n` +
          `⏸️ Paused: ${state.paused ? 'Yes' : 'No'}\n` +
          `📢 Today status: ${status ? 'Set ✅' : 'None'}`,
        parse_mode: 'HTML'
      });
      return res.status(200).json({ ok: true });
    }

    /* ─── 6️⃣ OWNER /pause ─── */
    if (isFromOwner && txt === '/pause') {
      state.paused = true;
      await tg('sendMessage', { chat_id: chatId, text: '⏸️ AI paused. Send /resume to restart.' });
      return res.status(200).json({ ok: true });
    }

    /* ─── 7️⃣ OWNER /resume ─── */
    if (isFromOwner && txt === '/resume') {
      state.paused = false;
      await tg('sendMessage', { chat_id: chatId, text: '▶️ AI resumed.' });
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

      const r = await tg('sendMessage', { chat_id: targetId, text: msgText });
      await tg('sendMessage', {
        chat_id: chatId,
        text: r && r.ok ? '✅ Sent' : '❌ Failed'
      });
      return res.status(200).json({ ok: true });
    }

    /* ─── 9️⃣ NON-OWNER — Regular user ─── */
    if (!isFromOwner && txt && !txt.startsWith('/')) {
      if (state.paused) return res.status(200).json({ ok: true });

      const senderName = dm.from?.first_name || 'there';
      const firstName = senderName.split(' ')[0];
      const isFirst = !state.introduced.has(String(chatId));

      console.log('[Anu] DM from', firstName, '| first:', isFirst);

      const status = getStatus();
      const reply = await generateReply(OWNER_NAME, firstName, txt, chatId, isFirst, status);

      await tg('sendMessage', {
        chat_id: chatId,
        text: reply,
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
            `🤖 Anu: <i>"${esc(reply.slice(0, 180))}${reply.length > 180 ? '…' : ''}"</i>\n\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `↩️ Reply to this message to send your own reply\n` +
            `📎 Or use: <code>/send ${chatId} &lt;message&gt;</code>\n\n` +
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

      const status = getStatus();
      const reply = await generateReply(OWNER_NAME, firstName, '/start', chatId, isFirst, status);

      await tg('sendMessage', { chat_id: chatId, text: reply });
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

  console.log('[Anu] Business from', firstName, '| first:', isFirst);

  tg('sendChatAction', {
    chat_id: chatId,
    action: isPhoto ? 'upload_photo' : 'typing',
    business_connection_id: bizConnId
  }).catch(() => {});

  const status = getStatus();
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

  if (isFirst) state.introduced.add(String(chatId));

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
        `${emoji} <b>${esc(label)}</b> from <b>${esc(firstName)}</b>\n\n` +
        `💬 <i>"${esc(userText || '[photo]')}"</i>\n\n` +
        `🤖 Anu: <i>"${esc(reply.slice(0, 180))}${reply.length > 180 ? '…' : ''}"</i>\n\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `↩️ Reply to this message to send your own reply\n` +
        `📎 Or use: <code>/send ${chatId} &lt;message&gt;</code>\n\n` +
        `REF:${chatId}:${bizConnId}`,
      parse_mode: 'HTML'
    });
  }

  return res.status(200).json({ ok: true });
}
