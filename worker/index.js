/**
 * Cloudflare Worker для проксирования запросов к API Polymarket, Binance и Bybit
 *
 * Маршруты:
 * - /api/gamma/* -> https://gamma-api.polymarket.com/*
 * - /api/clob/*  -> https://clob.polymarket.com/*
 * - /api/bybit/* -> https://api.bybit.com/*
 */

const ROUTES = {
  '/api/gamma': 'https://gamma-api.polymarket.com',
  '/api/clob': 'https://clob.polymarket.com',
  '/api/bybit': 'https://api.bybit.com',
  '/api/binance': 'https://api.binance.com',
};

// CORS заголовки для ответов
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

/**
 * Обработка preflight OPTIONS запросов
 */
function handleOptions(request) {
  const headers = request.headers;
  if (
    headers.get('Origin') !== null &&
    headers.get('Access-Control-Request-Method') !== null &&
    headers.get('Access-Control-Request-Headers') !== null
  ) {
    return new Response(null, {
      headers: corsHeaders,
    });
  }
  return new Response(null, {
    headers: {
      Allow: 'GET, POST, PUT, DELETE, OPTIONS',
    },
  });
}

/**
 * Проксирование запроса к целевому API
 */
async function handleRequest(request) {
  const url = new URL(request.url);
  const pathname = url.pathname;

  // Найти подходящий маршрут
  let targetBase = null;
  let prefix = null;

  for (const [routePrefix, target] of Object.entries(ROUTES)) {
    if (pathname.startsWith(routePrefix)) {
      targetBase = target;
      prefix = routePrefix;
      break;
    }
  }

  if (!targetBase) {
    return new Response(JSON.stringify({ error: 'Not found', path: pathname }), {
      status: 404,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders,
      },
    });
  }

  // Построить целевой URL
  const targetPath = pathname.replace(prefix, '');
  const targetUrl = new URL(targetPath || '/', targetBase);
  targetUrl.search = url.search;

  // Создать новый запрос к целевому API
  const modifiedRequest = new Request(targetUrl.toString(), {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: 'follow',
  });

  try {
    const response = await fetch(modifiedRequest);
    
    // Создать новый ответ с CORS заголовками
    const modifiedResponse = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });

    // Добавить CORS заголовки
    Object.entries(corsHeaders).forEach(([key, value]) => {
      modifiedResponse.headers.set(key, value);
    });

    return modifiedResponse;
  } catch (error) {
    return new Response(JSON.stringify({ error: 'Proxy error', message: error.message }), {
      status: 502,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders,
      },
    });
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return handleOptions(request);
    }
    return handleRequest(request);
  },
};

