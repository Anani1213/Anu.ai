/* ============================================================
   Anu Assistant Bot v13.0
   ------------------------------------------------------------
   ✅ Single file, no Firebase
   ✅ Only master AI (openai/gpt-oss-120b)
   ✅ Always identifies as Ananya's assistant
   ✅ Deep reasoning + natural language
   ✅ Owner manual reply via /send or reply-to-notification
   ✅ Amharic + English + Amharic-in-Latin (perfect matching)
   ✅ No parroting, no spam, no leaks
   ============================================================ */

const SMART_MODEL = 'openai/gpt-oss-120b';
const VISION_MODEL = 'qwen/qwen3.8-27b';

/* ═══════════════════════════════════════════════════════════
   IN-MEMORY CACHE (per warm instance only)
   ═══════════════════════════════════════════════════════════ */
const introduced = new Set();
const history = new Map();
const paused = { global: false };

function prune() {
  if (history.size > 200) {
    const keys = [...history.keys()].slice(0, 100);
    keys.forEach(k => history.delete(k));
  }
}

function getHistory(chatId) {
  return history.get(String(chatId)) || [];
}

function addHistory(chatId, role, content) {
  const key = String(chatId);
  const h = history.get(key) || [];
  h.push({ role, content });
  history.set(key, h.slice(-10));
  prune();
}

/* ═══════════════════════════════════════════════════════════
   MASTER SYSTEM PROMPT
   ═══════════════════════════════════════════════════════════ */
function systemPrompt(ownerName, senderName) {
  return `You are **Anu** — the personal AI assistant of **${ownerName}**, a warm Ethiopian man.

═══════════════════════════════════════════
🎯 YOUR CORE IDENTITY (NEVER FORGET)
═══════════════════════════════════════════
- Your name: **Anu**
- You are **${ownerName}'s AI assistant**
- You work FOR ${ownerName} — you are NOT ${ownerName}
- Speak about ${ownerName} in THIRD PERSON always
- NEVER say "I am ${ownerName}"
- ✅ Say: "${ownerName} is my boss", "I'll tell ${ownerName}", "I'm Anu, ${ownerName}'s assistant"

═══════════════════════════════════════════
🚨 CRITICAL: EVERY REPLY MUST FOLLOW THESE
═══════════════════════════════════════════
1. **ALWAYS identify as Anu, ${ownerName}'s assistant** — even on greetings
2. **Be brief and warm** — 2 short sentences (like real texting)
3. **Match the EXACT language style** — see below
4. **NEVER echo their exact words back**
5. **NEVER reply with just "Hi!" or 1 word**
6. **NEVER reveal AI model names** (ChatGPT, GPT, Llama, Qwen, Groq)
7. **NEVER show reasoning or thinking**
8. **If they want ${ownerName}** → "I'll let ${ownerName} know right away 🙏"
9. **If they ask a question** → answer it helpfully
10. **If unsure** → "Let me check with ${ownerName} 🙏"

═══════════════════════════════════════════
🌍 LANGUAGE MATCHING (CRITICAL)
═══════════════════════════════════════════
Match the sender's EXACT style:

1. **Amharic (Ge'ez script)** — reply in Amharic:
   "ሰላም" → "ሰላም! እኔ Anu ነኝ — የ ${ownerName} ረዳት 😊 ምን ልርዳህ?"
   "እንደምን ነህ?" → "ደህና ነኝ! አንተስ? እኔ Anu ነኝ — የ ${ownerName} ረዳት 😊"

2. **English** — reply in English:
   "Hi" → "Hi! I'm Anu, ${ownerName}'s AI assistant 😊 How can I help you?"
   "How are you?" → "I'm doing great, thanks! I'm Anu, ${ownerName}'s assistant. What can I help you with? 💛"

3. **Amharic-in-Latin (VERY IMPORTANT)** — reply in SAME STYLE:
   "selam" → "selam! ene Anu negn — ye ${ownerName} redat 😊 min lirdah?"
   "salam" → "salam! ene Anu negn, ye ${ownerName} redat. endet liredah? 😊"
   "dehna neh?" → "dehna negn, amesegnalehu! ene Anu negn — ye ${ownerName} redat 😊"
   "amesegenalew" → "amesegnalehu! 😊 ene Anu negn, min lirdah?"
   "man neh?" → "ene Anu negn — ye ${ownerName} redat 😊 antes?"
   "hi" → "Hi! ene Anu negn, ye ${ownerName} redat. endet liredah? 😊"

4. **Mixed** — match dominant language
5. **Emojis** — mirror them naturally

═══════════════════════════════════════════
🇪🇹 ETHIOPIAN WORD CHOICE (NATURAL)
═══════════════════════════════════════════
- ደህና ነህ? (male) / ደህና ነሽ? (female)
- እንዴት ነህ? / እንዴት ነሽ?
- ጤና ይስጥልኝ
- አመሰግናለሁ / amesegnalehu
- እሺ (okay)
- ምን ልርዳህ? (what can I help with?)
- ሰላም (peace/hello)

Match gender when inferrable from name.

═══════════════════════════════════════════
🎭 EXAMPLE REPLIES
═══════════════════════════════════════════
User: "Hi"
✅ GOOD: "Hi! I'm Anu, ${ownerName}'s AI assistant 😊 How can I help you today?"
❌ BAD: "Hi!" (echo)

User: "selam"
✅ GOOD: "selam! ene Anu negn — ye ${ownerName} redat 😊 min lirdah?"
❌ BAD: "selam!" (echo)

User: "Ananya ን አሳውቅ"
✅ GOOD: "እሺ! ${ownerName} ን አሳውቀዋለሁ 🙏"
❌ BAD: "Ananya ን አሳውቅ" (echo)

User: "How can I contact Ananya?"
✅ GOOD: "I'm Anu, ${ownerName}'s assistant. Leave your message here and I'll forward it to him 🙏"

═══════════════════════════════════════════
📸 PHOTOS
═══════════════════════════════════════════
Warm genuine reaction, ONE or TWO short sentences:
"I'm Anu, ${ownerName}'s assistant. Nice photo! What can I help you with? 😊"

═══════════════════════════════════════════
😠 INSULTS
═══════════════════════════════════════════
NEVER insult back. Stay calm:
"ምንም አይደለም፣ እንዴት ልርዳህ እችላለሁ?"

═══════════════════════════════════════════
🚨 OUTPUT FORMAT
═══════════════════════════════════════════
Output ONLY the reply text — no reasoning, no drafts, no explanation.
Just the natural reply as Anu.`;
}

/* ═══════════════════════════════════════════════════════════
   GROQ API CALL
   ═══════════════════════════════════════════════════════════ */
async function callAI(modelId, sysPrompt, messages, opts = {}) {
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
        model: modelId,
        messages: [{ role: 'system', content: sysPrompt }, ...messages],
        temperature: opts.temperature ?? 0.75,
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

    content = cleanResponse(content);
    return { ok: true, content };
  } catch (e) {
    clearTimeout(tId);
    return { ok: false, error: e.name === 'AbortError' ? 'Timeout' : e.message };
  }
}

/* Strip reasoning leaks and clean up */
function cleanResponse(text) {
  if (!text) return text;
  let t = text;

  // Remove think tags
  t = t.replace(/ thinking[\s\S]*?<\/think>/gi, '');
  t = t.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '');

  // Remove reasoning headers
  t = t.replace(/^(#{1,6}\s*)?(thinking|reasoning|chain of thought|analysis|my thought process|let me think|draft|tone|language):[\s\S]*?(?=\n\n[A-Z\u1200-\u137F]|\n#{1,6}\s|$)/gim, '');

  // If response is literally just a draft pattern
  const draftMatch = t.match(/draft:\s*"([^"]+)"/i);
  if (draftMatch && t.length < 300) {
    t = draftMatch[1];
  }

  return t.trim();
}

/* Detect weak/echo/parroting reply */
function isWeakReply(reply, userText, ownerName) {
  if (!reply) return true;
  const r = reply.toLowerCase().trim();
  const u = (userText || '').toLowerCase().trim();

  // Too short
  if (r.length < 20) return true;

  // Exact echo
  if (r === u) return true;

  // Greeting-only
  if (/^(hi|hello|hey|selam|salam|ሰላም|hi!|hello!|ሰላም!)[\s!?.😊🙏😄]*$/i.test(r)) return true;

  // Doesn't mention "Anu" when it should
  const shouldMentionAnu = /^(hi|hello|hey|selam|salam|ሰላም|man neh|who are you|who r u)/i.test(u) ||
                            /(who are you|ማን ነህ|who r u)/i.test(u);
  if (shouldMentionAnu && !/anu/i.test(r)) return true;

  return false;
}

/* ═══════════════════════════════════════════════════════════
   GENERATE REPLY
   ═══════════════════════════════════════════════════════════ */
async function generateReply(ownerName, senderName, userText, chatId, isFirst) {
  const sys = systemPrompt(ownerName, senderName);
  const hist = getHistory(chatId).slice(-6).map(h => ({ role: h.role, content: h.content }));

  // First contact → force intro
  if (isFirst) {
    const introPrompt = `${sys}

═══════════════════════════════════════════
🎯 FIRST CONTACT — SPECIAL INSTRUCTION
═══════════════════════════════════════════
This is the FIRST time "${senderName}" is messaging you.
- Introduce yourself as "Anu, ${ownerName}'s AI assistant"
- Give them TWO options:
  1. Send a message to ${ownerName} (you'll forward it)
  2. Get help from you directly
- Ask which they'd prefer
- Match their language EXACTLY
- Keep it short (2-3 sentences)`;

    const r = await callAI(SMART_MODEL, introPrompt,
      [{ role: 'user', content: userText }],
      { maxTokens: 300, temperature: 0.85 }
    );

    if (r.ok && /anu/i.test(r.content) && r.content.length > 30) {
      return r.content;
    }

    // Fallback guaranteed intro
    const isAmharic = /[\u1200-\u137F]/.test(userText);
    if (isAmharic) {
      return `ሰላም ${senderName}! እኔ Anu ነኝ — የ ${ownerName} ረዳት 🤖\nጥያቄ ልርዳህ ወይስ ለ ${ownerName} መልእክት ልላክ?\nምን ትፈልጋለህ? 💛`;
    }
    return `Hi ${senderName}! I'm Anu, ${ownerName}'s AI assistant 🤖\nI can help with questions or forward a message to ${ownerName}.\nWhat would you like? 💛`;
  }

  // Regular → single master AI call
  const userContent = `${senderName}: "${userText}"`;
  const r = await callAI(SMART_MODEL, sys,
    [...hist, { role: 'user', content: userContent }],
    { maxTokens: 300, temperature: 0.8 }
  );

  if (r.ok && !isWeakReply(r.content, userText, ownerName)) {
    addHistory(chatId, 'user', userText);
    addHistory(chatId, 'assistant', r.content);
    return r.content;
  }

  // Retry if weak
  if (r.ok) {
    console.warn('[Anu] Weak reply, retrying:', r.content?.slice(0, 60));
    const retryPrompt = `${sys}

🚨 YOUR PREVIOUS REPLY WAS TOO WEAK (short/echo/no identity).
Try again. REQUIREMENTS:
- Include "Anu" and "${ownerName}'s assistant" 
- At least 2 short sentences
- Match the sender's exact language style
- Warm and helpful`;

    const retry = await callAI(SMART_MODEL, retryPrompt,
      [{ role: 'user', content: userContent }],
      { maxTokens: 300, temperature: 0.9 }
    );

    if (retry.ok && retry.content.length > 20 && !isWeakReply(retry.content, userText, ownerName)) {
      addHistory(chatId, 'user', userText);
      addHistory(chatId, 'assistant', retry.content);
      return retry.content;
    }
  }

  // Final guaranteed fallback
  const isAmharic = /[\u1200-\u137F]/.test(userText);
  const isLatin = /(selam|salam|dehna|endet|amesegn)/i.test(userText);

  if (isAmharic) {
    return `ሰላም! እኔ Anu ነኝ — የ ${ownerName} ረዳት 😊 ምን ልርዳህ?`;
  }
  if (isLatin) {
    return `selam! ene Anu negn — ye ${ownerName} redat 😊 min lirdah?`;
  }
  return `Hi! I'm Anu, ${ownerName}'s assistant 😊 How can I help you?`;
}

/* ═══════════════════════════════════════════════════════════
   ANALYZE PHOTO
   ═══════════════════════════════════════════════════════════ */
async function analyzePhoto(ownerName, senderName, userText, isFirst) {
  const sys = systemPrompt(ownerName, senderName);
  const contextText = userText
    ? `[${senderName} sent a photo with caption: "${userText}"]`
    : `[${senderName} sent a photo]`;

  const instruction = isFirst
    ? `${contextText}\n\nAcknowledge the photo AND introduce yourself as "Anu, ${ownerName}'s assistant". Offer to help or forward message.`
    : `${contextText}\n\nReact warmly (ONE or TWO sentences). If greeting, include your identity.`;

  const r = await callAI(SMART_MODEL, sys,
    [{ role: 'user', content: instruction }],
    { maxTokens: 250, temperature: 0.85 }
  );

  if (r.ok && r.content && r.content.length > 15) {
    if (isFirst && !/anu/i.test(r.content)) {
      return `Nice photo! I'm Anu, ${ownerName}'s assistant 😊 What can I help you with?`;
    }
    return r.content;
  }

  return `Nice photo! I'm Anu, ${ownerName}'s assistant 😊 How can I help?`;
}

/* ═══════════════════════════════════════════════════════════
   DETECTION HELPERS
   ═══════════════════════════════════════════════════════════ */
function wantsOwner(text) {
  const t = (text || '').toLowerCase();
  return /(ananya|anani|owner|boss|speak to|talk to|important|urgent|meet|meeting|business|tell her|tell him|notify|reach her|reach him|contact her|contact him|let her know|let him know|pass this|forward this|አናንያ|አናኒ|ባለቤት|አስቸኳይ|አስፈላጊ|ንግድ|ጉዳይ|ስብሰባ|ቀጠሮ|ንገረው|ንገራት|ንገረኝ|አሳውቅ|አሳውቂ|አሳውቀው|አስታውቅ|ጥራው|ጥራት|ጥሪው|ደውል|ደውልለት|ደውልላት|አግኝ|አግኚ|ተናገር|ልናገር|ልናገራት|ልናገረው|nigerew|nigerat|nigeren|asawq|asekayi|asfelagi|guday|sbsba|qetro|traw|tirat|dewil|agen|nager|lenager|lenagrat|lenagerew)/i.test(t);
}

function detectSentiment(text) {
  const t = (text || '').toLowerCase();
  if (/(urgent|asap|emergency|አስቸኳይ|ፈጣን)/i.test(t)) return 'urgent';
  if (/(angry|upset|furious|mad|hate|😡|🤬|ተናደድኩ|ደደብ)/i.test(t)) return 'angry';
  if (/(sad|cry|😢|😭|አዘንኩ|ተቸገርኩ)/i.test(t)) return 'sad';
  if (/(happy|great|love|😊|😄|❤|ደስ|ጥሩ)/i.test(t)) return 'happy';
  return 'neutral';
}

/* ═══════════════════════════════════════════════════════════
   PARSE REF MARKER (from reply-to-notification)
   ═══════════════════════════════════════════════════════════ */
function parseRef(text) {
  if (!text) return null;
  const m = text.match(/REF:([0-9-]+):([a-zA-Z0-9_-]+)/);
  if (!m) return null;
  return {
    chatId: m[1],
    bizConnId: m[2] === 'direct' ? null : m[2]
  };
}

/* ═══════════════════════════════════════════════════════════
   MAIN HANDLER
   ═══════════════════════════════════════════════════════════ */
export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'Anu Assistant Bot v13.0',
      identity: 'Anu — Ananya\'s AI assistant',
      model: SMART_MODEL
    });
  }
  if (req.method !== 'POST') return res.status(405).send('Method not allowed');

  const BOT_TOKEN = process.env.BUSINESS_BOT_TOKEN;
  const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID;
  const OWNER_NAME = process.env.OWNER_NAME || 'Ananya';
  const GROQ_KEY = process.env.GROQ_API_KEY;

  if (!BOT_TOKEN || !GROQ_KEY) {
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

      console.log('[Anu] ═══ OWNER REPLY ═══');
      console.log('[Anu] Target ref:', JSON.stringify(ref));

      if (ref) {
        const payload = { chat_id: ref.chatId, text: txt };
        if (ref.bizConnId) payload.business_connection_id = ref.bizConnId;

        const sendResult = await tg('sendMessage', payload);

        if (sendResult && sendResult.ok) {
          await tg('sendMessage', {
            chat_id: chatId,
            text: '✅ Sent',
            reply_to_message_id: dm.message_id
          });
          console.log('[Anu] ✅ Manual reply routed');
        } else {
          await tg('sendMessage', {
            chat_id: chatId,
            text: `❌ Failed: \`${JSON.stringify(sendResult).slice(0, 100)}\``,
            parse_mode: 'Markdown',
            reply_to_message_id: dm.message_id
          });
        }
      } else {
        await tg('sendMessage', {
          chat_id: chatId,
          text: '⚠️ Could not find target. Use: `/send <chat_id> <message>`',
          parse_mode: 'Markdown',
          reply_to_message_id: dm.message_id
        });
      }
      return res.status(200).json({ ok: true });
    }

    /* ─── 2️⃣ /start ─── */
    if (txt === '/start') {
      if (isFromOwner) {
        await tg('sendMessage', {
          chat_id: chatId,
          text:
            `✅ *Anu Assistant Bot v13.0*\n\n` +
            `🤖 Anu — ${OWNER_NAME}'s AI assistant\n\n` +
            `*Commands:*\n` +
            `/start — This menu\n` +
            `/stats — Bot info\n` +
            `/pause — Pause AI\n` +
            `/resume — Resume AI\n` +
            `/send <chat_id> <text> — Send message\n` +
            `/help — Help\n\n` +
            `💡 Reply to any notification to send your own reply`,
          parse_mode: 'Markdown'
        });
      } else {
        const senderName = dm.from?.first_name || 'there';
        const firstName = senderName.split(' ')[0];
        const isFirst = !introduced.has(String(chatId));

        const reply = await generateReply(OWNER_NAME, firstName, '/start', chatId, isFirst);

        await tg('sendMessage', { chat_id: chatId, text: reply });
        if (isFirst) introduced.add(String(chatId));
      }
      return res.status(200).json({ ok: true });
    }

    /* ─── 3️⃣ /help ─── */
    if (txt === '/help') {
      await tg('sendMessage', {
        chat_id: chatId,
        text: isFromOwner
          ? `*Owner Commands*\n\n• Reply to notifications → direct reply\n• /send <chat_id> <text> — direct\n• /stats — info\n• /pause, /resume — control`
          : `*How I help*\n\n💬 Ask me anything\n📩 Send message to ${OWNER_NAME}\n🚨 Say "Ananya" or "urgent" for attention\n😊 Amharic + English`,
        parse_mode: 'Markdown'
      });
      return res.status(200).json({ ok: true });
    }

    /* ─── 4️⃣ OWNER COMMANDS ─── */
    if (isFromOwner && txt === '/stats') {
      await tg('sendMessage', {
        chat_id: chatId,
        text:
          `📊 *Bot Status*\n\n` +
          `✅ Online\n` +
          `🧠 Model: Master AI\n` +
          `👥 Known chats (this instance): ${introduced.size}\n` +
          `💾 History entries: ${history.size}\n` +
          `⏸️ Paused: ${paused.global ? 'Yes' : 'No'}`,
        parse_mode: 'Markdown'
      });
      return res.status(200).json({ ok: true });
    }

    if (isFromOwner && txt === '/pause') {
      paused.global = true;
      await tg('sendMessage', { chat_id: chatId, text: '⏸️ AI paused' });
      return res.status(200).json({ ok: true });
    }

    if (isFromOwner && txt === '/resume') {
      paused.global = false;
      await tg('sendMessage', { chat_id: chatId, text: '▶️ AI resumed' });
      return res.status(200).json({ ok: true });
    }

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

    /* ─── 5️⃣ NON-OWNER DIRECT MESSAGE ─── */
    if (!isFromOwner && txt && !txt.startsWith('/')) {
      if (paused.global) return res.status(200).json({ ok: true });

      const senderName = dm.from?.first_name || 'there';
      const firstName = senderName.split(' ')[0];
      const isFirst = !introduced.has(String(chatId));

      console.log('[Anu] DM from', firstName, '| first:', isFirst);

      const reply = await generateReply(OWNER_NAME, firstName, txt, chatId, isFirst);

      await tg('sendMessage', {
        chat_id: chatId,
        text: reply,
        reply_to_message_id: dm.message_id
      });

      if (isFirst) introduced.add(String(chatId));

      /* ─── ESCALATION ─── */
      const sentiment = detectSentiment(txt);
      const needsOwner = wantsOwner(txt);

      if ((needsOwner || sentiment === 'urgent' || sentiment === 'angry') && OWNER_CHAT_ID) {
        console.log('[Anu] 🔔 Escalating (DM)');
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

  if (paused.global) return res.status(200).json({ ok: true });

  let userText = '';
  let isPhoto = false;

  if (message.text) userText = message.text.trim();
  else if (message.caption) userText = message.caption.trim();
  if (message.photo && message.photo.length > 0) isPhoto = true;

  if (!userText && !isPhoto) return res.status(200).json({ ok: true });
  if (userText.startsWith('/')) return res.status(200).json({ ok: true });

  const firstName = senderName.split(' ')[0];
  const isFirst = !introduced.has(String(chatId));

  console.log('[Anu] Business msg from', firstName, '| first:', isFirst, '| photo:', isPhoto);

  // Typing indicator
  tg('sendChatAction', {
    chat_id: chatId,
    action: isPhoto ? 'upload_photo' : 'typing',
    business_connection_id: bizConnId
  }).catch(() => {});

  let reply = '';
  if (isPhoto) {
    reply = await analyzePhoto(OWNER_NAME, firstName, userText, isFirst);
  } else {
    reply = await generateReply(OWNER_NAME, firstName, userText, chatId, isFirst);
  }

  if (!reply) reply = `Hi! I'm Anu, ${OWNER_NAME}'s assistant 😊 How can I help?`;

  // Small human delay
  await new Promise(r => setTimeout(r, Math.min(reply.length * 15, 1200)));

  await tg('sendMessage', {
    chat_id: chatId,
    text: reply,
    business_connection_id: bizConnId,
    reply_to_message_id: msgId
  });

  if (isFirst) introduced.add(String(chatId));

  /* ─── ESCALATION ─── */
  const sentiment = detectSentiment(userText);
  const needsOwner = wantsOwner(userText);

  if ((needsOwner || sentiment === 'urgent' || sentiment === 'angry') && OWNER_CHAT_ID) {
    console.log('[Anu] 🔔 Escalating (business)');
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
