const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Config (заменить на реальные значения) ──
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '8671208562:AAHoqfc_oWy_KvuQh6TB9NuRwcn1hwM1TxM';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '507326616';
const SHOPIFY_SECRET = process.env.SHOPIFY_SECRET || 'ВАШ_SHOPIFY_WEBHOOK_SECRET';

// ── Middleware ──
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.static('public'));
app.use(express.static(__dirname));
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

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
const ORDERS_FILE = path.join(__dirname, 'orders.json');
function loadOrders() {
  try { return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8')); } catch { return []; }
}
function saveOrders(orders) {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
}

// ── Хранилище инвентаря ──
const INVENTORY_FILE = path.join(__dirname, 'inventory.json');
function loadInventory() {
  try { return JSON.parse(fs.readFileSync(INVENTORY_FILE, 'utf8')); } catch { return []; }
}
function saveInventory(inv) {
  fs.writeFileSync(INVENTORY_FILE, JSON.stringify(inv, null, 2));
}

// ── Хранилище магазина ──
const SHOPSTOCK_FILE = path.join(__dirname, 'shopstock.json');
function loadShopStock() {
  try { return JSON.parse(fs.readFileSync(SHOPSTOCK_FILE, 'utf8')); } catch { return []; }
}

// ── Telegram уведомление ──
async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'HTML'
      })
    });
    const data = await res.json();
    if (!data.ok) console.error('Telegram error:', data);
  } catch (e) {
    console.error('Telegram send failed:', e.message);
  }
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

  // 2. Ищем в barcodes.json (справочник склада)
  const barcodes = loadBarcodes(); // { "key": "barcode" }
  const bcKey = Object.keys(barcodes).find(k => String(barcodes[k]).trim() === bc);
  if (bcKey) {
    // Есть в справочнике но нет на складе — ищем в магазине
    const shopStock = loadShopStock();
    // bcKey формат: "Name||Size" или просто barcode lookup
    const shopItem = shopStock.find(item =>
      item.barcode && String(item.barcode).trim() === bc && item.shopQty > 0
    );
    if (shopItem) {
      return { source: 'shop', location: 'Магазин', item: shopItem };
    }
    return { source: 'none', location: '❌ нет в наличии', item: null };
  }

  return null;
}

// ── Найти товар на складе (fallback по названию+размеру) ──
function findInInventory(productName, size) {
  const inv = loadInventory();
  const name = productName.toLowerCase();
  const sz = String(size);

  // Сначала склад
  const warehouseItem = inv.find(item =>
    item.name.toLowerCase().includes(name) &&
    String(item.size) === sz &&
    item.qty > 0
  );
  if (warehouseItem) return { source: 'warehouse', location: warehouseItem.location, item: warehouseItem };

  // Потом магазин
  const shopStock = loadShopStock();
  const shopItem = shopStock.find(item =>
    item.name.toLowerCase().includes(name) &&
    String(item.size) === sz &&
    item.shopQty > 0
  );
  if (shopItem) return { source: 'shop', location: 'Магазин', item: shopItem };

  return null;
}

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

  // Формируем позиции заказа
  const lineItems = (order.line_items || []).map(item => {
    const size = extractSize(item);
    const barcode = item.barcode || null;

    // 1. Ищем по штрихкоду (приоритет)
    let found = barcode ? findByBarcode(barcode) : null;

    // 2. Fallback — по названию + размеру
    if (!found) found = findInInventory(item.title, size);

    const source = found ? found.source : null;
    const location = found ? found.location : '❓ не найдено';
    const sourceLabel = source === 'shop' ? ' (Магазин)' : source === 'warehouse' ? ' (Склад)' : '';

    return {
      title: item.title,
      variant: item.variant_title || '',
      sku: item.sku || '',
      barcode: barcode || '',
      qty: item.quantity,
      size,
      source: source || 'none',
      location: location + sourceLabel
    };
  });

  const newOrder = {
    id: `ORD-${Date.now()}`,
    shopifyId,
    shopifyOrderName: order.name || `#${shopifyId}`,
    customer: `${order.shipping_address?.first_name || ''} ${order.shipping_address?.last_name || ''}`.trim() || order.email || 'Покупатель',
    email: order.email || '',
    phone: order.phone || order.shipping_address?.phone || order.billing_address?.phone || '',
    address: formatAddress(order.shipping_address),
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
  );

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

// ════════════════════════════════════════
// API: Отгрузить заказ (списать остатки)
// ════════════════════════════════════════
app.post('/api/orders/:id/fulfill', async (req, res) => {
  const orders = loadOrders();
  const order = orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status === 'done') return res.status(400).json({ error: 'Already fulfilled' });

  const inv = loadInventory();
  const results = [];

  for (const li of order.lineItems) {
    const item = inv.find(i =>
      i.name.toLowerCase().includes(li.title.toLowerCase()) &&
      String(i.size) === String(li.size) &&
      i.qty >= li.qty
    );
    if (item) {
      item.qty -= li.qty;
      results.push(`✅ ${li.title} EU${li.size} с ${item.location} — списано ${li.qty} пар`);
    } else {
      results.push(`⚠️ ${li.title} EU${li.size} — не найдено на складе`);
    }
  }

  order.status = 'done';
  order.fulfilledAt = new Date().toISOString();
  saveOrders(orders);
  saveInventory(inv);

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
    `✅ <b>Заказ ${order.shopifyOrderName} отгружен</b>\n\n` +
    results.join('\n')
  );

  res.json({ ok: true, results });
});

// ════════════════════════════════════════
// API: Инвентарь (чтение и запись)
// ════════════════════════════════════════
app.get('/api/inventory', (req, res) => {
  res.json(loadInventory());
});

app.post('/api/inventory', (req, res) => {
  const inv = req.body;
  if (!Array.isArray(inv)) return res.status(400).json({ error: 'Expected array' });
  saveInventory(inv);
  res.json({ ok: true, count: inv.length });
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
const HISTORY_FILE = path.join(__dirname, 'history.json');

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

// ── Health check ──
app.get('/health', (req, res) => {
  res.json({ ok: true, orders: loadOrders().length, inventory: loadInventory().length });
});

// ── Telegram proxy endpoint ──
app.post('/api/telegram', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'No text' });
  await sendTelegram(text);
  res.json({ ok: true });
});

// ════════════════════════════════════════
// API: Штрихкоды
// ════════════════════════════════════════
const BARCODES_FILE = path.join(__dirname, 'barcodes.json');
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
const TRANSFERS_FILE = path.join(__dirname, 'transfers.json');
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
const QTY_FILE = path.join(__dirname, 'qty.json');
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

app.listen(PORT, () => {
  console.log(`🚀 AlagioStore сервер запущен на порту ${PORT}`);
});
