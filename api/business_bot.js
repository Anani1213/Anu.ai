// api/business_bot.js
// ─────────────────────────────────────────────────────────────────────────────
// Anu — Ananya's personal AI assistant (Telegram Business Bot)
// Vercel Serverless Function · Node.js 20+ ESM · zero npm deps (native fetch)
// ─────────────────────────────────────────────────────────────────────────────

// ═══════════════ CONFIG ═══════════════
const TOKEN = process.env.BUSINESS_BOT_TOKEN || "";
const OWNER_CHAT_ID = String(process.env.OWNER_CHAT_ID || "");
const OWNER_NAME = process.env.OWNER_NAME || "Ananya";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GROQ_MODEL = "openai/gpt-oss-120b";
const PROJECT_ID = "my-ai-eaf27";
const FS_BASE = "https://firestore.googleapis.com/v1/projects/" + PROJECT_ID + "/databases/(default)/documents";
const TG_BASE = TOKEN ? "https://api.telegram.org/bot" + TOKEN : "";
const AI_TIMEOUT_MS = 18000;
const PHOTO_MAX_BYTES = 4 * 1024 * 1024;

// ═══════════════ SMALL UTILS ═══════════════
const esc = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function todayStr() {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Africa/Addis_Ababa",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  } catch (e) {
    return new Date().toISOString().slice(0, 10);
  }
}

async function fetchWithTimeout(url, options, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, Object.assign({}, options || {}, { signal: ctrl.signal }));
  } finally {
    clearTimeout(t);
  }
}

// ═══════════════ TELEGRAM ═══════════════
async function tg(method, params, attempt) {
  if (!TG_BASE) throw new Error("BUSINESS_BOT_TOKEN missing");
  const r = await fetchWithTimeout(
    TG_BASE + "/" + method,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params || {}) },
    15000
  );
  const data = await r.json().catch(() => null);
  if (data && data.ok === false && data.error_code === 429 && !attempt) {
    const waitMs = Math.min(((data.parameters && data.parameters.retry_after) || 2) * 1000, 10000);
    console.error("[Anu] Telegram 429 on " + method + ", retrying after " + waitMs + "ms");
    await sleep(waitMs);
    return tg(method, params, 1);
  }
  if (!data || data.ok !== true) {
    console.error("[Anu] Telegram " + method + " failed: " + JSON.stringify(data).slice(0, 500));
  }
  return data;
}

async function sendWithTyping(chatId, htmlText, opts) {
  const o = opts || {};
  const delay = Math.max(5000, Math.min(String(htmlText).length * 30, 9000));
  const actionParams = { chat_id: chatId, action: "typing" };
  if (o.bizConnId) actionParams.business_connection_id = o.bizConnId;
  try { await tg("sendChatAction", actionParams); } catch (e) { console.error("[Anu] sendChatAction error", e && e.message); }
  await sleep(Math.floor(delay / 2));
  try { await tg("sendChatAction", actionParams); } catch (e) { /* refresh best-effort */ }
  await sleep(Math.ceil(delay / 2));
  const params = { chat_id: chatId, text: htmlText, parse_mode: "HTML" };
  if (o.bizConnId) params.business_connection_id = o.bizConnId;
  if (o.replyTo) params.reply_to_message_id = o.replyTo;
  const sent = await tg("sendMessage", params);
  if (!sent || sent.ok !== true) throw new Error("sendMessage failed");
  return sent;
}

async function sendCustomerMessage(chatId, text, opts) {
  await sendWithTyping(chatId, esc(text), opts || {});
}

async function sendAdmin(html) {
  if (!OWNER_CHAT_ID) { console.error("[Anu] OWNER_CHAT_ID missing, cannot send admin msg"); return; }
  await tg("sendMessage", { chat_id: OWNER_CHAT_ID, text: html, parse_mode: "HTML" });
}

async function notifyOwner(info) {
  const ref = "REF:" + info.chatId + ":" + (info.bizConnId || "direct");
  const msg =
    "📩 <b>Message</b> from <b>" + esc(info.firstName) + "</b> (DM)\n" +
    "🆔 <b>Chat:</b> <code>" + esc(String(info.chatId)) + "</code>\n\n" +
    "💬 <b>Message:</b>\n<i>&quot;" + esc(String(info.text).slice(0, 1000)) + "&quot;</i>\n\n" +
    "🤖 <b>anu bot replied:</b>\n<i>&quot;" + esc(String(info.reply).slice(0, 300)) + "&quot;</i>\n\n" +
    "━━━━━━━━━━━━━━━━━━\n" +
    "↩️ <b>Reply to this message</b>\n" +
    "📎 Or: <code>/send " + esc(String(info.chatId)) + " &lt;message&gt;</code>\n\n" +
    "<code>" + esc(ref) + "</code>";
  await tg("sendMessage", { chat_id: OWNER_CHAT_ID, text: msg, parse_mode: "HTML" });
}

// ═══════════════ FIRESTORE REST ═══════════════
function encVal(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encVal) } };
  if (typeof v === "object") {
    const fields = {};
    for (const k of Object.keys(v)) fields[k] = encVal(v[k]);
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}

function decVal(fv) {
  if (!fv || typeof fv !== "object") return null;
  if ("stringValue" in fv) return fv.stringValue;
  if ("integerValue" in fv) return parseInt(fv.integerValue, 10);
  if ("doubleValue" in fv) return fv.doubleValue;
  if ("booleanValue" in fv) return fv.booleanValue;
  if ("nullValue" in fv) return null;
  if ("arrayValue" in fv) return ((fv.arrayValue && fv.arrayValue.values) || []).map(decVal);
  if ("mapValue" in fv) {
    const out = {};
    const fields = (fv.mapValue && fv.mapValue.fields) || {};
    for (const k of Object.keys(fields)) out[k] = decVal(fields[k]);
    return out;
  }
  return null;
}

async function fsGet(col, docId) {
  const url = FS_BASE + "/" + col + "/" + encodeURIComponent(String(docId));
  let r;
  try {
    r = await fetchWithTimeout(url, { method: "GET" }, 10000);
  } catch (e) {
    console.error("[Anu] fsGet network error " + col, e && e.message ? e.message : e);
    throw e;
  }
  if (r.status === 404) return null;
  if (!r.ok) {
    console.error("[Anu] fsGet HTTP " + r.status + " for " + col + "/" + docId);
    throw new Error("fsGet http " + r.status);
  }
  const doc = await r.json().catch(() => null);
  if (!doc || !doc.fields) return {};
  const out = {};
  for (const k of Object.keys(doc.fields)) out[k] = decVal(doc.fields[k]);
  return out;
}

async function fsSet(col, docId, data) {
  const keys = Object.keys(data || {});
  if (!keys.length) return;
  const mask = keys.map((k) => "updateMask.fieldPaths=" + encodeURIComponent(k)).join("&");
  const url = FS_BASE + "/" + col + "/" + encodeURIComponent(String(docId)) + "?" + mask;
  const fields = {};
  for (const k of keys) fields[k] = encVal(data[k]);
  let r;
  try {
    r = await fetchWithTimeout(
      url,
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fields }) },
      10000
    );
  } catch (e) {
    console.error("[Anu] fsSet network error " + col, e && e.message ? e.message : e);
    throw e;
  }
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    console.error("[Anu] fsSet HTTP " + r.status + " for " + col + "/" + docId + " " + String(txt).slice(0, 300));
    throw new Error("fsSet http " + r.status);
  }
}

async function fsDelete(col, docId) {
  const url = FS_BASE + "/" + col + "/" + encodeURIComponent(String(docId));
  let r;
  try {
    r = await fetchWithTimeout(url, { method: "DELETE" }, 10000);
  } catch (e) {
    console.error("[Anu] fsDelete network error " + col, e && e.message ? e.message : e);
    throw e;
  }
  if (!r.ok && r.status !== 404) {
    console.error("[Anu] fsDelete HTTP " + r.status + " for " + col + "/" + docId);
    throw new Error("fsDelete http " + r.status);
  }
}

// ═══════════════ LANGUAGE ═══════════════
const GEEZ_RE = /[ሀ-፿]/;
const LATIN_AM_RE = /(selam|salam|dehna|dena|endet|amesegn|wendme|wendmu|ehite|ante|anchi|ene|egna|min|man|yet|lemin|meche|sint|neh|nesh|negn|new|nchi|achew|yelem|alew|alech|pic new|min adregnalh|yet neberk|bet sra|exersays|agricultur|temhert|meskerem|mels|eshi|ishi|awo|ay|aznalew|yikir|chat|gibity|gedel|guday|sira|sra|bet|genzeb|neber|honk|metah|hed|na|kolo|mana|nega|arat|ekul|and|hulet|sost)/i;

function detectLanguage(text) {
  const t = String(text || "");
  const geezCount = (t.match(/[ሀ-፿]/g) || []).length;
  const latinHit = LATIN_AM_RE.test(t);
  if (geezCount > 0 && latinHit) return geezCount >= 3 ? "geez" : "latin";
  if (geezCount > 0) return "geez";
  if (latinHit) return "latin";
  return "english";
}

function detectGender(text) {
  const t = String(text || "");
  if (/(ehite|anchi|\bnesh\b)/i.test(t)) return "female";
  if (/(wendme|\bante\b|\bneh\b)/i.test(t)) return "male";
  return null;
}

function isComplex(t) {
  const s = String(t || "");
  if (s.length >= 100) return true;
  if (s.indexOf("?") !== -1) return true;
  return /(explain|analy[sz]e|write|how does|why does|solve|calculate|translate|summari[sz]e|describe)/i.test(s);
}

function isJustGreeting(s) {
  return /^(hi|hello|hey|selam|salam|ሰላም|dehna|eshi|ishi|awo)[\s!.,?…،؛]*$/i.test(String(s || "").trim());
}

function repeatCount(history, text) {
  const t = String(text || "").trim();
  if (!t) return 0;
  let n = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (!m || m.role !== "user") continue;
    if (String(m.content || "").trim() === t) n++;
    else break;
  }
  return n;
}

function fallbackFor(lang) {
  if (lang === "geez") return "ይቅርታ፣ አሁን መልስ መስጠት አልቻልኩም። እባክዎ እንደገና ይሞክሩ። 🙏";
  if (lang === "latin") return "Yiqirta, ahun meles mes-tet alchalkum. Ebakwo endegena yimokiru. 🙏";
  return "Sorry, I could not reply right now. Please try again. 🙏";
}

function rateLimitMsg(lang) {
  if (lang === "geez") return "እባክዎ ትንሽ ዝግ ይበሉ። እንደገና ይሞክሩ። 🙏";
  if (lang === "latin") return "Ebakwo tinish zig yibelu. Endegena yimokiru. 🙏";
  return "Please slow down a bit and try again. 🙏";
}

// ═══════════════ AI PROVIDERS ═══════════════
async function postAI(url, key, body, ms, tag) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) {
      console.error("[Anu] " + tag + " HTTP " + r.status + ": " + JSON.stringify(data).slice(0, 500));
      throw new Error(tag + " http " + r.status);
    }
    return data;
  } catch (e) {
    if (e && e.name === "AbortError") console.error("[Anu] " + tag + " timeout after " + ms + "ms");
    else console.error("[Anu] " + tag + " error: " + (e && e.message ? e.message : e));
    throw e;
  } finally {
    clearTimeout(t);
  }
}

function extractChoiceText(data) {
  const c =
    data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  return typeof c === "string" && c.trim() ? c.trim() : null;
}

async function geminiChat(system, history, userText, timeoutMs) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY missing");
  const messages = [{ role: "system", content: system }];
  for (const h of history || []) {
    messages.push({
      role: h.role === "assistant" ? "assistant" : "user",
      content: String(h.content || "").slice(0, 2000),
    });
  }
  messages.push({ role: "user", content: String(userText) });
  const data = await postAI(
    "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    GEMINI_API_KEY,
    { model: GEMINI_MODEL, messages },
    timeoutMs || AI_TIMEOUT_MS,
    "Gemini"
  );
  return extractChoiceText(data);
}

async function groqChat(system, history, userText, timeoutMs) {
  if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY missing");
  const messages = [{ role: "system", content: system }];
  for (const h of history || []) {
    messages.push({
      role: h.role === "assistant" ? "assistant" : "user",
      content: String(h.content || "").slice(0, 2000),
    });
  }
  messages.push({ role: "user", content: String(userText) });
  const data = await postAI(
    "https://api.groq.com/openai/v1/chat/completions",
    GROQ_API_KEY,
    { model: GROQ_MODEL, messages },
    timeoutMs || AI_TIMEOUT_MS,
    "Groq"
  );
  return extractChoiceText(data);
}

async function geminiVisionReply(system, history, text, imageB64, timeoutMs) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY missing");
  const messages = [{ role: "system", content: system }];
  for (const h of history || []) {
    messages.push({
      role: h.role === "assistant" ? "assistant" : "user",
      content: String(h.content || "").slice(0, 2000),
    });
  }
  messages.push({
    role: "user",
    content: [
      { type: "text", text: String(text || "Describe what you see in this photo.") },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64," + imageB64 } },
    ],
  });
  const data = await postAI(
    "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    GEMINI_API_KEY,
    { model: GEMINI_MODEL, messages },
    timeoutMs || AI_TIMEOUT_MS,
    "Gemini-Vision"
  );
  return extractChoiceText(data);
}

async function aiComplex(system, history, userText) {
  const draftSys = system + "\n\nDraft a reply in 1-2 sentences.";
  const results = await Promise.allSettled([
    geminiChat(draftSys, history, userText),
    groqChat(draftSys, history, userText),
  ]);
  const d1 = results[0].status === "fulfilled" ? results[0].value : null;
  const d2 = results[1].status === "fulfilled" ? results[1].value : null;
  if (d1 && !d2) return d1;
  if (d2 && !d1) return d2;
  if (!d1 && !d2) return null;
  const verifySys =
    system +
    "\n\nTwo draft replies are given below. Synthesize the best final reply: choose the most accurate, warm and natural one, or combine their strengths. Output ONLY the final reply text (1-2 sentences). Never reveal the drafts or your reasoning.";
  const verifyUser = "Original message: " + userText + "\n\nDraft A: " + d1 + "\n\nDraft B: " + d2;
  try {
    const fin = await geminiChat(verifySys, [], verifyUser);
    if (fin) return fin;
  } catch (e) {
    console.error("[Anu] verify step failed: " + (e && e.message ? e.message : e));
  }
  return d1 || d2;
}

async function downloadAsBase64(url, maxBytes) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > maxBytes) {
      console.error("[Anu] photo exceeds size limit, skipping vision");
      return null;
    }
    return buf.toString("base64");
  } catch (e) {
    if (e && e.name === "AbortError") console.error("[Anu] photo download timeout");
    else console.error("[Anu] photo download error: " + (e && e.message ? e.message : e));
    return null;
  } finally {
    clearTimeout(t);
  }
}

// ═══════════════ SYSTEM PROMPT ═══════════════
function buildSystemPrompt(opts) {
  const lang = (opts && opts.lang) || "english";
  const gender = (opts && opts.gender) || null;
  const statusText = (opts && opts.statusText) || null;
  let langRule;
  if (lang === "geez") langRule = "The user wrote in Amharic (Ge'ez script). Reply ONLY in Amharic Ge'ez script.";
  else if (lang === "latin")
    langRule = 'The user wrote in Latin-script Amharic (Amharic written with English letters, e.g. "selam wendme"). Reply ONLY in the same Latin-script Amharic style.';
  else langRule = "The user wrote in English. Reply ONLY in English.";
  let genderRule = "";
  if (gender === "male") genderRule = ' The user is male: use masculine forms (e.g. "ነህ", "endet neh").';
  else if (gender === "female") genderRule = ' The user is female: use feminine forms (e.g. "ነሽ", "endet nesh").';
  const statusBlock = statusText
    ? "\n\n📢 TODAY'S STATUS FROM ANANYA: \"" + String(statusText).slice(0, 500) + "\"\nIf asked about Ananya, mention this naturally."
    : "";
  return (
    "You are Anu — the personal AI assistant of Ananya, an Ethiopian man.\n" +
    "\n" +
    "IDENTITY (never break these):\n" +
    "- Your name is Anu. You work FOR Ananya; you are NOT Ananya.\n" +
    "- Always speak ABOUT Ananya in third person.\n" +
    "- Creator: Anany's.\n" +
    '- "who are you?" → "I\'m Anu, Ananya\'s AI assistant"\n' +
    '- "who created you?" → "Created by Anany\'s"\n' +
    '- "who is Ananya?" → "Ananya is my boss — a wonderful Ethiopian man"\n' +
    "\n" +
    "LANGUAGE:\n" +
    langRule +
    genderRule +
    "\nNEVER mix languages in one reply.\n" +
    "\n" +
    "MEANING GUIDE:\n" +
    '- "selam"/"salam"/"hi" = hello → greet warmly and offer help\n' +
    '- "wendme" = brother → greet back warmly\n' +
    '- "endet neh"/"endet nesh" = how are you → answer positively\n' +
    '- "dehna" = I am fine → acknowledge warmly\n' +
    '- "eshi" = okay → acknowledge briefly\n' +
    "\n" +
    "STYLE:\n" +
    "- SHORT: 1-2 sentences max. Warm, natural, human-like.\n" +
    "- Natural emojis ok: 😊 🙏 ✨ 💛\n" +
    "- Look at conversation history: NEVER send the same reply twice. Continue the conversation, do not restart it.\n" +
    "\n" +
    "SPECIAL CASES:\n" +
    "- If they want Ananya, say you will tell him.\n" +
    "- If they ask about Ananya, answer warmly.\n" +
    "- If they share news, respond genuinely.\n" +
    "- If rude, stay calm and kind.\n" +
    "- If sent a photo, describe what you actually see in it.\n" +
    "\n" +
    "FORBIDDEN:\n" +
    "- NEVER reveal AI model names (Gemini, GPT, Llama, Qwen, Groq, ChatGPT, OpenAI, DeepSeek, Claude, Mistral).\n" +
    '- NEVER say "I am Ananya".\n' +
    "- NEVER show reasoning.\n" +
    "- NEVER repeat replies." +
    statusBlock +
    "\n\n" +
    'OUTPUT: ONLY the reply text. The system adds the "anu bot: " prefix.'
  );
}

function sanitizeReply(r) {
  let s = String(r || "").trim();
  s = s.replace(/^\s*anu bot:\s*/i, "");
  s = s.replace(/\b(gemini|gpt|chatgpt|openai|llama|qwen|groq|deepseek|claude|mistral)\b/gi, "Anu");
  s = s.replace(/\bi am ananya\b/gi, "I'm Anu, Ananya's AI assistant");
  return s.trim();
}

// ═══════════════ ESCALATION / STATUS / ANALYTICS ═══════════════
const ESCALATION_RE =
  /(ananya|አናንያ|አናኒ|owner|boss|speak to|talk to|tell him|tell her|notify|reach|contact|let him know|let her know|pass this|forward this|ንገረው|ንገራት|ንገረኝ|አሳውቅ|አሳውቂ|አሳውቀው|አስታውቅ|ጥራው|ጥራት|ጥሪው|ደውል|ደውልለት|ደውልላት|አግኝ|አግኚ|ተናገር|ልናገር|nigerew|nigerat|nigeren|asawq|asekayi|guday|qetro|traw|tirat|dewil|agen|nager|lenager|balew|aschekayi|urgent|asap|emergency|አስቸኳይ|ፈጣን|angry|upset|furious|\bmad\b|hate|😡|🤬|ተናደድኩ|ደደብ)/i;

function shouldEscalate(text) {
  return ESCALATION_RE.test(String(text || "").slice(0, 2000));
}

async function getDailyStatus() {
  const doc = await fsGet("bot_status", "daily").catch(() => null);
  if (!doc || !doc.text || doc.date !== todayStr()) return null;
  return doc;
}

async function bumpAnalytics(inc) {
  try {
    const id = todayStr();
    const cur = (await fsGet("bot_analytics", id).catch(() => null)) || {};
    const num = (v) => (typeof v === "number" && isFinite(v) ? v : 0);
    await fsSet("bot_analytics", id, {
      messages: num(cur.messages) + num(inc.messages),
      conversations: num(cur.conversations) + num(inc.conversations),
      photos: num(cur.photos) + num(inc.photos),
      escalations: num(cur.escalations) + num(inc.escalations),
      manual_replies: num(cur.manual_replies) + num(inc.manual_replies),
      lastUpdate: Date.now(),
    });
  } catch (e) {
    console.error("[Anu] analytics error: " + (e && e.message ? e.message : e));
  }
}

// ═══════════════ MESSAGE HELPERS ═══════════════
function extractText(msg) {
  if (!msg) return "";
  if (typeof msg.text === "string" && msg.text) return msg.text;
  if (typeof msg.caption === "string" && msg.caption) return msg.caption;
  return "";
}

// ═══════════════ CUSTOMER FLOW ═══════════════
async function handleCustomer(msg, bizConnId) {
  const chatId = msg && msg.chat && msg.chat.id;
  if (!chatId) return;
  if (msg.from && msg.from.is_bot) return;
  const messageId = msg.message_id;
  const firstName = (msg.from && msg.from.first_name) || "there";
  const userText = extractText(msg);
  const photo = msg.photo;

  try {
    // 1. Pause check
    const settings = await fsGet("bot_settings", "global").catch(() => null);
    if (settings && settings.paused === true) {
      console.log("[Anu] paused, skipping chat " + chatId);
      return;
    }

    // 2. Rate limit: max 15 msgs / 60s
    const now = Date.now();
    let rl = null;
    try { rl = await fsGet("bot_ratelimits", String(chatId)); } catch (e) { console.error("[Anu] ratelimit read error", e && e.message); }
    let stamps = rl && Array.isArray(rl.timestamps)
      ? rl.timestamps.filter((t) => typeof t === "number" && now - t < 60000)
      : [];
    if (stamps.length >= 15) {
      await sendCustomerMessage(chatId, "anu bot: " + rateLimitMsg(detectLanguage(userText)), {
        bizConnId,
        replyTo: messageId,
      });
      return;
    }
    stamps.push(now);
    try { await fsSet("bot_ratelimits", String(chatId), { timestamps: stamps.slice(-25) }); }
    catch (e) { console.error("[Anu] ratelimit write error", e && e.message); }

    // 3. Load memory
    let memDoc = null;
    try { memDoc = await fsGet("bot_memory", String(chatId)); } catch (e) { console.error("[Anu] memory read error", e && e.message); }
    const history = memDoc && Array.isArray(memDoc.messages) ? memDoc.messages.slice(-20) : [];
    const isNew = !memDoc;

    // 4. Photo → base64
    let imageB64 = null;
    if (photo && photo.length) {
      const largest = photo[photo.length - 1] || {};
      const tooBig = largest.file_size && largest.file_size > PHOTO_MAX_BYTES;
      if (!tooBig && largest.file_id) {
        try {
          const fi = await tg("getFile", { file_id: largest.file_id });
          const fp = fi && fi.result && fi.result.file_path;
          if (fp) imageB64 = await downloadAsBase64("https://api.telegram.org/file/bot" + TOKEN + "/" + fp, PHOTO_MAX_BYTES);
        } catch (e) { console.error("[Anu] photo handling failed: " + (e && e.message ? e.message : e)); }
      } else if (tooBig) {
        console.error("[Anu] photo file_size exceeds 4MB, skipping vision");
      }
    }

    const textForAI = userText || (imageB64 ? "Please describe this photo." : "");
    if (!textForAI && !imageB64) return;

    // 5. Classify
    const complex = isComplex(textForAI);
    const lang = detectLanguage(textForAI);
    const gender = detectGender(textForAI);
    let statusText = null;
    try { const st = await getDailyStatus(); if (st) statusText = st.text; } catch (e) { /* no status */ }
    let system = buildSystemPrompt({ statusText, lang, gender });
    if (repeatCount(history, textForAI) >= 2) {
      system += "\n\nNote: the user has repeated the same message multiple times. Acknowledge briefly and ask how you can help. Do not repeat yourself.";
    }
    const historyMsgs = history.map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: String(m.content || "").slice(0, 2000),
    }));

    // 6. Generate AI reply
    let reply = null;
    try {
      if (imageB64) {
        try { reply = await geminiVisionReply(system, historyMsgs, textForAI, imageB64); }
        catch (e) { console.error("[Anu] vision failed, trying Groq text fallback"); }
        if (!reply) reply = await groqChat(system, historyMsgs, textForAI).catch(() => null);
      } else if (complex) {
        reply = await aiComplex(system, historyMsgs, textForAI);
      } else {
        reply = await geminiChat(system, historyMsgs, textForAI).catch(() => null);
        if (!reply) reply = await groqChat(system, historyMsgs, textForAI).catch(() => null);
      }
    } catch (e) {
      console.error("[Anu] AI generation error: " + (e && e.message ? e.message : e));
    }

    // Anti-echo
    if (reply) {
      const rTrim = reply.trim();
      if (rTrim.length < 10 || rTrim === textForAI.trim() || isJustGreeting(rTrim)) {
        const strict =
          system + "\n\nPREVIOUS REPLY WAS TOO WEAK. Generate a REAL response now. Minimum 10 words. Do NOT repeat their words.";
        let retry = null;
        try {
          retry = await geminiChat(strict, historyMsgs, textForAI).catch(() => null);
          if (!retry) retry = await groqChat(strict, historyMsgs, textForAI).catch(() => null);
        } catch (e) { console.error("[Anu] retry error: " + (e && e.message ? e.message : e)); }
        if (retry && retry.trim().length >= 10 && retry.trim() !== textForAI.trim()) reply = retry;
        else reply = null;
      }
    }
    if (!reply) reply = fallbackFor(lang);
    reply = sanitizeReply(reply);
    if (!reply) reply = fallbackFor(lang);

    // 7-8. Typing delay, then send with prefix
    await sendCustomerMessage(chatId, "anu bot: " + reply, { bizConnId, replyTo: messageId });

    // 9. Save memory + analytics
    const ts = Date.now();
    const newMessages = history
      .concat([
        { role: "user", content: textForAI.slice(0, 2000), ts },
        { role: "assistant", content: reply.slice(0, 2000), ts },
      ])
      .slice(-20);
    try { await fsSet("bot_memory", String(chatId), { messages: newMessages, updatedAt: ts }); }
    catch (e) { console.error("[Anu] memory write error: " + (e && e.message ? e.message : e)); }
    try {
      await fsSet("bot_introduced", String(chatId), {
        introduced: true,
        senderName: String(firstName).slice(0, 100),
        introducedAt: ts,
      });
    } catch (e) { /* non-critical */ }
    await bumpAnalytics({ messages: 1, conversations: isNew ? 1 : 0, photos: imageB64 ? 1 : 0 });

    // 10. Escalation → notify owner
    if (shouldEscalate(textForAI)) {
      try {
        await notifyOwner({ firstName, chatId, text: textForAI, reply, bizConnId });
        await bumpAnalytics({ escalations: 1 });
      } catch (e) {
        console.error("[Anu] escalation error: " + (e && e.message ? e.message : e));
      }
    }
  } catch (e) {
    console.error("[Anu] customer flow fatal: " + (e && e.stack ? e.stack : e));
    try {
      await sendCustomerMessage(chatId, "anu bot: " + fallbackFor(detectLanguage(userText)), {
        bizConnId,
        replyTo: messageId,
      });
    } catch (_) { /* last resort failed, already logged */ }
  }
}

// ═══════════════ ADMIN FLOW ═══════════════
async function handleManualReply(msg, m, raw) {
  const chatId = m[1];
  const biz = m[2];
  if (!raw) {
    await sendAdmin("⚠️ Empty message — nothing sent.");
    return;
  }
  const params = { chat_id: chatId, text: esc("anu bot: " + raw), parse_mode: "HTML" };
  if (biz && biz !== "direct") params.business_connection_id = biz;
  let sent = null;
  try {
    sent = await tg("sendMessage", params);
  } catch (e) {
    console.error("[Anu] manual reply send error: " + (e && e.message ? e.message : e));
  }
  if (!sent || sent.ok !== true) {
    await sendAdmin("❌ Send failed. Check logs.");
    return;
  }
  await bumpAnalytics({ manual_replies: 1 });
  try {
    const ts = Date.now();
    const memDoc = await fsGet("bot_memory", chatId).catch(() => null);
    const hist = memDoc && Array.isArray(memDoc.messages) ? memDoc.messages : [];
    await fsSet("bot_memory", chatId, {
      messages: hist.concat([{ role: "assistant", content: raw.slice(0, 2000), ts }]).slice(-20),
      updatedAt: ts,
    });
  } catch (e) {
    console.error("[Anu] manual memory save error: " + (e && e.message ? e.message : e));
  }
  await sendAdmin("✅ Sent");
}

async function cmdStats() {
  const today = todayStr();
  const a = await fsGet("bot_analytics", today).catch(() => null);
  const settings = await fsGet("bot_settings", "global").catch(() => null);
  const st = await getDailyStatus().catch(() => null);
  const n = (v) => (typeof v === "number" && isFinite(v) ? v : 0);
  const lines = [
    "📊 <b>Anu Bot — Admin Dashboard</b>",
    "🎨 Created by Anany's",
    "",
    "━━━ STATUS ━━━",
    "🟢 Bot: Online",
    "⏸️ Paused: " + (settings && settings.paused ? "Yes" : "No"),
    "📢 Daily Status: " + (st ? "Set ✅" : "None"),
    "",
    "━━━ PROVIDERS ━━━",
    (GEMINI_API_KEY ? "✅" : "❌") + " Gemini API",
    (GROQ_API_KEY ? "✅" : "❌") + " Groq API",
    "",
    "━━━ MODELS ━━━",
    "🌟 Gemini: " + esc(GEMINI_MODEL),
    "🧠 Groq Master: " + esc(GROQ_MODEL),
    "👁️ Vision: " + esc(GEMINI_MODEL),
    "",
    "━━━ TODAY ━━━",
    "💬 Messages: " + n(a && a.messages),
    "👥 Conversations: " + n(a && a.conversations),
    "📸 Photos: " + n(a && a.photos),
    "🔔 Escalations: " + n(a && a.escalations),
    "✍️ Manual replies: " + n(a && a.manual_replies),
    "",
    "━━━ SYSTEM ━━━",
    "💾 Memory: Firebase (20/chat)",
    "⏱️ Typing delay: 5-9s",
    "🔗 Chain: Gemini + Groq → Verify",
  ];
  await sendAdmin(lines.join("\n"));
}

async function cmdMemory(arg) {
  if (!arg) {
    await sendAdmin("Usage: <code>/memory &lt;chatId&gt;</code>");
    return;
  }
  const doc = await fsGet("bot_memory", arg).catch(() => null);
  if (!doc || !Array.isArray(doc.messages) || !doc.messages.length) {
    await sendAdmin("🗂️ No memory for <code>" + esc(arg) + "</code>.");
    return;
  }
  const lines = doc.messages.slice(-10).map((m) => {
    const who = m.role === "assistant" ? "🤖" : "👤";
    return who + " " + esc(String(m.content || "").slice(0, 300));
  });
  let out = "🗂️ <b>Memory</b> <code>" + esc(arg) + "</code> (last " + lines.length + ")\n\n" + lines.join("\n");
  if (out.length > 4000) out = out.slice(0, 4000) + "…";
  await sendAdmin(out);
}

async function cmdExport(arg) {
  if (!arg) {
    await sendAdmin("Usage: <code>/export &lt;chatId&gt;</code>");
    return;
  }
  const doc = await fsGet("bot_memory", arg).catch(() => null);
  if (!doc) {
    await sendAdmin("🗂️ No memory for <code>" + esc(arg) + "</code>.");
    return;
  }
  const json = JSON.stringify(doc, null, 1).slice(0, 3500);
  await sendAdmin("<b>📦 Memory export</b> <code>" + esc(arg) + "</code>\n<pre>" + esc(json) + "</pre>");
}

async function cmdHealth() {
  const checks = [];
  checks.push((GEMINI_API_KEY ? "✅" : "❌") + " Gemini API key");
  checks.push((GROQ_API_KEY ? "✅" : "❌") + " Groq API key");
  try {
    await fsGet("bot_settings", "global");
    checks.push("✅ Firestore reachable");
  } catch (e) {
    checks.push("❌ Firestore: " + esc(e && e.message ? e.message : "error"));
  }
  checks.push(TOKEN ? "✅ Telegram token set" : "❌ Telegram token missing");
  checks.push(OWNER_CHAT_ID ? "✅ Owner chat configured" : "❌ Owner chat missing");
  await sendAdmin("<b>🏥 Health</b>\n" + checks.join("\n"));
}

function adminHelp() {
  return (
    "<b>🤖 Anu Bot — Commands</b>\n" +
    "🎨 Created by Anany's\n\n" +
    "<code>/status</code> — show today's status\n" +
    "<code>/status &lt;text&gt;</code> — set status\n" +
    "<code>/status clear</code> — clear status\n" +
    "<code>/stats</code> — analytics dashboard\n" +
    "<code>/memory &lt;chatId&gt;</code> — last 10 messages\n" +
    "<code>/export &lt;chatId&gt;</code> — memory as JSON\n" +
    "<code>/forget &lt;chatId&gt;</code> — delete memory\n" +
    "<code>/pause</code> — pause bot globally\n" +
    "<code>/resume</code> — resume bot\n" +
    "<code>/send &lt;chatId&gt; &lt;text&gt;</code> — send as bot\n" +
    "<code>/health</code> — check services\n" +
    "<code>/help</code> — this list\n\n" +
    "💡 Reply to an escalation notification to answer that customer directly."
  );
}

async function handleAdmin(msg) {
  const raw = extractText(msg).trim();
  try {
    // Manual reply flow: owner replies to an escalation notification carrying a REF marker
    const quoted =
      (msg.reply_to_message && (msg.reply_to_message.text || msg.reply_to_message.caption)) || "";
    const refM = quoted.match(/REF:([0-9-]+):([a-zA-Z0-9_-]+)/);
    if (msg.reply_to_message && refM) {
      await handleManualReply(msg, refM, raw);
      return;
    }

    if (!raw.startsWith("/")) {
      await sendAdmin("💡 Send <code>/help</code> for commands.");
      return;
    }
    const spaceIdx = raw.indexOf(" ");
    const cmdToken = (spaceIdx === -1 ? raw : raw.slice(0, spaceIdx)).split("@")[0].toLowerCase();
    const rest = spaceIdx === -1 ? "" : raw.slice(spaceIdx + 1).trim();
    const args = rest ? rest.split(/\s+/) : [];

    if (cmdToken === "/start" || cmdToken === "/admin") {
      await sendAdmin(
        "<b>🤖 Anu Bot — Admin Dashboard</b>\n" +
          "🎨 Created by Anany's\n\n" +
          "👤 Owner: " + esc(OWNER_NAME) + "\n" +
          "🟢 Status: Online\n\n" +
          adminHelp()
      );
    } else if (cmdToken === "/help") {
      await sendAdmin(adminHelp());
    } else if (cmdToken === "/status") {
      if (!args.length) {
        const st = await getDailyStatus().catch(() => null);
        await sendAdmin(st ? "📢 <b>Today's status:</b>\n<i>" + esc(st.text) + "</i>" : "📢 No status set for today.");
      } else if (args[0].toLowerCase() === "clear") {
        await fsDelete("bot_status", "daily").catch(() => {});
        await sendAdmin("🗑️ Status cleared.");
      } else {
        const text = rest.slice(0, 500);
        await fsSet("bot_status", "daily", { text, date: todayStr(), setAt: Date.now(), setBy: "owner" });
        await sendAdmin("✅ Status set:\n<i>" + esc(text) + "</i>");
      }
    } else if (cmdToken === "/stats") {
      await cmdStats();
    } else if (cmdToken === "/memory") {
      await cmdMemory(args[0]);
    } else if (cmdToken === "/export") {
      await cmdExport(args[0]);
    } else if (cmdToken === "/forget") {
      if (!args[0]) {
        await sendAdmin("Usage: <code>/forget &lt;chatId&gt;</code>");
      } else {
        await fsDelete("bot_memory", args[0]);
        await sendAdmin("🗑️ Memory deleted for <code>" + esc(args[0]) + "</code>.");
      }
    } else if (cmdToken === "/pause") {
      await fsSet("bot_settings", "global", { paused: true, changedAt: Date.now() });
      await sendAdmin("⏸️ Bot paused globally.");
    } else if (cmdToken === "/resume") {
      await fsSet("bot_settings", "global", { paused: false, changedAt: Date.now() });
      await sendAdmin("▶️ Bot resumed.");
    } else if (cmdToken === "/send") {
      if (args.length < 2) {
        await sendAdmin("Usage: <code>/send &lt;chatId&gt; &lt;text&gt;</code>");
      } else {
        const target = args[0];
        const body = rest.slice(target.length).trim();
        if (!body) {
          await sendAdmin("⚠️ Empty message — nothing sent.");
        } else {
          let sent = null;
          try {
            sent = await tg("sendMessage", {
              chat_id: target,
              text: esc("anu bot: " + body),
              parse_mode: "HTML",
            });
          } catch (e) {
            console.error("[Anu] /send error: " + (e && e.message ? e.message : e));
          }
          await sendAdmin(sent && sent.ok ? "✅ Sent to <code>" + esc(target) + "</code>." : "❌ Send failed. Check logs.");
        }
      }
    } else if (cmdToken === "/health") {
      await cmdHealth();
    } else {
      await sendAdmin("❓ Unknown command. Send <code>/help</code>.");
    }
  } catch (e) {
    console.error("[Anu] admin error: " + (e && e.stack ? e.stack : e));
    try {
      await sendAdmin("⚠️ Admin action failed. Check logs.");
    } catch (_) { /* ignore */ }
  }
}

// ═══════════════ ROUTER ═══════════════
async function routeUpdate(update) {
  if (!update || typeof update !== "object") return;

  if (update.callback_query) {
    const q = update.callback_query;
    try {
      if (q && q.id) await tg("answerCallbackQuery", { callback_query_id: q.id });
    } catch (e) {
      console.error("[Anu] answerCallbackQuery error: " + (e && e.message ? e.message : e));
    }
    return;
  }

  const bizMsg = update.business_message || update.edited_business_message;
  if (bizMsg) {
    if (bizMsg.from && String(bizMsg.from.id) === OWNER_CHAT_ID) return; // owner's own business message: ignore
    await handleCustomer(bizMsg, bizMsg.business_connection_id || null);
    return;
  }

  const msg = update.message || update.edited_message;
  if (msg) {
    const fromId = msg.from && msg.from.id ? String(msg.from.id) : "";
    if (fromId && OWNER_CHAT_ID && fromId === OWNER_CHAT_ID) {
      await handleAdmin(msg);
      return;
    }
    await handleCustomer(msg, null);
    return;
  }
}

// ═══════════════ HANDLER ═══════════════
export default async function handler(req, res) {
  try {
    if (!req || req.method !== "POST") return res.status(200).json({ ok: true });
    let update = req.body;
    if (typeof update === "string") {
      try {
        update = JSON.parse(update);
      } catch (e) {
        return res.status(200).json({ ok: true });
      }
    }
    try {
      await routeUpdate(update);
    } catch (e) {
      console.error("[Anu] routeUpdate failed: " + (e && e.stack ? e.stack : e));
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("[Anu] handler fatal: " + (e && e.stack ? e.stack : e));
    try {
      return res.status(200).json({ ok: true });
    } catch (_) {
      return;
    }
  }
}
