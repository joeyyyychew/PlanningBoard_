const TZ = 'Asia/Kuala_Lumpur';
const DEFAULT_ACCOUNT = 'fb108701968299986';
const MAX_CONTACTS_PER_EVENT = 50;
const MAX_EVENTS_PER_DAY = 300;
const ORDER_SHEET_ID = '1py5YznTXAD6TU9onEaa12MXWhLCUngQ5PDSTfD4Q_JQ';
const BROADCAST_SHEET_ID = '1kyNfmPbTQ39Bg5Nn2Eqtz5r-x7cdYmcM7dd6XZT8bwU';
const BROADCAST_SHEET_NAME = 'JULY Broadcast Planning';
const ORDER_MONTH_SHEETS = {
  0: 'Order Jan',
  1: 'Order Feb',
  2: 'Order Mar',
  3: 'Order Apr',
  4: 'Order May',
  5: 'Order June',
  6: 'Order July',
  7: 'Order Aug',
  8: 'Order Sep',
  9: 'Order Oct',
  10: 'Order Nov',
  11: 'Order Dec'
};

function json_(value) {
  return ContentService.createTextOutput(JSON.stringify(value))
    .setMimeType(ContentService.MimeType.JSON);
}

function authorized_(e) {
  const expected = PropertiesService.getScriptProperties().getProperty('INGEST_KEY');
  return expected && e && e.parameter && e.parameter.key === expected;
}

function safe_(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '');
}

function dayKey_(account, date) {
  return 'DAY_' + safe_(account) + '_' + date;
}

function stateKey_(account, contactId) {
  return 'CONTACT_' + safe_(account) + '_' + safe_(contactId);
}

function contactKeys_(contact) {
  if (!contact) return [];
  const values = [
    contact.id,
    contact.contact_id,
    contact.subscriber_id,
    contact.phone,
    contact.whatsapp_id,
    contact.wa_id,
    contact.inbox,
    contact.inbox_url,
    contact.live_chat_url,
    contact.name
  ];
  return values
    .map(function(value) { return String(value || '').trim().toLowerCase(); })
    .filter(function(value) { return !placeholderValue_(value); })
    .filter(Boolean);
}

function placeholderValue_(value) {
  const text = String(value || '').trim().toLowerCase();
  return !text ||
    text === 'no field selected' ||
    /^\{[^{}]+\}$/.test(text) ||
    /^\{\{[^{}]+\}\}$/.test(text) ||
    text.indexOf('subscriber.') >= 0 ||
    text.indexOf('contact id') >= 0 ||
    text.indexOf('full name') >= 0 ||
    text.indexOf('last text input') >= 0;
}

function contactKey_(contact) {
  const keys = contactKeys_(contact);
  return keys[0] || '';
}

function sameContact_(a, b) {
  const aKeys = contactKeys_(a);
  const bKeys = contactKeys_(b);
  if (!aKeys.length || !bKeys.length) return false;
  return aKeys.some(function(key) { return bKeys.indexOf(key) >= 0; });
}

function emptyDay_(account, date) {
  return {account: account, date: date, counts: {}, contacts: {}, events: [], updated_at: ''};
}

function readDay_(account, date) {
  const raw = PropertiesService.getScriptProperties().getProperty(dayKey_(account, date));
  return raw ? JSON.parse(raw) : emptyDay_(account, date);
}

function saveDay_(day) {
  PropertiesService.getScriptProperties().setProperty(dayKey_(day.account, day.date), JSON.stringify(day));
}

function contactFrom_(body, now) {
  const nested = body.contact || body.subscriber || {};
  const firstName = body.first_name || nested.first_name || '';
  const lastName = body.last_name || nested.last_name || '';
  const rawTags = body.tags || nested.tags || body.tag || body.tag_name || '';
  const tags = Array.isArray(rawTags) ? rawTags.map(function(tag) {
      return typeof tag === 'object' ? String(tag.name || tag.title || tag.id || '') : String(tag);
    }).filter(Boolean)
    : String(rawTags).split(',').map(item => item.trim()).filter(Boolean);
  return {
    id: String(body.contact_id || body.subscriber_id || body.id || nested.id || ''),
    name: String(body.contact_name || body.full_name || body.name || nested.name ||
      [firstName, lastName].filter(Boolean).join(' ')),
    phone: String(body.phone || body.whatsapp_id || body.wa_id || nested.phone || nested.whatsapp_id || nested.wa_id || ''),
    channel: String(body.channel || body.type || nested.channel || ''),
    returning: body.returning === true || body.returning === 'true' || body.is_returning === true || body.is_returning === 'true',
    inbox: String(body.inbox || body.inbox_url || body.chat_url || body.live_chat_url || nested.live_chat_url || ''),
    text: String(body.text || body.message || body.last_text_input || body.last_input || body.last_input_text || nested.last_input_text || body.note || ''),
    tags: tags,
    at: now.toISOString()
  };
}

function addContact_(day, type, contact) {
  day.contacts[type] = day.contacts[type] || [];
  if (!contactKeys_(contact).length) return false;
  const key = contactKey_(contact);
  day.contacts[type] = day.contacts[type].filter(item => !sameContact_(item, contact));
  day.contacts[type].unshift(contact);
  day.contacts[type] = day.contacts[type].slice(0, MAX_CONTACTS_PER_EVENT);
  return true;
}

function removeContact_(day, type, contact) {
  const probe = typeof contact === 'object' ? contact : { id: contact, name: contact, inbox: contact, phone: contact };
  day.contacts[type] = (day.contacts[type] || []).filter(item => {
    return !sameContact_(item, probe);
  });
  day.counts[type] = (day.contacts[type] || []).length;
}

function removePendingFromStoredDays_(account, contact, currentDate) {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  const prefix = 'DAY_' + safe_(account) + '_';
  Object.keys(all).forEach(function(key) {
    if (key.indexOf(prefix) !== 0) return;
    const day = JSON.parse(all[key] || '{}');
    if (!day || !day.date || String(day.date) > String(currentDate)) return;
    const before = (day.contacts && day.contacts.pending || []).length;
    removeContact_(day, 'pending', contact);
    const after = (day.contacts && day.contacts.pending || []).length;
    if (after !== before) {
      day.updated_at = new Date().toISOString();
      saveDay_(day);
    }
  });
}

function normalizedType_(body, rawType) {
  const text = String([
    body.text,
    body.message,
    body.tag,
    body.tag_name,
    body.source,
    body.flow,
    body.step,
    body.blocker
  ].filter(Boolean).join(' ')).toLowerCase();
  const type = String(rawType || '').toLowerCase().replace(/[^a-z0-9_ -]/g, '').replace(/[ -]+/g, '_');
  if (['pm', 'new_pm', 'subscribed', 'pm_subscribed', 'new_contact', 'subscriber_created'].indexOf(type) >= 0) return 'pm_subscribed';
  if (['pending', 'pending_added', 'pending_payment'].indexOf(type) >= 0) return 'pending';
  if (type === 'tag_added' && text.indexOf('pending') >= 0) return 'pending';
  if (['after_payment', 'ao', 'order_completed', 'completed_order'].indexOf(type) >= 0 ||
      /after[_\s-]*payment|after payment flow|ao\s*flow|main payment flow/.test(text)) return 'after_payment';
  if (['customer_message', 'message', 'inbox_message', 'reply'].indexOf(type) >= 0 || body.direction === 'in') return 'customer_message';
  if (['page_reply', 'admin_reply', 'agent_reply'].indexOf(type) >= 0 || body.direction === 'out') return 'page_reply';
  if (type === 'tag_added') return 'tag_added';
  return type || 'event';
}

function addEvent_(day, type, contact, body, now) {
  day.events = day.events || [];
  day.events.unshift({
    type: type,
    contact_id: contact.id,
    name: contact.name,
    phone: contact.phone,
    inbox: contact.inbox,
    text: contact.text,
    tags: contact.tags || [],
    blocker: String(body.blocker || body.reason || body.category || ''),
    source: String(body.source || body.flow || body.step || ''),
    occurred_at: String(body.occurred_at || body.event_time || body.created_at || now.toISOString())
  });
  day.events = day.events.slice(0, MAX_EVENTS_PER_DAY);
}

function addPmTags_(day, contact) {
  const tags = (contact.tags || []).map(item => String(item).toLowerCase());
  const joined = tags.join(' ');
  if (joined.indexOf('rm4.90') >= 0 || joined.indexOf('drink') >= 0 || joined.indexOf('collagen drinks') >= 0) {
    addContact_(day, 'collagen_drinks', contact);
    day.counts.collagen_drinks = (day.contacts.collagen_drinks || []).length;
  }
  if (joined.indexOf('free testing') >= 0 || joined.indexOf('freetesting') >= 0) {
    addContact_(day, 'free_testing', contact);
    day.counts.free_testing = (day.contacts.free_testing || []).length;
  }
  if (joined.indexOf("don't disturb") >= 0 || joined.indexOf('dont disturb') >= 0 || joined.indexOf('do not disturb') >= 0) {
    addContact_(day, 'dont_disturb', contact);
    day.counts.dont_disturb = (day.contacts.dont_disturb || []).length;
  }
}

function value_(order, key) {
  return order && Object.prototype.hasOwnProperty.call(order, key) ? order[key] : '';
}

function monthIndexFromDate_(dateValue) {
  const raw = String(dateValue || '').trim();
  const slash = raw.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);
  if (slash) return Number(slash[2]) - 1;
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return Number(iso[2]) - 1;
  return Number(Utilities.formatDate(new Date(), TZ, 'M')) - 1;
}

function orderSheetFor_(spreadsheet, order) {
  const monthIndex = monthIndexFromDate_(value_(order, 'F · Date'));
  const preferred = ORDER_MONTH_SHEETS[monthIndex];
  const sheet = preferred ? spreadsheet.getSheetByName(preferred) : null;
  if (sheet) return sheet;
  throw new Error('order_sheet_tab_not_found_' + preferred);
}

function normalizeOrderDate_(value) {
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value)) {
    return Utilities.formatDate(value, TZ, 'dd/MM/yyyy');
  }
  const raw = String(value || '').trim();
  const slash = raw.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);
  if (slash) {
    const year = slash[3].length === 2 ? '20' + slash[3] : slash[3];
    return slash[1].padStart(2, '0') + '/' + slash[2].padStart(2, '0') + '/' + year;
  }
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return iso[3] + '/' + iso[2] + '/' + iso[1];
  return raw;
}

function orderDateKey_(value) {
  const normalized = normalizeOrderDate_(value);
  const slash = String(normalized || '').match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);
  if (slash) {
    const year = slash[3].length === 2 ? '20' + slash[3] : slash[3];
    return year + '-' + slash[2].padStart(2, '0') + '-' + slash[1].padStart(2, '0');
  }
  const iso = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return iso[1] + '-' + iso[2] + '-' + iso[3];
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
}

function orderEntriesKey_(dateKey) {
  return 'ORDER_ENTRIES_' + String(dateKey || '').replace(/[^0-9-]/g, '');
}

function readOrderEntriesStore_(dateKey) {
  const raw = PropertiesService.getScriptProperties().getProperty(orderEntriesKey_(dateKey));
  return raw ? JSON.parse(raw) : [];
}

function propertyStorageStats_() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  const stats = {keys:0, bytes:0, contact:0, day:0, order:0, other:0};
  Object.keys(all).forEach(function(key) {
    stats.keys += 1;
    stats.bytes += String(key).length + String(all[key] || '').length;
    if (key.indexOf('CONTACT_') === 0) stats.contact += 1;
    else if (key.indexOf('DAY_') === 0) stats.day += 1;
    else if (key.indexOf('ORDER_ENTRIES_') === 0) stats.order += 1;
    else stats.other += 1;
  });
  return stats;
}

function pruneScriptStorage_() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  let deleted = 0;
  let compacted = 0;
  Object.keys(all).forEach(function(key) {
    if (key.indexOf('CONTACT_') === 0) {
      props.deleteProperty(key);
      deleted += 1;
      return;
    }
    if (key.indexOf('ORDER_ENTRIES_') === 0) {
      try {
        const entries = JSON.parse(all[key] || '[]')
          .map(compactOrderRecord_)
          .slice(0, 200);
        props.setProperty(key, JSON.stringify(entries));
        compacted += 1;
      } catch (err) {}
      return;
    }
    if (key.indexOf('DAY_') === 0) {
      try {
        const day = JSON.parse(all[key] || '{}');
        day.events = (day.events || []).slice(0, 80).map(function(event) {
          return {
            type: event.type,
            text: event.text,
            direction: event.direction,
            contact: event.contact,
            at: event.at
          };
        });
        day.contacts = day.contacts || {};
        Object.keys(day.contacts).forEach(function(type) {
          day.contacts[type] = (day.contacts[type] || []).slice(0, 50);
        });
        props.setProperty(key, JSON.stringify(day));
        compacted += 1;
      } catch (err) {}
    }
  });
  const after = propertyStorageStats_();
  after.deleted = deleted;
  after.compacted = compacted;
  return after;
}

function compactOrderRecord_(record) {
  const order = record.order || {};
  const compactOrder = {
    'D · Sales Person': value_(order, 'D · Sales Person') || 'Joey',
    'E · NO': value_(order, 'E · NO') || record.no || '',
    'F · Date': value_(order, 'F · Date') || record.date || '',
    'G · Platform Name': value_(order, 'G · Platform Name') || record.name || '',
    'H · Channel / Chanel': value_(order, 'H · Channel / Chanel') || record.channel || '',
    'M · Payment Method': value_(order, 'M · Payment Method') || record.payment || '',
    'N · Variant': value_(order, 'N · Variant') || record.product || '',
    'O · Remark': value_(order, 'O · Remark') || '',
    'P · Name': value_(order, 'P · Name') || record.name || '',
    'Q · Phone': value_(order, 'Q · Phone') || record.phone || '',
    'R · Address': value_(order, 'R · Address') || record.address || '',
    'S · Total/RM': value_(order, 'S · Total/RM') || record.total || '',
    'AK · Receipt Link': value_(order, 'AK · Receipt Link') || record.receipt || ''
  };
  return {
    id: String(record.id || ''),
    source: 'dashboard',
    sheet: String(record.sheet || ''),
    row: record.row || '',
    no: record.no || compactOrder['E · NO'],
    date: record.date || compactOrder['F · Date'],
    dateKey: record.dateKey || orderDateKey_(record.date || compactOrder['F · Date']),
    name: String(record.name || compactOrder['P · Name'] || ''),
    phone: String(record.phone || compactOrder['Q · Phone'] || ''),
    product: String(record.product || compactOrder['N · Variant'] || compactOrder['O · Remark'] || ''),
    address: String(record.address || compactOrder['R · Address'] || ''),
    total: record.total || compactOrder['S · Total/RM'],
    payment: String(record.payment || compactOrder['M · Payment Method'] || ''),
    page: String(record.page || ''),
    channel: String(record.channel || compactOrder['H · Channel / Chanel'] || ''),
    receipt: String(record.receipt || compactOrder['AK · Receipt Link'] || ''),
    order: compactOrder
  };
}

function saveOrderEntriesStore_(dateKey, entries) {
  const compactEntries = (entries || []).map(compactOrderRecord_);
  try {
    PropertiesService.getScriptProperties().setProperty(orderEntriesKey_(dateKey), JSON.stringify(compactEntries));
  } catch (err) {
    if (String(err && err.message || err).indexOf('property storage quota') < 0) throw err;
    pruneScriptStorage_();
    PropertiesService.getScriptProperties().setProperty(orderEntriesKey_(dateKey), JSON.stringify(compactEntries.slice(0, 200)));
  }
}

function upsertOrderRecord_(record) {
  const dateKey = record.dateKey || orderDateKey_(record.date);
  record.source = 'dashboard';
  const stableKey = orderRecordStableKey_(record);
  const entries = readOrderEntriesStore_(dateKey).filter(function(item) {
    const itemStableKey = orderRecordStableKey_(item);
    const sameStable = stableKey && itemStableKey === stableKey;
    const sameIdFallback = !stableKey && String(record.id || '') && String(item.id || '') === String(record.id || '');
    return !(sameStable || sameIdFallback);
  });
  entries.unshift(record);
  saveOrderEntriesStore_(dateKey, entries.slice(0, 500));
}

function orderRecordSignature_(record) {
  const order = record.order || {};
  const dateKey = String(record.dateKey || orderDateKey_(record.date || value_(order, 'F · Date')) || '').trim();
  const name = String(record.name || value_(order, 'P · Name') || '').trim().toLowerCase();
  const phone = String(record.phone || value_(order, 'Q · Phone') || '').replace(/\D/g, '');
  const total = String(record.total || value_(order, 'S · Total/RM') || '').replace(/[^0-9.]/g, '');
  const product = String(record.product || value_(order, 'N · Variant') || value_(order, 'O · Remark') || '').trim().toLowerCase();
  return [dateKey, name, phone, total, product].join('|');
}

function orderRecordPhoneKey_(record) {
  const order = record.order || {};
  const dateKey = String(record.dateKey || orderDateKey_(record.date || value_(order, 'F · Date')) || '').trim();
  const phone = String(record.phone || value_(order, 'Q · Phone') || '').replace(/\D/g, '');
  return dateKey && phone ? dateKey + '|' + phone : '';
}

function orderRecordStableKey_(record) {
  const order = record.order || {};
  const phoneKey = orderRecordPhoneKey_(record);
  const total = String(record.total || value_(order, 'S · Total/RM') || '').replace(/[^0-9.]/g, '');
  const product = String(record.product || value_(order, 'N · Variant') || value_(order, 'O · Remark') || '').trim().toLowerCase();
  if (phoneKey) return ['phone', phoneKey, total, product].join('|');
  const signature = orderRecordSignature_(record);
  if (signature !== '||||') return 'sig|' + signature;
  const id = String(record.id || '').trim();
  return id ? 'id|' + id : '';
}

function removeOrderRecord_(dateKey, record) {
  if (!dateKey) return;
  const stableKey = orderRecordStableKey_(record);
  const phoneKey = orderRecordPhoneKey_(record);
  const entries = readOrderEntriesStore_(dateKey).filter(function(item) {
    const itemStableKey = orderRecordStableKey_(item);
    const itemPhoneKey = orderRecordPhoneKey_(item);
    const sameStable = stableKey && itemStableKey === stableKey;
    const samePhone = !stableKey && phoneKey && itemPhoneKey === phoneKey;
    const sameIdFallback = !stableKey && !phoneKey && String(record.id || '') && String(item.id || '') === String(record.id || '');
    return !(sameStable || samePhone || sameIdFallback);
  });
  saveOrderEntriesStore_(dateKey, entries);
}

function orderRecordRowStillFilled_(record) {
  const sheetName = String(record.sheet || '').trim();
  const row = Number(record.row || 0);
  if (!sheetName || !Number.isFinite(row) || row < 2) return true;
  try {
    const spreadsheet = SpreadsheetApp.openById(ORDER_SHEET_ID);
    const sheet = spreadsheet.getSheetByName(sheetName);
    if (!sheet) return false;
    const values = sheet.getRange(row, 4, 1, 16).getValues()[0]; // D:S
    const receipt = sheet.getRange(row, 37).getValue(); // AK
    return values.some(function(cell) {
      return String(cell || '').trim() !== '';
    }) || String(receipt || '').trim() !== '';
  } catch (err) {
    return true;
  }
}

function dashboardOrderRowLikelyMatches_(rowValues, dateKey, storedEntries) {
  const record = {
    dateKey: dateKey,
    name: String(rowValues[12] || rowValues[3] || ''),
    phone: String(rowValues[13] || ''),
    total: rowValues[15],
    product: String(rowValues[10] || rowValues[11] || ''),
    order: {
      'F · Date': normalizeOrderDate_(rowValues[2]),
      'N · Variant': rowValues[10],
      'O · Remark': rowValues[11],
      'P · Name': rowValues[12],
      'Q · Phone': rowValues[13],
      'S · Total/RM': rowValues[15]
    }
  };
  const signature = orderRecordSignature_(record);
  const name = String(record.name || '').trim().toLowerCase();
  const phone = String(record.phone || '').replace(/\D/g, '');
  const total = String(record.total || '').replace(/[^0-9.]/g, '');
  const matchedStoredOrder = (storedEntries || []).some(function(item) {
    const itemSignature = orderRecordSignature_(item);
    const itemName = String(item.name || value_(item.order || {}, 'P · Name') || '').trim().toLowerCase();
    const itemPhone = String(item.phone || value_(item.order || {}, 'Q · Phone') || '').replace(/\D/g, '');
    const itemTotal = String(item.total || value_(item.order || {}, 'S · Total/RM') || '').replace(/[^0-9.]/g, '');
    if (signature !== '||||' && itemSignature === signature) return true;
    if (phone && itemPhone && phone === itemPhone && total && itemTotal === total) return true;
    return name && itemName && name === itemName && total && itemTotal === total;
  });
  if (matchedStoredOrder) return true;
  const salesPerson = String(rowValues[0] || '').trim().toLowerCase();
  return salesPerson === 'joey' && name && total;
}

function orderRecordsFromSheetDate_(dateValue, storedEntries) {
  const dateKey = orderDateKey_(dateValue);
  const spreadsheet = SpreadsheetApp.openById(ORDER_SHEET_ID);
  const sheetName = ORDER_MONTH_SHEETS[monthIndexFromDate_(dateKey)];
  const sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) return [];
  const last = Math.max(2, sheet.getLastRow());
  if (last < 2) return [];
  const values = sheet.getRange(2, 4, last - 1, 16).getValues(); // D:S
  const receipts = sheet.getRange(2, 37, last - 1, 1).getValues(); // AK
  const records = [];
  values.forEach(function(rowValues, index) {
    const row = index + 2;
    const hasOrderData = rowValues.some(function(cell) {
      return String(cell || '').trim() !== '';
    }) || String(receipts[index][0] || '').trim() !== '';
    if (!hasOrderData) return;
    const rowDateKey = orderDateKey_(rowValues[2]);
    if (rowDateKey !== dateKey) return;
    if (!dashboardOrderRowLikelyMatches_(rowValues, dateKey, storedEntries)) return;
    const record = orderRecordFromRow_(sheet, row, sheet.getName() + '-' + row);
    record.source = 'dashboard';
    records.push(record);
  });
  return records;
}

function mergeOrderRecords_(storedEntries, sheetEntries) {
  const seen = {};
  const merged = [];
  function keyFor(item) {
    const stableKey = orderRecordStableKey_(item);
    if (stableKey) return stableKey;
    if (String(item.id || '').trim()) return 'id:' + String(item.id).trim();
    return 'sig:' + orderRecordSignature_(item);
  }
  (storedEntries || []).forEach(function(item) {
    const key = keyFor(item);
    if (seen[key]) return;
    seen[key] = true;
    merged.push(item);
  });
  (sheetEntries || []).forEach(function(item) {
    const key = keyFor(item);
    if (seen[key]) return;
    seen[key] = true;
    merged.push(item);
  });
  merged.sort(function(a, b) {
    const rowA = Number(a.row || 0);
    const rowB = Number(b.row || 0);
    if (rowA && rowB && rowA !== rowB) return rowB - rowA;
    return String(b.id || '').localeCompare(String(a.id || ''));
  });
  return merged;
}

function styleSgdRemark_(range) {
  const text = String(range.getValue() || '');
  if (!/SGD\s*\d/i.test(text)) return;
  const builder = SpreadsheetApp.newRichTextValue().setText(text);
  const red = SpreadsheetApp.newTextStyle().setForegroundColor('#d93025').build();
  const regex = /SGD\s*\d+(?:\.\d{1,2})?/gi;
  let match;
  while ((match = regex.exec(text)) !== null) {
    builder.setTextStyle(match.index, match.index + match[0].length, red);
  }
  range.setRichTextValue(builder.build());
}

function orderRecordFromRow_(sheet, row, id) {
  const values = sheet.getRange(row, 4, 1, 16).getValues()[0]; // D:S
  const receipt = sheet.getRange(row, 37).getValue(); // AK
  const date = normalizeOrderDate_(values[2]);
  return {
    id: String(id || sheet.getName() + '-' + row),
    source: 'dashboard',
    sheet: sheet.getName(),
    row: row,
    no: values[1],
    date: date,
    dateKey: orderDateKey_(date),
    name: String(values[12] || values[3] || ''),
    phone: String(values[13] || ''),
    product: String(values[10] || values[11] || ''),
    address: String(values[14] || ''),
    total: values[15],
    payment: String(values[9] || ''),
    page: '',
    channel: String(values[4] || ''),
    receipt: String(receipt || ''),
    order: {
      'D · Sales Person': values[0],
      'E · NO': values[1],
      'F · Date': date,
      'G · Platform Name': values[3],
      'H · Channel / Chanel': values[4],
      'I · Classic BTL': values[5],
      'J · Knee BTL': values[6],
      'K · Ginseng BTL': values[7],
      'L · Floral BTL': values[8],
      'M · Payment Method': values[9],
      'N · Variant': values[10],
      'O · Remark': values[11],
      'P · Name': values[12],
      'Q · Phone': values[13],
      'R · Address': values[14],
      'S · Total/RM': values[15],
      'AK · Receipt Link': receipt
    }
  };
}

function orderRecordFromRowValues_(sheet, row, values, receipt, id) {
  const date = normalizeOrderDate_(values[2]);
  return {
    id: String(id || sheet.getName() + '-' + row),
    source: 'dashboard',
    sheet: sheet.getName(),
    row: row,
    no: values[1],
    date: date,
    dateKey: orderDateKey_(date),
    name: String(values[12] || values[3] || ''),
    phone: String(values[13] || ''),
    product: String(values[10] || values[11] || ''),
    address: String(values[14] || ''),
    total: values[15],
    payment: String(values[9] || ''),
    page: '',
    channel: String(values[4] || ''),
    receipt: String(receipt || ''),
    order: {
      'D · Sales Person': values[0],
      'E · NO': values[1],
      'F · Date': date,
      'G · Platform Name': values[3],
      'H · Channel / Chanel': values[4],
      'I · Classic BTL': values[5],
      'J · Knee BTL': values[6],
      'K · Ginseng BTL': values[7],
      'L · Floral BTL': values[8],
      'M · Payment Method': values[9],
      'N · Variant': values[10],
      'O · Remark': values[11],
      'P · Name': values[12],
      'Q · Phone': values[13],
      'R · Address': values[14],
      'S · Total/RM': values[15],
      'AK · Receipt Link': receipt
    }
  };
}

function findOrderRowByDatePhone_(sheet, dateKey, record) {
  const phoneKey = orderRecordPhoneKey_(record);
  if (!phoneKey) return 0;
  const targetPhone = phoneKey.split('|')[1];
  const targetTotal = String(record.total || value_(record.order || {}, 'S · Total/RM') || '').replace(/[^0-9.]/g, '');
  const targetProduct = String(record.product || value_(record.order || {}, 'N · Variant') || value_(record.order || {}, 'O · Remark') || '').trim().toLowerCase();
  const last = Math.max(2, sheet.getLastRow());
  if (last < 2) return 0;
  const values = sheet.getRange(2, 4, last - 1, 16).getValues(); // D:S
  const candidates = [];
  values.forEach(function(rowValues, index) {
    const rowDateKey = orderDateKey_(rowValues[2]);
    if (rowDateKey !== dateKey) return;
    const rowPhone = String(rowValues[13] || '').replace(/\D/g, '');
    if (!rowPhone || rowPhone !== targetPhone) return;
    const rowTotal = String(rowValues[15] || '').replace(/[^0-9.]/g, '');
    const rowProduct = String(rowValues[10] || rowValues[11] || '').trim().toLowerCase();
    let score = 1;
    if (targetTotal && rowTotal === targetTotal) score += 2;
    if (targetProduct && rowProduct === targetProduct) score += 1;
    candidates.push({row:index + 2, score:score});
  });
  candidates.sort(function(a, b) {
    if (b.score !== a.score) return b.score - a.score;
    return b.row - a.row;
  });
  return candidates[0] ? candidates[0].row : 0;
}

function resolveOrderRow_(sheet, dateKey, body) {
  const row = Number(body.row || 0);
  const lookup = {
    dateKey: dateKey,
    id: body.id,
    name: body.oldName || body.name,
    phone: body.oldPhone || body.phone || value_(body.order || {}, 'Q · Phone'),
    total: body.oldTotal || body.total || value_(body.order || {}, 'S · Total/RM'),
    product: body.oldProduct || body.product || value_(body.order || {}, 'N · Variant') || value_(body.order || {}, 'O · Remark'),
    order: body.oldOrder || body.order || {}
  };
  if (row && Number.isFinite(row) && row >= 2) {
    try {
      const values = sheet.getRange(row, 4, 1, 16).getValues()[0];
      const rowRecord = orderRecordFromRowValues_(sheet, row, values, sheet.getRange(row, 37).getValue(), body.id);
      if (orderRecordPhoneKey_(rowRecord) && orderRecordPhoneKey_(rowRecord) === orderRecordPhoneKey_(lookup)) return row;
    } catch (err) {}
  }
  return findOrderRowByDatePhone_(sheet, dateKey, lookup) || row;
}

function previousOrderLookup_(body, row) {
  return {
    id: body.id,
    sheet: body.sheet,
    row: row || body.row,
    dateKey: body.oldDateKey || body.dateKey,
    name: body.oldName || body.name,
    phone: body.oldPhone || body.phone || value_(body.oldOrder || {}, 'Q · Phone') || value_(body.order || {}, 'Q · Phone'),
    total: body.oldTotal || body.total || value_(body.oldOrder || {}, 'S · Total/RM') || value_(body.order || {}, 'S · Total/RM'),
    product: body.oldProduct || body.product || value_(body.oldOrder || {}, 'N · Variant') || value_(body.oldOrder || {}, 'O · Remark') || value_(body.order || {}, 'N · Variant') || value_(body.order || {}, 'O · Remark'),
    order: body.oldOrder || body.order || {}
  };
}

function getOrderEntries_(dateValue) {
  const dateKey = orderDateKey_(dateValue);
  const storedEntries = readOrderEntriesStore_(dateKey).filter(function(item) {
    return String(item.source || '') === 'dashboard';
  });
  return {ok:true, date:dateKey, entries:storedEntries};
}

function restoreOrderEntriesFromSheet_(dateValue) {
  const dateKey = orderDateKey_(dateValue);
  const sheetEntries = orderRecordsFromSheetDate_(dateKey, []);
  const records = sheetEntries.map(function(record) {
    record.source = 'dashboard';
    return record;
  });
  saveOrderEntriesStore_(dateKey, records);
  return {ok:true, date:dateKey, restored:records.length, entries:readOrderEntriesStore_(dateKey)};
}

function lastFilledOrderRow_(sheet) {
  const last = Math.max(2, sheet.getLastRow());
  if (last < 2) return 1;
  const values = sheet.getRange(2, 4, last - 1, 16).getValues(); // D:S
  for (let index = values.length - 1; index >= 0; index--) {
    if (values[index].some(cell => String(cell || '').trim() !== '')) {
      return index + 2;
    }
  }
  return 1;
}

function lastOrderDate_(sheet, lastDataRow) {
  if (lastDataRow < 2) return '';
  return normalizeOrderDate_(sheet.getRange(lastDataRow, 6).getValue()); // F
}

function nextOrderRow_(sheet, orderDate) {
  const lastDataRow = lastFilledOrderRow_(sheet);
  if (lastDataRow < 2) return 2;
  const previousDate = lastOrderDate_(sheet, lastDataRow);
  const nextDate = normalizeOrderDate_(orderDate);
  return previousDate && nextDate && previousDate !== nextDate
    ? lastDataRow + 3
    : lastDataRow + 1;
}

function nextOrderNo_(sheet) {
  const last = Math.max(2, sheet.getLastRow());
  if (last < 2) return 1;
  const values = sheet.getRange(2, 5, last - 1, 1).getValues(); // E
  let max = 0;
  values.forEach(function(row) {
    const number = Number(row[0]);
    if (Number.isFinite(number) && number > max) max = number;
  });
  return max + 1;
}

function compareDateKey_(a, b) {
  const left = orderDateKey_(a);
  const right = orderDateKey_(b);
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function ensureRows_(sheet, targetRow) {
  if (targetRow <= sheet.getMaxRows()) return;
  sheet.insertRowsAfter(sheet.getMaxRows(), targetRow - sheet.getMaxRows());
}

function reserveOrderRow_(sheet, orderDate) {
  const nextRow = nextOrderRow_(sheet, orderDate);
  ensureRows_(sheet, nextRow);
  return {row: nextRow, shifted: false};
}

function rowDSFromOrder_(order, orderNo) {
  return [
    value_(order, 'D · Sales Person') || 'Joey',
    orderNo,
    value_(order, 'F · Date'),
    value_(order, 'G · Platform Name'),
    value_(order, 'H · Channel / Chanel'),
    value_(order, 'I · Classic BTL'),
    value_(order, 'J · Knee BTL'),
    value_(order, 'K · Ginseng BTL'),
    value_(order, 'L · Floral BTL'),
    value_(order, 'M · Payment Method'),
    value_(order, 'N · Variant'),
    value_(order, 'O · Remark'),
    value_(order, 'P · Name'),
    value_(order, 'Q · Phone'),
    value_(order, 'R · Address'),
    value_(order, 'S · Total/RM')
  ];
}

function reseatStoredOrderRows_(sheetName, startRow, delta) {
  const change = Number(delta || 1);
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  Object.keys(all).forEach(function(key) {
    if (key.indexOf('ORDER_ENTRIES_') !== 0) return;
    const entries = JSON.parse(all[key] || '[]');
    let changed = false;
    entries.forEach(function(item) {
      if (String(item.sheet || '') === String(sheetName) && Number(item.row || 0) >= startRow) {
        item.row = Number(item.row) + change;
        changed = true;
      }
    });
    if (changed) props.setProperty(key, JSON.stringify(entries));
  });
}

function writeOrderRow_(sheet, row, order, orderNo) {
  const rowDS = rowDSFromOrder_(order, orderNo);
  sheet.getRange(row, 4, 1, rowDS.length).setValues([rowDS]);
  sheet.getRange(row, 37).setValue(value_(order, 'AK · Receipt Link'));
  styleSgdRemark_(sheet.getRange(row, 15));
  return rowDS;
}

function nextOrderNoBefore_(sheet, nextRow) {
  if (nextRow <= 2) return 1;
  const values = sheet.getRange(2, 5, nextRow - 2, 1).getValues(); // E
  for (let index = values.length - 1; index >= 0; index--) {
    const number = Number(values[index][0]);
    if (Number.isFinite(number) && number > 0) return number + 1;
  }
  return 1;
}

function appendOrderEntry_(body) {
  const order = body.order || {};
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const spreadsheet = SpreadsheetApp.openById(ORDER_SHEET_ID);
    const sheet = orderSheetFor_(spreadsheet, order);
    const reservation = reserveOrderRow_(sheet, value_(order, 'F · Date'));
    const nextRow = reservation.row;
    if (reservation.shifted) reseatStoredOrderRows_(sheet.getName(), nextRow, reservation.delta);
    const orderNo = nextOrderNo_(sheet);
    const rowDS = writeOrderRow_(sheet, nextRow, order, orderNo);
    SpreadsheetApp.flush();
    const check = sheet.getRange(nextRow, 4, 1, rowDS.length).getValues()[0];
    const receipt = sheet.getRange(nextRow, 37).getValue();
    const id = String(new Date().getTime()) + '-' + nextRow;
    const record = {
      id: id,
      sheet: sheet.getName(),
      row: nextRow,
      no: check[1],
      date: normalizeOrderDate_(check[2]),
      dateKey: orderDateKey_(check[2]),
      name: check[12],
      phone: check[13],
      product: String(check[10] || check[11] || ''),
      address: String(check[14] || ''),
      total: check[15],
      payment: check[9],
      page: String(body.page || ''),
      channel: check[4],
      receipt: receipt,
      source: 'dashboard',
      order: order
    };
    upsertOrderRecord_(record);
    return {
      ok: true,
      entry: record
    };
  } finally {
    lock.releaseLock();
  }
}

function updateOrderEntryDate_(body) {
  const newDate = normalizeOrderDate_(body.newDate || body.date);
  if (!newDate) throw new Error('new_date_required');
  const oldDateKey = body.oldDateKey || orderDateKey_(body.oldDate || body.dateKey || newDate);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const spreadsheet = SpreadsheetApp.openById(ORDER_SHEET_ID);
    const oldSheet = spreadsheet.getSheetByName(String(body.sheet || ORDER_MONTH_SHEETS[monthIndexFromDate_(oldDateKey)]));
    if (!oldSheet) throw new Error('old_order_sheet_not_found');
    const oldRow = resolveOrderRow_(oldSheet, oldDateKey, body);
    if (!Number.isFinite(oldRow) || oldRow < 2) throw new Error('order_row_not_found_for_date_phone');
    const newSheet = spreadsheet.getSheetByName(ORDER_MONTH_SHEETS[monthIndexFromDate_(newDate)]);
    if (!newSheet) throw new Error('new_order_sheet_not_found');

    let record;
    if (newSheet.getName() === oldSheet.getName()) {
      oldSheet.getRange(oldRow, 6).setValue(newDate); // F
      record = orderRecordFromRow_(oldSheet, oldRow, body.id);
    } else {
      const rowDS = oldSheet.getRange(oldRow, 4, 1, 16).getValues()[0];
      const receipt = oldSheet.getRange(oldRow, 37).getValue();
      rowDS[2] = newDate;
      oldSheet.getRange(oldRow, 4, 1, 16).clearContent();
      oldSheet.getRange(oldRow, 37).clearContent();
      const reservation = reserveOrderRow_(newSheet, newDate);
      const nextRow = reservation.row;
      if (reservation.shifted) reseatStoredOrderRows_(newSheet.getName(), nextRow, reservation.delta);
      newSheet.getRange(nextRow, 4, 1, rowDS.length).setValues([rowDS]);
      newSheet.getRange(nextRow, 37).setValue(receipt);
      styleSgdRemark_(newSheet.getRange(nextRow, 15));
      record = orderRecordFromRow_(newSheet, nextRow, body.id || (newSheet.getName() + '-' + nextRow));
    }
    removeOrderRecord_(oldDateKey, previousOrderLookup_(body, oldRow));
    upsertOrderRecord_(record);
    SpreadsheetApp.flush();
    return {ok:true, entry:record};
  } finally {
    lock.releaseLock();
  }
}

function updateOrderEntry_(body) {
  const order = body.order || {};
  const newDate = normalizeOrderDate_(value_(order, 'F · Date') || body.newDate || body.date);
  if (!newDate) throw new Error('order_date_required');
  const oldDateKey = body.oldDateKey || orderDateKey_(body.oldDate || body.dateKey || newDate);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const spreadsheet = SpreadsheetApp.openById(ORDER_SHEET_ID);
    const oldSheet = spreadsheet.getSheetByName(String(body.sheet || ORDER_MONTH_SHEETS[monthIndexFromDate_(oldDateKey)]));
    if (!oldSheet) throw new Error('old_order_sheet_not_found');
    const oldRow = resolveOrderRow_(oldSheet, oldDateKey, body);
    if (!Number.isFinite(oldRow) || oldRow < 2) throw new Error('order_row_not_found_for_date_phone');
    const newSheet = orderSheetFor_(spreadsheet, order);
    const existingNo = oldSheet.getRange(oldRow, 5).getValue() || value_(order, 'E · NO') || nextOrderNo_(newSheet);
    let row = oldRow;
    let targetSheet = oldSheet;

    if (newSheet.getName() === oldSheet.getName() && orderDateKey_(newDate) === oldDateKey) {
      writeOrderRow_(oldSheet, oldRow, order, existingNo);
    } else {
      oldSheet.getRange(oldRow, 4, 1, 16).clearContent();
      oldSheet.getRange(oldRow, 37).clearContent();
      targetSheet = newSheet;
      const reservation = reserveOrderRow_(newSheet, newDate);
      row = reservation.row;
      if (reservation.shifted) reseatStoredOrderRows_(newSheet.getName(), row, reservation.delta);
      writeOrderRow_(newSheet, row, order, existingNo);
    }

    removeOrderRecord_(oldDateKey, previousOrderLookup_(body, oldRow));
    const record = orderRecordFromRow_(targetSheet, row, body.id || (targetSheet.getName() + '-' + row));
    record.page = String(body.page || '');
    record.source = 'dashboard';
    record.order = order;
    upsertOrderRecord_(record);
    SpreadsheetApp.flush();
    return {ok:true, entry:record};
  } finally {
    lock.releaseLock();
  }
}

function deleteOrderEntry_(body) {
  const oldDateKey = body.oldDateKey || orderDateKey_(body.oldDate || body.dateKey || body.date);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const spreadsheet = SpreadsheetApp.openById(ORDER_SHEET_ID);
    const sheet = spreadsheet.getSheetByName(String(body.sheet || ORDER_MONTH_SHEETS[monthIndexFromDate_(oldDateKey)]));
    if (!sheet) throw new Error('order_sheet_not_found');
    const row = resolveOrderRow_(sheet, oldDateKey, body);
    if (!Number.isFinite(row) || row < 2) throw new Error('order_row_not_found_for_date_phone');
    sheet.getRange(row, 4, 1, 16).clearContent();
    sheet.getRange(row, 37).clearContent();
    removeOrderRecord_(oldDateKey, previousOrderLookup_(body, row));
    SpreadsheetApp.flush();
    return {ok:true, action:'delete', sheet:sheet.getName(), row:row};
  } finally {
    lock.releaseLock();
  }
}

function normalizeBroadcastDate_(value) {
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, TZ, 'dd/MM/yyyy');
  }
  const raw = String(value || '').trim();
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return iso[3] + '/' + iso[2] + '/' + iso[1];
  const slash = raw.match(/^(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?$/);
  if (slash) {
    const year = slash[3] ? (slash[3].length === 2 ? '20' + slash[3] : slash[3]) : Utilities.formatDate(new Date(), TZ, 'yyyy');
    return slash[1].padStart(2, '0') + '/' + slash[2].padStart(2, '0') + '/' + year;
  }
  return raw;
}

function broadcastNumber_(value) {
  if (typeof value === 'number') return value;
  const raw = String(value || '').replace(/,/g, '');
  const match = raw.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

function lastBroadcastRow_(sheet) {
  const last = Math.max(2, sheet.getLastRow());
  if (last < 2) return 1;
  const values = sheet.getRange(2, 1, last - 1, 9).getValues(); // A:I
  for (let index = values.length - 1; index >= 0; index--) {
    if (values[index].some(cell => String(cell || '').trim() !== '')) return index + 2;
  }
  return 1;
}

function broadcastDateKey_(value) {
  const raw = normalizeBroadcastDate_(value);
  const slash = String(raw || '').match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);
  if (!slash) return '';
  const year = slash[3].length === 2 ? '20' + slash[3] : slash[3];
  return year + '-' + slash[2].padStart(2, '0') + '-' + slash[1].padStart(2, '0');
}

function nextBroadcastRowForDate_(sheet, planDate) {
  const lastDataRow = lastBroadcastRow_(sheet);
  const targetKey = broadcastDateKey_(planDate);
  if (!targetKey || lastDataRow < 2) return {row: 2, inserted: false};

  const values = sheet.getRange(2, 1, lastDataRow - 1, 9).getValues(); // A:I
  for (let index = 0; index < values.length; index++) {
    const row = values[index];
    const hasData = row.some(cell => String(cell || '').trim() !== '');
    if (!hasData) return {row: index + 2, inserted: false};
    const rowKey = broadcastDateKey_(row[1]); // B Date
    if (rowKey && rowKey > targetKey) {
      const targetRow = index + 2;
      sheet.insertRowsBefore(targetRow, 1);
      return {row: targetRow, inserted: true};
    }
  }
  return {row: lastDataRow + 1, inserted: false};
}

function updateBroadcastPlan_(body) {
  const plan = body.plan || {};
  const action = String(body.action || 'update');
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const spreadsheet = SpreadsheetApp.openById(BROADCAST_SHEET_ID);
    const sheet = spreadsheet.getSheetByName(BROADCAST_SHEET_NAME);
    if (!sheet) throw new Error('broadcast_sheet_tab_not_found_' + BROADCAST_SHEET_NAME);
    let row = Number(plan.sheetRow || plan.row || 0);
    let inserted = false;
    if (action === 'append' || !row) {
      const reservation = nextBroadcastRowForDate_(sheet, plan.date);
      row = reservation.row;
      inserted = reservation.inserted === true;
    }
    if (!Number.isFinite(row) || row < 2) throw new Error('invalid_broadcast_row');

    if (action === 'delete') {
      sheet.getRange(row, 1, 1, 9).clearContent();
      SpreadsheetApp.flush();
      return {ok:true, action:'delete', sheet:sheet.getName(), row:row};
    }

    const pax = Number(plan.pax || 0);
    const spend = Number(plan.spend || (pax * 0.5) || 0);
    const rowAH = [
      plan.done === true || plan.done === 'true',
      normalizeBroadcastDate_(plan.date),
      String(plan.title || ''),
      String(plan.category || ''),
      String(plan.audience || ''),
      pax || '',
      String(plan.page || ''),
      spend
    ];
    sheet.getRange(row, 1, 1, rowAH.length).setValues([rowAH]);
    if (plan.copy || plan.broadcastCopy) {
      sheet.getRange(row, 9).setValue(String(plan.copy || plan.broadcastCopy || ''));
    }
    SpreadsheetApp.flush();
    return {
      ok:true,
      action: action,
      sheet: sheet.getName(),
      row: row,
      inserted: inserted,
      pax: pax,
      spend: spend
    };
  } finally {
    lock.releaseLock();
  }
}

function getBroadcastPlans_(monthValue) {
  const spreadsheet = SpreadsheetApp.openById(BROADCAST_SHEET_ID);
  const sheet = spreadsheet.getSheetByName(BROADCAST_SHEET_NAME);
  if (!sheet) throw new Error('broadcast_sheet_tab_not_found_' + BROADCAST_SHEET_NAME);
  const last = Math.max(2, sheet.getLastRow());
  if (last < 2) return {ok:true, sheet:sheet.getName(), rows:[]};
  const values = sheet.getRange(2, 1, last - 1, 9).getValues(); // A:I
  const targetMonth = String(monthValue || '').trim();
  const rows = [];
  values.forEach(function(row, index) {
    const hasData = row.some(function(cell) {
      return String(cell || '').trim() !== '';
    });
    if (!hasData) return;
    const dateKey = broadcastDateKey_(row[1]);
    if (targetMonth && dateKey && dateKey.slice(0, 7) !== targetMonth) return;
    const doneRaw = row[0];
    rows.push({
      sheetRow: index + 2,
      done: doneRaw === true || String(doneRaw).toLowerCase() === 'true' || String(doneRaw).trim() === '✓',
      date: dateKey,
      time: '',
      title: String(row[2] || ''),
      category: String(row[3] || ''),
      audience: String(row[4] || ''),
      pax: broadcastNumber_(row[5]),
      page: String(row[6] || ''),
      spend: broadcastNumber_(row[7]),
      copy: String(row[8] || ''),
      preview: false
    });
  });
  return {ok:true, sheet:sheet.getName(), rows:rows};
}

function getBroadcastRawRows_(limitValue) {
  const spreadsheet = SpreadsheetApp.openById(BROADCAST_SHEET_ID);
  const sheet = spreadsheet.getSheetByName(BROADCAST_SHEET_NAME);
  if (!sheet) throw new Error('broadcast_sheet_tab_not_found_' + BROADCAST_SHEET_NAME);
  const limit = Math.max(1, Math.min(Number(limitValue || 10), 25));
  const last = Math.max(1, Math.min(sheet.getLastRow(), limit));
  const width = Math.max(1, Math.min(sheet.getLastColumn(), 20));
  const rows = sheet.getRange(1, 1, last, width).getDisplayValues();
  return {ok:true, sheet:sheet.getName(), rows:rows};
}

function doPost(e) {
  if (!authorized_(e)) return json_({ok: false, error: 'unauthorized'});
  let body = {};
  try {
    body = JSON.parse((e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ok: false, error: 'invalid_json'});
  }

  const now = new Date();
  const date = body.event_date || Utilities.formatDate(now, TZ, 'yyyy-MM-dd');
  const account = safe_(body.account || e.parameter.account || DEFAULT_ACCOUNT) || DEFAULT_ACCOUNT;
  const rawType = body.event_type || e.parameter.event_type || '';
  const type = normalizedType_(body, rawType);
  if (type === 'order_entry') {
    try {
      return json_(appendOrderEntry_(body));
    } catch (err) {
      return json_({ok:false, error:String(err && err.message || err)});
    }
  }
  if (String(body.event_type || e.parameter.event_type || '') === 'order_update_date' || type === 'order_update_date') {
    try {
      return json_(updateOrderEntryDate_(body));
    } catch (err) {
      return json_({ok:false, error:String(err && err.message || err)});
    }
  }
  if (String(body.event_type || e.parameter.event_type || '') === 'order_update' || type === 'order_update') {
    try {
      return json_(updateOrderEntry_(body));
    } catch (err) {
      return json_({ok:false, error:String(err && err.message || err)});
    }
  }
  if (String(body.event_type || e.parameter.event_type || '') === 'order_delete' || type === 'order_delete') {
    try {
      return json_(deleteOrderEntry_(body));
    } catch (err) {
      return json_({ok:false, error:String(err && err.message || err)});
    }
  }
  if (String(body.event_type || e.parameter.event_type || '') === 'broadcast_plan_update' || type === 'broadcast_plan_update') {
    try {
      return json_(updateBroadcastPlan_(body));
    } catch (err) {
      return json_({ok:false, error:String(err && err.message || err)});
    }
  }
  if (!type) {
    return json_({ok:false, error:'event_type_required'});
  }
  const contact = contactFrom_(body, now);
  const props = PropertiesService.getScriptProperties();
  const stableContactKey = contactKey_(contact);
  const contactStateKey = stableContactKey ? stateKey_(account, stableContactKey) : '';
  const previous = contactStateKey && props.getProperty(contactStateKey)
    ? JSON.parse(props.getProperty(contactStateKey)) : {};
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const day = readDay_(account, date);
    addEvent_(day, type, contact, body, now);
    addPmTags_(day, contact);
    if (type === 'pending') {
      if (addContact_(day, 'pending', contact)) {
        day.counts.pending = (day.contacts.pending || []).length;
        if (contactStateKey) props.setProperty(contactStateKey, JSON.stringify({status:'pending', pending_date:date}));
      }
    } else if (type === 'after_payment') {
      if (addContact_(day, 'after_payment', contact)) {
        day.counts.after_payment = (day.contacts.after_payment || []).length;
        removeContact_(day, 'pending', contact);
        if (previous.status === 'pending' && previous.pending_date) {
          const pendingDay = previous.pending_date === date ? day : readDay_(account, previous.pending_date);
          removeContact_(pendingDay, 'pending', contact);
          pendingDay.counts.pending = (pendingDay.contacts.pending || []).length;
          pendingDay.updated_at = now.toISOString();
          if (previous.pending_date !== date) saveDay_(pendingDay);
        }
        removePendingFromStoredDays_(account, contact, date);
        if (contactStateKey) props.setProperty(contactStateKey, JSON.stringify({status:'completed', completed_date:date}));
      }
    } else if (type === 'pm_subscribed') {
      addContact_(day, 'pm', contact);
      day.counts.pm = (day.contacts.pm || []).length;
    } else if (type === 'customer_message') {
      addContact_(day, 'active', contact);
      day.counts.active = (day.contacts.active || []).length;
    } else if (type === 'page_reply') {
      addContact_(day, 'page_reply', contact);
      day.counts.page_reply = (day.contacts.page_reply || []).length;
    } else if (type === 'tag_added') {
      addContact_(day, 'tag_added', contact);
      day.counts.tag_added = (day.contacts.tag_added || []).length;
    } else {
      day.counts[type] = (day.counts[type] || 0) + 1;
      addContact_(day, type, contact);
    }
    day.updated_at = now.toISOString();
    saveDay_(day);
  } finally {
    lock.releaseLock();
  }
  return json_({ok:true, account:account, event_date:date, event_type:type});
}

function doGet(e) {
  if (!authorized_(e)) return json_({ok:false, error:'unauthorized'});
  const date = e.parameter.date || Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  if (String(e.parameter.action || '') === 'order_entries') {
    try {
      return json_(getOrderEntries_(date));
    } catch (err) {
      return json_({ok:false, error:String(err && err.message || err)});
    }
  }
  if (String(e.parameter.action || '') === 'restore_order_entries_from_sheet') {
    try {
      return json_(restoreOrderEntriesFromSheet_(date));
    } catch (err) {
      return json_({ok:false, error:String(err && err.message || err)});
    }
  }
  if (String(e.parameter.action || '') === 'storage_status') {
    try {
      return json_({ok:true, stats:propertyStorageStats_()});
    } catch (err) {
      return json_({ok:false, error:String(err && err.message || err)});
    }
  }
  if (String(e.parameter.action || '') === 'storage_cleanup') {
    try {
      return json_({ok:true, stats:pruneScriptStorage_()});
    } catch (err) {
      return json_({ok:false, error:String(err && err.message || err)});
    }
  }
  if (String(e.parameter.action || '') === 'broadcast_plans') {
    try {
      return json_(getBroadcastPlans_(e.parameter.month || ''));
    } catch (err) {
      return json_({ok:false, error:String(err && err.message || err)});
    }
  }
  if (String(e.parameter.action || '') === 'broadcast_raw') {
    try {
      return json_(getBroadcastRawRows_(e.parameter.limit || 10));
    } catch (err) {
      return json_({ok:false, error:String(err && err.message || err)});
    }
  }
  const account = safe_(e.parameter.account || DEFAULT_ACCOUNT) || DEFAULT_ACCOUNT;
  return json_({ok:true, report:readDay_(account, date)});
}

function setup() {
  return 'ready';
}
