# AlagioStore — Складской сервер

## Интеграция: Shopify ↔ Склад ↔ Telegram

---

## 🚀 Деплой на Railway (пошаговая инструкция)

### Шаг 1 — Telegram бот
1. Открыть Telegram → найти **@BotFather**
2. Написать `/newbot`
3. Назвать бота: `Alagio Склад`
4. Username: `alagio_warehouse_bot`
5. **Сохранить токен** (вида `7123456789:AAF...`)

6. Найти **@userinfobot** → написать `/start`
7. **Сохранить ваш Chat ID** (число)

---

### Шаг 2 — GitHub
1. Зайти на **github.com** → Sign Up (бесплатно)
2. Создать новый репозиторий: `alagio-warehouse`
3. Загрузить все файлы этой папки

---

### Шаг 3 — Railway
1. Зайти на **railway.app** → Login with GitHub
2. Нажать **New Project** → **Deploy from GitHub**
3. Выбрать репозиторий `alagio-warehouse`
4. Railway автоматически запустит сервер

### Шаг 4 — Переменные окружения на Railway
В разделе **Variables** добавить:

| Переменная | Значение |
|---|---|
| `TELEGRAM_TOKEN` | токен от BotFather |
| `TELEGRAM_CHAT_ID` | ваш chat ID |
| `SHOPIFY_SECRET` | из настроек Shopify (шаг 5) |
| `APP_URL` | URL вашего Railway проекта |

---

### Шаг 5 — Shopify Webhook
1. Shopify Admin → **Settings** → **Notifications**
2. Прокрутить вниз → **Webhooks**
3. Нажать **Create webhook**
4. Event: `Order payment` (оплаченный заказ)
5. URL: `https://ВАШ-RAILWAY-URL/webhook/shopify/orders`
6. Format: JSON
7. Скопировать **Signing secret** → вставить в Railway как `SHOPIFY_SECRET`

---

## API эндпоинты

| Метод | URL | Описание |
|---|---|---|
| POST | `/webhook/shopify/orders` | Принимает заказы от Shopify |
| GET | `/api/orders` | Список всех заказов |
| POST | `/api/orders/:id/fulfill` | Отгрузить заказ (списать остатки) |
| GET | `/api/inventory` | Получить инвентарь |
| POST | `/api/inventory` | Обновить инвентарь |
| GET | `/health` | Проверка статуса |

---

## Как это работает

1. Покупатель оплачивает заказ на Shopify
2. Shopify отправляет webhook на ваш сервер
3. Сервер находит товар на складе и сообщает ячейку
4. Вам приходит Telegram уведомление с деталями
5. Вы подбираете товар и нажимаете "Отгрузил" в складской программе
6. Остатки автоматически списываются
