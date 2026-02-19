/**
 * Конфигурация API endpoints
 * 
 * В режиме разработки используется проксирование через Vite
 * В production используется Cloudflare Worker
 */

const isDev = import.meta.env.DEV;

// URL воркера из переменной окружения или дефолтное значение
const WORKER_URL = import.meta.env.VITE_WORKER_URL || '';

// В dev режиме используем относительные пути (проксируются Vite)
// В prod режиме используем URL воркера
export const API_CONFIG = {
  GAMMA_API_BASE: isDev ? '/api/gamma' : `${WORKER_URL}/api/gamma`,
  CLOB_API_BASE: isDev ? '/api/clob' : `${WORKER_URL}/api/clob`,
};

// Для отладки
if (isDev) {
  console.log('[API Config] Development mode - using Vite proxy');
} else {
  console.log('[API Config] Production mode - using Worker URL:', WORKER_URL || '(not set)');
}

