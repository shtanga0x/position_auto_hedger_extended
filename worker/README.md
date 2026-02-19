# Cloudflare Worker - Polymarket API Proxy

Этот воркер проксирует запросы к API Polymarket и Binance, обходя ограничения CORS.

## Маршруты

| Путь | Целевой API |
|------|-------------|
| `/api/gamma/*` | `https://gamma-api.polymarket.com/*` |
| `/api/clob/*` | `https://clob.polymarket.com/*` |

## Деплой

### Предварительные требования

1. Аккаунт на [Cloudflare](https://cloudflare.com)
2. Установленный Node.js (v16+)
3. Установленный Wrangler CLI

### Установка Wrangler

```bash
npm install -g wrangler
```

### Авторизация

```bash
wrangler login
```

Откроется браузер для авторизации в вашем аккаунте Cloudflare.

### Деплой воркера

```bash
cd worker
wrangler deploy
```

После успешного деплоя вы получите URL вида:
```
https://polymarket-proxy.<your-subdomain>.workers.dev
```

### Локальное тестирование

```bash
cd worker
wrangler dev
```

Воркер будет доступен по адресу `http://localhost:8787`

## Настройка приложения

После деплоя воркера, установите переменную окружения `VITE_WORKER_URL` в вашем production окружении:

```bash
VITE_WORKER_URL=https://polymarket-proxy.<your-subdomain>.workers.dev
```

Или укажите её в файле `.env.production`:

```
VITE_WORKER_URL=https://polymarket-proxy.<your-subdomain>.workers.dev
```

## Кастомный домен (опционально)

Если вы хотите использовать свой домен вместо `*.workers.dev`:

1. Добавьте домен в Cloudflare
2. Раскомментируйте и настройте секцию `routes` в `wrangler.toml`:

```toml
routes = [
  { pattern = "api.yourdomain.com/*", zone_name = "yourdomain.com" }
]
```

3. Выполните `wrangler deploy`

## Лимиты бесплатного плана

Бесплатный план Cloudflare Workers включает:
- 100,000 запросов в день
- 10ms CPU time на запрос
- Неограниченное количество воркеров

Этого более чем достаточно для личного использования.

