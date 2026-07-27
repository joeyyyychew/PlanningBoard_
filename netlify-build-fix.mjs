import { readFile, writeFile } from "node:fs/promises";

const file = "build-public.mjs";
let text = await readFile(file, "utf8");

const oldForwardManyChat = `async function forwardManyChatEvent(request, env, url, account) {
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
  return forwardWebhookPost(env, eventType, { ...payload, account: accountId, event_type: eventType });
}`;

const newForwardManyChat = `async function forwardManyChatEvent(request, env, url, account) {
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
}`;

if (text.includes(oldForwardManyChat)) {
  text = text.replace(oldForwardManyChat, newForwardManyChat);
}

const eventsRoute = `    if (url.pathname === "/api/events" && request.method === "POST") {
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
`;

if (!text.includes('url.pathname === "/api/events" && request.method === "POST"')) {
  text = text.replace('    if (url.pathname === "/api/order-entry/date" && request.method === "POST") {', `${eventsRoute}    if (url.pathname === "/api/order-entry/date" && request.method === "POST") {`);
}

await writeFile(file, text);
