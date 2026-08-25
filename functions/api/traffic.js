/**
 * Cloudflare Pages Function — прослойка между дашбордом и Google Sheets.
 *
 * GET /api/traffic           — нормализованные данные листов (из edge-кэша, если он тёплый)
 * GET /api/traffic?refresh=1 — принудительно обойти кэш и сходить в Google
 *
 * Зачем прослойка:
 *  1. ID таблицы не уезжает в браузер — он живёт только в переменных окружения Pages;
 *  2. ответ кэшируется на edge (Google отдаёт no-store, поэтому кэшируем сами);
 *  3. последний удачный ответ хранится отдельно и отдаётся как stale,
 *     если Google недоступен — дашборд не белеет;
 *  4. два листа склеиваются в одну стабильную JSON-схему, одинаковую со снапшотом.
 *
 * Переменные окружения (Pages → Settings → Variables):
 *   SHEET_ID       — id таблицы (обязательна в проде)
 *   SHEET_DAILY    — лист с посещаемостью по дням, по умолчанию "По дням"
 *   SHEET_ENGINES  — лист с разбивкой поиска, по умолчанию "Поисковые системы (для графика)"
 *   CACHE_TTL      — время жизни edge-кэша в секундах, по умолчанию 300
 */

const DEFAULT_SHEET_ID = '10hH-WRYkhc7lR8bZd74CEBqCHfcK7lQ-Q9OnRQaDy5U';
const DEFAULT_DAILY_SHEET = 'По дням';
const DEFAULT_ENGINES_SHEET = 'Поисковые системы (для графика)';
const DEFAULT_TTL = 300;

/** Ключ, под которым в edge-кэше лежит последний успешный ответ. */
const LAST_GOOD_KEY = 'https://cache.internal/traffic/last-good';

/**
 * Колонки листа «По дням». Заголовки в таблице пронумерованы
 * («1. Переходы из поисковых систем»), поэтому ищем по корню слова,
 * а не по точному совпадению.
 */
const DAILY_FIELDS = [
  { key: 'search', test: /поисков/i, fallback: 1 },
  { key: 'direct', test: /прям/i, fallback: 2 },
  { key: 'ads', test: /реклам/i, fallback: 3 },
  { key: 'links', test: /ссылк/i, fallback: 4 },
  { key: 'internal', test: /внутренн/i, fallback: 5 },
];

/** Колонки листа с поисковыми системами. */
const ENGINE_FIELDS = [
  { key: 'yandex', test: /яндекс|yandex/i, fallback: 2 },
  { key: 'google', test: /google|гугл/i, fallback: 3 },
  { key: 'other', test: /проч|остальн/i, fallback: 4 },
];

export async function onRequestGet(context) {
  const { request, env, waitUntil } = context;
  const url = new URL(request.url);
  const bypass = url.searchParams.has('refresh');

  const sheetId = env.SHEET_ID || DEFAULT_SHEET_ID;
  const dailySheet = env.SHEET_DAILY || DEFAULT_DAILY_SHEET;
  const enginesSheet = env.SHEET_ENGINES || DEFAULT_ENGINES_SHEET;
  const ttl = clampTtl(env.CACHE_TTL);

  const cache = caches.default;
  const cacheKey = new Request(`${url.origin}${url.pathname}`, { method: 'GET' });

  if (!bypass) {
    const hit = await cache.match(cacheKey);
    if (hit) return withHeaders(hit, { 'x-cache': 'HIT' });
  }

  try {
    const payload = await loadTraffic(sheetId, dailySheet, enginesSheet);
    const fresh = json(payload, {
      'cache-control': `public, max-age=60, s-maxage=${ttl}`,
      'x-cache': bypass ? 'BYPASS' : 'MISS',
      'x-data-source': 'google-sheets',
    });

    // Кладём и в обычный ключ (истекает по TTL), и в «последний удачный» (живёт дольше).
    waitUntil(cache.put(cacheKey, fresh.clone()));
    waitUntil(
      cache.put(
        new Request(LAST_GOOD_KEY, { method: 'GET' }),
        json(payload, { 'cache-control': 'public, max-age=86400' })
      )
    );

    return fresh;
  } catch (err) {
    const stale = await cache.match(new Request(LAST_GOOD_KEY, { method: 'GET' }));
    if (stale) {
      return withHeaders(stale, {
        'x-cache': 'STALE',
        'x-data-source': 'google-sheets-stale',
        'cache-control': 'no-store',
      });
    }
    return json(
      { ok: false, error: String(err && err.message ? err.message : err) },
      { 'cache-control': 'no-store' },
      502
    );
  }
}

/** Preflight — дашборд может жить на другом домене, чем эта функция. */
export function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-max-age': '86400',
    },
  });
}

/**
 * Тянет оба листа параллельно и приводит к схеме дашборда.
 *
 * days:    [[«2016-01-01», поиск, прямые, реклама, ссылки, внутренние], …]
 * engines: [[«2024-07», яндекс, google, прочие], …]
 *
 * Строки — массивы, а не объекты: дней больше трёх с половиной тысяч,
 * и на объектах снапшот распухает втрое без единого лишнего байта смысла.
 */
export async function loadTraffic(sheetId, dailySheet, enginesSheet) {
  const [daily, engines] = await Promise.all([
    fetchSheet(sheetId, dailySheet),
    fetchSheet(sheetId, enginesSheet),
  ]);

  return {
    ok: true,
    source: 'google-sheets',
    fetchedAt: new Date().toISOString(),
    sheets: { daily: dailySheet, engines: enginesSheet },
    columns: {
      days: ['date', 'search', 'direct', 'ads', 'links', 'internal'],
      engines: ['month', 'yandex', 'google', 'other'],
    },
    days: parseDaily(daily),
    engines: parseEngines(engines),
  };
}

async function fetchSheet(sheetId, sheetName) {
  const src =
    `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/gviz/tq` +
    `?tqx=out:json&headers=1&sheet=${encodeURIComponent(sheetName)}`;

  const res = await fetch(src, {
    headers: { 'user-agent': 'site-traffic-dashboard/1.0' },
    cf: { cacheTtl: 0, cacheEverything: false },
  });

  if (!res.ok) throw new Error(`Google Sheets ответил ${res.status} на лист «${sheetName}»`);
  return parseGviz(await res.text(), sheetName);
}

function parseDaily(table) {
  const map = mapColumns(table.cols || [], DAILY_FIELDS);
  const rows = [];

  for (const row of table.rows || []) {
    const cells = row.c || [];
    const date = day(pick(cells, 0));
    if (!date) continue;

    const values = DAILY_FIELDS.map((field) => num(pick(cells, map[field.key])));
    // Лист размечен до 2028 года вперёд: строки с датой, но без чисел — это ещё не данные.
    if (values.every((value) => value === null)) continue;

    rows.push([date, ...values.map((value) => value || 0)]);
  }

  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return rows;
}

function parseEngines(table) {
  const map = mapColumns(table.cols || [], ENGINE_FIELDS);
  const rows = [];

  for (const row of table.rows || []) {
    const cells = row.c || [];
    const date = day(pick(cells, 0));
    if (!date) continue;

    const values = ENGINE_FIELDS.map((field) => num(pick(cells, map[field.key])));
    if (values.every((value) => value === null)) continue;

    rows.push([date.slice(0, 7), ...values.map((value) => value || 0)]);
  }

  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return rows;
}

/** gviz отдаёт JS-обёртку `/*O_o*\/google.visualization.Query.setResponse({...});` */
function parseGviz(body, sheetName) {
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error(`Неожиданный формат ответа gviz (лист «${sheetName}»)`);

  const data = JSON.parse(body.slice(start, end + 1));
  if (data.status === 'error') {
    const reason = (data.errors || []).map((e) => e.detailed_message || e.message).join('; ');
    throw new Error(reason || `gviz вернул ошибку по листу «${sheetName}»`);
  }
  if (!data.table) throw new Error(`В ответе gviz нет таблицы (лист «${sheetName}»)`);
  return data.table;
}

/**
 * Заголовки в таблице люди правят, поэтому колонки ищутся по смыслу.
 * Если ни один заголовок не подошёл — берём позицию, как в исходном листе.
 */
function mapColumns(cols, fields) {
  const labels = cols.map((c) => String((c && c.label) || ''));
  const used = new Set();
  const map = {};

  for (const field of fields) {
    let idx = labels.findIndex((label, i) => !used.has(i) && field.test.test(label));
    if (idx === -1 && !used.has(field.fallback) && field.fallback < cols.length) {
      idx = field.fallback;
    }
    if (idx !== -1) used.add(idx);
    map[field.key] = idx;
  }
  return map;
}

function pick(cells, idx) {
  if (idx === undefined || idx === -1) return null;
  const cell = cells[idx];
  return cell ? cell.v : null;
}

/**
 * Дата приходит либо как `Date(2016,0,1)` (колонка распознана таблицей как дата),
 * либо как текст «01.01.2016». Возвращаем ISO-дату без времени.
 */
function day(value) {
  if (value === null || value === undefined) return '';

  if (value instanceof Date) return iso(value.getFullYear(), value.getMonth() + 1, value.getDate());

  const raw = String(value).trim();
  const gviz = /^Date\((\d+),(\d+),(\d+)/.exec(raw);
  if (gviz) return iso(Number(gviz[1]), Number(gviz[2]) + 1, Number(gviz[3]));

  const dotted = /^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/.exec(raw);
  if (dotted) return iso(Number(dotted[3]), Number(dotted[2]), Number(dotted[1]));

  const isoLike = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (isoLike) return iso(Number(isoLike[1]), Number(isoLike[2]), Number(isoLike[3]));

  return '';
}

function iso(year, month, date) {
  if (!year || !month || !date) return '';
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(date).padStart(2, '0')}`;
}

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed =
    typeof value === 'number' ? value : Number(String(value).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function clampTtl(raw) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_TTL;
  return Math.min(Math.max(Math.trunc(parsed), 30), 3600);
}

function json(payload, headers = {}, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      ...headers,
    },
  });
}

function withHeaders(response, headers) {
  const next = new Response(response.body, response);
  for (const [key, value] of Object.entries(headers)) next.headers.set(key, value);
  return next;
}
