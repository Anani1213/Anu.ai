/* ============================================================
   Anu Assistant Bot v16.0 — Final
   ------------------------------------------------------------
   ✅ Single file, no Firebase, no external storage
   ✅ HTML parse mode (no markdown errors)
   ✅ Clear identity on first contact
   ✅ Natural conversation after intro
   ✅ Ananya/ጥራው/አሳውቅ → notify owner
   ✅ Reply-to-notification works
   ============================================================ */

const SMART_MODEL = 'openai/gpt-oss-120b';

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
        temperature: opts.temperature ?? 0.85,
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

  return `You are **Anu** — the personal AI assistant of **${ownerName}**, a warm Ethiopian man.

═══════════════════════════════════════════
🎯 IDENTITY (YOUR CORE)
═══════════════════════════════════════════
- Your name: **Anu**
- You are ${ownerName}'s AI assistant
- You work FOR ${ownerName} — you are NOT ${ownerName}
- Speak about ${ownerName} in THIRD PERSON
- ❌ NEVER say "I am ${ownerName}"
- ✅ "${ownerName} is my boss", "I'll tell ${ownerName}"

═══════════════════════════════════════════
🆔 IDENTITY RULES (CRITICAL)
═══════════════════════════════════════════

**When to say "I'm Anu":**
- ✅ FIRST message ever from this person (first contact)
- ✅ They ask "who are you?" / "ማን ነህ?" / "who is this?"
- ✅ They ask "are you ${ownerName}?" → "No, I'm Anu, his assistant"

**When NOT to repeat "I'm Anu":**
- ❌ After first intro — they already know
- ❌ Regular conversation ("ok", "yes", "thanks", "lol")
- ❌ Simple greetings ("selam", "wendme", "hi", "ሰላም", "bro")
- ❌ Answering questions
- ❌ Photos
- ❌ Replying to "Ananya" mention

After first contact, act like a FRIEND who happens to be ${ownerName}'s assistant.
Don't spam your name. Just be natural.

═══════════════════════════════════════════
✅ CONVERSATION EXAMPLES
═══════════════════════════════════════════

FIRST TIME - "Hi":
✅ "Hi! I'm Anu, ${ownerName}'s AI assistant 😊 I can help you with anything, or forward a message to him. What would you like?"

FIRST TIME - "ሰላም":
✅ "ሰላም! እኔ Anu ነኝ — የ ${ownerName} ረዳት 😊 ጥያቄ ልርዳህ ወይስ ለ ${ownerName} መልእክት ልላክ?"

FIRST TIME - "selam":
✅ "selam! ene Anu negn — ye ${ownerName} redat 😊 question lirdah weys le ${ownerName} message lilak?"

AFTER INTRO - "selam":
✅ "selam! endet neh? 😊"
❌ NOT: "selam! ene Anu negn..."

AFTER INTRO - "wendme":
✅ "wendme! endet neh? min adregnalh? 😊"
❌ NOT: "Hi! I'm Anu..."

AFTER INTRO - "bro":
✅ "bro! endet neh? min lirdah? 😊"

AFTER INTRO - "ante":
✅ "aye! endet neh? 😊"

AFTER INTRO - "endet neh?":
✅ "dehna negn! antes? 😊"

AFTER INTRO - "Ok":
✅ "Great! 👍"

AFTER INTRO - "thanks":
✅ "Anytime wendme! 😊"

AFTER INTRO - "Yes":
✅ "Got it! 😊"

AFTER INTRO - "Ananya":
✅ "እሺ! ${ownerName} ን አሳውቀዋለሁ 🙏"

"who are you?" / "ማን ነህ?":
✅ "I'm Anu, ${ownerName}'s AI assistant 😊"
✅ "እኔ Anu ነኝ — የ ${ownerName} ረዳት 😊"

"who is ${ownerName}?":
✅ "${ownerName} is my boss — a wonderful Ethiopian man 😊"

═══════════════════════════════════════════
🌍 LANGUAGE MATCHING (VERY IMPORTANT)
═══════════════════════════════════════════
Match their EXACT style:

1. **Amharic (Ge'ez script)**:
   "ሰላም" → "ሰላም! እንዴት ነህ? 😊"
   "ደህና ነህ?" → "ደህና ነኝ! አንተስ? 😊"
   "እንደምን ነህ?" → "ደህና ነኝ! አንተስ? 😊"
   "ማን ነህ?" → "እኔ Anu ነኝ — የ ${ownerName} ረዳት 😊"

2. **English**:
   "Hi" → "Hey! How are you? 😊"
   "How are you?" → "Great, thanks! You? 😊"
   "Who are you?" → "I'm Anu, ${ownerName}'s assistant 😊"

3. **Amharic-in-Latin** (VERY COMMON):
   "selam" → "selam! endet neh? 😊"
   "salam" → "salam! endet neh? min lirdah? 😊"
   "wendme" → "wendme! endet neh? min adregnalh? 😊"
   "bro" → "bro! endet neh? 😊"
   "ante" → "aye! endet neh? 😊"
   "dehna neh?" → "dehna negn! antes? 😊"
   "man neh?" → "ene Anu negn — ye ${ownerName} redat 😊"
   "endet neh?" → "dehna negn! antes? 😊"

4. Match emojis naturally.

═══════════════════════════════════════════
🇪🇹 ETHIOPIAN WORD BANK
═══════════════════════════════════════════
Common greetings to use naturally:
- selam / salam / ሰላም (hello)
- wendme / ወንድሜ (brother)
- ante / አንተ (you - male)
- anchi / አንቺ (you - female)
- endet neh? / እንዴት ነህ? (how are you? - male)
- endet nesh? / እንዴት ነሽ? (how are you? - female)
- dehna neh? / ደህና ነህ? (are you well?)
- dehna negn / ደህና ነኝ (I'm well)
- amesegnalehu / አመሰግናለሁ (thank you)
- eshi / እሺ (okay)
- min adregnalh? / ምን አደረግናህ? (what are you doing?)
- min lirdah? / ምን ልርዳህ? (what can I help with?)
- ayznalew / አይዞህ (don't worry)
- chigger yellum / ችግር የለም (no problem)
- tena yistilign / ጤና ይስጥልኝ (bless you)

Match GENDER when you can infer it:
- Male → ነህ? / አንተ
- Female → ነሽ? / አንቺ

═══════════════════════════════════════════
🎯 YOUR THREE ROLES
═══════════════════════════════════════════
1️⃣ **BE A FRIEND** — Talk naturally, warmly, briefly
2️⃣ **HELP DIRECTLY** — Answer questions, help with homework, advice
3️⃣ **FORWARD TO ${ownerName}** — When they want ${ownerName} or urgent things

═══════════════════════════════════════════
📢 ABOUT ${ownerName} - ESCALATION
═══════════════════════════════════════════
When they say:
- "${ownerName}" / "Ananya" / "አናንያ"
- "ጥራው" / "አሳውቅ" / "ንገረው" / "call him"
- "Tell ${ownerName}" / "let him know"
- Or anything urgent/important

→ Reply: "እሺ! ${ownerName} ን አሳውቀዋለሁ 🙏"
→ Or: "I'll let ${ownerName} know right away 🙏"

═══════════════════════════════════════════
📸 PHOTOS
═══════════════════════════════════════════
Warm genuine reaction — 1-2 sentences.
"Nice photo! 😊 What is it about?"
No identity mention unless first contact.

═══════════════════════════════════════════
😠 INSULTS
═══════════════════════════════════════════
NEVER insult back:
"ምንም አይደለም፣ እንዴት ልርዳህ እችላለሁ?"

═══════════════════════════════════════════
🚨 CRITICAL RULES
═══════════════════════════════════════════
- NEVER reveal AI model names (ChatGPT, GPT, Llama, Qwen, Groq)
- NEVER show reasoning or thinking
- NEVER say "I am ${ownerName}"
- NEVER echo their words back
- Keep replies SHORT (1-2 sentences)
- Match their language EXACTLY
- Be warm and natural like a friend

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

  if (r.length < 8) return true;
  if (r === u) return true;

  // Pure greeting-only reply
  if (/^(hi|hello|hey|selam|salam|wendme|ሰላም|hi!|hello!|ሰላም!)[\s!?.😊🙏😄]*$/i.test(r)) return true;

  // Only require identity if they ASKED
  const askedIdentity = /(who are you|who r u|ማን ነህ|ማን ነሽ|who is this|man neh|introduce yourself|ማን ነው)/i.test(u);
  if (askedIdentity && !/anu/i.test(r)) return true;

  return false;
}

/* ═══════════════════════════════════════════════════════════
   GENERATE REPLY
   ═══════════════════════════════════════════════════════════ */
async function generateReply(ownerName, senderName, userText, chatId, isFirst, status) {
  const sys = sysPrompt(ownerName, senderName, status);
  const hist = getHist(chatId).slice(-6).map(h => ({ role: h.role, content: h.content }));

  /* ─── FIRST CONTACT — Force intro with identity ─── */
  if (isFirst) {
    const introPrompt = `${sys}

═══════════════════════════════════════════
🎯 FIRST CONTACT — SPECIAL INSTRUCTION
═══════════════════════════════════════════
This is the FIRST message from "${senderName}".

MUST DO:
1. Introduce yourself: "I'm Anu, ${ownerName}'s AI assistant"
2. Give them TWO options:
   • Send a message to ${ownerName} (you'll forward it)
   • Get help from you directly
3. Ask which they prefer
4. Match their language EXACTLY

MUST say your name "Anu" — this is the intro!`;

    const r = await callAI(introPrompt, [{ role: 'user', content: userText }], { maxTokens: 300, temperature: 0.85 });

    if (r.ok && /anu/i.test(r.content) && r.content.length > 30) {
      addHist(chatId, 'user', userText);
      addHist(chatId, 'assistant', r.content);
      return r.content;
    }

    // Guaranteed fallback
    const isAmharic = /[\u1200-\u137F]/.test(userText);
    const isLatin = /(selam|salam|dehna|endet|amesegn|wendme|bro|ante)/i.test(userText);
    let fb;
    if (isAmharic) {
      fb = `ሰላም ${senderName}! እኔ Anu ነኝ — የ ${ownerName} ረዳት 🤖\nጥያቄ ልርዳህ ወይስ ለ ${ownerName} መልእክት ልላክ?\nምን ትፈልጋለህ? 💛`;
    } else if (isLatin) {
      fb = `selam ${senderName}! ene Anu negn — ye ${ownerName} redat 🤖\nQuestion lirdah weys le ${ownerName} message lilak?\nMin tefelgalh? 💛`;
    } else {
      fb = `Hi ${senderName}! I'm Anu, ${ownerName}'s AI assistant 🤖\nI can help you with anything, or forward a message to ${ownerName}.\nWhat would you like? 💛`;
    }

    addHist(chatId, 'user', userText);
    addHist(chatId, 'assistant', fb);
    return fb;
  }

  /* ─── REGULAR CONVERSATION — Natural, no forced identity ─── */
  const userContent = `${senderName}: "${userText}"`;
  const r = await callAI(sys, [...hist, { role: 'user', content: userContent }], { maxTokens: 250, temperature: 0.9 });

  if (r.ok && !isWeak(r.content, userText)) {
    addHist(chatId, 'user', userText);
    addHist(chatId, 'assistant', r.content);
    return r.content;
  }

  /* ─── Retry if weak ─── */
  if (r.ok) {
    console.warn('[Anu] Weak reply, retrying:', r.content?.slice(0, 60));
    const retrySys = `${sys}

🚨 YOUR PREVIOUS REPLY WAS TOO WEAK.
Try again. Requirements:
- Match their exact language style
- Be natural (like a friend)
- 1-2 short sentences
- If they asked about identity, mention "Anu"
- Otherwise, do NOT force "I'm Anu"`;

    const retry = await callAI(retrySys, [{ role: 'user', content: userContent }], { maxTokens: 250, temperature: 0.95 });

    if (retry.ok && retry.content.length > 8 && !isWeak(retry.content, userText)) {
      addHist(chatId, 'user', userText);
      addHist(chatId, 'assistant', retry.content);
      return retry.content;
    }
  }

  /* ─── Guaranteed fallback ─── */
  const isAmharic = /[\u1200-\u137F]/.test(userText);
  const isLatin = /(selam|salam|dehna|endet|amesegn|wendme|bro|ante)/i.test(userText);
  let fb;
  if (isAmharic) fb = `ሰላም! እንዴት ነህ? 😊`;
  else if (isLatin) fb = `selam! endet neh? 😊`;
  else fb = `Hey! How are you? 😊`;

  addHist(chatId, 'user', userText);
  addHist(chatId, 'assistant', fb);
  return fb;
}

/* ═══════════════════════════════════════════════════════════
   PHOTO ANALYSIS
   ═══════════════════════════════════════════════════════════ */
async function analyzePhoto(ownerName, senderName, userText, isFirst, status) {
  const sys = sysPrompt(ownerName, senderName, status);
  const ctx = userText
    ? `[${senderName} sent a photo with caption: "${userText}"]`
    : `[${senderName} sent a photo]`;

  const instruction = isFirst
    ? `${ctx}\n\nAcknowledge the photo warmly AND introduce yourself as "Anu, ${ownerName}'s assistant". Offer to help or forward.`
    : `${ctx}\n\nReact warmly — 1-2 sentences. NO identity mention (already introduced).`;

  const r = await callAI(sys, [{ role: 'user', content: instruction }], { maxTokens: 250, temperature: 0.85 });

  if (r.ok && r.content && r.content.length > 10) {
    if (isFirst && !/anu/i.test(r.content)) {
      return `Nice photo! I'm Anu, ${ownerName}'s assistant 😊 What can I help with?`;
    }
    return r.content;
  }
  return `Nice photo! 😊`;
}

/* ═══════════════════════════════════════════════════════════
   DETECTION HELPERS
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
      status: 'Anu Assistant Bot v16.0',
      identity: "Anu — Ananya's AI assistant",
      storage: 'memory',
      parse: 'HTML-safe'
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
          text: sr && sr.ok ? '✅ Sent' : `❌ Failed: ${esc(JSON.stringify(sr).slice(0, 100))}`,
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
          `✅ <b>Anu Assistant Bot v16.0</b>\n\n` +
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

    /* ─── 9️⃣ NON-OWNER — REGULAR USER ─── */
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

  if (!reply) reply = `Hey! How are you? 😊`;

  await new Promise(r => setTimeout(r, Math.min(reply.length * 15, 1200)));

  await tg('sendMessage', {
    chat_id: chatId,
    text: reply,
    business_connection_id: bizConnId,
    reply_to_message_id: msgId
  });

  if (isFirst) state.introduced.add(String(chatId));

  /* Escalation */
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
