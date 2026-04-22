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
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
function loadOrders() {
  try { return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8')); } catch { return []; }
}
function saveOrders(orders) {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
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
  const shop = loadShopStock();
  const results = [];
  const source = order.source || 'shopify'; // 'manual'/'shopify' — для ручных смотрим source

  for (const li of order.lineItems) {
    const isShopSource = li.location && li.location.includes('Магазин') && !li.location.includes('Склад');

    if (isShopSource) {
      // Списываем из магазина
      const shopItem = shop.find(i =>
        String(i.barcode) === String(li.barcode) ||
        (i.name.toLowerCase().includes(li.title.split(' ')[0].toLowerCase()) &&
         String(i.size) === String(li.size))
      );
      if (shopItem && shopItem.shopQty >= li.qty) {
        shopItem.shopQty -= li.qty;
        results.push(`✅ ${li.title} EU${li.size} из магазина — списано ${li.qty} пар`);
      } else {
        results.push(`⚠️ ${li.title} EU${li.size} — не найдено в магазине (есть: ${shopItem?.shopQty || 0})`);
      }
    } else {
      // Списываем со склада
      const item = inv.find(i =>
        (String(i.barcode) === String(li.barcode)) ||
        (i.name.toLowerCase().includes(li.title.split(' ')[0].toLowerCase()) &&
         String(i.size) === String(li.size) &&
         i.qty >= li.qty)
      );
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
  saveOrders(data);
  res.json({ ok: true, count: data.length });
});

// ════════════════════════════════════════
// SHOPIFY OAUTH
// ════════════════════════════════════════
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID || 'd3bebe952a71faa9a58ae1ab6b7796a7';
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
    const shop = loadShopStock();
    const warehouseQty = inv.filter(i => String(i.barcode) === String(barcode)).reduce((s, i) => s + i.qty, 0);
    const shopQty = shop.filter(i => String(i.barcode) === String(barcode)).reduce((s, i) => s + (i.shopQty||0), 0);
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
    const shop = loadShopStock();
    const warehouseQty = inv.filter(i => String(i.barcode) === String(barcode)).reduce((s, i) => s + i.qty, 0);
    const shopQty = shop.filter(i => String(i.barcode) === String(barcode)).reduce((s, i) => s + (i.shopQty||0), 0);
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
      // Ищем вариант по штрихкоду — перебираем страницы
      let allVariants = [];
      let pi = null;
      do {
        const url = pi
          ? `https://${shop}/admin/api/2024-04/variants.json?limit=250&page_info=${pi}`
          : `https://${shop}/admin/api/2024-04/variants.json?barcode=${item.barcode}&limit=250`;
        const sr = await fetch(url, { headers });
        if (sr.status === 429) { await delay(2000); break; }
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
        await delay(2000);
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

      // Пауза 500ms между запросами
      await delay(300);

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
