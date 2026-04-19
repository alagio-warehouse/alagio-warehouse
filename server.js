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
app.use(express.static(__dirname)); // также ищем в корне
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

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

// ── Найти товар на складе ──
function findInInventory(productName, size) {
  const inv = loadInventory();
  const name = productName.toLowerCase();
  const sz = String(size);
  return inv.find(item =>
    item.name.toLowerCase().includes(name) &&
    String(item.size) === sz &&
    item.qty > 0
  );
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
    const location = findInInventory(item.title, size);
    return {
      title: item.title,
      variant: item.variant_title || '',
      sku: item.sku || '',
      qty: item.quantity,
      size,
      location: location ? location.location : '❓ не найдено'
    };
  });

  const newOrder = {
    id: `ORD-${Date.now()}`,
    shopifyId,
    shopifyOrderName: order.name || `#${shopifyId}`,
    customer: `${order.shipping_address?.first_name || ''} ${order.shipping_address?.last_name || ''}`.trim() || order.email || 'Покупатель',
    email: order.email || '',
    phone: order.phone || '',
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
  const itemsText = lineItems.map(li =>
    `  • <b>${li.title}</b>${li.size ? ` EU${li.size}` : ''} × ${li.qty}\n    📦 Место: <code>${li.location}</code>`
  ).join('\n');

  await sendTelegram(
    `🛒 <b>Новый заказ ${newOrder.shopifyOrderName}</b>\n` +
    `👤 ${newOrder.customer}\n` +
    `📍 ${newOrder.address}\n\n` +
    `${itemsText}\n\n` +
    `💰 ${newOrder.total}\n` +
    `🔗 Открыть склад: ${process.env.APP_URL || 'http://localhost:3000'}`
  );

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

// ── Health check ──
app.get('/health', (req, res) => {
  res.json({ ok: true, orders: loadOrders().length, inventory: loadInventory().length });
});

app.listen(PORT, () => {
  console.log(`🚀 AlagioStore сервер запущен на порту ${PORT}`);
});
