/**
 * Обновляет public/data/fallback.json — снапшот таблицы, который дашборд
 * показывает, если Cloudflare-прослойка недоступна.
 *
 *   node scripts/snapshot.mjs
 *   SHEET_ID=... SHEET_DAILY="По дням" node scripts/snapshot.mjs
 *
 * Логика нормализации переиспользуется из самой функции, чтобы схема снапшота
 * и схема живого ответа не разъезжались.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTraffic } from '../functions/api/traffic.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(root, 'public/data/fallback.json');

const sheetId = process.env.SHEET_ID || '10hH-WRYkhc7lR8bZd74CEBqCHfcK7lQ-Q9OnRQaDy5U';
const dailySheet = process.env.SHEET_DAILY || 'По дням';
const enginesSheet = process.env.SHEET_ENGINES || 'Поисковые системы (для графика)';

const payload = await loadTraffic(sheetId, dailySheet, enginesSheet);
payload.source = 'snapshot';

await mkdir(dirname(target), { recursive: true });
await writeFile(target, JSON.stringify(payload) + '\n', 'utf8');

console.log(
  `Снапшот обновлён: ${payload.days.length} дней, ${payload.engines.length} месяцев по поисковикам → ${target}`
);
