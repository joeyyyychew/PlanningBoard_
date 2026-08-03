import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const files = [
  "dashboard.html",
  "dashboard-shell.css",
  "dashboard-shell.js",
  "login.html",
  "auth-client.js",
  "index.html",
  "order-key-in.html",
  "broadcast-planning.html",
  "manychat-setup.html",
  "theme-luxe.css",
  "sidebar-unified.css",
  "embedded-frame.css",
  "date-picker-unified.js",
  "custom-select.js"
];

const optionalJsonFiles = {
  "data/reports.json": {}
};

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

function extname(path) {
  const i = path.lastIndexOf(".");
  return i >= 0 ? path.slice(i) : "";
}

function publicPath(path) {
  if (path === "index.html") return "/index.html";
  return `/${path}`;
}

const assets = {};
for (const file of files) {
  const body = await readFile(file, "utf8");
  assets[publicPath(file)] = {
    mime: mime[extname(file)] || "application/octet-stream",
    body
  };
}

for (const [file, fallback] of Object.entries(optionalJsonFiles)) {
  let body;
  try {
    body = await readFile(file, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    body = JSON.stringify(fallback);
  }
  assets[publicPath(file)] = {
    mime: "application/json; charset=utf-8",
    body
  };
}

const reports = JSON.parse(assets["/data/reports.json"]?.body || "{}");

const worker = String.raw`const ASSETS = ${JSON.stringify(assets)};
const REPORTS = ${JSON.stringify(reports)};
const ACCOUNTS = {
  fb108701968299986: { name: "Scalestory - 天然胶原蛋白", inbox: "https://app.manychat.com/fb108701968299986/chat", tags: { pending: ["PENDING"], afterPayment: [] } },
  fb1177107122151553: { name: "鳞记 - 天然胶原蛋白", inbox: "https://app.manychat.com/fb1177107122151553/chat", tags: { pending: ["PENDING", "Pending"], afterPayment: [] } },
  fb701760706347255: { name: "鳞记 SG", inbox: "https://app.manychat.com/fb701760706347255/chat", tags: { pending: ["Pending Payment 【SG】"], afterPayment: [] } }
};
const ORDER_SHEET_URL = "https://docs.google.com/spreadsheets/d/1py5YznTXAD6TU9onEaa12MXWhLCUngQ5PDSTfD4Q_JQ/edit";
const BROADCAST_SHEET_URL = "https://docs.google.com/spreadsheets/d/1kyNfmPbTQ39Bg5Nn2Eqtz5r-x7cdYmcM7dd6XZT8bwU/edit?gid=1673664470#gid=1673664470";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, X-Ingest-Key",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
    }
  });
}

function parseCookies(header = "") {
  return Object.fromEntries(String(header).split(";").map(part => {
    const i = part.indexOf("=");
    if (i < 0) return null;
    return [part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim())];
  }).filter(Boolean));
}

function authEnabled(env = {}) {
  return /^(1|true|yes)$/i.test(env.AUTH_ENABLED || "") || Boolean(env.AUTH_PASSWORD || env.AUTH_PASSWORD_HASH);
}

async function sha256(value = "") {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function authCookie(value, maxAge = 604800) {
  return "scale_story_session=" + encodeURIComponent(value) + "; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=" + maxAge;
}

function publicAuthPath(pathname) {
  return pathname === "/login" ||
    pathname === "/login.html" ||
    pathname === "/api/auth/status" ||
    pathname === "/api/auth/login" ||
    pathname === "/api/auth/logout" ||
    pathname === "/api/manychat-event" ||
    pathname === "/api/events" ||
    pathname === "/favicon.ico";
}

async function signedSession(env = {}, expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000) {
  const secret = env.AUTH_SESSION_SECRET || env.AUTH_PASSWORD || env.EVENT_INGEST_KEY || "scale-story-dashboard";
  const signature = await sha256(String(expiresAt) + "|" + secret);
  return String(expiresAt) + ":" + signature;
}

async function isAuthenticated(request, env = {}) {
  if (!authEnabled(env)) return true;
  const token = parseCookies(request.headers.get("cookie") || "").scale_story_session || "";
  const [expiresAt, signature] = token.split(":");
  if (!expiresAt || !signature || Number(expiresAt) < Date.now()) return false;
  return signature === await signedSession(env, Number(expiresAt)).then(value => value.split(":")[1]);
}

async function checkPassword(env = {}, password = "") {
  const configuredHash = String(env.AUTH_PASSWORD_HASH || "").replace(/^sha256:/, "").trim().toLowerCase();
  if (configuredHash) return await sha256(password) === configuredHash;
  return Boolean(env.AUTH_PASSWORD) && password === env.AUTH_PASSWORD;
}

async function requireAuth(request, env, url) {
  if (!authEnabled(env) || publicAuthPath(url.pathname) || await isAuthenticated(request, env)) return null;
  if (url.pathname.startsWith("/api/")) return json({ ok: false, error: "Login required" }, 401);
  return new Response(null, {
    status: 302,
    headers: { Location: "/login?next=" + encodeURIComponent(url.pathname + url.search) }
  });
}

function accountFrom(url) {
  const id = url.searchParams.get("account") || "fb108701968299986";
  return ACCOUNTS[id] ? { id, ...ACCOUNTS[id] } : { id: "fb108701968299986", ...ACCOUNTS.fb108701968299986 };
}

function manychatKeyFor(env = {}, accountId = "") {
  if (accountId === "fb1177107122151553") return env.MANYCHAT_API_KEY_FB1177107122151553 || "";
  if (accountId === "fb701760706347255") return env.MANYCHAT_API_KEY_FB701760706347255 || "";
  return env.MANYCHAT_API_KEY || "";
}

function serveAsset(pathname) {
  const url = new URL("https://local" + pathname);
  const embedded = url.searchParams.get("embedded") === "1";
  const cleanPathname = url.pathname;
  if (cleanPathname === "/favicon.ico") {
    return new Response("", { status: 204, headers: { "Cache-Control": "public, max-age=86400" } });
  }
  if (!embedded && ["/index.html", "/order-key-in.html", "/broadcast-planning.html"].includes(cleanPathname)) {
    url.pathname = "/";
    url.searchParams.delete("embedded");
    if (cleanPathname === "/order-key-in.html") url.searchParams.set("view", "order-key-in");
    else if (cleanPathname === "/broadcast-planning.html") url.searchParams.set("view", "broadcast-planning");
    else url.searchParams.set("view", url.searchParams.get("account") ? "analysis-account" : "analysis-overview");
    return new Response(null, {
      status: 302,
      headers: { Location: url.pathname + url.search }
    });
  }
  const routes = {
    "/": "/dashboard.html",
    "/dashboard": "/dashboard.html",
    "/index": embedded ? "/index.html" : "/dashboard.html",
    "/index.html": embedded ? "/index.html" : "/dashboard.html",
    "/order-key-in": embedded ? "/order-key-in.html" : "/dashboard.html",
    "/order-key-in.html": embedded ? "/order-key-in.html" : "/dashboard.html",
    "/broadcast-planning": embedded ? "/broadcast-planning.html" : "/dashboard.html",
    "/broadcast-planning.html": embedded ? "/broadcast-planning.html" : "/dashboard.html",
    "/manychat-setup": "/manychat-setup.html"
  };
  const clean = routes[cleanPathname] || cleanPathname;
  const asset = ASSETS[clean] || ASSETS["/index.html"];
  return new Response(asset.body, {
    headers: {
      "Content-Type": asset.mime,
      "Cache-Control": clean.endsWith(".css") ? "public, max-age=300" : "no-store"
    }
  });
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
  return String(value || "").match(/app\.manychat\.com\/fb\d+\/chat\/(\d+)/)?.[1] || "";
}

function contactId(source = {}) {
  const contact = source.contact || source.subscriber || source.user || {};
  const inbox = firstRealValue(source.inbox, source.inbox_url, source.live_chat_url, contact.inbox, contact.inbox_url, contact.live_chat_url);
  return firstRealValue(source.contact_id, source.subscriber_id, source.manychat_contact_id, source.id, contact.id, contact.contact_id, contact.subscriber_id, extractChatIdFromUrl(inbox));
}

function isButtonLike(text = "") {
  const plain = String(text || "").replace(/[👉🏻👉🏼🌟⚡️🌹😍✨🎬🦐🔵🟢🟠🔴【】"'「」]/g, "").trim();
  return !plain ||
    /^whatsapp_message$/i.test(plain) ||
    /^default_reply_contact$/i.test(plain) ||
    /^(\d+|A|B|C)$/i.test(plain) ||
    /^西马\s*\/\s*东马$/i.test(plain) ||
    /contact tapped|quick reply|follow the link/i.test(plain) ||
    /^(我想了解更多.*|我想了解(养颜|护膝|护肤|关节)?系列～?|开始了解鳞记鱼鳞冻|了解这个月配套|can share more info\??|can i make a purchase\??|能帮我查看一件商品的价格吗？?|我要了解最新优惠|了解collagen drink|我要免费试吃|新品荔枝玫瑰|rm 1promotion|5月闪电优惠|西马|东马|新加坡|马来西亚|west malaysia|east malaysia|singapore|sg)$/i.test(plain);
}

function isSyntheticPerson(person = {}) {
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

function isAudio(value = "") {
  return /\.(ogg|mp3|m4a|wav|aac)(\?|$)/i.test(String(value || "")) || /audioclip|voice/i.test(String(value || ""));
}

function displayText(value = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  return isAudio(text) ? "语音" : text;
}

function uniquePeople(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = personKey(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
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
  const aKeys = personKeys(a);
  const bKeys = new Set(personKeys(b));
  return aKeys.some(key => bKeys.has(key));
}

function personFromWebhook(person = {}, accountId, fallbackNote = "") {
  const id = contactId(person);
  const name = firstRealValue(person.name, person.full_name, person.contact_name, id) || "Unknown";
  const directInbox = /^\d+$/.test(id) ? "https://app.manychat.com/" + accountId + "/chat/" + id : "";
  const suppliedInbox = person.inbox || person.inbox_url || person.live_chat_url || "";
  return {
    id: id || name,
    name,
    note: displayText(person.note || person.text || person.message || person.last_text_input || fallbackNote),
    tags: Array.isArray(person.tags) ? person.tags : [],
    inbox: directInbox || suppliedInbox || ACCOUNTS[accountId]?.inbox || ""
  };
}

function blockerFromText(text = "") {
  const t = String(text || "");
  if (isAudio(t) || t === "语音") return { title: "语音留言 / 需要人工听", detail: "顾客发了语音，Dashboard 暂时不能辨别内容，需要人工听完再 follow up。" };
  if (/多少钱|价钱|价格|一盒多少|cost|price|RM|盒|package|配套|atome|贵|便宜|优惠/i.test(t)) return { title: "价格 / 配套不清楚", detail: "顾客主要在问价格、盒数、优惠或付款配套，需要更直接给下单选项。" };
  if (/糖尿病|手术|可以吃|品质|颜色|味道|适合|副作用|health|效果|多久|关节|皮肤|胶原/i.test(t)) return { title: "产品顾虑 / 身体状况", detail: "顾客在确认效果、适不适合自己、品质或身体状况，需要安心解释和给例子。" };
  if (/门店|地址|包邮|邮寄|快递|shopee|cod|货到付款|shipping|delivery|平台|bank/i.test(t)) return { title: "地点 / 邮寄 / 平台问题", detail: "顾客在问门店、邮寄、Shopee、COD 或付款方式相关问题。" };
  return { title: "犹豫中 / 需要 follow up", detail: "顾客有实际回应但还没明确下单，需要轻 follow up。" };
}

function reportFromWebhook(live, accountId, fallback = null) {
  if (fallback?.manualConfirmed) return fallback;
  const counts = live?.counts || {};
  const contacts = live?.contacts || {};
  const events = Array.isArray(live?.events) ? live.events : [];
  const hasData = Boolean(live?.updated_at) || events.length || Object.values(counts).some(value => Number(value || 0) > 0);
  if (!hasData) return fallback || null;
  const pm = uniquePeople([...(contacts.pm || []), ...(contacts.new_pm || []), ...(contacts.pm_subscribed || [])].map(person => personFromWebhook(person, accountId, "Subscribed on 当日")).filter(person => !isSyntheticPerson(person)));
  const pending = uniquePeople([...(contacts.pending || [])].map(person => personFromWebhook(person, accountId, "今天加入 Pending")).filter(person => !isSyntheticPerson(person)));
  const orders = uniquePeople([...(contacts.after_payment || [])].map(person => personFromWebhook(person, accountId, "完成订单 / After Payment")).filter(person => !isSyntheticPerson(person)));
  const activeFromContacts = [...(contacts.active || []), ...(contacts.customer_message || [])]
    .map(person => personFromWebhook(person, accountId))
    .filter(person => !isSyntheticPerson(person) && person.note && !isButtonLike(person.note));
  const activeFromEvents = events
    .filter(event => String(event.type || "").toLowerCase().replace(/[ -]+/g, "_") === "customer_message")
    .map(event => personFromWebhook({ id: event.contact_id, name: event.name, inbox: event.inbox, text: event.text, tags: event.tags }, accountId))
    .filter(person => !isSyntheticPerson(person) && person.note && !isButtonLike(person.note));
  const active = uniquePeople([...activeFromContacts, ...activeFromEvents]);
  const pendingAfterOrders = pending.filter(person => !orders.some(order => samePerson(person, order)));
  const afterPaymentCount = Number(counts.after_payment || 0);
  const eventsByType = (type) => events.filter(event => String(event.type || "").toLowerCase().replace(/[ -]+/g, "_") === type);
  const pmEventTotal = eventsByType("pm_subscribed").length +
    eventsByType("pm").length +
    eventsByType("new_pm").length +
    eventsByType("subscribed").length +
    eventsByType("new_contact").length +
    eventsByType("subscriber_created").length;
  const afterPaymentEventTotal = eventsByType("after_payment").length +
    eventsByType("ao").length +
    eventsByType("order_completed").length +
    eventsByType("completed_order").length;
  const pmEventCount = Number(counts.pm || 0) +
    Number(counts.new_pm || 0) +
    Number(counts.pm_subscribed || 0) +
    (contacts.pm || []).length +
    (contacts.new_pm || []).length +
    (contacts.pm_subscribed || []).length +
    pm.length;
  const trackedActivityCount = events.length +
    Number(counts.customer_message || 0) +
    Number(counts.active || 0) +
    Number(counts.pending || 0) +
    Number(counts.after_payment || 0);
  const syncWarnings = [];
  if (trackedActivityCount > 0 && pmEventCount === 0) {
    syncWarnings.push("PM 事件还没有接上：这个 Channel 有收到 ManyChat 事件，但没有收到 Subscribed on / PM 名单，所以 RUN 不能准确统计当日 PM 人数。请在顾客进入的 Default Reply / 入口 Flow 加 pm_subscribed External Request。");
  }
  if (afterPaymentCount > orders.length) {
    syncWarnings.push("After Payment 收到 " + afterPaymentCount + " 个事件，但只有 " + orders.length + " 位顾客名单；请检查 ManyChat External Request 是否有带 contact_id/name/inbox。");
  }
  if (pmEventTotal > pm.length) {
    syncWarnings.push("PM 收到 " + pmEventTotal + " 个入口事件，但只有 " + pm.length + " 位有效顾客名单；目前人数先按 event 统计，名单/inbox 需要 ManyChat External Request 带真实 contact_id/name。");
  }
  const blockerMap = new Map();
  active.forEach(person => {
    if (orders.some(order => samePerson(person, order))) return;
    const blocker = blockerFromText(person.note);
    if (!blockerMap.has(blocker.title)) blockerMap.set(blocker.title, { ...blocker, count: 0, people: [] });
    const item = blockerMap.get(blocker.title);
    item.count += 1;
    item.people.push(person.name);
  });
  const blockers = [...blockerMap.values()].sort((a, b) => b.count - a.count);
  const pmTags = {
    collagenDrinks: Number(counts.collagen_drinks || 0),
    freeTesting: Number(counts.free_testing || 0),
    dontDisturb: Number(counts.dont_disturb || 0)
  };
  return {
    pm: Math.max(pm.length, pmEventTotal),
    pending: pendingAfterOrders.length,
    active: active.length,
    orders: Math.max(orders.length, afterPaymentEventTotal),
    pmTags,
    customers: { pm, pending: pendingAfterOrders, active, orders },
    syncWarnings,
    blockers,
    summary: blockers.length
      ? "今天顾客主要卡在：" + blockers.map(item => item.title + " " + item.count + " 位").join("、") + "。" + (orders.length ? "已有 " + orders.length + " 位完成订单。" : "") + (pendingAfterOrders.length ? "还有 " + pendingAfterOrders.length + " 位 Pending 需要跟进。" : "")
      : "今天暂时没有从事件资料里看到明显未下单卡点。" + (orders.length ? "已有 " + orders.length + " 位完成订单。" : ""),
    status: "Webhook Report",
    lastUpdated: live.updated_at || new Date().toISOString(),
    source: "manychat_webhook"
  };
}

async function readWebhookReport(env, accountId, date) {
  const fallback = REPORTS[accountId]?.[date] || null;
  if (fallback?.manualConfirmed) return fallback;
  if (!env.WEBHOOK_URL || !env.EVENT_INGEST_KEY || !date) return null;
  const endpoint = new URL(env.WEBHOOK_URL);
  endpoint.searchParams.set("key", env.EVENT_INGEST_KEY);
  endpoint.searchParams.set("account", accountId);
  endpoint.searchParams.set("date", date);
  const response = await fetch(endpoint, { redirect: "follow" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) throw new Error(body.error || "Webhook " + response.status);
  return reportFromWebhook(body.report, accountId, fallback);
}

async function readOrderEntries(env, date) {
  if (!env.WEBHOOK_URL || !env.EVENT_INGEST_KEY) return { ok: false, error: "Hosted Google Sheet webhook 尚未连接。" };
  const endpoint = new URL(env.WEBHOOK_URL);
  endpoint.searchParams.set("key", env.EVENT_INGEST_KEY);
  endpoint.searchParams.set("action", "order_entries");
  endpoint.searchParams.set("date", date);
  const response = await fetch(endpoint, { redirect: "follow" });
  const result = await response.json().catch(() => ({}));
  if (result.ok && !Array.isArray(result.entries)) {
    return json({ ok: false, error: "Apps Script 还没更新到 Order Records 版本，请重新部署 apps-script-webhook.gs" }, 503);
  }
  return new Response(JSON.stringify(result), {
    status: response.status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

async function readBroadcastPlans(env, month = "") {
  if (!env.WEBHOOK_URL || !env.EVENT_INGEST_KEY) return json({ ok: false, error: "Hosted Google Sheet webhook 尚未连接。" }, 503);
  const endpoint = new URL(env.WEBHOOK_URL);
  endpoint.searchParams.set("key", env.EVENT_INGEST_KEY);
  endpoint.searchParams.set("action", "broadcast_plans");
  if (month) endpoint.searchParams.set("month", month);
  const response = await fetch(endpoint, { redirect: "follow" });
  const result = await response.json().catch(() => ({}));
  if (result.ok && !Array.isArray(result.rows)) {
    return json({ ok: false, error: "Apps Script 还没更新到 Broadcast Planning 读取版本，请重新部署 apps-script-webhook.gs" }, 503);
  }
  return json(result, response.status);
}

async function readBroadcastSheetConfig(env, month = "") {
  if (!env.WEBHOOK_URL || !env.EVENT_INGEST_KEY) return json({ ok: false, error: "Hosted Google Sheet webhook 尚未连接。" }, 503);
  const endpoint = new URL(env.WEBHOOK_URL);
  endpoint.searchParams.set("key", env.EVENT_INGEST_KEY);
  endpoint.searchParams.set("action", "broadcast_sheet_config");
  if (month) endpoint.searchParams.set("month", month);
  const response = await fetch(endpoint, { redirect: "follow" });
  const result = await response.json().catch(() => ({}));
  return json(result, response.status);
}

async function forwardWebhookPost(env, eventType, payload) {
  if (!env.WEBHOOK_URL || !env.EVENT_INGEST_KEY) return json({ ok: false, error: "Hosted Google Sheet webhook 尚未连接。" }, 503);
  const endpoint = new URL(env.WEBHOOK_URL);
  endpoint.searchParams.set("key", env.EVENT_INGEST_KEY);
  const response = await fetch(endpoint, {
    method: "POST",
    redirect: "follow",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event_type: eventType, ...payload })
  });
  const result = await response.json().catch(() => ({}));
  return json(result, response.status);
}

async function forwardManyChatEvent(request, env, url, account) {
  if (!env.WEBHOOK_URL || !env.EVENT_INGEST_KEY) return json({ ok: false, error: "Hosted event database 尚未连接。" }, 503);
  const suppliedKey = url.searchParams.get("key") || request.headers.get("x-ingest-key") || "";
  if (env.EVENT_INGEST_KEY && suppliedKey !== env.EVENT_INGEST_KEY) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }
  const payload = await request.json().catch(() => ({}));
  const accountId = payload.account || url.searchParams.get("account") || account.id;
  if (!ACCOUNTS[accountId]) return json({ ok: false, error: "Valid account required" }, 400);
  const eventType = payload.event_type || url.searchParams.get("event_type") || "";
  if (!eventType) return json({ ok: false, error: "event_type required" }, 400);
  const rawContact = payload.contact || payload.subscriber || payload.user || {};
  const cleanContact = {
    id: firstRealValue(payload.contact_id, payload.subscriber_id, payload.manychat_contact_id, payload.id, rawContact.id, rawContact.contact_id, rawContact.subscriber_id),
    name: firstRealValue(payload.name, payload.contact_name, payload.full_name, rawContact.name, rawContact.full_name),
    phone: firstRealValue(payload.phone, payload.whatsapp_id, payload.wa_id, rawContact.phone, rawContact.whatsapp_id, rawContact.wa_id),
    inbox: firstRealValue(payload.inbox, payload.inbox_url, payload.chat_url, payload.live_chat_url, rawContact.inbox, rawContact.inbox_url, rawContact.live_chat_url)
  };
  return forwardWebhookPost(env, eventType, {
    account: accountId,
    event_type: eventType,
    date: payload.date || payload.event_date,
    event_date: payload.event_date || payload.date,
    occurred_at: payload.occurred_at || payload.event_time || payload.created_at,
    contact: cleanContact,
    contact_id: cleanContact.id,
    name: cleanContact.name,
    phone: cleanContact.phone,
    inbox: cleanContact.inbox,
    text: firstRealValue(payload.text, payload.message, payload.last_text_input, payload.last_input, payload.last_input_text),
    tags: payload.tags || [],
    source: firstRealValue(payload.source, payload.flow, payload.step),
    blocker: firstRealValue(payload.blocker, payload.reason, payload.category)
  });
}

function combinedReport(date) {
  return Object.entries(ACCOUNTS).map(([id, account]) => {
    const report = REPORTS[id]?.[date] || {};
    const blockers = Array.isArray(report.blockers) && report.blockers.length
      ? report.blockers.map(item => "- " + item.title + "（" + item.count + "人）：" + item.detail).join("\\n")
      : "- 暂无未下单卡点";
    return [
      "Page: " + account.name,
      "日期: " + date,
      "",
      "PM 人数: " + (report.pm ?? 0),
      "Pending: " + (report.pending ?? 0),
      "After Payment: " + (report.orders ?? 0),
      "有互动: " + (report.active ?? 0),
      "",
      "Inbox 总结:",
      report.summary || "这一天还没有保存报告。",
      "",
      "未下单卡点:",
      blockers
    ].join("\\n");
  }).join("\\n\\n====================\\n\\n");
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return json({}, 204);
    const url = new URL(request.url);

    if (url.pathname === "/api/auth/status") {
      return json({
        enabled: authEnabled(env),
        authenticated: await isAuthenticated(request, env),
        email: env.AUTH_EMAIL || ""
      });
    }
    if (url.pathname === "/api/auth/login" && request.method === "POST") {
      if (!authEnabled(env)) return json({ ok: false, error: "Login 还没启用：请先设置 AUTH_PASSWORD。" }, 400);
      const payload = await request.json().catch(() => ({}));
      const email = String(payload.email || "").trim().toLowerCase();
      const allowedEmail = String(env.AUTH_EMAIL || "").trim().toLowerCase();
      if (allowedEmail && email !== allowedEmail) return json({ ok: false, error: "Email 不正确。" }, 401);
      if (!await checkPassword(env, String(payload.password || ""))) return json({ ok: false, error: "Password 不正确。" }, 401);
      return new Response(JSON.stringify({ ok: true }), {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "Set-Cookie": authCookie(await signedSession(env))
        }
      });
    }
    if (url.pathname === "/api/auth/logout" && request.method === "POST") {
      return new Response(JSON.stringify({ ok: true }), {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "Set-Cookie": authCookie("", 0)
        }
      });
    }
    if (url.pathname === "/login" || url.pathname === "/login.html") {
      return serveAsset("/login.html");
    }

    const authResponse = await requireAuth(request, env, url);
    if (authResponse) return authResponse;

    const account = accountFrom(url);

    if (url.pathname === "/api/accounts") {
      return json({ accounts: Object.entries(ACCOUNTS).map(([id, item]) => ({ id, name: item.name, inbox: item.inbox, connected: Boolean(manychatKeyFor(env, id)) })) });
    }
    if (url.pathname === "/api/meta") {
      return json({
        connected: Boolean(manychatKeyFor(env, account.id)),
        account: { id: account.id, name: account.name, timezone: "Asia/Kuala_Lumpur" },
        expectedTags: account.tags,
        tags: [],
        fields: []
      });
    }
    if (url.pathname === "/api/reports") {
      const date = url.searchParams.get("date");
      const accountReports = REPORTS[account.id] || {};
      if (date) {
        const liveReport = await readWebhookReport(env, account.id, date).catch(() => null);
        return json({ account: account.id, date, report: liveReport || accountReports[date] || null });
      }
      return json(date ? { account: account.id, date, report: accountReports[date] || null } : { account: account.id, reports: accountReports });
    }
    if (url.pathname === "/api/live") {
      const date = url.searchParams.get("date");
      const liveReport = await readWebhookReport(env, account.id, date).catch(() => null);
      return json({ connected: true, account: account.id, report: liveReport || (date ? (REPORTS[account.id]?.[date] || null) : null) });
    }
    if (url.pathname === "/api/order-sheet-url") return json({ url: ORDER_SHEET_URL });
    if (url.pathname === "/api/broadcast-sheet-url") return json({ url: BROADCAST_SHEET_URL });
    if (url.pathname === "/api/broadcast-sheet-config") {
      if (request.method === "POST") {
        const payload = await request.json().catch(() => ({}));
        return forwardWebhookPost(env, "broadcast_sheet_config", payload);
      }
      const month = url.searchParams.get("month") || "";
      return readBroadcastSheetConfig(env, month);
    }
    if (url.pathname === "/api/order-entries") {
      const date = url.searchParams.get("date") || new Date().toISOString().slice(0, 10);
      return readOrderEntries(env, date);
    }
    if (url.pathname === "/api/broadcast-plans") {
      const month = url.searchParams.get("month") || "";
      return readBroadcastPlans(env, month);
    }
    if (url.pathname === "/api/download-report") {
      const date = url.searchParams.get("date") || new Date().toISOString().slice(0, 10);
      return new Response(combinedReport(date), {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": "attachment; filename=Inbox-Report-" + date + ".txt"
        }
      });
    }
    if (url.pathname === "/api/whatsapp-report") {
      const date = url.searchParams.get("date") || new Date().toISOString().slice(0, 10);
      return Response.redirect("https://web.whatsapp.com/send?phone=60129676255&text=" + encodeURIComponent(combinedReport(date)), 302);
    }
    if (url.pathname === "/api/run-request" && request.method === "POST") {
      const payload = await request.json().catch(() => ({}));
      const date = payload.date || url.searchParams.get("date") || new Date().toISOString().slice(0, 10);
      const requestedAccount = payload.account || url.searchParams.get("account") || account.id;
      const targets = Array.isArray(payload.accounts) && payload.accounts.length
        ? payload.accounts.filter(id => ACCOUNTS[id])
        : [requestedAccount].filter(id => ACCOUNTS[id]);
      const results = {};
      for (const id of targets) {
        const fallback = REPORTS[id]?.[date] || null;
        results[id] = fallback?.manualConfirmed
          ? fallback
          : await readWebhookReport(env, id, date).catch(error => ({ error: error.message || "Webhook read failed" }));
      }
      return json({ ok: true, accepted: true, date, results }, 200);
    }
    if (url.pathname === "/api/events" && request.method === "POST") {
      const suppliedKey = request.headers.get("x-ingest-key") || url.searchParams.get("key") || "";
      if (env.EVENT_INGEST_KEY && suppliedKey !== env.EVENT_INGEST_KEY) {
        return json({ ok: false, error: "Unauthorized" }, 401);
      }
      const payload = await request.json().catch(() => ({}));
      const eventType = payload.event_type || payload.type || url.searchParams.get("event_type") || "";
      if (!eventType) return json({ ok: false, error: "event_type required" }, 400);
      return forwardManyChatEvent(
        new Request(request.url, {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify({ ...payload, event_type: eventType, account: payload.account || account.id })
        }),
        env,
        url,
        account
      );
    }
    if (url.pathname === "/api/events") {
      return json({ ok: true, accepted: true, note: "Event endpoint is reachable. Use POST with event_type to save events." }, 202);
    }
    if (url.pathname === "/api/order-entry/date" && request.method === "POST") {
      const payload = await request.json().catch(() => ({}));
      return forwardWebhookPost(env, "order_update_date", payload);
    }
    if (url.pathname === "/api/order-entry/update" && request.method === "POST") {
      const payload = await request.json().catch(() => ({}));
      return forwardWebhookPost(env, "order_update", payload);
    }
    if (url.pathname === "/api/order-entry/delete" && request.method === "POST") {
      const payload = await request.json().catch(() => ({}));
      return forwardWebhookPost(env, "order_delete", payload);
    }
    if (url.pathname === "/api/order-entry" || url.pathname === "/api/broadcast-plan") {
      const payload = await request.json().catch(() => ({}));
      const eventType = url.pathname === "/api/order-entry" ? "order_entry" : "broadcast_plan_update";
      return forwardWebhookPost(env, eventType, payload);
    }
    if (url.pathname === "/api/manychat-event" && request.method === "POST") {
      return forwardManyChatEvent(request, env, url, account);
    }
    if (url.pathname === "/api/manychat-event") {
      return json({ ok: true, accepted: true, note: "Event endpoint is reachable. Use POST with event_type to save events." }, 202);
    }
    return serveAsset(url.pathname + url.search);
  }
};`;

await mkdir("dist/server", { recursive: true });
await writeFile("dist/server/index.js", worker);
await mkdir("dist/.openai", { recursive: true });
await copyFile(".openai/hosting.json", "dist/.openai/hosting.json");
