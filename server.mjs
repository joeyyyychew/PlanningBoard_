import http from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const DATA_DIR = join(ROOT, "data");
const REPORTS_FILE = join(DATA_DIR, "reports.json");
const EVENTS_FILE = join(DATA_DIR, "events.jsonl");
const RUN_REQUESTS_FILE = join(DATA_DIR, "run-requests.jsonl");
const CONTACT_WATCHLIST_FILE = join(DATA_DIR, "contact-watchlist.json");
const ORDER_SPREADSHEET_ID = "1py5YznTXAD6TU9onEaa12MXWhLCUngQ5PDSTfD4Q_JQ";
const BROADCAST_SPREADSHEET_ID = "1kyNfmPbTQ39Bg5Nn2Eqtz5r-x7cdYmcM7dd6XZT8bwU";
const BROADCAST_SHEET_GID = "1673664470";
const ORDER_SHEET_GIDS = {
  0: "1376338968",
  1: "1263496879",
  2: "1143781812",
  3: "1289557819",
  4: "1957679479",
  5: "1827266133",
  6: "1222127904",
  8: "1989301272"
};
function currentOrderSheetUrl() {
  const month = Number(new Intl.DateTimeFormat("en", { timeZone: "Asia/Kuala_Lumpur", month: "numeric" }).format(new Date())) - 1;
  const gid = ORDER_SHEET_GIDS[month] || ORDER_SHEET_GIDS[6];
  return `https://docs.google.com/spreadsheets/d/${ORDER_SPREADSHEET_ID}/edit?gid=${gid}#gid=${gid}`;
}
function broadcastSheetUrl() {
  return `https://docs.google.com/spreadsheets/d/${BROADCAST_SPREADSHEET_ID}/edit?gid=${BROADCAST_SHEET_GID}#gid=${BROADCAST_SHEET_GID}`;
}
const INBOX_ANALYSIS_RULES = {
  pm: "PM 人数必须用 ManyChat Contacts 里面 Subscribed on 选中日期来算；不要用 All Chats 当 PM 人数。",
  conversation: "All Chats 只用来检查当天有没有真实互动、卡点和总结；不是第一天进来的顾客，只要当天有真实讲话也要纳入互动分析。",
  active: "只计算顾客有实际文字、语音或有意义回复的对话；纯按钮点击、Quick Reply、地区选择，或第一步选择想了解的系列，不计入有互动。",
  pending: "Pending 只计算当天新加对应 Pending Tag 的顾客；如果同一天已经发送 After Payment/AO Flow，Pending 要扣掉，After Payment 要加上。",
  orders: "After Payment / 完成订单以当天发送 After Payment 或 AO Flow 的顾客为准。",
  tags: "PM 名单里同步标记 RM4.90drinks/RM4.90 DRINK（Collagen Drinks）、Free Testing/FreeTesting、Don't Disturb/Dont Disturb/Do Not Disturb，并在每日总结列出人数。",
  blockers: "逐一阅读当天实际对话，以顾客最后一个明确问题或犹豫点判断主要未下单卡点；纯流程入口或按钮选择不能当作卡点。每位顾客优先归入一个最主要卡点，已完成订单者排除。",
  summary: "使用白话总结当天顾客行为和未下单卡点，可列 PM 分类；不要复述自动化流程或中间 Tag 变化。"
};

async function loadEnv() {
  const text = await readFile(join(ROOT, ".env"), "utf8").catch(error => error.code === "ENOENT" ? "" : Promise.reject(error));
  const fileEnv = Object.fromEntries(text.split(/\r?\n/).filter(Boolean).map(line => {
    const i = line.indexOf("=");
    return [line.slice(0, i), line.slice(i + 1)];
  }));
  return { ...fileEnv, ...process.env };
}

const env = await loadEnv();
const EVENT_INGEST_SECRET = env.EVENT_INGEST_KEY || env.MANYCHAT_EVENT_KEY || "";
const PORT = Number(env.PORT || 4173);
const AUTH_ENABLED = /^(1|true|yes)$/i.test(env.AUTH_ENABLED || "") || Boolean(env.AUTH_PASSWORD || env.AUTH_PASSWORD_HASH);
const AUTH_EMAIL = String(env.AUTH_EMAIL || "").trim().toLowerCase();
const AUTH_PASSWORD = String(env.AUTH_PASSWORD || "");
const AUTH_PASSWORD_HASH = String(env.AUTH_PASSWORD_HASH || "").replace(/^sha256:/, "").trim().toLowerCase();
const AUTH_COOKIE = "scale_story_session";
const AUTH_SESSIONS = new Map();
const API = "https://api.manychat.com";
const ACCOUNTS = {
  fb108701968299986: {
    name: "Scalestory - 天然胶原蛋白",
    inbox: "https://app.manychat.com/fb108701968299986/chat",
    key: env.MANYCHAT_API_KEY,
    tags: { pending: ["PENDING"], afterPayment: [] }
  },
  fb111840620574302: {
    name: "ScaleStory 968",
    inbox: "https://app.manychat.com/fb111840620574302/chat",
    key: env.MANYCHAT_API_KEY_FB111840620574302,
    tags: { pending: ["PENDING", "Pending"], afterPayment: [] }
  },
  fb1177107122151553: {
    name: "鳞记 - 天然胶原蛋白",
    inbox: "https://app.manychat.com/fb1177107122151553/chat",
    key: env.MANYCHAT_API_KEY_FB1177107122151553,
    tags: { pending: ["PENDING", "Pending"], afterPayment: [] }
  },
  fb701760706347255: {
    name: "鳞记 SG",
    inbox: "https://app.manychat.com/fb701760706347255/chat",
    key: env.MANYCHAT_API_KEY_FB701760706347255,
    tags: { pending: ["Pending Payment 【SG】"], afterPayment: [] }
  }
};

function accountFrom(url) {
  const id = url.searchParams.get("account") || "fb108701968299986";
  if (!ACCOUNTS[id]) throw new Error("Unknown ManyChat account");
  return { id, ...ACCOUNTS[id] };
}

function parseCookies(header = "") {
  return Object.fromEntries(String(header).split(";").map(part => {
    const i = part.indexOf("=");
    if (i < 0) return null;
    return [part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim())];
  }).filter(Boolean));
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function safeEqual(a = "", b = "") {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

function isAuthenticated(req) {
  if (!AUTH_ENABLED) return true;
  const token = parseCookies(req.headers.cookie || "")[AUTH_COOKIE];
  if (!token) return false;
  const session = AUTH_SESSIONS.get(token);
  if (!session || session.expiresAt < Date.now()) {
    AUTH_SESSIONS.delete(token);
    return false;
  }
  return true;
}

function publicAuthPath(pathname) {
  return pathname === "/login" ||
    pathname === "/login.html" ||
    pathname === "/api/auth/status" ||
    pathname === "/api/auth/login" ||
    pathname === "/api/auth/logout" ||
    pathname === "/api/manychat-event" ||
    pathname === "/api/manychat/broadcast-campaign" ||
    pathname === "/api/manychat/broadcast-lead" ||
    pathname === "/api/manychat/broadcast-order" ||
    pathname === "/api/events" ||
    pathname === "/favicon.ico";
}

function requireAuth(req, res, url) {
  if (!AUTH_ENABLED || publicAuthPath(url.pathname) || isAuthenticated(req)) return true;
  if (url.pathname.startsWith("/api/")) {
    json(res, 401, { ok: false, error: "Login required" });
    return false;
  }
  const next = `${url.pathname}${url.search}`;
  res.writeHead(302, {
    Location: `/login?next=${encodeURIComponent(next)}`,
    "Cache-Control": "no-store"
  });
  res.end();
  return false;
}

function loginCookie(token) {
  return `${AUTH_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`;
}

function logoutCookie() {
  return `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function checkPassword(password) {
  if (AUTH_PASSWORD_HASH) return safeEqual(sha256(password), AUTH_PASSWORD_HASH);
  return AUTH_PASSWORD ? safeEqual(password, AUTH_PASSWORD) : false;
}

async function manychat(account, path, options = {}) {
  if (!account.key) throw new Error(`API key missing for ${account.id}`);
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${account.key}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.status === "error") {
    throw new Error(body.message || `ManyChat API ${response.status}`);
  }
  return body.data;
}

async function readReports() {
  return JSON.parse(await readFile(REPORTS_FILE, "utf8"));
}

async function writeReports(reports) {
  await writeFile(REPORTS_FILE, `${JSON.stringify(reports, null, 2)}\n`);
}

async function readEvents() {
  const text = await readFile(EVENTS_FILE, "utf8").catch(error => error.code === "ENOENT" ? "" : Promise.reject(error));
  return text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

async function readContactWatchlist() {
  return JSON.parse(await readFile(CONTACT_WATCHLIST_FILE, "utf8").catch(error => error.code === "ENOENT" ? "{}" : Promise.reject(error)));
}

function klDate(value = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kuala_Lumpur", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date(value));
}

function cleanEventType(value) {
  return String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function normalizeTag(tag) {
  return String(tag || "").trim().toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ");
}

function isDontDisturb(tags = []) {
  return tags.some(tag => /don'?t disturb|dont disturb|do not disturb/i.test(tag));
}

function isCollagenDrink(tags = []) {
  return tags.some(tag => /rm4\.?90\s*drink|rm4\.?90drinks|collagen drinks/i.test(tag));
}

function isFreeTesting(tags = []) {
  return tags.some(tag => /free\s*testing|freetesting/i.test(tag));
}

function hasConfiguredTag(tags = [], names = []) {
  const normalized = tags.map(normalizeTag);
  return names.some(name => normalized.includes(normalizeTag(name)));
}

function isButtonLike(text = "") {
  const t = String(text).trim();
  const plain = t.replace(/[👉🏻👉🏼🌟⚡️🌹😍✨🎬🦐🔵🟢🟠🔴【】"'「」]/g, "").trim();
  return !t ||
    t === "..." ||
    /^whatsapp_message$/i.test(plain) ||
    /^default_reply_contact$/i.test(plain) ||
    /^(\d+|A|B|C)$/i.test(t) ||
    /^(555|666|777)$/i.test(plain) ||
    /^西马\s*\/\s*东马$/i.test(plain) ||
    /contact tapped|quick reply|follow the link/i.test(t) ||
    /^(我想了解更多.*|我想了解(养颜|护膝|护肤|关节)?系列～?|开始了解鳞记鱼鳞冻|了解这个月配套|can share more info\??|can i make a purchase\??|能帮我查看一件商品的价格吗？?|我要了解最新优惠|了解collagen drink|我要免费试吃|新品荔枝玫瑰|rm 1promotion|5月闪电优惠|西马|东马|新加坡|马来西亚|west malaysia|east malaysia|singapore|sg)$/i.test(plain);
}

function isSyntheticWebhookPerson(person = {}) {
  const id = String(person.id || person.contact_id || "").trim();
  const name = String(person.name || person.contact_name || "").trim();
  const note = String(person.note || person.text || "").trim();
  const hasTemplatePlaceholder = [id, name, note].some(value => isPlaceholderValue(value) || /\{\{[^}]+\}\}/.test(value));
  return /^default_reply_contact$/i.test(id) ||
    hasTemplatePlaceholder ||
    /^whatsapp customer(?:\s+\d+)?$/i.test(name) ||
    /^whatsapp_message$/i.test(note) ||
    /^(Webhook：)?顾客有真实留言$/i.test(note);
}

function contextLabel(source = "") {
  const raw = String(source || "");
  const text = raw.replace(/[_-]+/g, " ").trim();
  if (/price|rm|payment|atome|package|配套|价/i.test(text)) return "价格 / 配套内容";
  if (/shopee|cod|delivery|shipping|post|邮|快递|平台/i.test(text)) return "平台 / 邮寄 / 付款方式";
  if (/skin|joint|sop|invivo|factory|test|效果|工厂|测试/i.test(text)) return "产品效果 / 信任感";
  if (/group|offer|follow|福利|优惠/i.test(text)) return "优惠 / 福利群跟进";
  return text || "";
}

function isShortIntent(text = "") {
  return /^(要|可以|ok|okay|yes|pm|多少钱|几钱|价钱|价格|还有吗|有吗|我要|怎样买|怎么买|how much|price\??)$/i.test(String(text).trim());
}

function isAudioContent(value = "") {
  return /\.(ogg|mp3|m4a|wav|aac)(\?|$)/i.test(String(value || "")) ||
    /audioclip|manybot-files.*\/(wa|fb)\/.*\.(ogg|mp3|m4a|wav|aac)|voice/i.test(String(value || ""));
}

function displayMessageText(value = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  return isAudioContent(text) ? "语音" : text;
}

function classifyBlocker(text = "", context = "") {
  if (isAudioContent(text) || String(text).trim() === "语音") {
    return { title: "语音留言 / 需要人工听", detail: "顾客发了语音，Dashboard 暂时不能辨别内容，需要人工听完再 follow up。" };
  }
  const t = String(text);
  const c = String(context);
  const combined = `${t} ${c}`;
  if (/多少钱|价钱|价格|一盒多少|cost|price|RM|盒|package|配套|atome|贵|便宜|优惠/i.test(combined)) {
    return { title: "价格 / 配套不清楚", detail: "顾客主要在问价格、盒数、优惠或付款配套，需要更直接给下单选项。" };
  }
  if (/糖尿病|手术|可以吃|品质|颜色|味道|适合|副作用|health|效果|多久|关节|皮肤|胶原|invivo|factory|test/i.test(combined)) {
    return { title: "产品顾虑 / 身体状况", detail: "顾客在确认效果、适不适合自己、品质或身体状况，需要安心解释和给例子。" };
  }
  if (/门店|地址|包邮|邮寄|快递|shopee|cod|货到付款|shipping|delivery|平台|bank|bank in/i.test(combined)) {
    return { title: "地点 / 邮寄 / 平台问题", detail: "顾客在问门店、邮寄、Shopee、COD 或付款方式相关问题。" };
  }
  if (/考虑|迟点|等|先看看|先想|不用|不要|没兴趣|下次|再说|贵/i.test(t)) {
    return { title: "还在考虑 / 暂时不买", detail: "顾客还没有准备下单，需要轻 follow up，不要太硬推。" };
  }
  if (isShortIntent(t) && c) {
    return { title: `${contextLabel(c)}后有兴趣`, detail: "顾客看完前面的内容后有回应，但还没有完成下单，需要接着确认数量或付款。" };
  }
  return { title: "犹豫中 / 需要 follow up", detail: "顾客有实际回应但还没明确下单，需要轻 follow up。" };
}

function firstValue(...values) {
  return values.map(value => String(value || "").trim()).find(Boolean) || "";
}

function isPlaceholderValue(value = "") {
  const text = String(value || "").trim().toLowerCase();
  return !text ||
    text === "no field selected" ||
    /^\{[^{}]+\}$/.test(text) ||
    /^\{\{[^{}]+\}\}$/.test(text) ||
    text.includes("subscriber.") ||
    text.includes("contact id") ||
    text.includes("full name") ||
    text.includes("last text input");
}

function firstRealValue(...values) {
  return values
    .map(value => String(value || "").trim())
    .find(value => value && !isPlaceholderValue(value)) || "";
}

function extractChatIdFromUrl(value = "") {
  const match = String(value || "").match(/app\.manychat\.com\/fb\d+\/chat\/(\d+)/);
  return match?.[1] || "";
}

function manychatContactId(source = {}) {
  const contact = source.contact || source.subscriber || source.user || {};
  const inbox = firstRealValue(source.inbox, source.inbox_url, source.live_chat_url, contact.inbox, contact.inbox_url, contact.live_chat_url);
  return firstRealValue(
    source.contact_id,
    source.subscriber_id,
    source.subscriberId,
    source.user_id,
    source.userId,
    source.manychat_id,
    source.manychat_contact_id,
    source.mc_id,
    source.id,
    contact.id,
    contact.contact_id,
    contact.subscriber_id,
    contact.subscriberId,
    contact.user_id,
    contact.userId,
    contact.manychat_id,
    contact.manychat_contact_id,
    extractChatIdFromUrl(inbox)
  );
}

function contactFromEvent(event, accountId) {
  const contact = event.contact || {};
  const id = manychatContactId(event);
  const name = firstRealValue(event.name, contact.name, contact.full_name, contact.first_name, id) || "Unknown";
  const directInbox = /^\d+$/.test(id) ? `https://app.manychat.com/${accountId}/chat/${id}` : "";
  const suppliedInbox = event.inbox || contact.inbox || contact.inbox_url || "";
  const inbox = directInbox || ACCOUNTS[accountId]?.inbox || suppliedInbox;
  return { id: id || name, name, inbox };
}

function normalizeManyChatEvent(raw, fallbackAccount = "") {
  const eventType = cleanEventType(raw.event_type || raw.type || raw.action || raw.status);
  const account = String(raw.account || raw.page_id || raw.manychat_account || fallbackAccount || "").trim();
  const occurredAt = raw.occurred_at || raw.date_time || raw.timestamp || raw.created_at || new Date().toISOString();
  const tags = [
    ...(Array.isArray(raw.tags) ? raw.tags : []),
    raw.tag,
    raw.tag_name,
    raw.label
  ].filter(Boolean).map(String);
  const text = String(raw.text || raw.message || raw.last_message || raw.customer_message || "").trim();
  return {
    id: raw.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    received_at: new Date().toISOString(),
    occurred_at: occurredAt,
    date: raw.date || klDate(occurredAt),
    account,
    event_type: eventType,
    contact: contactFromEvent(raw, account),
    text,
    direction: String(raw.direction || "").toLowerCase(),
    tags,
    blocker: raw.blocker || raw.category || "",
    source: String(raw.source || raw.flow || raw.step || "").trim(),
    raw
  };
}

function peopleUnique(items) {
  const seen = new Set();
  return items.filter(item => {
    const keys = personKeys(item);
    if (!keys.length || keys.some(key => seen.has(key))) return false;
    keys.forEach(key => seen.add(key));
    return true;
  });
}

function personKeys(item = {}) {
  return [
    item.id,
    item.contact_id,
    item.subscriber_id,
    item.phone,
    item.whatsapp_id,
    item.wa_id,
    item.inbox,
    item.inbox_url,
    item.live_chat_url,
    item.name
  ].map(value => String(value || "").trim().toLowerCase()).filter(value => value && !isPlaceholderValue(value));
}

function personKey(item = {}) {
  return personKeys(item)[0] || "";
}

function samePerson(a = {}, b = {}) {
  const bKeys = new Set(personKeys(b));
  return personKeys(a).some(key => bKeys.has(key));
}

function isAfterPaymentEvent(event = {}) {
  const type = String(event.event_type || "").toLowerCase();
  const source = String(event.source || event.flow || event.step || "").toLowerCase();
  const text = String(event.text || event.blocker || "").toLowerCase();
  return (
    ["after_payment", "ao", "order_completed", "completed_order"].includes(type) ||
    /after[_\s-]*payment|after payment flow|ao\s*flow|main payment flow/.test(source) ||
    /after[_\s-]*payment|after payment flow|ao\s*flow/.test(text)
  );
}

function buildReportFromEvents(events, accountId, date, existingReport = null) {
  const dayEvents = events.filter(event => event.account === accountId && event.date === date);
  if (!dayEvents.length) return { skipped: true, report: existingReport || null };

  const contactTags = new Map();
  const touch = event => {
    const contact = event.contact || contactFromEvent(event, accountId);
    if (!contactTags.has(contact.id)) contactTags.set(contact.id, { ...contact, tags: new Set() });
    const record = contactTags.get(contact.id);
    event.tags?.forEach(tag => record.tags.add(tag));
    return record;
  };
  dayEvents.forEach(touch);

  const eventIs = (event, names) => names.includes(event.event_type);
  const pmEvents = dayEvents.filter(event => eventIs(event, ["pm", "new_pm", "subscribed", "pm_subscribed", "new_contact", "subscriber_created"]));
  const pendingEvents = dayEvents.filter(event =>
    eventIs(event, ["pending", "pending_added", "tag_added"]) &&
    [...(event.tags || []), event.text, event.blocker].some(value => /pending/i.test(String(value)))
  );
  const orderEvents = dayEvents.filter(isAfterPaymentEvent);
  const laterOrderEvents = events.filter(event =>
    event.account === accountId &&
    event.date >= date &&
    isAfterPaymentEvent(event)
  );
  const messageEvents = dayEvents.filter(event =>
    eventIs(event, ["customer_message", "message", "inbox_message", "reply"]) ||
    event.direction === "in"
  ).filter(event => !isButtonLike(event.text));
  const pageReplyEvents = dayEvents.filter(event =>
    eventIs(event, ["page_reply", "admin_reply", "agent_reply"]) ||
    event.direction === "out"
  );
  const previousPageReplyFor = (messageEvent) => {
    const messageTime = new Date(messageEvent.occurred_at).getTime();
    return pageReplyEvents
      .filter(event => event.contact.id === messageEvent.contact.id && new Date(event.occurred_at).getTime() <= messageTime)
      .sort((a, b) => new Date(b.occurred_at) - new Date(a.occurred_at))[0] || null;
  };

  const orderPeople = peopleUnique(orderEvents.map(event => ({ ...event.contact, note: "完成订单 / After Payment" })));
  const pendingPeople = peopleUnique(pendingEvents.map(event => event.contact).filter(contact =>
    !orderPeople.some(order => samePerson(contact, order)) &&
    !laterOrderEvents.some(event => samePerson(contact, event.contact || contactFromEvent(event, accountId)))
  ));
  const activePeople = peopleUnique(messageEvents.map(event => {
    const context = previousPageReplyFor(event);
    const contextText = context ? contextLabel(context.source || context.text) : "";
    const text = displayMessageText(event.text);
    return { ...event.contact, note: contextText ? `${text}（前面看到：${contextText}）` : text };
  }));
  const pmPeople = peopleUnique(pmEvents.map(event => {
    const record = touch(event);
    const tags = [...record.tags];
    return { ...event.contact, note: "Subscribed on 当日", tags };
  }));

  const latestByContact = new Map();
  [...messageEvents.map(event => ({...event, kind:"customer"})), ...pageReplyEvents.map(event => ({...event, kind:"page"}))]
    .sort((a, b) => new Date(a.occurred_at) - new Date(b.occurred_at))
    .forEach(event => latestByContact.set(event.contact.id, event));
  const blockerMap = new Map();
  for (const event of messageEvents) {
    if (orderPeople.some(order => samePerson(event.contact, order))) continue;
    const context = previousPageReplyFor(event);
    const contextText = context?.source || context?.text || "";
    const blocker = event.blocker ? { title: event.blocker, detail: displayMessageText(event.text) || "ManyChat Flow 已记录卡点。" } : classifyBlocker(event.text, contextText);
    if (!blockerMap.has(blocker.title)) blockerMap.set(blocker.title, { ...blocker, count: 0, people: [] });
    const item = blockerMap.get(blocker.title);
    item.count += 1;
    item.people.push(event.contact.name);
  }
  const blockers = [...blockerMap.values()].sort((a, b) => b.count - a.count);

  const pmContactRecords = pmPeople.map(person => contactTags.get(person.id)).filter(Boolean);
  const pmTags = {
    collagenDrinks: pmContactRecords.filter(record => isCollagenDrink([...record.tags])).length,
    freeTesting: pmContactRecords.filter(record => isFreeTesting([...record.tags])).length,
    dontDisturb: pmContactRecords.filter(record => isDontDisturb([...record.tags])).length
  };

  const summary = blockers.length
    ? `今天顾客主要卡在：${blockers.map(item => `${item.title} ${item.count} 位`).join("、")}。${orderPeople.length ? ` 已有 ${orderPeople.length} 位完成订单。` : ""}${pendingPeople.length ? ` 还有 ${pendingPeople.length} 位 Pending 需要跟进。` : ""}`
    : `今天暂时没有从事件资料里看到明显未下单卡点。${orderPeople.length ? ` 已有 ${orderPeople.length} 位完成订单。` : ""}`;

  return {
    skipped: false,
    report: {
      pm: pmPeople.length,
      pending: pendingPeople.length,
      active: activePeople.length,
      orders: orderPeople.length,
      unanswered: 0,
      pmTags,
      customers: { pm: pmPeople, pending: pendingPeople, active: activePeople, orders: orderPeople },
      blockers,
      summary,
      status: "Database Report",
      lastUpdated: new Date().toISOString(),
      source: "manychat_events"
    }
  };
}

function mergeReportWithoutDowngrade(existingReport, incomingReport) {
  if (!existingReport || !incomingReport?.customers) return incomingReport || existingReport || null;
  const merged = structuredClone(incomingReport);
  merged.customers ||= { pm: [], pending: [], active: [], orders: [], unanswered: [] };
  const existingCustomers = existingReport.customers || {};
  for (const type of ["pm", "active", "orders", "unanswered"]) {
    const combined = peopleUnique([
      ...(merged.customers[type] || []),
      ...(existingCustomers[type] || [])
    ]).filter(person => !isSyntheticWebhookPerson(person) && (type !== "active" || !isButtonLike(person.note || person.text || "")));
    merged.customers[type] = combined;
    merged[type === "orders" ? "orders" : type] = combined.length;
  }
  merged.customers.pending = peopleUnique([
    ...(merged.customers.pending || []),
    ...(existingCustomers.pending || [])
  ]).filter(person =>
    !isSyntheticWebhookPerson(person) &&
    !(merged.customers.orders || []).some(order => samePerson(person, order))
  );
  merged.pending = merged.customers.pending.length;
  merged.pm = Math.max(
    merged.customers.pm.length,
    Number(existingReport.pm || 0),
    Number(incomingReport.pm || 0)
  );
  merged.active = Math.max(
    merged.customers.active.length,
    Number(existingReport.active || 0),
    Number(incomingReport.active || 0)
  );
  merged.orders = Math.max(
    merged.customers.orders.length,
    Number(existingReport.orders || 0),
    Number(incomingReport.orders || 0)
  );
  const blockerByTitle = new Map();
  for (const blocker of [...(existingReport.blockers || []), ...(incomingReport.blockers || [])]) {
    const title = String(blocker.title || "").trim();
    if (!title) continue;
    const current = blockerByTitle.get(title);
    if (!current || Number(blocker.count || 0) >= Number(current.count || 0)) blockerByTitle.set(title, blocker);
  }
  merged.blockers = [...blockerByTitle.values()].filter(item => Number(item.count || 0) > 0);
  merged.pmTags = {
    collagenDrinks: Math.max(Number(existingReport.pmTags?.collagenDrinks || 0), Number(incomingReport.pmTags?.collagenDrinks || 0)),
    freeTesting: Math.max(Number(existingReport.pmTags?.freeTesting || 0), Number(incomingReport.pmTags?.freeTesting || 0)),
    dontDisturb: Math.max(Number(existingReport.pmTags?.dontDisturb || 0), Number(incomingReport.pmTags?.dontDisturb || 0))
  };
  if (Number(existingReport.active || 0) > Number(incomingReport.active || 0) && existingReport.summary) {
    merged.summary = existingReport.summary;
  }
  merged.source = incomingReport.source || existingReport.source;
  merged.status = incomingReport.status || existingReport.status;
  merged.lastUpdated = incomingReport.lastUpdated || new Date().toISOString();
  return merged;
}

function buildCombinedReport(reports, date) {
  const formatPage = (accountId, pageName) => {
    const report = reports[accountId]?.[date] || null;
    const pmTags = report?.pmTags || {};
    const pmCategories = [
      ["询问 Collagen Drinks", pmTags.collagenDrinks],
      ["Free Testing", pmTags.freeTesting],
      ["Don't Disturb", pmTags.dontDisturb]
    ].filter(([, count]) => Number(count) > 0);
    const pmCategoryText = pmCategories.length
      ? pmCategories.map(([label, count]) => `- ${label}：${count}人`).join("\n")
      : "- 今天没有特别标记的 PM 分类";
    const blockerItems = report?.blockers?.filter(item => Number(item.count) > 0) || [];
    const blockerText = blockerItems.length
      ? blockerItems.map(item => `- ${item.title}：${item.count}人。${item.detail}`).join("\n")
      : "- 目前没有从实际对话中确认到未下单卡点。";
    const plainSummary = blockerItems.length
      ? `今天还没下单的顾客，主要卡在以下几件事：\n${blockerText}`
      : "今天暂时没有从实际对话中确认到顾客卡在哪里。";
    return [
      `Page: ${pageName}`,
      `日期: ${date}`,
      "",
      `PM 人数: ${report?.pm ?? 0}`,
      `Pending: ${report?.pending ?? 0}`,
      `After Payment: ${report?.orders ?? 0}`,
      `有互动: ${report?.active ?? 0}`,
      "",
      "PM 分类:",
      pmCategoryText,
      "",
      "Inbox 总结:",
      plainSummary
    ].join("\n");
  };

  return Object.entries(ACCOUNTS)
    .map(([accountId, item]) => formatPage(accountId, item.name))
    .join("\n\n====================\n\n");
}

function contactFromWebhook(person = {}, accountId, note = "") {
  const id = manychatContactId(person);
  const name = firstRealValue(person.name, person.full_name, id) || "Unknown";
  const directInbox = /^\d+$/.test(id) ? `https://app.manychat.com/${accountId}/chat/${id}` : "";
  const suppliedInbox = person.inbox || person.inbox_url || person.live_chat_url || "";
  return {
    id: id || name,
    name,
    phone: person.phone || person.whatsapp_id || person.wa_id || "",
    note: person.note || note,
    tags: person.tags || [],
    inbox: directInbox || suppliedInbox || ACCOUNTS[accountId]?.inbox
  };
}

function tagsFromManyChatContact(contact = {}) {
  return (contact.tags || []).map(tag => String(tag.name || tag.title || tag.id || tag).trim()).filter(Boolean);
}

function normalizeName(value = "") {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function datePart(value = "") {
  return String(value || "").slice(0, 10);
}

function meaningfulNote(value = "") {
  return String(value || "").replace(/（.*$/, "").replace(/^Webhook：/, "").trim();
}

async function manychatFindByName(account, name) {
  if (!name) return [];
  try {
    const data = await manychat(account, `/fb/subscriber/findByName?name=${encodeURIComponent(name)}`);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function updatePeopleWithContactInfo(people = [], contact = {}, accountId) {
  const id = String(contact.id || "").trim();
  const tags = tagsFromManyChatContact(contact);
  const name = String(contact.name || contact.full_name || [contact.first_name, contact.last_name].filter(Boolean).join(" ") || "").trim();
  return people.map(person => {
    const same = id && String(person.id || "") === id;
    if (!same) return person;
    return {
      ...person,
      id,
      name: name || person.name,
      tags: tags.length ? tags : (person.tags || []),
      inbox: `https://app.manychat.com/${accountId}/chat/${id}`
    };
  });
}

async function resolveMissingContactIdsByName(report, accountId, date) {
  const account = { id: accountId, ...ACCOUNTS[accountId] };
  const lists = ["pm", "pending", "orders", "active", "unanswered"];
  const knownByName = new Map();
  for (const listName of lists) {
    for (const person of report.customers[listName] || []) {
      if (/^\d+$/.test(String(person.id || "").trim())) knownByName.set(normalizeName(person.name), person);
    }
  }
  const cache = new Map();
  const resolvePerson = async (person) => {
    if (!person || /^\d+$/.test(String(person.id || "").trim())) return person;
    const name = String(person.name || "").trim();
    if (!name) return person;
    const known = knownByName.get(normalizeName(name));
    if (known) {
      return {
        ...person,
        id: String(known.id),
        name: known.name || person.name,
        tags: (known.tags || []).length ? known.tags : (person.tags || []),
        inbox: `https://app.manychat.com/${accountId}/chat/${known.id}`
      };
    }
    if (!cache.has(name)) cache.set(name, manychatFindByName(account, name));
    const matches = (await cache.get(name)).filter(contact => normalizeName(contact.name) === normalizeName(name));
    if (!matches.length) return { ...person, id: "", inbox: ACCOUNTS[accountId].inbox };
    const note = normalizeName(meaningfulNote(person.note));
    const scored = matches.map(contact => {
      const last = normalizeName(contact.last_input_text);
      const score =
        3 +
        (datePart(contact.subscribed) === date ? 2 : 0) +
        (note && last && (last.includes(note) || note.includes(last)) ? 4 : 0) +
        (contact.live_chat_url ? 1 : 0);
      return { contact, score };
    }).sort((a, b) => b.score - a.score);
    const top = scored[0];
    const second = scored[1];
    if (!top || top.score < 4 || (second && top.score === second.score)) {
      return { ...person, id: "", inbox: ACCOUNTS[accountId].inbox };
    }
    const tags = tagsFromManyChatContact(top.contact);
    const id = String(top.contact.id || "").trim();
    return {
      ...person,
      id,
      name: top.contact.name || person.name,
      tags: tags.length ? tags : (person.tags || []),
      inbox: `https://app.manychat.com/${accountId}/chat/${id}`
    };
  };
  for (const listName of lists) {
    report.customers[listName] = await Promise.all((report.customers[listName] || []).map(resolvePerson));
  }
  return report;
}

async function enrichReportWithManyChatContacts(report, accountId, date = klDate()) {
  if (!report?.customers) return report;
  const account = { id: accountId, ...ACCOUNTS[accountId] };
  report = await resolveMissingContactIdsByName(report, accountId, date);
  const ids = [...new Set([
    ...(report.customers.pm || []),
    ...(report.customers.pending || []),
    ...(report.customers.orders || []),
    ...(report.customers.active || [])
  ].map(person => String(person.id || "").trim()).filter(id => /^\d+$/.test(id)))];
  if (!ids.length) return report;
  const contacts = [];
  for (const id of ids.slice(0, 80)) {
    try {
      contacts.push(await manychat(account, `/fb/subscriber/getInfo?subscriber_id=${encodeURIComponent(id)}`));
    } catch {}
  }
  for (const contact of contacts) {
    report.customers.pm = updatePeopleWithContactInfo(report.customers.pm || [], contact, accountId);
    report.customers.pending = updatePeopleWithContactInfo(report.customers.pending || [], contact, accountId);
    report.customers.orders = updatePeopleWithContactInfo(report.customers.orders || [], contact, accountId);
    report.customers.active = updatePeopleWithContactInfo(report.customers.active || [], contact, accountId);
  }
  report.customers.pending = (report.customers.pending || []).filter(person =>
    !(report.customers.orders || []).some(order => samePerson(person, order))
  );
  report.pending = report.customers.pending.length;
  report.orders = report.customers.orders.length;
  report.active = report.customers.active.length;
  const blockerMap = new Map();
  for (const person of report.customers.active || []) {
    if ((report.customers.orders || []).some(order => samePerson(person, order))) continue;
    const text = displayMessageText(person.note || "").trim();
    if (!text || isButtonLike(text)) continue;
    const blocker = classifyBlocker(text, "");
    if (!blockerMap.has(blocker.title)) blockerMap.set(blocker.title, { ...blocker, count: 0, people: [] });
    const item = blockerMap.get(blocker.title);
    item.count += 1;
    item.people.push(person.name);
  }
  if (blockerMap.size) {
    report.blockers = [...blockerMap.values()].sort((a, b) => b.count - a.count);
  }
  const pmContactRecords = (report.customers.pm || []).map(person => person.tags || []);
  report.pmTags = {
    collagenDrinks: pmContactRecords.filter(tags => isCollagenDrink(tags)).length,
    freeTesting: pmContactRecords.filter(tags => isFreeTesting(tags)).length,
    dontDisturb: pmContactRecords.filter(tags => isDontDisturb(tags)).length
  };
  if (report.active > 0 && (!report.summary || /暂时还没有收到顾客真实留言|已有顾客真实互动/.test(report.summary))) {
    report.summary = report.blockers?.length
      ? `今天有 ${report.active} 位顾客真实留言，主要卡在：${report.blockers.map(item => `${item.title} ${item.count} 位`).join("、")}。`
      : `今天有 ${report.active} 位顾客真实留言，暂时没有明显未下单卡点。`;
  }
  return report;
}

function mergeWebhookReport(baseReport, live, accountId) {
  const counts = live?.counts || {};
  const contacts = live?.contacts || {};
  const liveEvents = Array.isArray(live?.events) ? live.events : [];
  const eventsByType = (type) => liveEvents.filter(event => cleanEventType(event.type) === type);
  const hasLiveActivity = Boolean(live?.updated_at) ||
    liveEvents.length > 0 ||
    ["pm", "pending", "after_payment", "active", "customer_message", "page_reply"].some(key => Number(counts[key] || 0) > 0);
  if (!hasLiveActivity) return { skipped: true, report: baseReport || null };

  const report = baseReport ? structuredClone(baseReport) : {
    pm: 0,
    pending: 0,
    active: 0,
    orders: 0,
    unanswered: 0,
    pmTags: { collagenDrinks: 0, freeTesting: 0, dontDisturb: 0 },
    customers: { pm: [], pending: [], active: [], orders: [], unanswered: [] },
    blockers: [],
    summary: "Webhook 已开始收集这一天的顾客事件。",
    status: "Webhook Report",
    source: "manychat_webhook"
  };

  report.customers ||= { pm: [], pending: [], active: [], orders: [], unanswered: [] };
  report.customers.active = (report.customers.active || []).filter(person => !isSyntheticWebhookPerson(person) && !isButtonLike(person.note || person.text || ""));
  const mergePeople = (key, incoming) => {
    report.customers[key] = peopleUnique([...(incoming || []), ...(report.customers[key] || [])]);
  };
  const isLiveAfterPaymentEvent = (event = {}) => {
    const type = cleanEventType(event.type || event.event_type || "");
    const source = String(event.source || event.flow || event.step || "").toLowerCase();
    const text = String(event.text || event.blocker || "").toLowerCase();
    return ["after_payment", "ao", "order_completed", "completed_order"].includes(type) ||
      /after[_\s-]*payment|after payment flow|ao\s*flow|main payment flow/.test(source) ||
      /after[_\s-]*payment|after payment flow|ao\s*flow|main payment flow/.test(text);
  };

  const pmPeople = [
    ...(contacts.pm || []),
    ...(contacts.new_pm || []),
    ...(contacts.pm_subscribed || [])
  ]
    .map(person => contactFromWebhook(person, accountId, "广告入口 / Subscribed 当日"))
    .filter(person => !isSyntheticWebhookPerson(person));
  const pendingPeople = (contacts.pending || []).map(person => contactFromWebhook(person, accountId, "今天加入 Pending"));
  const orderPeople = (contacts.after_payment || []).map(person => contactFromWebhook(person, accountId, "完成订单 / After Payment"));
  const eventOrderPeople = liveEvents.filter(isLiveAfterPaymentEvent).map((event, index) => contactFromWebhook({
    id: event.contact_id || event.subscriber_id || event.manychat_contact_id || "",
    name: event.name || event.contact_name || event.full_name || `After Payment Customer ${index + 1}`,
    phone: event.phone || "",
    text: event.text || "",
    inbox: event.inbox || ""
  }, accountId, "完成订单 / After Payment"))
    .filter(person => !isSyntheticWebhookPerson(person));
  const eventActivePeople = eventsByType("customer_message").map((event, index) => contactFromWebhook({
    id: event.contact_id || event.subscriber_id || event.manychat_contact_id || "",
    name: event.name || event.contact_name || event.full_name || `WhatsApp Customer ${index + 1}`,
    text: event.text || "",
    tags: event.tags || [],
    inbox: event.inbox || ""
  }, accountId, displayMessageText(event.text) || "Webhook：顾客有真实留言"))
    .filter(person => !isSyntheticWebhookPerson(person) && !isButtonLike(person.note || person.text || ""));
  const activeWebhookContacts = [
    ...(contacts.active || []),
    ...(contacts.customer_message || []).filter(person => {
      const actualText = String(person.text || person.message || person.last_text_input || person.lastInputText || "").trim();
      return actualText && !isButtonLike(actualText);
    })
  ];
  const activePeople = [
    ...activeWebhookContacts.map(person => contactFromWebhook(person, accountId, displayMessageText(person.text || person.message || person.last_text_input) || "顾客有真实留言")),
    ...eventActivePeople
  ].filter(person => !isSyntheticWebhookPerson(person) && !isButtonLike(person.note || person.text || ""));

  mergePeople("pm", pmPeople);
  mergePeople("pending", pendingPeople);
  mergePeople("orders", [...orderPeople, ...eventOrderPeople]);
  mergePeople("active", activePeople);

  report.customers.pending = (report.customers.pending || []).filter(person =>
    !(report.customers.orders || []).some(order => samePerson(person, order))
  );

  const pmEventTotal = eventsByType("pm_subscribed").length +
    eventsByType("pm").length +
    eventsByType("new_pm").length +
    eventsByType("subscribed").length +
    eventsByType("new_contact").length +
    eventsByType("subscriber_created").length;
  const afterPaymentEventTotal = liveEvents.filter(isLiveAfterPaymentEvent).length +
    eventsByType("ao").length +
    eventsByType("order_completed").length +
    eventsByType("completed_order").length;
  report.pm = Math.max(report.customers.pm.length, pmEventTotal);
  report.orders = Math.max(report.customers.orders.length, afterPaymentEventTotal);
  report.pending = report.customers.pending.length;
  report.active = report.customers.active.length;
  report.unanswered = 0;
  const afterPaymentCount = Number(counts.after_payment || 0);
  const pmEventCount = Number(counts.pm || 0) +
    Number(counts.new_pm || 0) +
    Number(counts.pm_subscribed || 0) +
    (contacts.pm || []).length +
    (contacts.new_pm || []).length +
    (contacts.pm_subscribed || []).length +
    (report.customers.pm || []).length;
  const trackedActivityCount = liveEvents.length +
    Number(counts.customer_message || 0) +
    Number(counts.active || 0) +
    Number(counts.pending || 0) +
    Number(counts.after_payment || 0);
  report.syncWarnings = (Array.isArray(report.syncWarnings) ? report.syncWarnings : [])
    .filter(message =>
      !/^After Payment 收到 \d+ 个事件，但只有 \d+ 位顾客名单/.test(String(message)) &&
      !/^PM 事件还没有接上/.test(String(message))
    );
  if (trackedActivityCount > 0 && pmEventCount === 0) {
    const message = "PM 事件还没有接上：这个 Channel 有收到 ManyChat 事件，但没有收到 Subscribed on / PM 名单，所以 RUN 不能准确统计当日 PM 人数。请在顾客进入的 Default Reply / 入口 Flow 加 pm_subscribed External Request。";
    if (!report.syncWarnings.includes(message)) report.syncWarnings.push(message);
  }
  if (afterPaymentCount > report.customers.orders.length) {
    const message = `After Payment 收到 ${afterPaymentCount} 个事件，但只有 ${report.customers.orders.length} 位顾客名单；请检查 ManyChat External Request 是否有带 contact_id/name/inbox。`;
    if (!report.syncWarnings.includes(message)) report.syncWarnings.push(message);
  }
  if (pmEventTotal > report.customers.pm.length) {
    const message = `PM 收到 ${pmEventTotal} 个入口事件，但只有 ${report.customers.pm.length} 位有效顾客名单；目前人数先按 event 统计，名单/inbox 需要 ManyChat External Request 带真实 contact_id/name。`;
    if (!report.syncWarnings.includes(message)) report.syncWarnings.push(message);
  }
  report.lastUpdated = live.updated_at || new Date().toISOString();
  report.status = report.source === "manychat_events" ? "Database + Webhook" : "Webhook Report";
  report.source = report.source === "manychat_events" ? "manychat_events_and_webhook" : "manychat_webhook";
  if (!report.summary || /Webhook 已开始|还没有|已有顾客真实互动/.test(report.summary)) {
    report.summary = report.active
      ? "今天已有顾客真实互动，卡点会根据顾客文字继续累积分析。"
      : "今天暂时还没有收到顾客真实留言；PM、Pending 和 After Payment 会先按 webhook 事件统计。";
  }
  return { skipped: false, report };
}

function removePendingCompletedLater(report, events, accountId, date) {
  if (!report?.customers?.pending?.length) return report;
  const laterOrderEvents = events.filter(event =>
    event.account === accountId &&
    event.date >= date &&
    isAfterPaymentEvent(event)
  );
  if (!laterOrderEvents.length) return report;
  report.customers.pending = report.customers.pending.filter(person =>
    !laterOrderEvents.some(event => samePerson(person, event.contact || contactFromEvent(event, accountId)))
  );
  report.pending = report.customers.pending.length;
  return report;
}

function isManualConfirmedReport(report) {
  return Boolean(report?.manualConfirmed);
}

async function readWebhookReport(accountId, date) {
  if (!env.WEBHOOK_URL || !env.EVENT_INGEST_KEY) return null;
  const endpoint = new URL(env.WEBHOOK_URL);
  endpoint.searchParams.set("key", env.EVENT_INGEST_KEY);
  endpoint.searchParams.set("account", accountId);
  endpoint.searchParams.set("date", date);
  const response = await fetch(endpoint, { redirect: "follow", cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) throw new Error(body.error || `Webhook ${response.status}`);
  return body.report || null;
}

async function forwardManyChatEventToWebhook(raw, event) {
  if (!env.WEBHOOK_URL || !env.EVENT_INGEST_KEY) return null;
  const endpoint = new URL(env.WEBHOOK_URL);
  endpoint.searchParams.set("key", env.EVENT_INGEST_KEY);
  endpoint.searchParams.set("account", event.account);
  const contact = event.contact || {};
  const rawContact = raw.contact || raw.subscriber || raw.user || {};
  const cleanContact = {
    id: firstRealValue(raw.contact_id, raw.subscriber_id, raw.manychat_contact_id, raw.id, rawContact.id, rawContact.contact_id, rawContact.subscriber_id, contact.id),
    name: firstRealValue(raw.name, raw.contact_name, raw.full_name, rawContact.name, rawContact.full_name, contact.name),
    phone: firstRealValue(raw.phone, raw.whatsapp_id, raw.wa_id, rawContact.phone, rawContact.whatsapp_id, rawContact.wa_id, contact.phone),
    inbox: firstRealValue(raw.inbox, raw.inbox_url, raw.chat_url, raw.live_chat_url, rawContact.inbox, rawContact.inbox_url, rawContact.live_chat_url, contact.inbox)
  };
  const payload = {
    account: event.account,
    event_type: event.event_type,
    event_date: event.date,
    date: event.date,
    occurred_at: event.occurred_at,
    contact: cleanContact,
    contact_id: cleanContact.id,
    name: cleanContact.name,
    phone: cleanContact.phone,
    inbox: cleanContact.inbox,
    text: firstRealValue(raw.text, raw.message, raw.last_text_input, raw.last_input, raw.last_input_text, event.text),
    tags: raw.tags || event.tags || [],
    source: firstRealValue(raw.source, raw.flow, raw.step, event.source),
    blocker: firstRealValue(raw.blocker, raw.reason, raw.category)
  };
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    redirect: "follow",
    cache: "no-store"
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) throw new Error(body.error || `Webhook ${response.status}`);
  return body;
}

async function writeOrderEntry(payload) {
  if (!env.WEBHOOK_URL || !env.EVENT_INGEST_KEY) {
    throw new Error("Google Sheet webhook 尚未连接");
  }
  const endpoint = new URL(env.WEBHOOK_URL);
  endpoint.searchParams.set("key", env.EVENT_INGEST_KEY);
  const response = await fetch(endpoint, {
    method: "POST",
    redirect: "follow",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ event_type: "order_entry", ...payload })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) {
    const confirmed = await confirmWrittenOrderEntry(payload.order).catch(() => null);
    if (confirmed?.row) return confirmed;
    const details = Array.isArray(body.errors) && body.errors.length
      ? body.errors.map(item => `${item.name || item.phone || "订单"}: ${item.error || "写入失败"}`).join("；")
      : "";
    throw new Error(details || body.error || `Google Sheet webhook ${response.status}`);
  }
  if (!body.entry || !body.entry.row) {
    const confirmed = await confirmWrittenOrderEntry(payload.order).catch(() => null);
    if (confirmed?.row) return confirmed;
    throw new Error("Apps Script 还没更新到 Order Key-In 版本，请先把 apps-script-webhook.gs 重新部署");
  }
  return body.entry;
}

function orderDateKeyFromOrder(order = {}) {
  const raw = String(order["F · Date"] || "").trim();
  const slash = raw.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);
  if (slash) {
    const year = slash[3].length === 2 ? `20${slash[3]}` : slash[3];
    return `${year}-${slash[2].padStart(2, "0")}-${slash[1].padStart(2, "0")}`;
  }
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kuala_Lumpur", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
}

function normalizeOrderComparable(value = "") {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function digitsOnly(value = "") {
  return String(value || "").replace(/\D/g, "");
}

function orderMatchesEntry(order = {}, entry = {}) {
  const phone = digitsOnly(order["Q · Phone"]);
  const entryPhone = digitsOnly(entry.phone || entry.order?.["Q · Phone"]);
  const total = String(order["S · Total/RM"] || "").replace(/[^0-9.]/g, "");
  const entryTotal = String(entry.total || entry.order?.["S · Total/RM"] || "").replace(/[^0-9.]/g, "");
  const name = normalizeOrderComparable(order["P · Name"] || order["G · Platform Name"]);
  const entryName = normalizeOrderComparable(entry.name || entry.order?.["P · Name"] || entry.order?.["G · Platform Name"]);
  const product = normalizeOrderComparable(order["N · Variant"] || order["O · Remark"]);
  const entryProduct = normalizeOrderComparable(entry.product || entry.order?.["N · Variant"] || entry.order?.["O · Remark"]);
  const phoneMatch = phone && entryPhone && phone === entryPhone;
  const nameMatch = name && entryName && name === entryName;
  const totalMatch = total && entryTotal && total === entryTotal;
  const productMatch = !product || !entryProduct || product === entryProduct;
  return (phoneMatch || nameMatch) && (!total || !entryTotal || totalMatch) && productMatch;
}

async function confirmWrittenOrderEntry(order = {}) {
  const dateKey = orderDateKeyFromOrder(order);
  const result = await readOrderEntries(dateKey);
  const entries = Array.isArray(result.entries) ? result.entries : [];
  return entries.find(entry => orderMatchesEntry(order, entry)) || null;
}

async function writeOrderEntries(entries) {
  const cleanEntries = (entries || []).filter(item => item && item.order && typeof item.order === "object");
  if (!cleanEntries.length) throw new Error("Order data required");

  const written = [];
  const errors = [];
  for (let index = 0; index < cleanEntries.length; index += 1) {
    const item = cleanEntries[index];
    try {
      const entry = await writeOrderEntry({
        page: item.page || "",
        raw: item.raw || "",
        order: item.order
      });
      written.push(entry);
    } catch (error) {
      errors.push({
        index,
        name: item.order?.["P · Name"] || item.order?.["G · Platform Name"] || `订单 ${index + 1}`,
        error: error?.message || String(error || "Google Sheet 写入失败")
      });
    }
  }

  if (!written.length) {
    throw new Error(errors.map(item => `${item.name}: ${item.error}`).join("；") || "Google Sheet 写入失败");
  }
  return { entries: written, errors };
}

async function readOrderEntries(date) {
  if (!env.WEBHOOK_URL || !env.EVENT_INGEST_KEY) {
    throw new Error("Google Sheet webhook 尚未连接");
  }
  const endpoint = new URL(env.WEBHOOK_URL);
  endpoint.searchParams.set("key", env.EVENT_INGEST_KEY);
  endpoint.searchParams.set("action", "order_entries");
  endpoint.searchParams.set("date", date);
  const response = await fetch(endpoint, { redirect: "follow", cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) {
    throw new Error(body.error || `Google Sheet webhook ${response.status}`);
  }
  if (!Array.isArray(body.entries)) {
    throw new Error("Apps Script 还没更新到 Order Records 版本，请重新部署 apps-script-webhook.gs");
  }
  return body;
}

async function updateOrderEntryDate(payload) {
  if (!env.WEBHOOK_URL || !env.EVENT_INGEST_KEY) {
    throw new Error("Google Sheet webhook 尚未连接");
  }
  const endpoint = new URL(env.WEBHOOK_URL);
  endpoint.searchParams.set("key", env.EVENT_INGEST_KEY);
  const response = await fetch(endpoint, {
    method: "POST",
    redirect: "follow",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ event_type: "order_update_date", ...payload })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) {
    throw new Error(body.error || `Google Sheet webhook ${response.status}`);
  }
  return body.entry || body;
}

async function updateOrderEntry(payload) {
  if (!env.WEBHOOK_URL || !env.EVENT_INGEST_KEY) {
    throw new Error("Google Sheet webhook 尚未连接");
  }
  const endpoint = new URL(env.WEBHOOK_URL);
  endpoint.searchParams.set("key", env.EVENT_INGEST_KEY);
  const response = await fetch(endpoint, {
    method: "POST",
    redirect: "follow",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ event_type: "order_update", ...payload })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) {
    throw new Error(body.error || `Google Sheet webhook ${response.status}`);
  }
  return body.entry || body;
}

async function deleteOrderEntry(payload) {
  if (!env.WEBHOOK_URL || !env.EVENT_INGEST_KEY) {
    throw new Error("Google Sheet webhook 尚未连接");
  }
  const endpoint = new URL(env.WEBHOOK_URL);
  endpoint.searchParams.set("key", env.EVENT_INGEST_KEY);
  const response = await fetch(endpoint, {
    method: "POST",
    redirect: "follow",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ event_type: "order_delete", action: "delete", ...payload })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) {
    throw new Error(body.error || `Google Sheet webhook ${response.status}`);
  }
  return body.entry || body;
}

async function writeBroadcastPlan(payload) {
  if (!env.WEBHOOK_URL || !env.EVENT_INGEST_KEY) {
    throw new Error("Google Sheet webhook 尚未连接");
  }
  const endpoint = new URL(env.WEBHOOK_URL);
  endpoint.searchParams.set("key", env.EVENT_INGEST_KEY);
  const response = await fetch(endpoint, {
    method: "POST",
    redirect: "follow",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ event_type: "broadcast_plan_update", ...payload })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) {
    throw new Error(body.error || `Google Sheet webhook ${response.status}`);
  }
  if (!body.row && payload.action !== "delete") {
    throw new Error("Apps Script 还没更新到 Broadcast Planning 版本，请先把 apps-script-webhook.gs 重新部署");
  }
  return body;
}

async function readBroadcastPlans(month = "") {
  if (!env.WEBHOOK_URL || !env.EVENT_INGEST_KEY) {
    throw new Error("Google Sheet webhook 尚未连接");
  }
  const endpoint = new URL(env.WEBHOOK_URL);
  endpoint.searchParams.set("key", env.EVENT_INGEST_KEY);
  endpoint.searchParams.set("action", "broadcast_plans");
  if (month) endpoint.searchParams.set("month", month);
  const response = await fetch(endpoint, { redirect: "follow", cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) {
    throw new Error(body.error || `Google Sheet webhook ${response.status}`);
  }
  if (!Array.isArray(body.rows)) {
    throw new Error("Apps Script 还没更新到 Broadcast Planning 读取版本，请先重新部署 apps-script-webhook.gs");
  }
  return body;
}

async function readBroadcastSheetConfig(month = "") {
  if (!env.WEBHOOK_URL || !env.EVENT_INGEST_KEY) {
    throw new Error("Google Sheet webhook 尚未连接");
  }
  const endpoint = new URL(env.WEBHOOK_URL);
  endpoint.searchParams.set("key", env.EVENT_INGEST_KEY);
  endpoint.searchParams.set("action", "broadcast_sheet_config");
  if (month) endpoint.searchParams.set("month", month);
  const response = await fetch(endpoint, { redirect: "follow", cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) {
    throw new Error(body.error || `Google Sheet webhook ${response.status}`);
  }
  return body;
}

async function writeBroadcastSheetConfig(payload) {
  if (!env.WEBHOOK_URL || !env.EVENT_INGEST_KEY) {
    throw new Error("Google Sheet webhook 尚未连接");
  }
  const endpoint = new URL(env.WEBHOOK_URL);
  endpoint.searchParams.set("key", env.EVENT_INGEST_KEY);
  const response = await fetch(endpoint, {
    method: "POST",
    redirect: "follow",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ event_type: "broadcast_sheet_config", ...payload })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) {
    throw new Error(body.error || `Google Sheet webhook ${response.status}`);
  }
  return body;
}

async function readBroadcastTracking(params = {}) {
  if (!env.WEBHOOK_URL || !env.EVENT_INGEST_KEY) {
    throw new Error("Google Sheet webhook 尚未连接");
  }
  const endpoint = new URL(env.WEBHOOK_URL);
  endpoint.searchParams.set("key", env.EVENT_INGEST_KEY);
  endpoint.searchParams.set("action", "broadcast_tracking");
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && String(value).trim()) endpoint.searchParams.set(key, value);
  });
  const response = await fetch(endpoint, { redirect: "follow", cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) {
    throw new Error(body.error || `Broadcast Tracking webhook ${response.status}`);
  }
  return body;
}

async function writeBroadcastTrackingEvent(eventType, payload) {
  if (!env.WEBHOOK_URL || !env.EVENT_INGEST_KEY) {
    throw new Error("Google Sheet webhook 尚未连接");
  }
  const endpoint = new URL(env.WEBHOOK_URL);
  endpoint.searchParams.set("key", env.EVENT_INGEST_KEY);
  const response = await fetch(endpoint, {
    method: "POST",
    redirect: "follow",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ event_type: eventType, ...payload })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) {
    throw new Error(body.error || `Broadcast Tracking webhook ${response.status}`);
  }
  return body;
}

function json(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-Ingest-Key",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error("Request too large");
  }
  return body ? JSON.parse(body) : {};
}

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png"
};

await mkdir(DATA_DIR, { recursive: true });

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, X-Ingest-Key",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
      });
      return res.end();
    }
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === "/api/auth/status" && req.method === "GET") {
      return json(res, 200, {
        enabled: AUTH_ENABLED,
        authenticated: isAuthenticated(req),
        email: AUTH_EMAIL
      });
    }

    if (url.pathname === "/api/auth/login" && req.method === "POST") {
      if (!AUTH_ENABLED) return json(res, 400, { ok: false, error: "Login 还没启用：请先设置 AUTH_PASSWORD。" });
      const request = await readBody(req);
      const email = String(request.email || "").trim().toLowerCase();
      const password = String(request.password || "");
      if (AUTH_EMAIL && email !== AUTH_EMAIL) return json(res, 401, { ok: false, error: "Email 不正确。" });
      if (!checkPassword(password)) return json(res, 401, { ok: false, error: "Password 不正确。" });
      const token = randomBytes(32).toString("hex");
      AUTH_SESSIONS.set(token, {
        email: email || AUTH_EMAIL || "dashboard-user",
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000
      });
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Set-Cookie": loginCookie(token)
      });
      return res.end(JSON.stringify({ ok: true }));
    }

    if (url.pathname === "/api/auth/logout" && req.method === "POST") {
      const token = parseCookies(req.headers.cookie || "")[AUTH_COOKIE];
      if (token) AUTH_SESSIONS.delete(token);
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Set-Cookie": logoutCookie()
      });
      return res.end(JSON.stringify({ ok: true }));
    }

    if (url.pathname === "/login" || url.pathname === "/login.html") {
      const content = await readFile(join(ROOT, "login.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(content);
    }

    if (!requireAuth(req, res, url)) return;

    const account = accountFrom(url);

    if (url.pathname === "/api/accounts") {
      return json(res, 200, { accounts: Object.entries(ACCOUNTS).map(([id, item]) => ({
        id, name: item.name, inbox: item.inbox, connected: Boolean(item.key)
      })) });
    }

    if (url.pathname === "/api/health") {
      const info = await manychat(account, "/fb/page/getInfo");
      return json(res, 200, { ok: true, account: info.name, timezone: info.timezone });
    }

    if (url.pathname === "/api/meta") {
      const [info, tags, fields] = await Promise.all([
        manychat(account, "/fb/page/getInfo"),
        manychat(account, "/fb/page/getTags"),
        manychat(account, "/fb/page/getCustomFields")
      ]);
      const wanted = new Set(["PENDING", "Pending", "Pending Payment 【SG】", "AO", "June Purchased", "FreeTesting", "RM4.90 DRINK", "RM4.90drinks", "Dont Disturb", "Don't Disturb", "Do Not disturb", "Do Not Disturb"]);
      return json(res, 200, {
        connected: true,
        account: { id: info.id, name: info.name, timezone: info.timezone },
        expectedTags: account.tags,
        tags: tags.filter(tag => wanted.has(tag.name)),
        fields: fields.filter(field => field.name === "Status")
      });
    }

    if (url.pathname === "/api/reports") {
      const reports = await readReports();
      const date = url.searchParams.get("date");
      const accountReports = reports[account.id] || {};
      return json(res, 200, date ? { account: account.id, date, report: accountReports[date] || null } : { account: account.id, reports: accountReports });
    }

    if (url.pathname === "/api/download-report" && req.method === "GET") {
      const date = url.searchParams.get("date") || "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(res, 400, { error: "Valid date required" });
      const reports = await readReports();
      const formatPage = (accountId, pageName) => {
        const report = reports[accountId]?.[date] || null;
        const blockers = report?.blockers?.length
          ? report.blockers.map(item => `- ${item.title}（${item.count}人）：${item.detail}`).join("\n")
          : "- 暂无未下单卡点";
        return [
          `Page: ${pageName}`,
          `日期: ${date}`,
          "",
          `PM 人数: ${report?.pm ?? 0}`,
          `Pending: ${report?.pending ?? 0}`,
          `After Payment: ${report?.orders ?? 0}`,
          `有互动: ${report?.active ?? 0}`,
          "",
          "Inbox 总结:",
          report?.summary || "这一天还没有保存报告。",
          "",
          "未下单卡点:",
          blockers
        ].join("\n");
      };
      const allPages = url.searchParams.get("all") === "1";
      const pageName = (url.searchParams.get("page") || account.name).trim() || account.name;
      const content = allPages
        ? Object.entries(ACCOUNTS).map(([accountId, item]) => formatPage(accountId, item.name)).join("\n\n====================\n\n")
        : formatPage(account.id, pageName);
      const safeName = allPages ? "Three-Pages" : pageName.replace(/[\\/:*?\"<>|]/g, "-");
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${safeName}-${date}-Inbox-Report.txt`)}`,
        "Cache-Control": "no-store"
      });
      return res.end(content);
    }

    if (url.pathname === "/api/whatsapp-report" && req.method === "GET") {
      const date = url.searchParams.get("date") || "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(res, 400, { error: "Valid date required" });
      const reports = await readReports();
      const content = buildCombinedReport(reports, date);
      const whatsappUrl = `https://web.whatsapp.com/send?phone=60129676255&text=${encodeURIComponent(content)}`;
      res.writeHead(302, {
        Location: whatsappUrl,
        "Cache-Control": "no-store"
      });
      return res.end();
    }

    if (url.pathname === "/api/order-sheet-url" && req.method === "GET") {
      return json(res, 200, { url: currentOrderSheetUrl() });
    }

    if (url.pathname === "/api/broadcast-sheet-url" && req.method === "GET") {
      return json(res, 200, { url: broadcastSheetUrl() });
    }

    if (url.pathname === "/api/broadcast-sheet-config" && req.method === "GET") {
      const month = url.searchParams.get("month") || "";
      const result = await readBroadcastSheetConfig(month);
      return json(res, 200, result);
    }

    if (url.pathname === "/api/broadcast-sheet-config" && req.method === "POST") {
      const request = await readBody(req);
      const result = await writeBroadcastSheetConfig(request);
      return json(res, 200, result);
    }

    if (url.pathname === "/api/broadcast-plans" && req.method === "GET") {
      const month = url.searchParams.get("month") || "";
      const result = await readBroadcastPlans(month);
      return json(res, 200, result);
    }

    if (url.pathname === "/api/broadcast-tracking" && req.method === "GET") {
      const result = await readBroadcastTracking({
        page: url.searchParams.get("page") || "",
        manychat_page_id: url.searchParams.get("manychat_page_id") || "",
        search: url.searchParams.get("search") || "",
        date_from: url.searchParams.get("date_from") || "",
        date_to: url.searchParams.get("date_to") || ""
      });
      return json(res, 200, result);
    }

    if (url.pathname === "/api/broadcast-campaign" && req.method === "POST") {
      const request = await readBody(req);
      const result = await writeBroadcastTrackingEvent("broadcast_campaign", request);
      return json(res, 200, result);
    }

    if (url.pathname === "/api/order-entry" && req.method === "POST") {
      const request = await readBody(req);
      const batchEntries = Array.isArray(request.entries) ? request.entries : (Array.isArray(request.orders) ? request.orders : null);
      if (batchEntries) {
        const result = await writeOrderEntries(batchEntries);
        return json(res, 200, {
          ok: !result.errors.length,
          partial: Boolean(result.errors.length),
          entries: result.entries,
          entry: result.entries[0] || null,
          errors: result.errors,
          sheetUrl: currentOrderSheetUrl()
        });
      }
      if (!request.order || typeof request.order !== "object") {
        return json(res, 400, { ok: false, error: "Order data required" });
      }
      const entry = await writeOrderEntry({
        page: request.page || "",
        raw: request.raw || "",
        order: request.order
      });
      return json(res, 200, { ok: true, entry, sheetUrl: currentOrderSheetUrl() });
    }

    if (url.pathname === "/api/order-entries" && req.method === "GET") {
      const date = url.searchParams.get("date") || new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kuala_Lumpur", year: "numeric", month: "2-digit", day: "2-digit"
      }).format(new Date());
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(res, 400, { ok: false, error: "Valid date required" });
      const result = await readOrderEntries(date);
      return json(res, 200, result);
    }

    if (url.pathname === "/api/order-entry/date" && req.method === "POST") {
      const request = await readBody(req);
      if (!request.row || !request.newDate) {
        return json(res, 400, { ok: false, error: "Order row and new date required" });
      }
      const entry = await updateOrderEntryDate(request);
      return json(res, 200, { ok: true, entry, sheetUrl: currentOrderSheetUrl() });
    }

    if (url.pathname === "/api/order-entry/update" && req.method === "POST") {
      const request = await readBody(req);
      if (!request.row || !request.order || typeof request.order !== "object") {
        return json(res, 400, { ok: false, error: "Order row and order data required" });
      }
      const entry = await updateOrderEntry(request);
      return json(res, 200, { ok: true, entry, sheetUrl: currentOrderSheetUrl() });
    }

    if (url.pathname === "/api/order-entry/delete" && req.method === "POST") {
      const request = await readBody(req);
      if (!request.row) {
        return json(res, 400, { ok: false, error: "Order row required" });
      }
      const entry = await deleteOrderEntry(request);
      return json(res, 200, { ok: true, entry, sheetUrl: currentOrderSheetUrl() });
    }

    if (url.pathname === "/api/broadcast-plan" && req.method === "POST") {
      const request = await readBody(req);
      if (!request.plan || typeof request.plan !== "object") {
        return json(res, 400, { ok: false, error: "Broadcast plan data required" });
      }
      const result = await writeBroadcastPlan({
        action: request.action || "update",
        month: request.month || "",
        plan: request.plan
      });
      return json(res, 200, { ok: true, result, sheetUrl: broadcastSheetUrl() });
    }

    if ((url.pathname === "/api/manychat/broadcast-campaign" || url.pathname === "/api/manychat/broadcast-lead" || url.pathname === "/api/manychat/broadcast-order") && req.method === "POST") {
      const suppliedKey = url.searchParams.get("key") || req.headers["x-ingest-key"] || "";
      if (EVENT_INGEST_SECRET && suppliedKey !== EVENT_INGEST_SECRET) {
        return json(res, 401, { ok: false, error: "Unauthorized" });
      }
      const request = await readBody(req);
      const eventType = url.pathname.endsWith("broadcast-campaign")
        ? "broadcast_campaign"
        : url.pathname.endsWith("broadcast-lead")
          ? "broadcast_lead"
          : "broadcast_order";
      const result = await writeBroadcastTrackingEvent(eventType, request);
      return json(res, 200, result);
    }

    if (url.pathname === "/api/live" && req.method === "GET") {
      const date = url.searchParams.get("date") || new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kuala_Lumpur", year: "numeric", month: "2-digit", day: "2-digit"
      }).format(new Date());
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(res, 400, { error: "Valid date required" });
      const reports = await readReports();
      const baseReport = reports[account.id]?.[date] || null;
      if (isManualConfirmedReport(baseReport)) {
        return json(res, 200, { connected: true, account: account.id, report: baseReport });
      }
      const live = await readWebhookReport(account.id, date);
      const merged = mergeWebhookReport(baseReport, live, account.id);
      let report = merged.report || baseReport || null;
      if (report) {
        const events = await readEvents();
        report = mergeReportWithoutDowngrade(baseReport, report);
        report = removePendingCompletedLater(report, events, account.id, date);
        report = await enrichReportWithManyChatContacts(report, account.id, date);
      }
      return json(res, 200, { connected: true, account: account.id, report });
    }

    if (url.pathname === "/api/manychat-event" && req.method === "POST") {
      const suppliedKey = url.searchParams.get("key") || req.headers["x-ingest-key"] || "";
      if (EVENT_INGEST_SECRET && suppliedKey !== EVENT_INGEST_SECRET) {
        return json(res, 401, { ok: false, error: "Unauthorized" });
      }
      const raw = await readBody(req);
      const event = normalizeManyChatEvent(raw, account.id);
      if (!event.account || !ACCOUNTS[event.account]) return json(res, 400, { ok: false, error: "Valid account required" });
      if (!event.event_type) return json(res, 400, { ok: false, error: "event_type required" });
      let webhook = null;
      if (env.WEBHOOK_URL && env.EVENT_INGEST_KEY) {
        webhook = await forwardManyChatEventToWebhook(raw, event);
      }
      await appendFile(EVENTS_FILE, `${JSON.stringify(event)}\n`).catch(() => null);
      return json(res, 202, { ok: true, accepted: true, event: {
        id: event.id, account: event.account, date: event.date, event_type: event.event_type, contact: event.contact
      }, webhook });
    }

    if (url.pathname === "/api/rebuild-report" && req.method === "POST") {
      const request = await readBody(req);
      const date = request.date || klDate();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(res, 400, { ok: false, error: "Valid date required" });
      const requestedAccount = request.account || url.searchParams.get("account") || account.id;
      const targets = Array.isArray(request.accounts) && request.accounts.length
        ? request.accounts.filter(id => ACCOUNTS[id])
        : [requestedAccount].filter(id => ACCOUNTS[id]);
      const events = await readEvents();
      const reports = await readReports();
      const results = {};
      for (const accountId of targets) {
        reports[accountId] ||= {};
        if (isManualConfirmedReport(reports[accountId][date]) && !request.forceConfirmedOverwrite) {
          results[accountId] = {
            skipped: false,
            report: reports[accountId][date],
            protected: true,
            eventCount: events.filter(event => event.account === accountId && event.date === date).length,
            webhookCount: 0,
            webhookError: ""
          };
          continue;
        }
        const eventResult = buildReportFromEvents(events, accountId, date, reports[accountId][date] || null);
        let skipped = eventResult.skipped;
        let report = eventResult.report;
        let webhookCount = 0;
        let webhookError = "";
        try {
          const live = await readWebhookReport(accountId, date);
          const liveResult = mergeWebhookReport(skipped ? null : report, live, accountId);
          webhookCount = ["pm", "pending", "after_payment", "active", "customer_message", "page_reply"]
            .reduce((sum, key) => sum + Number(live?.counts?.[key] || 0), 0) + (Array.isArray(live?.events) ? live.events.length : 0);
          if (!liveResult.skipped) {
            skipped = false;
            report = liveResult.report;
          }
        } catch (error) {
          webhookError = error.message || "Webhook read failed";
        }
        if (!skipped && report) {
          report = mergeReportWithoutDowngrade(reports[accountId][date] || null, report);
          report = removePendingCompletedLater(report, events, accountId, date);
          report = await enrichReportWithManyChatContacts(report, accountId, date);
        }
        if (!skipped && report) reports[accountId][date] = report;
        results[accountId] = {
          skipped,
          report: reports[accountId][date] || null,
          eventCount: events.filter(event => event.account === accountId && event.date === date).length,
          webhookCount,
          webhookError
        };
      }
      await writeReports(reports);
      return json(res, 200, { ok: true, date, results });
    }

    if (url.pathname === "/api/setup/manychat" && req.method === "GET") {
      const base = `${req.headers["x-forwarded-proto"] || "http"}://${req.headers.host}`;
      return json(res, 200, {
        endpoint: `${base}/api/manychat-event?account=${account.id}&key=YOUR_EVENT_KEY`,
        account: { id: account.id, name: account.name },
        eventTypes: [
          "pm_subscribed",
          "customer_message",
          "page_reply",
          "pending_added",
          "after_payment",
          "tag_added"
        ],
        exampleBody: {
          account: account.id,
          event_type: "customer_message",
          occurred_at: "{{now}}",
          contact: "{Full Contact Data}",
          text: "{{last_text_input}}",
          source: "flow_or_keyword_name",
          tags: ["{{tag.name}}"]
        },
        templates: {
          pmSubscribed: {
            event_type: "pm_subscribed",
            account: account.id,
            contact: "{Full Contact Data}",
            text: "广告入口 / Subscribed 当日",
            source: "default_reply_or_entry_flow"
          },
          customerMessage: {
            event_type: "customer_message",
            account: account.id,
            contact: "{Full Contact Data}",
            text: "{{last_text_input}}",
            source: "keyword_or_user_input",
            blocker: ""
          },
          blockerCategory: {
            event_type: "customer_message",
            account: account.id,
            contact: "{Full Contact Data}",
            text: "{{last_text_input}}",
            source: "ai_or_manual_category",
            blocker: "price_concern"
          },
          pageReply: {
            event_type: "page_reply",
            account: account.id,
            contact: "{Full Contact Data}",
            text: "",
            source: "admin_reply"
          },
          pending: {
            event_type: "pending_added",
            account: account.id,
            contact: "{Full Contact Data}",
            source: "pending_payment_flow"
          },
          afterPayment: {
            event_type: "after_payment",
            account: account.id,
            contact: "{Full Contact Data}",
            source: "after_payment_flow"
          }
        }
      });
    }

    if (url.pathname === "/api/run-request" && req.method === "POST") {
      const request = await readBody(req);
      const date = request.date || url.searchParams.get("date") || klDate();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(res, 400, { ok: false, error: "Valid date required" });
      const requestedAccount = request.account || url.searchParams.get("account") || account.id;
      const targets = Array.isArray(request.accounts) && request.accounts.length
        ? request.accounts.filter(id => ACCOUNTS[id])
        : [requestedAccount].filter(id => ACCOUNTS[id]);
      const events = await readEvents();
      const reports = await readReports();
      const results = {};
      for (const accountId of targets) {
        reports[accountId] ||= {};
        if (isManualConfirmedReport(reports[accountId][date]) && !request.forceConfirmedOverwrite) {
          results[accountId] = reports[accountId][date];
          continue;
        }
        const eventResult = buildReportFromEvents(events, accountId, date, reports[accountId][date] || null);
        let skipped = eventResult.skipped;
        let report = eventResult.report;
        try {
          const live = await readWebhookReport(accountId, date);
          const liveResult = mergeWebhookReport(skipped ? null : report, live, accountId);
          if (!liveResult.skipped) {
            skipped = false;
            report = liveResult.report;
          }
        } catch (error) {
          if (!report) results[accountId] = { error: error.message || "Webhook read failed" };
        }
        if (!skipped && report) {
          report = mergeReportWithoutDowngrade(reports[accountId][date] || null, report);
          report = removePendingCompletedLater(report, events, accountId, date);
          report = await enrichReportWithManyChatContacts(report, accountId, date);
          reports[accountId][date] = report;
          results[accountId] = report;
        } else if (!results[accountId]) {
          results[accountId] = reports[accountId][date] || null;
        }
      }
      await writeReports(reports);
      return json(res, 200, { ok: true, accepted: true, date, results });
    }

    if (url.pathname === "/api/run-request" && req.method === "GET") {
      const text = await readFile(RUN_REQUESTS_FILE, "utf8").catch(error => error.code === "ENOENT" ? "" : Promise.reject(error));
      const records = text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
      const completed = new Set(records.filter(item => item.status === "completed").map(item => item.id));
      return json(res, 200, { requests: records.filter(item => item.status === "pending_inbox_scan" && !completed.has(item.id)) });
    }

    if (url.pathname === "/api/run-request/complete" && req.method === "POST") {
      const request = await readBody(req);
      if (!request.id) return json(res, 400, { error: "id required" });
      const record = { id: request.id, completed_at: new Date().toISOString(), status: "completed" };
      await appendFile(RUN_REQUESTS_FILE, `${JSON.stringify(record)}\n`);
      return json(res, 200, { completed: true, request: record });
    }

    if (url.pathname === "/api/contact" && req.method === "GET") {
      const id = url.searchParams.get("id");
      if (!id || !/^\d+$/.test(id)) return json(res, 400, { error: "Valid contact id required" });
      const contact = await manychat(account, `/fb/subscriber/getInfo?subscriber_id=${encodeURIComponent(id)}`);
      return json(res, 200, { contact });
    }

    if (url.pathname === "/api/events" && req.method === "POST") {
      const suppliedKey = url.searchParams.get("key") || req.headers["x-ingest-key"] || "";
      if (EVENT_INGEST_SECRET && suppliedKey !== EVENT_INGEST_SECRET) {
        return json(res, 401, { ok: false, error: "Unauthorized" });
      }
      const raw = await readBody(req);
      const eventType = raw.event_type || raw.type || url.searchParams.get("event_type") || "";
      if (!eventType) return json(res, 400, { ok: false, error: "event_type required" });
      const normalizedRaw = { ...raw, event_type: eventType, account: raw.account || url.searchParams.get("account") || account.id };
      const event = normalizeManyChatEvent(normalizedRaw, account.id);
      if (!event.account || !ACCOUNTS[event.account]) return json(res, 400, { ok: false, error: "Valid account required" });
      let webhook = null;
      if (env.WEBHOOK_URL && env.EVENT_INGEST_KEY) {
        webhook = await forwardManyChatEventToWebhook(normalizedRaw, event);
      }
      await appendFile(EVENTS_FILE, `${JSON.stringify(event)}\n`).catch(() => null);
      return json(res, 202, { ok: true, accepted: true, event: {
        id: event.id, account: event.account, date: event.date, event_type: event.event_type, contact: event.contact
      }, webhook });
    }

    if (url.pathname === "/api/events") {
      return json(res, 202, { ok: true, accepted: true, note: "Event endpoint is reachable. Use POST with event_type to save events." });
    }

    if (url.pathname === "/favicon.ico") {
      res.writeHead(204, { "Cache-Control": "public, max-age=86400" });
      return res.end();
    }

    const embedded = url.searchParams.get("embedded") === "1";
    if (!embedded && ["/index.html", "/order-key-in.html", "/broadcast-planning.html", "/broadcast-tracking.html"].includes(url.pathname)) {
      const next = new URL(url);
      next.pathname = "/";
      next.searchParams.delete("embedded");
      if (url.pathname === "/order-key-in.html") next.searchParams.set("view", "order-key-in");
      else if (url.pathname === "/broadcast-planning.html") next.searchParams.set("view", "broadcast-planning");
      else if (url.pathname === "/broadcast-tracking.html") next.searchParams.set("view", "broadcast-tracking");
      else next.searchParams.set("view", next.searchParams.get("account") ? "analysis-account" : "analysis-overview");
      res.writeHead(302, { Location: `${next.pathname}${next.search}` });
      return res.end();
    }
    const routeFiles = {
      "/": "dashboard.html",
      "/dashboard": "dashboard.html",
      "/index": embedded ? "index.html" : "dashboard.html",
      "/index.html": embedded ? "index.html" : "dashboard.html",
      "/order-key-in": embedded ? "order-key-in.html" : "dashboard.html",
      "/order-key-in.html": embedded ? "order-key-in.html" : "dashboard.html",
      "/broadcast-planning": embedded ? "broadcast-planning.html" : "dashboard.html",
      "/broadcast-planning.html": embedded ? "broadcast-planning.html" : "dashboard.html",
      "/broadcast-tracking": embedded ? "broadcast-tracking.html" : "dashboard.html",
      "/broadcast-tracking.html": embedded ? "broadcast-tracking.html" : "dashboard.html",
      "/manychat-setup": "manychat-setup.html",
      "/auth-client.js": "auth-client.js"
    };
    const requested = routeFiles[url.pathname] || url.pathname.slice(1);
    const file = normalize(join(ROOT, requested));
    if (!file.startsWith(ROOT)) return json(res, 403, { error: "Forbidden" });
    const content = await readFile(file);
    res.writeHead(200, { "Content-Type": mime[extname(file)] || "application/octet-stream" });
    res.end(content);
  } catch (error) {
    if (error.code === "ENOENT") return json(res, 404, { error: "Not found" });
    json(res, 500, { error: error.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Scale Story dashboard: http://127.0.0.1:${PORT}`);
});
