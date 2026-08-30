const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Определяем папку для данных ──
// Если примонтирован Railway Volume — используем /data, иначе __dirname
const DATA_DIR = (() => {
  try {
    fs.accessSync('/data', fs.constants.W_OK);
    console.log('📁 Используем /data (Railway Volume)');
    return '/data';
  } catch {
    console.log('📁 Используем локальную папку');
    return __dirname;
  }
})();

// ── Config (заменить на реальные значения) ──
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const SHOPIFY_SECRET = process.env.SHOPIFY_SECRET || 'ВАШ_SHOPIFY_WEBHOOK_SECRET';

// ── Middleware ──
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.static('public'));
app.use(express.static(__dirname));
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '20mb' }));

// Явный маршрут для главной страницы
app.get('/', (req, res) => {
  const publicPath = path.join(__dirname, 'public', 'index.html');
  const rootPath = path.join(__dirname, 'index.html');
  if (fs.existsSync(publicPath)) {
    res.sendFile(publicPath);
  } else if (fs.existsSync(rootPath)) {
    res.sendFile(rootPath);
  } else {
    res.send('<h1>AlagioStore Server</h1><p>index.html not found. Upload it to /public/ folder.</p>');
  }
});

// ── Хранилище заказов (файл, чтобы не терять при рестарте) ──
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
function loadOrders() {
  try { return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8')); } catch { return []; }
}
function saveOrders(orders) {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
}

// ── Хранилище прайс-листа ──
const PRICELIST_FILE = path.join(DATA_DIR, 'pricelist.json');
function loadPriceList() {
  try { return JSON.parse(fs.readFileSync(PRICELIST_FILE, 'utf8')); } catch { return {}; }
}
function savePriceList(data) {
  fs.writeFileSync(PRICELIST_FILE, JSON.stringify(data, null, 2));
}

// ── Хранилище инвентаря ──
const INVENTORY_FILE = path.join(DATA_DIR, 'inventory.json');
function loadInventory() {
  try { return JSON.parse(fs.readFileSync(INVENTORY_FILE, 'utf8')); } catch { return []; }
}
function saveInventory(inv) {
  fs.writeFileSync(INVENTORY_FILE, JSON.stringify(inv, null, 2));
}

// ── Хранилище магазина ──
const SHOPSTOCK_FILE = path.join(DATA_DIR, 'shopstock.json');
function saveShopStockData(data) {
  fs.writeFileSync(SHOPSTOCK_FILE, JSON.stringify(data, null, 2));
}

const SHOWROOM_FILE = path.join(DATA_DIR, 'showroom.json');
function loadShowroom() {
  try { return JSON.parse(fs.readFileSync(SHOWROOM_FILE, 'utf8')); } catch { return []; }
}
function saveShowroom(data) {
  fs.writeFileSync(SHOWROOM_FILE, JSON.stringify(data, null, 2));
}

// ── Фото моделей (ключ "NAME||COLOR" → dataURL) ──
const MODEL_PHOTOS_FILE = path.join(DATA_DIR, 'model_photos.json');
function loadModelPhotos() {
  try { return JSON.parse(fs.readFileSync(MODEL_PHOTOS_FILE, 'utf8')); } catch { return {}; }
}
function saveModelPhotos(data) {
  fs.writeFileSync(MODEL_PHOTOS_FILE, JSON.stringify(data));
}
app.get('/api/model-photos', (req, res) => res.json(loadModelPhotos()));
app.post('/api/model-photos', (req, res) => {
  const incoming = req.body && req.body.photos ? req.body.photos : req.body;
  if (!incoming || typeof incoming !== 'object') return res.status(400).json({ error: 'photos обязателен' });
  const cur = loadModelPhotos();
  let added = 0;
  for (const k of Object.keys(incoming)) {
    if (incoming[k]) { cur[k] = incoming[k]; added++; }
  }
  saveModelPhotos(cur);
  res.json({ ok: true, count: Object.keys(cur).length, added });
});

app.get('/api/showroom', (req, res) => res.json(loadShowroom()));
app.post('/api/showroom', (req, res) => {
  const data = req.body;
  if (!Array.isArray(data)) return res.status(400).json({ error: 'Expected array' });
  saveShowroom(data);
  const v = bumpInvVersion();
  console.log(`🏛️ showroom сохранён: ${data.length} позиций (v${v})`);
  res.json({ ok: true, count: data.length, version: v });
});

function loadShopStock() {
  try { return JSON.parse(fs.readFileSync(SHOPSTOCK_FILE, 'utf8')); } catch { return []; }
}

// ── Telegram уведомление (с разделением по темам супергруппы) ──
// Темы форума Alagio Warehouse: chat_id -1004335682227
const TG_TOPICS = {
  transfer: 2,   // 📦 Перемещения
  shop_sale: 4,  // 🛍️ Заказы из магазина
  online: 6      // 🌐 Он-лайн заказы
};

async function sendTelegram(text, topic) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const threadId = TG_TOPICS[topic];

  // Telegram лимит 4096 символов — режем длинные сообщения по строкам
  const LIMIT = 3800;
  const parts = [];
  if ((text || '').length <= LIMIT) {
    parts.push(text);
  } else {
    let cur = '';
    for (const line of String(text).split('\n')) {
      if ((cur + '\n' + line).length > LIMIT) {
        if (cur) parts.push(cur);
        cur = line.length > LIMIT ? line.slice(0, LIMIT) : line;
      } else {
        cur = cur ? cur + '\n' + line : line;
      }
    }
    if (cur) parts.push(cur);
    parts.forEach((p, i) => { if (parts.length > 1) parts[i] = p + `\n<i>(часть ${i+1}/${parts.length})</i>`; });
  }

  let lastError = null;
  for (const part of parts) {
    const body = { chat_id: TELEGRAM_CHAT_ID, text: part, parse_mode: 'HTML' };
    if (threadId) body.message_thread_id = threadId;
    try {
      let res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      let data = await res.json();
      if (!data.ok && String(data.description || '').includes("can't parse entities")) {
        // Битый HTML в тексте — повторяем без разметки
        delete body.parse_mode;
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        data = await res.json();
      }
      if (!data.ok) {
        console.error('Telegram error:', data);
        lastError = data.description || 'unknown';
      }
    } catch (e) {
      console.error('Telegram send failed:', e.message);
      lastError = e.message;
    }
  }
  return { ok: !lastError, error: lastError };
}

// ── Верификация Shopify webhook ──
function verifyShopify(req) {
  if (!SHOPIFY_SECRET || SHOPIFY_SECRET === 'ВАШ_SHOPIFY_WEBHOOK_SECRET') return true; // dev mode
  const hmac = req.headers['x-shopify-hmac-sha256'];
  const hash = crypto
    .createHmac('sha256', SHOPIFY_SECRET)
    .update(req.body)
    .digest('base64');
  return hmac === hash;
}

// ── Найти товар по штрихкоду → склад → магазин ──
function findByBarcode(barcode) {
  if (!barcode) return null;
  const bc = String(barcode).trim();

  // 1. Ищем на складе по barcode
  const inv = loadInventory();
  const warehouseItem = inv.find(item =>
    item.barcode && String(item.barcode).trim() === bc && item.qty > 0
  );
  if (warehouseItem) {
    return { source: 'warehouse', location: warehouseItem.location, item: warehouseItem };
  }

  // 2. Шоурум — приоритетнее магазина
  const showroom = loadShowroom();
  const srItem = showroom.find(item =>
    item.barcode && String(item.barcode).trim() === bc && (item.qty||0) > 0
  );
  if (srItem) {
    return { source: 'showroom', location: 'Шоурум', item: srItem };
  }

  // 3. Ищем в магазине НАПРЯМУЮ (не завися от справочника barcodes.json)
  const shopStock = loadShopStock();
  const shopItem = shopStock.find(item =>
    item.barcode && String(item.barcode).trim() === bc && item.shopQty > 0
  );
  if (shopItem) {
    return { source: 'shop', location: 'Магазин', item: shopItem };
  }

  // 3. ШК известен системе (склад/магазин/справочник), но нигде нет в наличии
  const barcodes = loadBarcodes();
  const knownInRef = Object.keys(barcodes).some(k => String(barcodes[k]).trim() === bc);
  const knownInInv = inv.some(item => item.barcode && String(item.barcode).trim() === bc);
  const knownInShop = shopStock.some(item => item.barcode && String(item.barcode).trim() === bc);
  const knownInShowroom = showroom.some(item => item.barcode && String(item.barcode).trim() === bc);
  if (knownInRef || knownInInv || knownInShop || knownInShowroom) {
    return { source: 'none', location: '❌ нет в наличии', item: null };
  }

  return null;
}

// ── Найти товар на складе (fallback по названию+размеру) ──
function findInInventory(productName, size) {
  const inv = loadInventory();
  // Название с Shopify может быть длиннее: "Ogni Giorno suede sneaker" vs "Ogni Giorno"
  // Проверяем оба направления: имя из склада входит в название Shopify, или наоборот
  const nameShopify = productName.toLowerCase();
  const sz = String(size);

  const nameMatches = (inventoryName) => {
    const n = inventoryName.toLowerCase();
    return nameShopify.includes(n) || n.includes(nameShopify);
  };

  // Сначала склад
  const warehouseItem = inv.find(item =>
    nameMatches(item.name) &&
    String(item.size) === sz &&
    item.qty > 0
  );
  if (warehouseItem) return { source: 'warehouse', location: warehouseItem.location, item: warehouseItem };

  // Потом магазин
  const shopStock = loadShopStock();
  const shopItem = shopStock.find(item =>
    nameMatches(item.name) &&
    String(item.size) === sz &&
    item.shopQty > 0
  );
  if (shopItem) return { source: 'shop', location: 'Магазин', item: shopItem };

  return null;
}

// ── Пересчитать location для всех заказов у которых '❓ не найдено' ──
app.post('/api/orders/rematch', (req, res) => {
  const orders = loadOrders();
  let fixed = 0;
  orders.forEach(o => {
    if (!o.lineItems) return;
    o.lineItems.forEach(li => {
      if (li.location && !li.location.includes('не найдено')) return;
      const barcode = li.barcode || null;
      // Только по штрихкоду
      let found = barcode ? findByBarcode(barcode) : null;
      if (found) {
        const sourceLabel = found.source === 'shop' ? ' (Магазин)' : found.source === 'warehouse' ? ' (Склад)' : found.source === 'showroom' ? ' (Шоурум)' : '';
        li.location = found.location + sourceLabel;
        li.source = found.source;
        fixed++;
      }
    });
  });
  saveOrders(orders);
  res.json({ ok: true, fixed });
});

// ════════════════════════════════════════
// WEBHOOK: Shopify → новый заказ
// ════════════════════════════════════════
app.post('/webhook/shopify/orders', async (req, res) => {
  if (!verifyShopify(req)) {
    return res.status(401).send('Unauthorized');
  }

  let order;
  try {
    order = JSON.parse(req.body.toString());
  } catch {
    return res.status(400).send('Bad JSON');
  }

  const orders = loadOrders();
  const shopifyId = String(order.id);

  // Не дублируем
  if (orders.find(o => o.shopifyId === shopifyId)) {
    return res.status(200).send('Duplicate');
  }

  // Получаем штрихкоды через Shopify API по variant_id (вебхук не передаёт barcode)
  const tokenData = loadShopifyToken(); // { shop, token }
  if (!tokenData) console.log('⚠️ Shopify токен не найден — запрос ШК по variant_id невозможен');

  const getBarcodeForVariant = async (variantId) => {
    if (!variantId || !tokenData || !tokenData.token || !tokenData.shop) return null;
    try {
      const r = await fetch(`https://${tokenData.shop}/admin/api/2024-04/variants/${variantId}.json`, {
        headers: { 'X-Shopify-Access-Token': tokenData.token }
      });
      if (!r.ok) { console.log(`⚠️ Variant API ${r.status} для ${variantId}`); return null; }
      const d = await r.json();
      return d.variant?.barcode || null;
    } catch(e) { console.log(`⚠️ Variant API ошибка: ${e.message}`); return null; }
  };

  // Формируем позиции заказа
  const lineItemsRaw = order.line_items || [];
  const lineItems = [];
  for (const item of lineItemsRaw) {
    const size = extractSize(item);
    // Сначала пробуем штрихкод из вебхука, потом запрашиваем через API
    let barcode = item.barcode || null;
    if (!barcode && item.variant_id) {
      barcode = await getBarcodeForVariant(item.variant_id);
      if (barcode) console.log(`  🔍 Штрихкод получен через API для variant ${item.variant_id}: ${barcode}`);
    }

    console.log(`📦 Позиция заказа: "${item.title}" | size: ${size} | barcode: ${barcode} | variant_id: ${item.variant_id}`);

    // Ищем ТОЛЬКО по штрихкоду
    let found = barcode ? findByBarcode(barcode) : null;
    if (found) console.log(`  ✅ Найдено по штрихкоду ${barcode}: ${found.location}`);
    else console.log(`  ❌ Не найдено: barcode=${barcode}`);

    const source = found ? found.source : null;
    const location = found ? found.location : '❓ не найдено';
    const sourceLabel = source === 'shop' ? ' (Магазин)' : source === 'warehouse' ? ' (Склад)' : source === 'showroom' ? ' (Шоурум)' : '';

    lineItems.push({
      title: item.title,
      variant: item.variant_title || '',
      sku: item.sku || '',
      barcode: barcode || '',
      qty: item.quantity,
      size,
      source: source || 'none',
      location: location + sourceLabel
    });
  }

  const newOrder = {
    id: `ORD-${Date.now()}`,
    shopifyId,
    shopifyOrderName: order.name || `#${shopifyId}`,
    customer: `${order.shipping_address?.first_name || ''} ${order.shipping_address?.last_name || ''}`.trim() || order.email || 'Покупатель',
    email: order.email || '',
    phone: order.phone || order.shipping_address?.phone || order.billing_address?.phone || '',
    address: formatAddress(order.shipping_address),
    // Структурированный адрес для FedEx
    shippingAddress: order.shipping_address ? {
      firstName: order.shipping_address.first_name || '',
      lastName: order.shipping_address.last_name || '',
      phone: order.shipping_address.phone || order.phone || order.billing_address?.phone || '',
      address1: order.shipping_address.address1 || '',
      address2: order.shipping_address.address2 || '',
      city: order.shipping_address.city || '',
      zip: order.shipping_address.zip || '',
      provinceCode: order.shipping_address.province_code || '',
      countryCode: order.shipping_address.country_code || 'IT'
    } : null,
    lineItems,
    total: order.total_price ? `${order.total_price} ${order.currency}` : '',
    status: 'new',
    createdAt: new Date().toISOString(),
    time: new Date().toLocaleString('ru-RU')
  };

  orders.unshift(newOrder);
  saveOrders(orders);

  // Telegram уведомление
  const itemsText = lineItems.map(li => {
    const srcIcon = li.source === 'warehouse' ? '🏭' : li.source === 'shop' ? '🛍️' : '❓';
    return `  • <b>${li.title}</b>${li.size ? ` EU${li.size}` : ''} × ${li.qty}\n    ${srcIcon} <code>${li.location}</code>${li.barcode ? ` · ${li.barcode}` : ''}`;
  }).join('\n');

  await sendTelegram(
    `🛒 <b>Новый заказ ${newOrder.shopifyOrderName}</b>\n` +
    `👤 ${newOrder.customer}\n` +
    `📍 ${newOrder.address}\n\n` +
    `${itemsText}\n\n` +
    `💰 ${newOrder.total}\n` +
    `🔗 Открыть склад: ${process.env.APP_URL || 'http://localhost:3000'}`
  , 'online');

  // Пишем в историю
  addHistoryEvent({
    type: 'order_created',
    orderId: newOrder.id,
    shopifyOrderName: newOrder.shopifyOrderName,
    customer: newOrder.customer,
    phone: newOrder.phone,
    email: newOrder.email,
    address: newOrder.address,
    total: newOrder.total,
    items: newOrder.lineItems.map(li => ({
      title: li.title, size: li.size, qty: li.qty,
      barcode: li.barcode || '', location: li.location, source: li.source
    }))
  });

  console.log(`✅ Новый заказ: ${newOrder.shopifyOrderName}`);
  res.status(200).send('OK');
});

// ── Вспомогательные функции ──
function extractSize(item) {
  // Ищем размер в вариантах (EU 38, size: 39, etc.)
  const text = [item.variant_title, item.title, item.sku].join(' ');
  const match = text.match(/\b(3[5-9]|4[0-2])\b/);
  return match ? match[1] : '';
}

function formatAddress(addr) {
  if (!addr) return '—';
  return [addr.address1, addr.city, addr.country].filter(Boolean).join(', ');
}

// ════════════════════════════════════════
// API: Получить заказы
// ════════════════════════════════════════
app.get('/api/orders', (req, res) => {
  res.json(loadOrders());
});

// ── Исправить позицию в заказе ──
app.post('/api/orders/:id/fix-line', (req, res) => {
  const orders = loadOrders();
  const order = orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  const { lineIdx, barcode, location } = req.body;
  if (!order.lineItems || !order.lineItems[lineIdx]) return res.status(400).json({ error: 'Invalid lineIdx' });
  if (barcode) order.lineItems[lineIdx].barcode = String(barcode);
  if (location) order.lineItems[lineIdx].location = location;
  saveOrders(orders);
  res.json({ ok: true });
});

// ── Переотправить уведомление в Telegram ──
app.post('/api/orders/:id/notify', async (req, res) => {
  const orders = loadOrders();
  const order = orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found' });

  const itemsText = (order.lineItems || []).map(li => {
    const srcIcon = li.source === 'warehouse' ? '🏭' : li.source === 'shop' ? '🛍️' : '📦';
    return `  • <b>${li.title}</b>${li.size ? ` EU${li.size}` : ''} × ${li.qty}\n    ${srcIcon} <code>${li.location}</code>${li.barcode ? ` · ${li.barcode}` : ''}`;
  }).join('\n');

  await sendTelegram(
    `🛒 <b>${order.shopifyOrderName} (повтор)</b>\n` +
    `👤 ${order.customer}\n` +
    `📍 ${order.address}\n\n` +
    `${itemsText}\n\n` +
    `💰 ${order.total}`
  , 'online');
  res.json({ ok: true });
});

// ════════════════════════════════════════
// API: Отгрузить заказ (списать остатки)
// ════════════════════════════════════════
// Списание по позициям заказа + закрытие. Используется ручным fulfill и авто-fulfill по забору FedEx.
async function fulfillOrderCore(order, orders, opts = {}) {
  const inv = loadInventory();
  const shop = loadShopStock();
  const showroom = loadShowroom();
  const results = [];
  const source = order.source || 'shopify'; // 'manual'/'shopify' — для ручных смотрим source

  for (const li of order.lineItems) {
    const isShopSource = li.location && li.location.includes('Магазин') && !li.location.includes('Склад');
    const isShowroomSource = li.location && li.location.includes('Шоурум');

    if (isShowroomSource) {
      // Списываем из шоурума по ШК
      const srItem = showroom.find(i => li.barcode && String(i.barcode) === String(li.barcode));
      if (srItem && (srItem.qty||0) >= li.qty) {
        srItem.qty -= li.qty;
        results.push(`✅ ${li.title} EU${li.size} из шоурума — списано ${li.qty} пар`);
      } else if (srItem) {
        results.push(`⚠️ ${li.title} EU${li.size} — недостаточно в шоуруме (есть: ${srItem.qty||0})`);
      } else {
        results.push(`⚠️ ${li.title} EU${li.size} — не найдено в шоуруме`);
      }
    } else if (isShopSource) {
      // Списываем из магазина — ищем по штрихкоду или по имени+размеру
      console.log(`🔍 Ищем в магазине: barcode=${li.barcode} size=${li.size} title=${li.title}`);
      console.log(`📦 Всего в shopstock: ${shop.length} позиций`);
      const shopItem = shop.find(i => {
        // Сначала по штрихкоду
        if (li.barcode && String(i.barcode) === String(li.barcode)) return true;
        return false;
      });
      if (shopItem && shopItem.shopQty >= li.qty) {
        shopItem.shopQty -= li.qty;
        results.push(`✅ ${li.title} EU${li.size} из магазина — списано ${li.qty} пар`);
      } else if (shopItem) {
        results.push(`⚠️ ${li.title} EU${li.size} — недостаточно в магазине (есть: ${shopItem.shopQty})`);
      } else {
        results.push(`⚠️ ${li.title} EU${li.size} — не найдено в магазине`);
      }
    } else {
      // Списываем со склада — ПРИОРИТЕТ: точная ячейка, записанная в заказе при подборе
      const locFromOrder = (li.location || '').replace(/\s*\((Склад|Магазин|Шоурум)\)\s*$/,'').trim();

      let item = null;
      // 1. По ШК + ячейке из заказа (именно то, что показали сборщику)
      if (li.barcode && locFromOrder) {
        item = inv.find(i => String(i.barcode) === String(li.barcode) && i.location === locFromOrder && i.qty >= li.qty);
      }
      // 2. По ячейке из заказа (запись без ШК)
      if (!item && locFromOrder) {
        item = inv.find(i => i.location === locFromOrder && String(i.size) === String(li.size) && i.qty >= li.qty &&
          i.name.toLowerCase().includes(li.title.split(' ')[0].toLowerCase()));
      }
      // 3. По ШК — первая с достаточным остатком (как ищет подбор)
      if (!item && li.barcode) {
        item = inv.find(i => String(i.barcode) === String(li.barcode) && i.qty >= li.qty);
      }
      // 4. Последний резерв: по имени+размеру
      if (!item) {
        item = inv.find(i =>
          i.name.toLowerCase().includes(li.title.split(' ')[0].toLowerCase()) &&
          String(i.size) === String(li.size) &&
          i.qty >= li.qty
        );
      }

      if (item) {
        item.qty -= li.qty;
        results.push(`✅ ${li.title} EU${li.size} с ${item.location} — списано ${li.qty} пар`);
      } else {
        results.push(`⚠️ ${li.title} EU${li.size} — не найдено на складе`);
      }
    }
  }

  order.status = 'done';
  order.fulfilledAt = new Date().toISOString();
  saveOrders(orders);
  saveInventory(inv);
  saveShopStockData(shop);
  saveShowroom(showroom);

  // Пишем в историю
  addHistoryEvent({
    type: 'order_fulfilled',
    orderId: order.id,
    shopifyOrderName: order.shopifyOrderName,
    customer: order.customer,
    fulfilledAt: order.fulfilledAt,
    results,
    items: order.lineItems.map(li => ({
      title: li.title, size: li.size, qty: li.qty, location: li.location
    }))
  });

  // Уведомление в Telegram
  await sendTelegram(
    (opts.reason ? opts.reason + '\n' : '') +
    `✅ <b>Заказ ${order.shopifyOrderName} отгружен</b>\n\n` +
    results.join('\n')
  , 'online');

  return results;
}

app.post('/api/orders/:id/fulfill', async (req, res) => {
  const orders = loadOrders();
  const order = orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status === 'done' && order.fulfilledAt) return res.status(400).json({ error: 'Already fulfilled' });
  try {
    const results = await fulfillOrderCore(order, orders);
    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════
// API: Инвентарь (чтение и запись)
// ════════════════════════════════════════
// ── Версия инвентаря (защита от затирания при работе с нескольких устройств) ──
const INV_VERSION_FILE = path.join(DATA_DIR, 'inventory_version.json');
function loadInvVersion() {
  try { return JSON.parse(fs.readFileSync(INV_VERSION_FILE, 'utf8')).v || 0; } catch { return 0; }
}
function saveInvVersion(v) {
  fs.writeFileSync(INV_VERSION_FILE, JSON.stringify({ v, ts: new Date().toISOString() }));
}
function bumpInvVersion() {
  const v = loadInvVersion() + 1;
  saveInvVersion(v);
  return v;
}

app.get('/api/inventory', (req, res) => {
  res.json(loadInventory());
});

// Инвентарь + версия одним запросом
app.get('/api/inventory/versioned', (req, res) => {
  res.json({ version: loadInvVersion(), inventory: loadInventory() });
});

// Патч штрихкодов в shopstock по name+material+color+size
app.post('/api/shopstock/patch-barcodes', (req, res) => {
  const { updates } = req.body;
  if (!updates || !Array.isArray(updates)) return res.status(400).json({ error: 'updates required' });
  const shop = loadShopStock();
  const results = [];
  updates.forEach(u => {
    const item = shop.find(i =>
      i.name === u.name &&
      (i.material||'') === (u.material||'') &&
      i.color === u.color &&
      String(i.size||'') === String(u.size||'')
    );
    if (item) {
      const old = item.barcode;
      item.barcode = u.barcode;
      results.push(`✅ ${u.name} ${u.color} EU${u.size}: ${old} → ${u.barcode}`);
    } else {
      results.push(`⚠️ Не найдено: ${u.name} ${u.color} EU${u.size}`);
    }
  });
  saveShopStockData(shop);
  res.json({ ok: true, results });
});

// Патч штрихкодов в inventory по name+material+color+size
app.post('/api/inventory/patch-barcodes', (req, res) => {
  const { updates } = req.body;
  if (!updates || !Array.isArray(updates)) return res.status(400).json({ error: 'updates required' });
  const inv = loadInventory();
  const results = [];
  updates.forEach(u => {
    const items = inv.filter(i =>
      i.name === u.name &&
      (i.material||'') === (u.material||'') &&
      i.color === u.color &&
      String(i.size||'') === String(u.size||'')
    );
    if (items.length > 0) {
      items.forEach(i => { i.barcode = u.barcode; });
      results.push(`✅ ${u.name} ${u.color} EU${u.size} (${items.length} ячеек): → ${u.barcode}`);
    } else {
      results.push(`⚠️ Не найдено: ${u.name} ${u.color} EU${u.size}`);
    }
  });
  saveInventory(inv);
  res.json({ ok: true, results });
});

// Патч конкретной позиции по id
app.post('/api/inventory/patch', (req, res) => {
  const { id, qty } = req.body;
  if (!id || qty === undefined) return res.status(400).json({ error: 'id and qty required' });
  const inv = loadInventory();
  const item = inv.find(i => i.id === id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  const oldQty = item.qty;
  item.qty = qty;
  saveInventory(inv);
  res.json({ ok: true, id, oldQty, newQty: qty, name: item.name, color: item.color, size: item.size });
});

app.post('/api/inventory', (req, res) => {
  // Поддерживаем два формата:
  //  старый: [items]  — без проверки версии (для совместимости)
  //  новый:  { baseVersion, inventory } — с optimistic locking
  const body = req.body;

  if (Array.isArray(body)) {
    // Старый клиент — сохраняем как раньше, но версию всё равно двигаем
    saveInventory(body);
    const v = bumpInvVersion();
    return res.json({ ok: true, count: body.length, version: v });
  }

  const { baseVersion, inventory: inv } = body || {};
  if (!Array.isArray(inv)) return res.status(400).json({ error: 'Expected array' });

  const serverVersion = loadInvVersion();
  if (typeof baseVersion === 'number' && baseVersion !== serverVersion) {
    // Клиент отталкивался от устаревших данных — отклоняем, отдаём свежие
    console.log(`🛡️ Инвентарь: конфликт версий (клиент ${baseVersion}, сервер ${serverVersion}) — сохранение отклонено`);
    return res.status(409).json({
      ok: false,
      error: 'version_conflict',
      version: serverVersion,
      inventory: loadInventory()
    });
  }

  saveInventory(inv);
  const v = bumpInvVersion();
  res.json({ ok: true, count: inv.length, version: v });
});

// ════════════════════════════════════════
// API: Удалить заказ
// ════════════════════════════════════════
app.delete('/api/orders/:id', (req, res) => {
  const orders = loadOrders();
  const filtered = orders.filter(o => o.id !== req.params.id);
  if (filtered.length === orders.length) return res.status(404).json({ error: 'Not found' });
  saveOrders(filtered);
  console.log(`🗑 Заказ удалён: ${req.params.id}`);
  res.json({ ok: true });
});

// ════════════════════════════════════════
// ИСТОРИЯ СОБЫТИЙ (аналитика)
// ════════════════════════════════════════
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch { return []; }
}
function saveHistory(data) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2));
}
function addHistoryEvent(event) {
  const history = loadHistory();
  history.push({
    ...event,
    ts: new Date().toISOString()
  });
  saveHistory(history);
}

// Получить историю (с фильтрами)
app.get('/api/history', (req, res) => {
  let history = loadHistory();
  const { type, from, to, limit } = req.query;
  if (type) history = history.filter(e => e.type === type);
  if (from) history = history.filter(e => e.ts >= from);
  if (to)   history = history.filter(e => e.ts <= to);
  history = history.sort((a, b) => b.ts.localeCompare(a.ts));
  if (limit) history = history.slice(0, parseInt(limit));
  res.json(history);
});

// Записать событие в историю
app.post('/api/history', (req, res) => {
  const event = req.body;
  if (!event || !event.type) return res.status(400).json({ error: 'Missing type' });
  addHistoryEvent(event);
  res.json({ ok: true });
});

// ════════════════════════════════════════
// API: Магазин (shopstock)
// ════════════════════════════════════════
const SHOPSTOCK_FILE2 = path.join(DATA_DIR, 'shopstock.json');

app.get('/api/shopstock', (req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(SHOPSTOCK_FILE2, 'utf8'))); }
  catch { res.json([]); }
});

app.post('/api/shopstock', (req, res) => {
  const data = req.body;
  if (!Array.isArray(data)) return res.status(400).json({ error: 'Expected array' });
  fs.writeFileSync(SHOPSTOCK_FILE2, JSON.stringify(data, null, 2));
  res.json({ ok: true, count: data.length });
});

// ════════════════════════════════════════
// API: Синхронизация заказов (полная запись)
// ════════════════════════════════════════
app.post('/api/orders/sync', (req, res) => {
  const data = req.body;
  if (!Array.isArray(data)) return res.status(400).json({ error: 'Expected array' });

  // МЕРДЖ вместо перезаписи: защищаем свежие вебхук-заказы от затирания
  // старым списком из браузера (гонка: заказ пришёл на сервер, а браузер
  // ещё его не видел и отправил свой список без него)
  const current = loadOrders();
  const sentIds = new Set(data.map(o => String(o.id)));
  const tenMinAgo = Date.now() - 10 * 60 * 1000;

  const preserved = current.filter(o => {
    if (sentIds.has(String(o.id))) return false; // есть в присланном — берём версию браузера
    if (!o.shopifyId) return false; // не вебхук-заказ (ручной/продажа) — браузер главный, удаление законно
    const createdAt = o.createdAt ? new Date(o.createdAt).getTime() : 0;
    return createdAt > tenMinAgo; // свежий вебхук-заказ, браузер его ещё не видел — сохраняем
  });

  if (preserved.length > 0) {
    console.log(`🛡️ Защищено от затирания ${preserved.length} свежих вебхук-заказов`);
  }

  const merged = [...preserved, ...data];
  saveOrders(merged);
  res.json({ ok: true, count: merged.length, preserved: preserved.length });
});

// ════════════════════════════════════════
// SHOPIFY OAUTH
// ════════════════════════════════════════
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID || '';
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || '';
const SHOPIFY_SCOPES = 'read_products,write_products,read_inventory,write_inventory';
const APP_URL = process.env.APP_URL || 'https://alagio-warehouse-production.up.railway.app';

// Шаг 1: Редирект на Shopify для авторизации
app.get('/auth/shopify', (req, res) => {
  const shop = req.query.shop || 'alagio-2.myshopify.com';
  const redirectUri = `${APP_URL}/auth/shopify/callback`;
  const installUrl = `https://${shop}/admin/oauth/authorize?client_id=${SHOPIFY_CLIENT_ID}&scope=${SHOPIFY_SCOPES}&redirect_uri=${redirectUri}`;
  res.redirect(installUrl);
});

// Шаг 2: Callback — получаем токен
app.get('/auth/shopify/callback', async (req, res) => {
  const { shop, code } = req.query;
  if (!shop || !code) return res.status(400).send('Missing shop or code');

  try {
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: SHOPIFY_CLIENT_ID,
        client_secret: SHOPIFY_CLIENT_SECRET,
        code
      })
    });
    const data = await tokenRes.json();
    const token = data.access_token;

    if (!token) return res.status(400).send('Failed to get token: ' + JSON.stringify(data));

    // Сохраняем токен
    const tokenFile = path.join(DATA_DIR, 'shopify_token.json');
    fs.writeFileSync(tokenFile, JSON.stringify({ shop, token }, null, 2));
    console.log(`✅ Shopify токен получен для ${shop}`);

    res.send(`<h2>✅ Успешно!</h2><p>Токен для ${shop} сохранён.</p><p>Теперь можно закрыть эту страницу.</p>`);
  } catch(e) {
    res.status(500).send('Error: ' + e.message);
  }
});

// Получить сохранённый токен
function loadShopifyToken() {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'shopify_token.json'), 'utf8'));
    return data;
  } catch { return null; }
}

// Проверить токен
app.get('/auth/shopify/token', (req, res) => {
  const data = loadShopifyToken();
  if (!data) return res.json({ ok: false, message: 'Токен не найден' });
  res.json({ ok: true, shop: data.shop, token: data.token.substring(0, 8) + '...' });
});

// ════════════════════════════════════════
// SHOPIFY INVENTORY SYNC
// ════════════════════════════════════════

// Посмотреть локации магазина
app.get('/api/shopify/locations', async (req, res) => {
  const tokenData = loadShopifyToken();
  if (!tokenData) return res.status(400).json({ error: 'Не авторизован' });
  const { shop, token } = tokenData;
  const r = await fetch(`https://${shop}/admin/api/2024-04/locations.json`, {
    headers: { 'X-Shopify-Access-Token': token }
  });
  res.json(await r.json());
});

// Тест синхронизации одного штрихкода
app.get('/api/shopify/sync-one', async (req, res) => {
  const tokenData = loadShopifyToken();
  if (!tokenData) return res.status(400).json({ error: 'Shopify не авторизован' });

  const { barcode } = req.query;
  if (!barcode) return res.status(400).json({ error: 'Укажите ?barcode=...' });

  const { shop, token } = tokenData;
  const headers = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };

  try {
    // Ищем вариант по штрихкоду — перебираем страницы если нужно
    let variants = [];
    let page_info = null;
    do {
      const url = page_info
        ? `https://${shop}/admin/api/2024-04/variants.json?limit=250&page_info=${page_info}`
        : `https://${shop}/admin/api/2024-04/variants.json?barcode=${barcode}&limit=250`;
      const searchRes = await fetch(url, { headers });
      const searchData = await searchRes.json();
      variants = variants.concat(searchData.variants || []);
      // Проверяем Link header для пагинации
      const link = searchRes.headers.get('Link') || '';
      const nextMatch = link.match(/<[^>]*page_info=([^>&]+)[^>]*>;\s*rel="next"/);
      page_info = nextMatch ? nextMatch[1] : null;
    } while (page_info && variants.length < 500);

    // Фильтруем по штрихкоду (на случай если API вернул лишнее)
    const matched = variants.filter(v => v.barcode === barcode);

    if (!matched.length) {
      // Попробуем через GraphQL поиск
      return res.json({ ok: false, message: `Штрихкод ${barcode} не найден в Shopify` });
    }

    // Берём первый найденный вариант
    const variant = matched[0];

    // Получаем location
    const locRes = await fetch(`https://${shop}/admin/api/2024-04/locations.json`, { headers });
    const locData = await locRes.json();
    const locationId = locData.locations?.[0]?.id;

    // Текущий остаток
    const invRes = await fetch(
      `https://${shop}/admin/api/2024-04/inventory_levels.json?inventory_item_ids=${variant.inventory_item_id}&location_ids=${locationId}`,
      { headers }
    );
    const invData = await invRes.json();
    const currentQty = invData.inventory_levels?.[0]?.available ?? '?';

    // Считаем сводные остатки (склад + магазин)
    const inv = loadInventory();
    const shopStockData = loadShopStock();
    const warehouseQty = inv.filter(i => String(i.barcode) === String(barcode)).reduce((s, i) => s + i.qty, 0);
    const shopQty = shopStockData.filter(i => String(i.barcode) === String(barcode)).reduce((s, i) => s + (i.shopQty||0), 0);
    const newQty = warehouseQty + shopQty;

    res.json({
      ok: true,
      barcode,
      variantTitle: variant.title,
      productId: variant.product_id,
      currentQtyShopify: currentQty,
      newQtyWarehouse: newQty,
      warehouseQty,
      shopQty,
      willChange: currentQty !== newQty,
      message: `Текущий остаток в Shopify: ${currentQty} → Новый: ${newQty} (склад: ${warehouseQty} + магазин: ${shopQty})`
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Применить синхронизацию одного штрихкода
app.get('/api/shopify/sync-one/apply', async (req, res) => {
  const tokenData = loadShopifyToken();
  if (!tokenData) return res.status(400).json({ error: 'Shopify не авторизован' });

  const { barcode } = req.query;
  if (!barcode) return res.status(400).json({ error: 'Укажите ?barcode=...' });

  const { shop, token } = tokenData;
  const headers = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };

  try {
    let allVariants = [];
    let pi = null;
    do {
      const url = pi
        ? `https://${shop}/admin/api/2024-04/variants.json?limit=250&page_info=${pi}`
        : `https://${shop}/admin/api/2024-04/variants.json?barcode=${barcode}&limit=250`;
      const sr = await fetch(url, { headers });
      const sd = await sr.json();
      allVariants = allVariants.concat(sd.variants || []);
      const lnk = sr.headers.get('Link') || '';
      const nm = lnk.match(/<[^>]*page_info=([^>&]+)[^>]*>;\s*rel="next"/);
      pi = nm ? nm[1] : null;
    } while (pi && allVariants.length < 500);

    const matched = allVariants.filter(v => v.barcode === barcode);
    if (!matched.length) return res.json({ ok: false, message: 'Не найден в Shopify' });

    const variant = matched[0];
    const locRes = await fetch(`https://${shop}/admin/api/2024-04/locations.json`, { headers });
    const locationId = (await locRes.json()).locations?.[0]?.id;

    const inv = loadInventory();
    const shopStockData = loadShopStock();
    const warehouseQty = inv.filter(i => String(i.barcode) === String(barcode)).reduce((s, i) => s + i.qty, 0);
    const shopQty = shopStockData.filter(i => String(i.barcode) === String(barcode)).reduce((s, i) => s + (i.shopQty||0), 0);
    const newQty = warehouseQty + shopQty;

    const setRes = await fetch(`https://${shop}/admin/api/2024-04/inventory_levels/set.json`, {
      method: 'POST', headers,
      body: JSON.stringify({ location_id: locationId, inventory_item_id: variant.inventory_item_id, available: newQty })
    });
    const setData = await setRes.json();

    if (setData.inventory_level) {
      res.json({ ok: true, barcode, newQty, message: `✅ Обновлено! Остаток: ${newQty}` });
    } else {
      res.json({ ok: false, error: setData });
    }
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Проверить штрихкоды — что найдётся в Shopify (без изменений)
app.get('/api/shopify/check', async (req, res) => {
  const tokenData = loadShopifyToken();
  if (!tokenData) return res.status(400).json({ error: 'Shopify не авторизован' });

  const { shop, token } = tokenData;
  const headers = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };

  // Берём все штрихкоды из инвентаря
  const inv = loadInventory();
  const barcodeQty = {};
  inv.forEach(item => {
    if (item.barcode && item.qty > 0) {
      barcodeQty[item.barcode] = (barcodeQty[item.barcode] || 0) + item.qty;
    }
  });

  const results = [];
  let found = 0, notFound = 0;

  for (const [barcode, qty] of Object.entries(barcodeQty)) {
    try {
      const searchRes = await fetch(
        `https://${shop}/admin/api/2024-04/variants.json?barcode=${barcode}&limit=1`,
        { headers }
      );
      const searchData = await searchRes.json();
      const variant = searchData.variants?.[0];

      if (variant) {
        // Получаем текущий остаток
        const invRes = await fetch(
          `https://${shop}/admin/api/2024-04/inventory_levels.json?inventory_item_ids=${variant.inventory_item_id}`,
          { headers }
        );
        const invData = await invRes.json();
        const currentQty = invData.inventory_levels?.[0]?.available ?? '?';

        results.push({
          barcode,
          productTitle: variant.title,
          currentQtyShopify: currentQty,
          newQtyWarehouse: qty,
          willChange: currentQty !== qty
        });
        found++;
      } else {
        results.push({ barcode, status: 'NOT FOUND IN SHOPIFY', newQtyWarehouse: qty });
        notFound++;
      }
    } catch(e) {
      results.push({ barcode, status: 'ERROR', detail: e.message });
    }
  }

  res.json({
    summary: { total: Object.keys(barcodeQty).length, found, notFound },
    results
  });
});

// Синхронизировать остатки в Shopify по штрихкоду
app.post('/api/shopify/sync', async (req, res) => {
  const tokenData = loadShopifyToken();
  if (!tokenData) return res.status(400).json({ error: 'Shopify не авторизован. Пройдите /auth/shopify' });

  const { shop, token } = tokenData;
  const { items } = req.body; // [{ barcode, qty }]

  if (!items || !items.length) return res.status(400).json({ error: 'No items' });

  const headers = {
    'X-Shopify-Access-Token': token,
    'Content-Type': 'application/json'
  };

  const results = [];
  let synced = 0, errors = 0;

  // Получаем location_id один раз
  const locRes = await fetch(`https://${shop}/admin/api/2024-04/locations.json`, { headers });
  const locData = await locRes.json();
  const locationId = locData.locations?.[0]?.id;
  if (!locationId) return res.status(400).json({ error: 'No location found' });

  // Задержка между запросами чтобы не словить throttling
  const delay = ms => new Promise(r => setTimeout(r, ms));

  for (const item of items) {
    try {
      // Ищем вариант по штрихкоду — с retry при 429
      let allVariants = [];
      let pi = null;
      do {
        const url = pi
          ? `https://${shop}/admin/api/2024-04/variants.json?limit=250&page_info=${pi}`
          : `https://${shop}/admin/api/2024-04/variants.json?barcode=${item.barcode}&limit=250`;
        let sr = await fetch(url, { headers });
        if (sr.status === 429) {
          const retryAfter = parseFloat(sr.headers.get('Retry-After') || '2');
          console.log(`⏳ Rate limit — ждём ${retryAfter}с`);
          await delay(retryAfter * 1000 + 500);
          sr = await fetch(url, { headers }); // повтор
        }
        if (sr.status === 429) { errors++; results.push({ barcode: item.barcode, status: 'throttled' }); break; }
        const sd = await sr.json();
        allVariants = allVariants.concat(sd.variants || []);
        const lnk = sr.headers.get('Link') || '';
        const nm = lnk.match(/page_info=([^>&"]+)[^>]*>;\s*rel="next"/);
        pi = nm ? nm[1] : null;
      } while (pi && allVariants.length < 500);

      const matched = allVariants.filter(v => String(v.barcode) === String(item.barcode));
      const variant = matched[0];

      if (!variant) {
        results.push({ barcode: item.barcode, status: 'not_found' });
        errors++;
        await delay(100);
        continue;
      }

      // Обновляем количество
      const setRes = await fetch(`https://${shop}/admin/api/2024-04/inventory_levels/set.json`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          location_id: locationId,
          inventory_item_id: variant.inventory_item_id,
          available: item.qty
        })
      });

      if (setRes.status === 429) {
        const retryAfter = parseFloat(setRes.headers.get('Retry-After') || '2');
        console.log(`⏳ Rate limit на set — ждём ${retryAfter}с`);
        await delay(retryAfter * 1000 + 500);
        // Повторная попытка
        const setRes2 = await fetch(`https://${shop}/admin/api/2024-04/inventory_levels/set.json`, {
          method: 'POST', headers,
          body: JSON.stringify({ location_id: locationId, inventory_item_id: variant.inventory_item_id, available: item.qty })
        });
        if (setRes2.ok) { synced++; results.push({ barcode: item.barcode, qty: item.qty, status: 'ok' }); continue; }
        errors++;
        results.push({ barcode: item.barcode, status: 'throttled' });
        continue;
      }

      const setData = await setRes.json();
      if (setData.inventory_level) {
        results.push({ barcode: item.barcode, qty: item.qty, status: 'ok' });
        synced++;
      } else {
        results.push({ barcode: item.barcode, status: 'error', detail: JSON.stringify(setData) });
        errors++;
      }

      // Пауза между запросами — 600ms чтобы не превышать 2 req/sec лимит Shopify
      await delay(600);

    } catch(e) {
      results.push({ barcode: item.barcode, status: 'exception', detail: e.message });
      errors++;
    }
  }

  // Сохраняем успешно синхронизированные значения как "последние отправленные"
  const qtyUpdate = {};
  results.filter(r => r.status === 'ok').forEach(r => {
    qtyUpdate[r.barcode] = r.qty;
  });
  if (Object.keys(qtyUpdate).length > 0) {
    const current = loadQty();
    Object.assign(current, qtyUpdate);
    saveQty(current);
  }

  console.log(`📦 Shopify sync: ${synced} обновлено, ${errors} ошибок`);
  res.json({ ok: true, synced, errors, results });
});

// Debug: сколько вариантов с этим штрихкодом
app.get('/api/shopify/debug-barcode', async (req, res) => {
  const tokenData = loadShopifyToken();
  if (!tokenData) return res.status(400).json({ error: 'Не авторизован' });
  const { shop, token } = tokenData;
  const { barcode } = req.query;
  const headers = { 'X-Shopify-Access-Token': token };
  
  let allVariants = [];
  let pi = null;
  do {
    const url = pi
      ? `https://${shop}/admin/api/2024-04/variants.json?limit=250&page_info=${pi}`
      : `https://${shop}/admin/api/2024-04/variants.json?barcode=${barcode}&limit=250`;
    const sr = await fetch(url, { headers });
    const sd = await sr.json();
    allVariants = allVariants.concat(sd.variants || []);
    const lnk = sr.headers.get('Link') || '';
    const nm = lnk.match(/page_info=([^>&"]+)[^>]*>; rel="next"/);
    pi = nm ? nm[1] : null;
  } while (pi && allVariants.length < 500);

  const matched = allVariants.filter(v => String(v.barcode) === String(barcode));
  
  // Для каждого получаем текущий остаток
  const locRes = await fetch(`https://${shop}/admin/api/2024-04/locations.json`, { headers });
  const locationId = (await locRes.json()).locations?.[0]?.id;
  
  const details = await Promise.all(matched.map(async v => {
    const invRes = await fetch(`https://${shop}/admin/api/2024-04/inventory_levels.json?inventory_item_ids=${v.inventory_item_id}&location_ids=${locationId}`, { headers });
    const invData = await invRes.json();
    return {
      variantId: v.id,
      productId: v.product_id,
      title: v.title,
      inventoryItemId: v.inventory_item_id,
      available: invData.inventory_levels?.[0]?.available ?? '?'
    };
  }));
  
  res.json({ barcode, found: matched.length, details });
});

// ── PWA файлы ──
app.get('/manifest.json', (req, res) => {
  res.sendFile(path.join(__dirname, 'manifest.json'));
});
app.get('/sw.js', (req, res) => {
  res.setHeader('Service-Worker-Allowed', '/');
  res.sendFile(path.join(__dirname, 'sw.js'));
});
app.get('/icon-192.png', (req, res) => {
  res.sendFile(path.join(__dirname, 'icon-192.png'));
});
app.get('/icon-512.png', (req, res) => {
  res.sendFile(path.join(__dirname, 'icon-512.png'));
});

// ════════════════════════════════════════
// API: Прайс-лист
// ════════════════════════════════════════
app.get('/api/pricelist', (req, res) => {
  res.json(loadPriceList());
});

// Полная замена прайса
app.post('/api/pricelist/full', (req, res) => {
  const { prices } = req.body || {};
  if (!prices || typeof prices !== 'object') return res.status(400).json({ error: 'prices required' });
  savePriceList(prices);
  res.json({ ok: true, count: Object.keys(prices).length });
});

// Обновить только присланные позиции
app.post('/api/pricelist/merge', (req, res) => {
  const { prices } = req.body || {};
  if (!prices || typeof prices !== 'object') return res.status(400).json({ error: 'prices required' });
  const current = loadPriceList();
  const merged = { ...current, ...prices };
  savePriceList(merged);
  res.json({ ok: true, count: Object.keys(merged).length });
});

// Очистить прайс
app.delete('/api/pricelist', (req, res) => {
  savePriceList({});
  res.json({ ok: true });
});

// ── Health check ──
app.get('/health', (req, res) => {
  res.json({ ok: true, orders: loadOrders().length, inventory: loadInventory().length, prices: Object.keys(loadPriceList()).length });
});

// ── Telegram proxy endpoint ──
// Определение темы по содержимому — страховка для старых клиентов без topic
function guessTopicFromText(text) {
  const t = (text || '').toUpperCase();
  if (t.includes('ПЕРЕМЕЩЕНИЕ') || t.includes('ОТПРАВЛЕН</B>') || t.includes('ПРИНЯТ') || t.includes('ТОВАР В ПУТИ')) return 'transfer';
  if (t.includes('ПРОДАЖА')) return 'shop_sale';
  if (t.includes('ЗАКАЗ') || t.includes('ВОЗВРАТ')) return 'online';
  return null;
}




// ════════════════════════════════════════
// B2B: оптовые заказы (выставки/шоурум)
// ════════════════════════════════════════
const B2B_CATALOG_FILE = path.join(DATA_DIR, 'b2b_catalog.json');
const B2B_ORDERS_FILE = path.join(DATA_DIR, 'b2b_orders.json');

function loadB2bCatalog() {
  try { return JSON.parse(fs.readFileSync(B2B_CATALOG_FILE, 'utf8')); } catch { return []; }
}
function saveB2bCatalog(d) { fs.writeFileSync(B2B_CATALOG_FILE, JSON.stringify(d, null, 2)); }
function loadB2bOrders() {
  try { return JSON.parse(fs.readFileSync(B2B_ORDERS_FILE, 'utf8')); } catch { return []; }
}
function saveB2bOrders(d) { fs.writeFileSync(B2B_ORDERS_FILE, JSON.stringify(d, null, 2)); }

app.get('/api/b2b/catalog', (req, res) => res.json(loadB2bCatalog()));
app.post('/api/b2b/catalog', (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ error: 'Expected array' });
  saveB2bCatalog(req.body);
  console.log(`🤝 B2B каталог сохранён: ${req.body.length} позиций`);
  res.json({ ok: true, count: req.body.length });
});

app.get('/api/b2b/orders', (req, res) => res.json(loadB2bOrders()));

// Сохранение ОДНОГО заказа (безопасно при работе двух людей одновременно)
app.post('/api/b2b/order', (req, res) => {
  const order = req.body;
  if (!order || !order.id) return res.status(400).json({ error: 'Expected order with id' });
  const orders = loadB2bOrders();
  const idx = orders.findIndex(o => o.id === order.id);
  if (idx >= 0) orders[idx] = order; else orders.push(order);
  saveB2bOrders(orders);
  console.log(`🤝 B2B заказ сохранён: ${order.id} (${order.customer?.company || '—'})`);
  res.json({ ok: true, count: orders.length });
});

app.post('/api/b2b/order/delete', (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'Expected id' });
  let orders = loadB2bOrders();
  orders = orders.filter(o => o.id !== id);
  saveB2bOrders(orders);
  console.log(`🤝 B2B заказ удалён: ${id}`);
  res.json({ ok: true, count: orders.length });
});
app.post('/api/b2b/orders', (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ error: 'Expected array' });
  saveB2bOrders(req.body);
  console.log(`🤝 B2B заказы сохранены: ${req.body.length}`);
  res.json({ ok: true, count: req.body.length });
});

// ════════════════════════════════════════
// FEDEX ИНТЕГРАЦИЯ (Ship + Pickup)
// ════════════════════════════════════════
const FEDEX_API_KEY = process.env.FEDEX_API_KEY || '';
const FEDEX_SECRET_KEY = process.env.FEDEX_SECRET_KEY || '';
// Отдельный проект FedEx для трекинга (Basic Integrated Visibility). Если не заданы — используем основной ключ.
const FEDEX_TRACK_API_KEY = process.env.FEDEX_TRACK_API_KEY || '';
const FEDEX_TRACK_SECRET_KEY = process.env.FEDEX_TRACK_SECRET_KEY || '';
const FEDEX_ACCOUNT = process.env.FEDEX_ACCOUNT_NUMBER || '';
const FEDEX_BASE = process.env.FEDEX_ENV === 'production'
  ? 'https://apis.fedex.com'
  : 'https://apis-sandbox.fedex.com';

const LABELS_DIR = path.join(DATA_DIR, 'labels');
if (!fs.existsSync(LABELS_DIR)) fs.mkdirSync(LABELS_DIR, { recursive: true });

// Три адреса отправки по источнику позиций
const FEDEX_SENDERS = {
  shop: {
    label: 'Магазин',
    contact: { personName: 'Maria Luneva', phoneNumber: process.env.FEDEX_PHONE_SHOP || '393333453828', companyName: 'Alagio' },
    address: { streetLines: ['Via Palermo 21'], city: 'Milano', postalCode: '20121', countryCode: 'IT' }
  },
  showroom: {
    label: 'Шоурум',
    contact: { personName: 'Maria Luneva', phoneNumber: process.env.FEDEX_PHONE_SHOWROOM || '393333453828', companyName: 'Alagio' },
    address: { streetLines: ['Corso Lodi 3'], city: 'Milano', postalCode: '20135', countryCode: 'IT' }
  },
  warehouse: {
    label: 'Склад',
    contact: { personName: 'Markin Kirill', phoneNumber: process.env.FEDEX_PHONE_WAREHOUSE || '393333453828', companyName: 'Alagio' },
    address: { streetLines: ['Via Castelfidardo 19'], city: 'Lodi', postalCode: '26900', countryCode: 'IT' }
  }
};

// OAuth токен с кэшем
let _fedexToken = null;
let _fedexTokenExp = 0;
async function getFedexToken() {
  if (_fedexToken && Date.now() < _fedexTokenExp - 60000) return _fedexToken;
  if (!FEDEX_API_KEY || !FEDEX_SECRET_KEY) {
    throw new Error(`FedEx ключи не заданы в Railway Variables (API_KEY: ${FEDEX_API_KEY ? 'есть' : 'НЕТ'}, SECRET_KEY: ${FEDEX_SECRET_KEY ? 'есть' : 'НЕТ'})`);
  }
  const params = new URLSearchParams();
  params.append('grant_type', 'client_credentials');
  params.append('client_id', FEDEX_API_KEY.trim());
  params.append('client_secret', FEDEX_SECRET_KEY.trim());
  const r = await fetch(`${FEDEX_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('FedEx OAuth: ' + JSON.stringify(d).slice(0, 300));
  _fedexToken = d.access_token;
  _fedexTokenExp = Date.now() + (d.expires_in || 3600) * 1000;
  console.log('🚚 FedEx OAuth токен получен');
  return _fedexToken;
}

// Отдельный OAuth-токен для трекинга (проект Basic Integrated Visibility).
// Если трек-ключи не заданы — откатываемся на основной токен.
let _fedexTrackToken = null;
let _fedexTrackTokenExp = 0;
async function getFedexTrackToken() {
  if (!FEDEX_TRACK_API_KEY || !FEDEX_TRACK_SECRET_KEY) return getFedexToken(); // фолбэк
  if (_fedexTrackToken && Date.now() < _fedexTrackTokenExp - 60000) return _fedexTrackToken;
  const params = new URLSearchParams();
  params.append('grant_type', 'client_credentials');
  params.append('client_id', FEDEX_TRACK_API_KEY.trim());
  params.append('client_secret', FEDEX_TRACK_SECRET_KEY.trim());
  const r = await fetch(`${FEDEX_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('FedEx Track OAuth: ' + JSON.stringify(d).slice(0, 300));
  _fedexTrackToken = d.access_token;
  _fedexTrackTokenExp = Date.now() + (d.expires_in || 3600) * 1000;
  console.log('🚚 FedEx Track OAuth токен получен (отдельный проект)');
  return _fedexTrackToken;
}

// Страны ЕС (таможня не нужна)
const EU_COUNTRIES = new Set(['IT','FR','DE','ES','PT','NL','BE','LU','AT','IE','FI','SE','DK','PL','CZ','SK','SI','HR','HU','RO','BG','GR','CY','MT','EE','LV','LT']);


// Тарифы FedEx: возвращает отсортированный по цене массив доступных сервисов
async function getFedexRates(token, sender, recipientAddr, parcel) {
  try {
    const r = await fetch(`${FEDEX_BASE}/rate/v1/rates/quotes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        accountNumber: { value: FEDEX_ACCOUNT },
        requestedShipment: {
          shipper: { address: sender.address },
          recipient: { address: recipientAddr },
          pickupType: 'USE_SCHEDULED_PICKUP',
          packagingType: 'YOUR_PACKAGING',
          rateRequestType: ['ACCOUNT', 'LIST'],
          requestedPackageLineItems: [{
            weight: { units: 'KG', value: parcel.weightKg || 1 },
            dimensions: {
              length: Math.round(parcel.length || 33),
              width: Math.round(parcel.width || 23),
              height: Math.round(parcel.height || 14),
              units: 'CM'
            }
          }]
        }
      })
    });
    const d = await r.json();
    const options = (d.output?.rateReplyDetails || []).map(rd => {
      const shipmentRate = (rd.ratedShipmentDetails || [])[0];
      return {
        serviceType: rd.serviceType,
        serviceName: rd.serviceName || rd.serviceType,
        price: shipmentRate?.totalNetCharge ?? shipmentRate?.totalNetFedExCharge ?? null,
        currency: shipmentRate?.currency || 'EUR'
      };
    }).filter(o => o.serviceType);
    if (!options.length) {
      console.log('🚚 Rates: пусто —', JSON.stringify(d).slice(0, 300));
      return [];
    }
    options.sort((a,b) => (a.price ?? 1e9) - (b.price ?? 1e9));
    console.log('🚚 Rates доступно:', options.map(o => `${o.serviceType}=${o.price}${o.currency}`).join(', '));
    return options;
  } catch(e) {
    console.log('🚚 Rates error:', e.message);
    return [];
  }
}

// ── Создать отправление ──
app.post('/api/fedex/ship', async (req, res) => {
  try {
    const { orderId, from, recipient, parcel, serviceType, customs } = req.body || {};
    if (!orderId || !recipient || !parcel) return res.status(400).json({ error: 'orderId, recipient, parcel обязательны' });
    const sender = FEDEX_SENDERS[from] || FEDEX_SENDERS.warehouse;

    const orders = loadOrders();
    const order = orders.find(o => o.id === orderId);
    if (!order) return res.status(404).json({ error: 'Заказ не найден' });

    const token = await getFedexToken();

    const rcc = String(recipient.countryCode || 'IT').trim().toUpperCase();
    const isIntl = rcc !== 'IT';
    // FedEx требует таможенную декларацию на международные экспресс-отправления даже внутри ЕС.
    // Прикладываем для любой страны кроме Италии; авто-ретрай ниже добавит её и в остальных случаях.
    const needCustoms = isIntl;
    console.log(`🚚 Ship: страна="${recipient.countryCode}"→"${rcc}", isIntl=${isIntl}, needCustoms=${needCustoms}`);

    const recipientAddr = {
      streetLines: [recipient.address1 || '', recipient.address2 || ''].filter(Boolean),
      city: recipient.city || '',
      postalCode: recipient.postalCode || '',
      countryCode: rcc
    };

    // Тарифы FedEx для этого отправления (для авто-выбора сервиса и/или показа цены)
    const rateOptions = await getFedexRates(token, sender, recipientAddr, parcel);

    // Авто-выбор: самый дешёвый доступный сервис, если сервис не задан явно
    let chosenService = serviceType || null;
    let chosenPrice = null;
    if (!chosenService) {
      const cheapest = rateOptions[0];
      chosenService = cheapest ? cheapest.serviceType : (isIntl ? 'INTERNATIONAL_ECONOMY' : 'FEDEX_REGIONAL_ECONOMY');
      if (cheapest) console.log(`🚚 Выбран дешёвый сервис: ${chosenService}`);
    }
    // Цену показываем ВСЕГДА — берём тариф именно выбранного сервиса; если его нет в ответе — самый дешёвый
    let priceOpt = rateOptions.find(o => o.serviceType === chosenService && o.price != null);
    if (!priceOpt && !serviceType) priceOpt = rateOptions.find(o => o.price != null); // при авто-выборе можно взять дешёвый
    if (priceOpt) chosenPrice = `${priceOpt.price} ${priceOpt.currency}`;

    const requestedShipment = {
      shipper: { contact: sender.contact, address: sender.address },
      recipients: [{
        contact: {
          personName: recipient.personName || 'Recipient',
          phoneNumber: (recipient.phoneNumber || '').replace(/[^\d+]/g, '') || '0000000000'
        },
        address: { ...recipientAddr, stateOrProvinceCode: recipient.stateCode || undefined }
      }],
      serviceType: chosenService,
      packagingType: 'YOUR_PACKAGING',
      pickupType: 'USE_SCHEDULED_PICKUP',
      shippingChargesPayment: {
        paymentType: 'SENDER',
        payor: { responsibleParty: { accountNumber: { value: FEDEX_ACCOUNT } } }
      },
      labelSpecification: {
        imageType: 'PDF',
        labelStockType: 'PAPER_85X11_TOP_HALF_LABEL'
      },
      requestedPackageLineItems: [{
        weight: { units: 'KG', value: parcel.weightKg || 1 },
        dimensions: {
          length: Math.round(parcel.length || 33),
          width: Math.round(parcel.width || 23),
          height: Math.round(parcel.height || 14),
          units: 'CM'
        }
      }]
    };

    const buildCustoms = () => ({
      dutiesPayment: { paymentType: 'RECIPIENT' },
      isDocumentOnly: false,
      commodities: [{
        description: (customs && customs.description) || "Women's leather shoes",
        countryOfManufacture: (customs && customs.countryOfManufacture) || 'IT',
        quantity: (customs && customs.quantity) || 1,
        quantityUnits: 'PCS',
        unitPrice: { amount: (customs && customs.unitPrice) || 100, currency: 'EUR' },
        customsValue: { amount: (customs && customs.totalValue) || 100, currency: 'EUR' },
        weight: { units: 'KG', value: parcel.weightKg || 1 }
      }]
    });

    if (needCustoms || (customs && customs.force)) {
      requestedShipment.customsClearanceDetail = buildCustoms();
    }

    async function doShip() {
      const rr = await fetch(`${FEDEX_BASE}/ship/v1/shipments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({
          labelResponseOptions: 'LABEL',
          accountNumber: { value: FEDEX_ACCOUNT },
          requestedShipment
        })
      });
      return { rr, data: await rr.json() };
    }

    let { rr: shipRes, data: shipData } = await doShip();

    // Если FedEx требует таможню, а мы её не добавили — добавляем и повторяем
    if (!shipRes.ok) {
      const needsCustomsErr = (shipData.errors || []).some(e =>
        String(e.code || '').toUpperCase().includes('CUSTOMSCLEARANCEDETAIL.REQUIRED'));
      if (needsCustomsErr && !requestedShipment.customsClearanceDetail) {
        console.log('🚚 FedEx требует таможню — добавляю декларацию и повторяю');
        requestedShipment.customsClearanceDetail = buildCustoms();
        ({ rr: shipRes, data: shipData } = await doShip());
      }
    }

    if (!shipRes.ok) {
      const errMsg = (shipData.errors || []).map(e => `${e.code}: ${e.message}`).join('; ') || JSON.stringify(shipData).slice(0, 400);
      console.log(`🚚❌ FedEx ship error: ${errMsg}`);
      return res.status(422).json({ error: errMsg });
    }

    const txShipment = shipData.output?.transactionShipments?.[0];
    const piece = txShipment?.pieceResponses?.[0];
    const tracking = piece?.trackingNumber || txShipment?.masterTrackingNumber || null;
    const labelB64 = piece?.packageDocuments?.[0]?.encodedLabel
      || txShipment?.shipmentDocuments?.[0]?.encodedLabel || null;

    if (!tracking) {
      return res.status(422).json({ error: 'FedEx не вернул трек-номер', raw: JSON.stringify(shipData).slice(0, 400) });
    }

    // Сохраняем этикетку PDF на диск
    let labelFile = null;
    if (labelB64) {
      labelFile = `${orderId.replace(/[^\w-]/g,'')}_${tracking}.pdf`;
      fs.writeFileSync(path.join(LABELS_DIR, labelFile), Buffer.from(labelB64, 'base64'));
    }

    // Записываем в заказ
    order.fedex = {
      tracking,
      labelFile,
      from,
      serviceType: requestedShipment.serviceType,
      createdAt: new Date().toISOString()
    };
    saveOrders(orders);

    console.log(`🚚 FedEx: отправление создано ${tracking} (${order.shopifyOrderName || orderId})`);

    // ТГ с треком
    await sendTelegram(
      `🚚 <b>FedEx отправление создано</b>\n` +
      `Заказ: <b>${order.shopifyOrderName || orderId}</b>\n` +
      `👤 ${order.customer || ''}\n` +
      `📦 Забор: ${sender.label}\n` +
      `🚛 Сервис: ${requestedShipment.serviceType}${chosenPrice ? ' · ~' + chosenPrice : ''}\n` +
      `🔖 Трек: <code>${tracking}</code>`,
      'online'
    );

    res.json({ ok: true, tracking, labelFile, service: requestedShipment.serviceType, price: chosenPrice });
  } catch (e) {
    console.log('🚚❌ FedEx ship exception:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Скачать этикетку ──
app.get('/api/fedex/label/:orderId', (req, res) => {
  const orders = loadOrders();
  const order = orders.find(o => o.id === req.params.orderId);
  if (!order || !order.fedex || !order.fedex.labelFile) return res.status(404).send('Label not found');
  const fp = path.join(LABELS_DIR, order.fedex.labelFile);
  if (!fs.existsSync(fp)) return res.status(404).send('Label file missing');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${order.fedex.labelFile}"`);
  fs.createReadStream(fp).pipe(res);
});

// ── Заказать забор ──
app.post('/api/fedex/pickup', async (req, res) => {
  try {
    const { orderId, from, pickupDate, readyTime, closeTime } = req.body || {};
    const sender = FEDEX_SENDERS[from] || FEDEX_SENDERS.warehouse;
    const orders = loadOrders();
    const order = orders.find(o => o.id === orderId);
    if (!order || !order.fedex) return res.status(404).json({ error: 'Заказ или отправление не найдены' });

    const token = await getFedexToken();

    const pickupRes = await fetch(`${FEDEX_BASE}/pickup/v1/pickups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        associatedAccountNumber: { value: FEDEX_ACCOUNT },
        originDetail: {
          pickupLocation: {
            contact: sender.contact,
            address: sender.address
          },
          readyDateTimestamp: `${pickupDate}T${readyTime || '14:00'}:00`,
          customerCloseTime: `${closeTime || '18:00'}:00`
        },
        carrierCode: 'FDXE'
      })
    });
    const pd = await pickupRes.json();

    if (!pickupRes.ok) {
      const errMsg = (pd.errors || []).map(e => `${e.code}: ${e.message}`).join('; ') || JSON.stringify(pd).slice(0, 300);
      console.log(`🚚❌ FedEx pickup error: ${errMsg}`);
      return res.status(422).json({ error: errMsg });
    }

    const confirmation = pd.output?.pickupConfirmationCode || pd.output?.confirmationNumber || 'OK';
    order.fedex.pickup = {
      confirmation,
      date: pickupDate,
      window: `${readyTime || '14:00'}–${closeTime || '18:00'}`,
      createdAt: new Date().toISOString()
    };
    saveOrders(orders);

    console.log(`🚚 FedEx pickup подтверждён: ${confirmation} на ${pickupDate}`);

    await sendTelegram(
      `📅 <b>FedEx забор заказан</b>\n` +
      `Заказ: <b>${order.shopifyOrderName || orderId}</b>\n` +
      `📦 Откуда: ${sender.label}\n` +
      `🗓 ${pickupDate}, окно ${readyTime || '14:00'}–${closeTime || '18:00'}\n` +
      `✅ Подтверждение: <code>${confirmation}</code>`,
      'online'
    );

    res.json({ ok: true, confirmation });
  } catch (e) {
    console.log('🚚❌ FedEx pickup exception:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── FedEx Track: статус отправления по трек-номеру ──
async function fedexTrack(tracking) {
  const token = await getFedexTrackToken();
  const r = await fetch(`${FEDEX_BASE}/track/v1/trackingnumbers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'X-locale': 'en_US' },
    body: JSON.stringify({ includeDetailedScans: true, trackingInfo: [{ trackingNumberInfo: { trackingNumber: String(tracking) } }] })
  });
  let d = {};
  try { d = await r.json(); } catch(e) {}
  // Ошибка уровня API (не авторизован, неверный запрос и т.п.)
  if (!r.ok || (d && d.errors)) {
    const apiError = (d && d.errors) ? d.errors.map(e => `${e.code}: ${e.message}`).join('; ') : `HTTP ${r.status}`;
    console.log(`🚚 track API error [${tracking}]: ${apiError}`);
    return { pickedUp: false, status: null, code: null, apiError, httpStatus: r.status };
  }
  const tr = d?.output?.completeTrackResults?.[0]?.trackResults?.[0];
  if (!tr) {
    console.log(`🚚 track: нет trackResults [${tracking}] — ${JSON.stringify(d).slice(0,300)}`);
    return { pickedUp: false, status: null, code: null, note: 'no trackResults' };
  }
  // Ошибка по конкретному трек-номеру (не найден и т.п.)
  if (tr.error) {
    console.log(`🚚 track: ошибка трека [${tracking}] — ${tr.error.code}: ${tr.error.message}`);
    return { pickedUp: false, status: null, code: null, trackError: `${tr.error.code}: ${tr.error.message}` };
  }
  const latest = tr.latestStatusDetail || {};
  const events = tr.scanEvents || [];
  const code = latest.derivedCode || latest.code || null;
  // «Забран» = пакет уже у FedEx (любой скан после создания этикетки).
  // Коды до забора: OC (Order/Label Created), PL (Plan/Label). Всё остальное — уже в движении.
  const preCodes = ['OC', 'PL', 'SF', 'IN'];
  const movedByCode = code && !preCodes.includes(code);
  const movedByEvent = events.some(e => {
    const et = (e.eventType || '').toUpperCase();
    return ['PU', 'DP', 'AR', 'IT', 'OD', 'DL'].includes(et) || /picked up|in transit|departed|arrived|delivered|out for delivery|received the (package|shipment)|ricevuto il collo/i.test(e.eventDescription || '');
  });
  // «Доставлено»
  const delEvent = events.find(e => (e.eventType || '').toUpperCase() === 'DL' || /delivered|consegnato/i.test(e.eventDescription || ''));
  const delivered = code === 'DL' || !!delEvent || /delivered|consegnato/i.test(latest.statusByLocale || latest.description || '');
  let deliveredAt = null;
  if (delivered) {
    const dt = (tr.dateAndTimes || []).find(x => x.type === 'ACTUAL_DELIVERY');
    deliveredAt = (dt && dt.dateTime) || (delEvent && delEvent.date) || null;
  }
  return {
    pickedUp: !!(movedByCode || movedByEvent),
    delivered, deliveredAt,
    status: latest.statusByLocale || latest.description || null,
    code, eventCount: events.length
  };
}

// Ручная проверка статуса по заказу (id, имя заказа или трек-номер)
app.get('/api/fedex/track/:orderId', async (req, res) => {
  try {
    const q = String(req.params.orderId).trim();
    const orders = loadOrders();
    const order = orders.find(o =>
      o.id === q ||
      (o.shopifyOrderName && (o.shopifyOrderName === q || o.shopifyOrderName === '#'+q || o.shopifyOrderName.replace(/^#/,'') === q)) ||
      (o.fedex && String(o.fedex.tracking) === q)
    );
    if (!order || !order.fedex || !order.fedex.tracking) return res.status(404).json({ error: 'Нет трек-номера у заказа' });
    const t = await fedexTrack(order.fedex.tracking);
    res.json({ ok: true, orderId: order.id, orderName: order.shopifyOrderName, fulfilled: !!order.fulfilledAt, tracking: order.fedex.tracking, ...t });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Прямая проверка Track по трек-номеру (диагностика доступа к Track API)
app.get('/api/fedex/track-number/:tracking', async (req, res) => {
  try {
    const t = await fedexTrack(String(req.params.tracking).trim());
    res.json({ ok: true, tracking: req.params.tracking, ...t });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Авто-закрытие заказа по факту забора FedEx ──
const FEDEX_AUTO_FULFILL = (process.env.FEDEX_AUTO_FULFILL || 'on').toLowerCase() !== 'off';
// ── Расписание опроса FedEx ──
// По умолчанию — РАЗ В ДЕНЬ в заданный час (UTC). Италия = UTC+1/+2, т.е. 19 UTC ≈ 20–21 по Милану.
// Можно переключить на частый опрос, задав FEDEX_POLL_MIN (в минутах).
const FEDEX_POLL_MIN = process.env.FEDEX_POLL_MIN ? parseInt(process.env.FEDEX_POLL_MIN, 10) : null;
const FEDEX_POLL_HOUR = process.env.FEDEX_POLL_HOUR != null ? parseInt(process.env.FEDEX_POLL_HOUR, 10) : 19; // час UTC
let _fedexLastPollDay = null;
let _fedexPolling = false;

// Запустить проверку немедленно (для теста)
app.post('/api/fedex/poll-now', async (req, res) => {
  const summary = await pollFedexPickups();
  res.json({ ok: true, ...summary });
});

if (FEDEX_AUTO_FULFILL) {
  console.log(FEDEX_TRACK_API_KEY && FEDEX_TRACK_SECRET_KEY
    ? '🚚 Трекинг: отдельный проект FedEx (Basic Integrated Visibility)'
    : '🚚 Трекинг: основной ключ FedEx (отдельные трек-ключи не заданы)');
  // Прогон вскоре после старта — чтобы после деплоя проверка шла сразу (не дожидаясь суточного окна)
  setTimeout(() => { pollFedexPickups().then(s => { if (s && s.checked) console.log(`🚚 Стартовый прогон: проверено ${s.checked}, закрыто ${(s.closed||[]).length}`); }); }, 8000);
  if (FEDEX_POLL_MIN && FEDEX_POLL_MIN >= 2) {
    setInterval(pollFedexPickups, FEDEX_POLL_MIN * 60 * 1000);
    console.log(`🚚 Авто-закрытие по забору FedEx: ВКЛ · интервал ${FEDEX_POLL_MIN} мин`);
  } else {
    // раз в день: каждые 15 мин сверяем час; когда совпал и сегодня ещё не гоняли — запускаем
    setInterval(() => {
      const now = new Date();
      const dayKey = now.toISOString().slice(0, 10);
      if (now.getUTCHours() === FEDEX_POLL_HOUR && _fedexLastPollDay !== dayKey) {
        _fedexLastPollDay = dayKey;
        pollFedexPickups();
      }
    }, 15 * 60 * 1000);
    console.log(`🚚 Авто-закрытие по забору FedEx: ВКЛ · раз в день в ${FEDEX_POLL_HOUR}:00 UTC`);
  }
} else {
  console.log('🚚 Авто-закрытие по забору FedEx: ВЫКЛ (FEDEX_AUTO_FULFILL=off)');
}

async function pollFedexPickups() {
  const summary = { checked: 0, closed: [], delivered: [], skipped: 'auto-fulfill off or no keys' };
  if (!FEDEX_AUTO_FULFILL || _fedexPolling) return summary;
  const haveTrackKeys = (FEDEX_TRACK_API_KEY && FEDEX_TRACK_SECRET_KEY) || (FEDEX_API_KEY && FEDEX_SECRET_KEY);
  if (!haveTrackKeys) return summary;
  _fedexPolling = true;
  summary.skipped = null;
  try {
    const orders = loadOrders();
    const now = Date.now();
    // есть трек, ещё НЕ доставлен, отправление не старше 30 дней
    // (охватывает и незакрытые — для забора, и закрытые — для отметки о доставке)
    const pending = orders.filter(o =>
      o.fedex && o.fedex.tracking && !o.fedex.delivered &&
      (!o.fedex.createdAt || (now - new Date(o.fedex.createdAt).getTime()) < 30 * 864e5)
    );
    summary.checked = pending.length;
    let ordersChanged = false;
    for (const order of pending) {
      try {
        const t = await fedexTrack(order.fedex.tracking);
        // 1) Забор → автозакрытие (только для ещё не отгруженных)
        if (t.pickedUp && !order.fulfilledAt && !order.fedex.autoFulfillDone) {
          order.fedex.autoFulfillDone = true;
          order.fedex.pickupDetectedAt = new Date().toISOString();
          order.fedex.pickupStatus = t.status || t.code || 'picked up';
          await fulfillOrderCore(order, orders, {
            reason: `🚚✅ <b>Забран FedEx — автозакрытие</b>\nТрек: <code>${order.fedex.tracking}</code>${t.status ? ` · ${t.status}` : ''}`
          });
          summary.closed.push(order.shopifyOrderName || order.id);
          console.log(`🚚✅ Авто-fulfill по забору FedEx: ${order.shopifyOrderName || order.id} (${order.fedex.tracking})`);
        }
        // 2) Доставлено → отметка с датой
        if (t.delivered && !order.fedex.delivered) {
          order.fedex.delivered = { at: t.deliveredAt || new Date().toISOString(), status: t.status || 'Delivered' };
          ordersChanged = true;
          summary.delivered.push(order.shopifyOrderName || order.id);
          console.log(`🚚📦 Доставлено: ${order.shopifyOrderName || order.id} (${order.fedex.tracking}) — ${order.fedex.delivered.at}`);
          await sendTelegram(`📦✅ <b>Доставлено клиенту</b>\nЗаказ ${order.shopifyOrderName || order.id}\nТрек: <code>${order.fedex.tracking}</code>`, 'online');
        }
      } catch (e) {
        console.log(`🚚 track err ${order.id}: ${e.message}`);
      }
    }
    if (ordersChanged) saveOrders(orders);
  } catch (e) {
    console.log('🚚 poll err: ' + e.message);
    summary.error = e.message;
  } finally {
    _fedexPolling = false;
  }
  return summary;
}

// ════════════════════════════════════════
// API: Точечные складские операции (атомарно на сервере)
// ops: [{ op: 'deduct_shop'|'add_shop'|'deduct_wh'|'add_wh',
//         barcode?, name?, color?, material?, size?, qty, location? }]
// Выполняются на серверных данных — без гонок между устройствами.
// ════════════════════════════════════════

// Уплотнение ячеек-коробок: пустая коробка изымается, стопка выше опускается на уровень ниже
// Формат ячейки: К<колонна>-М<уровень>. Другие форматы не трогаем.
function compactWarehouseCells(inv) {
  const re = /^К(\d+)-М(\d+)$/i;
  const cols = {}; // колонна → уровень → totalQty
  inv.forEach(i => {
    const m = re.exec(String(i.location || '').trim());
    if (!m) return;
    const col = m[1], lvl = parseInt(m[2]);
    if (!cols[col]) cols[col] = {};
    cols[col][lvl] = (cols[col][lvl] || 0) + (i.qty || 0);
  });

  const renames = [];
  for (const col of Object.keys(cols)) {
    const levels = Object.keys(cols[col]).map(Number).sort((a,b) => a-b);
    const nonEmpty = levels.filter(l => cols[col][l] > 0);
    // Новая нумерация: непустые уровни получают 1..N по порядку
    const mapping = {};
    nonEmpty.forEach((oldLvl, idx) => { mapping[oldLvl] = idx + 1; });

    levels.forEach(oldLvl => {
      const oldLoc = `К${col}-М${oldLvl}`;
      if (cols[col][oldLvl] === 0) {
        // Пустая коробка исчезает: удаляем её нулевые записи
        for (let k = inv.length - 1; k >= 0; k--) {
          if (String(inv[k].location || '').trim().toLowerCase() === oldLoc.toLowerCase()) inv.splice(k, 1);
        }
      } else if (mapping[oldLvl] !== oldLvl) {
        const newLoc = `К${col}-М${mapping[oldLvl]}`;
        inv.forEach(i => {
          if (String(i.location || '').trim().toLowerCase() === oldLoc.toLowerCase()) i.location = newLoc;
        });
        renames.push(`${oldLoc}→${newLoc}`);
      }
      // Убираем нулевые записи внутри непустого уровня (чтобы не мусорили на карте)
      for (let k = inv.length - 1; k >= 0; k--) {
        const loc = String(inv[k].location || '').trim();
        if ((inv[k].qty || 0) <= 0 && re.test(loc) && loc.split('-')[0] === `К${col}`) {
          inv.splice(k, 1);
        }
      }
    });
  }
  if (renames.length) console.log(`📦 Ячейки уплотнены: ${renames.join(', ')}`);
  return renames;
}

app.post('/api/stock/ops', (req, res) => {
  const { ops } = req.body || {};
  if (!Array.isArray(ops) || !ops.length) return res.status(400).json({ error: 'Expected ops array' });

  const inv = loadInventory();
  const shop = loadShopStock();
  const showroom = loadShowroom();
  const results = [];

  const norm = s => String(s||'').trim().toLowerCase();
  const matchByKey = (i, o) =>
    (i.name||'') === (o.name||'') &&
    String(i.size) === String(o.size) &&
    (!o.color || (i.color||'') === o.color) &&
    (!o.material || (i.material||'') === o.material);
  // Мягкое совпадение: без учёта регистра и материала (для расхождений в данных)
  const matchLoose = (i, o) =>
    norm(i.name) === norm(o.name) &&
    String(i.size) === String(o.size) &&
    norm(i.color) === norm(o.color);

  for (const o of ops) {
    const qty = o.op === 'set_sr' ? Math.max(0, parseInt(o.qty) || 0) : Math.max(1, parseInt(o.qty) || 1);
    const bc = o.barcode ? String(o.barcode).trim() : null;
    let r = { op: o.op, barcode: bc, qty, ok: false };

    if (o.op === 'deduct_shop' || o.op === 'add_shop') {
      let candidates = bc ? shop.filter(i => String(i.barcode||'').trim() === bc) : [];
      if (!candidates.length) candidates = shop.filter(i => matchByKey(i, o));
      if (o.op === 'deduct_shop') {
        candidates = candidates.filter(i => (i.shopQty||0) > 0);
        let remaining = qty;
        candidates.forEach(i => {
          if (remaining <= 0) return;
          const take = Math.min(i.shopQty, remaining);
          i.shopQty -= take; remaining -= take;
        });
        r.ok = remaining === 0;
        r.deducted = qty - remaining;
        if (remaining > 0) r.error = 'insufficient_shop_stock';
      } else {
        if (candidates.length) {
          candidates[0].shopQty = (candidates[0].shopQty||0) + qty;
        } else {
          shop.push({ name: o.name||'?', material: o.material||null, color: o.color||'',
                      size: o.size, shopQty: qty, barcode: bc });
        }
        r.ok = true;
      }
    } else if (o.op === 'deduct_wh' || o.op === 'add_wh') {
      let candidates = [];
      if (o.op === 'add_wh' && o.location) {
        // Приход в КОНКРЕТНУЮ ячейку: ищем запись только в ней (по ШК, затем по ключу)
        candidates = bc ? inv.filter(i => String(i.barcode||'').trim() === bc && i.location === o.location) : [];
        if (!candidates.length) candidates = inv.filter(i => matchByKey(i, o) && i.location === o.location);
      } else if (o.location) {
        // Списание СТРОГО из указанной ячейки (по ШК, затем по точному ключу). Без «мягких» совпадений.
        candidates = bc ? inv.filter(i => String(i.barcode||'').trim() === bc && i.location === o.location) : [];
        if (!candidates.length) candidates = inv.filter(i => matchByKey(i, o) && i.location === o.location);
      } else {
        // Ячейка не задана: по ШК (в любой ячейке), затем по точному ключу
        if (bc) candidates = inv.filter(i => String(i.barcode||'').trim() === bc);
        if (!candidates.length) candidates = inv.filter(i => matchByKey(i, o));
      }
      if (o.op === 'deduct_wh') {
        candidates = candidates.filter(i => i.qty > 0);
        let remaining = qty;
        const cells = [];
        candidates.forEach(i => {
          if (remaining <= 0) return;
          const take = Math.min(i.qty, remaining);
          i.qty -= take; remaining -= take;
          cells.push(`${i.location}×${take}`);
        });
        r.ok = remaining === 0;
        r.deducted = qty - remaining;
        r.cells = cells;
        if (remaining > 0) r.error = 'insufficient_wh_stock';
      } else {
        if (candidates.length) {
          candidates[0].qty = (candidates[0].qty||0) + qty;
          r.cell = candidates[0].location;
        } else {
          inv.push({ id: Date.now() + Math.random(), name: o.name||'?', brand: 'Alagio',
                     sku: 'OP', size: o.size, color: o.color||'', material: o.material||'',
                     qty, location: o.location || 'ВОЗВРАТ', barcode: bc || undefined,
                     addedAt: new Date().toLocaleDateString('ru-RU') });
          r.cell = o.location || 'ВОЗВРАТ';
        }
        r.ok = true;
      }
    } else if (o.op === 'deduct_sr' || o.op === 'add_sr' || o.op === 'set_sr') {
      let candidates = bc ? showroom.filter(i => String(i.barcode||'').trim() === bc) : [];
      if (!candidates.length) candidates = showroom.filter(i => matchByKey(i, o));
      if (!candidates.length && o.op === 'deduct_sr') {
        candidates = showroom.filter(i => matchLoose(i, o) && (i.qty||0) > 0);
        if (candidates.length) console.log(`🏛️ deduct_sr мягкое совпадение: ${o.name} ${o.color} EU${o.size} (ШК заказа=${bc||'нет'})`);
      }
      if (o.op === 'deduct_sr') {
        candidates = candidates.filter(i => (i.qty||0) > 0);
        let remaining = qty;
        candidates.forEach(i => {
          if (remaining <= 0) return;
          const take = Math.min(i.qty, remaining);
          i.qty -= take; remaining -= take;
        });
        r.ok = remaining === 0;
        r.deducted = qty - remaining;
        if (remaining > 0) {
          r.error = 'insufficient_showroom_stock';
          console.log(`🏛️❌ deduct_sr НЕ списано: ${o.name} ${o.color} EU${o.size} qty=${qty} ШК=${bc||'нет'} — кандидатов ${candidates.length}`);
        }
      } else if (o.op === 'add_sr') {
        if (candidates.length) {
          candidates[0].qty = (candidates[0].qty||0) + qty;
        } else {
          showroom.push({ name: o.name||'?', material: o.material||null, color: o.color||'',
                          size: o.size, qty, barcode: bc });
        }
        r.ok = true;
      } else { // set_sr — инвентаризация: установить точное значение
        const setQty = Math.max(0, parseInt(o.qty) || 0);
        if (candidates.length) {
          candidates[0].qty = setQty;
        } else {
          showroom.push({ name: o.name||'?', material: o.material||null, color: o.color||'',
                          size: o.size, qty: setQty, barcode: bc });
        }
        r.ok = true;
      }
    } else {
      r.error = 'unknown_op';
    }
    results.push(r);
  }

  // Уплотняем коробки-ячейки, если были складские списания
  let cellRenames = [];
  if (ops.some(o => o.op === 'deduct_wh')) {
    cellRenames = compactWarehouseCells(inv);
  }

  saveInventory(inv);
  saveShopStockData(shop);
  saveShowroom(showroom);
  const v = bumpInvVersion();
  console.log(`🎯 stock/ops: ${results.filter(r=>r.ok).length}/${results.length} ок (v${v})`);
  res.json({ ok: true, results, version: v, inventory: inv, shopStock: shop, showroom, cellRenames });
});



// Переезд ячейки: все товары из fromLoc получают newLoc (объединяется, если newLoc уже занята)
// Нормализация ячейки: латинские K/M → кириллические К/М, uppercase, trim.
// Локации склада всегда в формате К#-М# (кириллица) — латиница это всегда опечатка ввода.
function normCell(s) {
  return String(s == null ? '' : s).trim().toUpperCase()
    .replace(/K/g, 'К')   // Latin K (U+004B) → Cyrillic К (U+041A)
    .replace(/M/g, 'М');  // Latin M (U+004D) → Cyrillic М (U+041C)
}

app.post('/api/warehouse/move-cell', (req, res) => {
  const { from, to } = req.body || {};
  if (!from || !to) return res.status(400).json({ error: 'from и to обязательны' });
  const fromN = normCell(from), toN = normCell(to);
  if (fromN === toN) return res.status(400).json({ error: 'Совпадают' });

  const inv = loadInventory();

  // Самолечение: приводим ВСЕ локации к каноничному виду (латиница K/M → кириллица),
  // чтобы ранее записанные «латинские» ячейки чинились и корректно рисовались на карте.
  let normalizedCount = 0;
  inv.forEach(i => {
    const canon = normCell(i.location);
    if (i.location != null && canon !== String(i.location)) { i.location = canon; normalizedCount++; }
  });

  let moved = 0;
  inv.forEach(i => {
    if (normCell(i.location) === fromN) { i.location = toN; moved++; }
  });
  if (!moved) return res.status(404).json({ error: 'В ячейке нет товаров' });

  saveInventory(inv);
  const v = bumpInvVersion();
  console.log(`📦 Переезд ячейки: ${fromN} → ${toN} (${moved} позиций; нормализовано ${normalizedCount}, v${v})`);
  res.json({ ok: true, moved, from: fromN, to: toN, normalized: normalizedCount, version: v, inventory: inv });
});

// Ручное уплотнение всех коробок-ячеек склада
app.post('/api/warehouse/compact', (req, res) => {
  const inv = loadInventory();
  const renames = compactWarehouseCells(inv);
  saveInventory(inv);
  const v = bumpInvVersion();
  console.log(`📦 Ручное уплотнение: ${renames.length} переездов (v${v})`);
  res.json({ ok: true, renames, version: v, inventory: inv });
});

app.post('/api/telegram', async (req, res) => {
  const { text, topic } = req.body;
  if (!text) return res.status(400).json({ error: 'No text' });
  const finalTopic = topic || guessTopicFromText(text);
  if (!topic && finalTopic) console.log(`📬 Тема не передана клиентом — определена по тексту: ${finalTopic}`);
  const r = await sendTelegram(text, finalTopic);
  if (!r.ok) return res.status(502).json({ error: 'Telegram: ' + r.error });
  res.json({ ok: true });
});

// ════════════════════════════════════════
// API: Штрихкоды
// ════════════════════════════════════════
const BARCODES_FILE = path.join(DATA_DIR, 'barcodes.json');
function loadBarcodes() {
  try { return JSON.parse(fs.readFileSync(BARCODES_FILE, 'utf8')); } catch { return {}; }
}
function saveBarcodes(data) {
  fs.writeFileSync(BARCODES_FILE, JSON.stringify(data, null, 2));
}

app.get('/api/barcodes', (req, res) => {
  res.json(loadBarcodes());
});

app.post('/api/barcodes', (req, res) => {
  const data = req.body;
  if (typeof data !== 'object') return res.status(400).json({ error: 'Expected object' });
  saveBarcodes(data);
  res.json({ ok: true });
});

// ════════════════════════════════════════
// API: Перемещения
// ════════════════════════════════════════
const TRANSFERS_FILE = path.join(DATA_DIR, 'transfers.json');
function loadTransfersData() {
  try { return JSON.parse(fs.readFileSync(TRANSFERS_FILE, 'utf8')); }
  catch { return { transferOrders: [], transitItems: [] }; }
}
function saveTransfersData(data) {
  fs.writeFileSync(TRANSFERS_FILE, JSON.stringify(data, null, 2));
}

app.get('/api/transfers', (req, res) => {
  res.json(loadTransfersData());
});

app.post('/api/transfers', (req, res) => {
  const { transferOrders, transitItems } = req.body;
  if (!transferOrders || !transitItems) return res.status(400).json({ error: 'Invalid data' });
  saveTransfersData({ transferOrders, transitItems });
  res.json({ ok: true });
});

// ════════════════════════════════════════
// API: Остатки по qty (только количество)
// ════════════════════════════════════════
const QTY_FILE = path.join(DATA_DIR, 'qty.json');
function loadQty() {
  try { return JSON.parse(fs.readFileSync(QTY_FILE, 'utf8')); } catch { return {}; }
}
function saveQty(data) {
  fs.writeFileSync(QTY_FILE, JSON.stringify(data, null, 2));
}

app.get('/api/qty', (req, res) => {
  res.json(loadQty());
});

app.post('/api/qty', (req, res) => {
  const data = req.body;
  if (typeof data !== 'object' || Array.isArray(data)) return res.status(400).json({ error: 'Expected object' });
  const current = loadQty();
  Object.assign(current, data);
  saveQty(current);
  res.json({ ok: true });
});

// ════════════════════════════════════════
// ФОТО МОДЕЛЕЙ
// ════════════════════════════════════════
const PHOTOS_DIR = path.join(DATA_DIR, 'photos');
if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR, { recursive: true });
if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR);

// Отдаём фото
app.use('/photos', express.static(PHOTOS_DIR));

// Загрузка фото (multipart/form-data)
app.post('/api/photos/:model', (req, res) => {
  const model = req.params.model.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  const chunks = [];
  let contentType = 'image/jpeg';

  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    // Определяем расширение по Content-Type заголовку
    const ct = req.headers['content-type'] || '';
    const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : 'jpg';
    const filename = `${model}.${ext}`;
    const filepath = path.join(PHOTOS_DIR, filename);

    // Удаляем старые версии этой модели
    ['jpg','jpeg','png','webp'].forEach(e => {
      const old = path.join(PHOTOS_DIR, `${model}.${e}`);
      if (fs.existsSync(old)) fs.unlinkSync(old);
    });

    fs.writeFileSync(filepath, body);
    console.log(`📸 Фото загружено: ${filename}`);
    res.json({ ok: true, url: `/photos/${filename}` });
  });
});

// Список загруженных фото
app.get('/api/photos', (req, res) => {
  try {
    const files = fs.readdirSync(PHOTOS_DIR)
      .filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f))
      .map(f => ({ model: f.replace(/\.[^.]+$/, ''), url: `/photos/${f}` }));
    res.json(files);
  } catch { res.json([]); }
});

// Удалить фото модели
app.delete('/api/photos/:model', (req, res) => {
  const model = req.params.model.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  let deleted = false;
  ['jpg','jpeg','png','webp'].forEach(e => {
    const f = path.join(PHOTOS_DIR, `${model}.${e}`);
    if (fs.existsSync(f)) { fs.unlinkSync(f); deleted = true; }
  });
  res.json({ ok: deleted });
});

app.listen(PORT, () => {
  console.log(`🚀 AlagioStore сервер запущен на порту ${PORT}`);
});
