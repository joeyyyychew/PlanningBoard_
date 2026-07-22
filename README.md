# Scale Story Inbox Dashboard

## Start

```bash
node server.mjs
```

Then open `http://127.0.0.1:4173`.

The ManyChat API token is stored locally in `.env` and is never sent to the browser.

The dashboard now supports three independently connected accounts:

- Scalestory - 天然胶原蛋白
- 鳞记 - 天然胶原蛋白
- 鳞记 - 纯天然鱼鳞冻 SG

## API coverage

The official ManyChat Page API is connected for account information, Tags, Custom Fields, Flows, and individual contacts. It does not expose Inbox conversation history, Tag-added timestamps, or a full contact-list endpoint.

Consequently:

- Account, Tag, Custom Field, Flow, and known-contact data can use the official API.
- Inbox text analysis continues through the authenticated browser scan.
- Push-based updates are now connected through a public Google Apps Script webhook.

## Live webhook

ManyChat currently sends these events:

- `Dashboard · New Contact Webhook`: New contact created → External Request
- `Dashboard · Pending Tag Webhook`: PENDING Tag applied → External Request
- `💸 After Payment CHN`: the existing payment Flow now includes an External Request

The dashboard reads the daily live totals through `/api/live?date=YYYY-MM-DD`. Manual two-way interactions and conversation blockers still require an Inbox scan because ManyChat does not expose Inbox messages through its public API.

Pending is treated as an unresolved customer state rather than a lifetime event total. A `pending` event adds the contact; a matching `after_payment` event removes the contact from Pending and adds one completed order.

## Publish-ready architecture

The dashboard is moving away from Codex/Chrome scanning and toward this hosted flow:

`ManyChat account → External Request / API token → hosted dashboard → database → report`

New endpoints:

- `POST /api/manychat-event?account=ACCOUNT_ID&key=EVENT_KEY` stores normalized ManyChat events in `data/events.jsonl`.
- `POST /api/rebuild-report` rebuilds `data/reports.json` from stored events for one or more accounts.
- `GET /api/setup/manychat?account=ACCOUNT_ID` returns a setup template for ManyChat External Request.

Supported event types:

- `pm_subscribed`
- `customer_message`
- `page_reply`
- `pending_added`
- `after_payment`
- `tag_added`

The RUN button now first rebuilds reports from collected event data. Chrome scanning should be treated as a fallback only when event data is missing.

## Conversation analysis events

Use `customer_message` only after a real customer input, keyword trigger, user-input answer, AI step, or manual category decision. Do not send button clicks, quick replies, region choices, or first-step product-selection buttons as real interaction.

Suggested blocker categories:

- `price_concern`
- `need_consider`
- `proof_question`
- `shipping_question`
- `payment_question`
- `product_question`
- `no_clear_blocker`

ManyChat body examples are shown in `manychat-setup.html`.
