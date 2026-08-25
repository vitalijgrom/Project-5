/* ---------------------------------------------------------------------------
   Дашборд трафика сайта.
   Данные приходят из Cloudflare-функции /api/traffic, которая ходит в Google
   Таблицу. Если функция недоступна (локальная статика, обрыв связи) —
   подхватывается снапшот public/data/fallback.json, и об этом говорит баннер.

   Единственный источник чисел — посуточный лист. Месяцы, кварталы и годы
   собираются здесь, поэтому цифры в KPI, графиках и таблице не могут разойтись.
   --------------------------------------------------------------------------- */
'use strict';

var CONFIG = {
  apiUrl: 'api/traffic',
  fallbackUrl: 'data/fallback.json',
  autoRefreshMs: 5 * 60 * 1000,
  requestTimeoutMs: 15000,
};

/* Слот цвета закреплён за источником навсегда: выключение соседа
   не перекрашивает остальные. */
var SOURCES = [
  { key: 'search', slot: 1, label: 'Переходы из поисковых систем', short: 'Поиск' },
  { key: 'direct', slot: 2, label: 'Прямые заходы', short: 'Прямые' },
  { key: 'ads', slot: 3, label: 'Переходы по рекламе', short: 'Реклама' },
  { key: 'links', slot: 4, label: 'Переходы по ссылкам на сайтах', short: 'Ссылки' },
  { key: 'internal', slot: 5, label: 'Внутренние переходы', short: 'Внутренние' },
];

var ENGINES = [
  { key: 'yandex', slot: 1, label: 'Яндекс', short: 'Яндекс' },
  { key: 'google', slot: 2, label: 'Google', short: 'Google' },
  { key: 'other', slot: 3, label: 'Прочие', short: 'Прочие' },
];

var MONTH_NOM = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
var MONTH_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн',
  'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
var QUARTER_ROMAN = ['I', 'II', 'III', 'IV'];

/** Сколько месяцев в одном столбце при каждом шаге. */
var STEP_MONTHS = { month: 1, quarter: 3, year: 12 };
var STEP_LABEL = { month: 'месяц', quarter: 'квартал', year: 'год' };

var STATE = {
  months: [],        // только полные месяцы, по возрастанию
  partial: null,     // хвостовой неполный месяц, если он есть
  engines: [],       // [{ key: '2026-07', values: {...} }]
  lastDate: '',      // последняя дата, по которую вообще есть данные
  meta: null,
  filters: { window: 24, step: 'month', sources: activeAll() },
  sort: { key: 'period', dir: 'desc' },
  loading: false,
};

var nf = new Intl.NumberFormat('ru-RU');
var $ = function (id) { return document.getElementById(id); };

function activeAll() {
  var out = {};
  SOURCES.forEach(function (s) { out[s.key] = true; });
  return out;
}

function activeSources() {
  return SOURCES.filter(function (s) { return STATE.filters.sources[s.key]; });
}

/* --- Форматирование ------------------------------------------------------- */

function ru(value, digits) {
  return value.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

/** Компактная запись: 5,16 млн · 270 тыс · 12,4 тыс · 843 */
function compact(value) {
  var abs = Math.abs(value);
  if (abs >= 1e6) return ru(value / 1e6, 2) + ' млн';
  if (abs >= 1e4) return ru(value / 1e3, abs >= 1e5 ? 0 : 1) + ' тыс';
  return nf.format(Math.round(value));
}

function axisFormat(value, max) {
  if (value === 0) return '0';
  if (max >= 1e6) return ru(value / 1e6, 1) + ' млн';
  if (max >= 1e4) return ru(value / 1e3, 0) + ' тыс';
  return nf.format(value);
}

function pct(value, total) {
  if (!total) return '0%';
  var share = (value / total) * 100;
  return ru(share, share < 10 ? 1 : 0) + '%';
}

/** Дельта всегда несёт стрелку и знак — цвет не остаётся единственным носителем. */
function deltaInfo(now, was) {
  if (!was) return { text: '—', dir: 0, known: false };
  var change = ((now - was) / was) * 100;
  var dir = change > 0.05 ? 1 : change < -0.05 ? -1 : 0;
  return { text: formatDelta(change, dir), dir: dir, known: true };
}

/** Знак ставим только там, где движение действительно есть: «−0%» — не число. */
function formatDelta(change, dir) {
  var abs = Math.abs(change);
  var sign = dir > 0 ? '+' : dir < 0 ? '−' : '';
  return sign + ru(dir ? abs : 0, abs < 10 ? 1 : 0) + '%';
}

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function monthLabel(year, month, short) {
  var name = short ? MONTH_SHORT[month - 1] : MONTH_NOM[month - 1];
  return name + ' ' + year;
}

/* --- Сборка периодов ------------------------------------------------------ */

/**
 * Посуточные строки → месяцы. Месяц считается полным, если в нём есть
 * его последний календарный день: лист размечен на годы вперёд, и хвост
 * текущего месяца иначе тянул бы вниз и динамику, и средние.
 */
function buildMonths(days) {
  var byKey = {};
  var lastDate = '';

  days.forEach(function (row) {
    var date = String(row[0] || '');
    if (date.length < 10) return;
    if (date > lastDate) lastDate = date;

    var key = date.slice(0, 7);
    var month = byKey[key];
    if (!month) {
      month = byKey[key] = {
        key: key,
        year: Number(date.slice(0, 4)),
        month: Number(date.slice(5, 7)),
        values: {},
        days: 0,
        lastDay: 0,
      };
      SOURCES.forEach(function (s) { month.values[s.key] = 0; });
    }

    SOURCES.forEach(function (s, i) {
      month.values[s.key] += Number(row[i + 1]) || 0;
    });
    month.days += 1;
    var dayNumber = Number(date.slice(8, 10));
    if (dayNumber > month.lastDay) month.lastDay = dayNumber;
  });

  var all = Object.keys(byKey).sort().map(function (key) { return byKey[key]; });
  all.forEach(function (month) {
    month.complete = month.lastDay >= daysInMonth(month.year, month.month);
    month.label = monthLabel(month.year, month.month, false);
    month.short = monthLabel(month.year, month.month, true);
  });

  var complete = all.filter(function (month) { return month.complete; });
  var partial = all.filter(function (month) { return !month.complete; }).pop() || null;

  return { months: complete, partial: partial, lastDate: lastDate };
}

/** Месяцы → столбцы выбранного шага. Неполные корзины отбрасываются целиком. */
function buildBuckets(months, step) {
  if (step === 'month') {
    return months.map(function (month) {
      return {
        key: month.key,
        label: month.label,
        short: month.short,
        from: month.key,
        to: month.key,
        months: [month],
        values: month.values,
      };
    });
  }

  var size = STEP_MONTHS[step];
  var groups = {};
  var order = [];

  months.forEach(function (month) {
    var slot = step === 'year' ? 0 : Math.floor((month.month - 1) / 3);
    var key = step === 'year' ? String(month.year) : month.year + '-Q' + (slot + 1);
    var group = groups[key];
    if (!group) {
      group = groups[key] = { key: key, year: month.year, slot: slot, months: [] };
      order.push(key);
    }
    group.months.push(month);
  });

  return order
    .map(function (key) { return groups[key]; })
    .filter(function (group) { return group.months.length === size; })
    .map(function (group) {
      var values = {};
      SOURCES.forEach(function (s) {
        values[s.key] = group.months.reduce(function (acc, m) { return acc + m.values[s.key]; }, 0);
      });
      var label = step === 'year'
        ? String(group.year) + ' год'
        : QUARTER_ROMAN[group.slot] + ' квартал ' + group.year;
      return {
        key: group.key,
        label: label,
        short: step === 'year' ? String(group.year) : QUARTER_ROMAN[group.slot] + ' ' + group.year,
        from: group.months[0].key,
        to: group.months[group.months.length - 1].key,
        months: group.months,
        values: values,
      };
    });
}

function totalOf(values, sources) {
  return sources.reduce(function (acc, s) { return acc + (values[s.key] || 0); }, 0);
}

/** Что именно сейчас показано: окно, предыдущее окно того же размера и шаг. */
function currentSlice() {
  var step = STATE.filters.step;
  var all = buildBuckets(STATE.months, step);
  var windowMonths = Number(STATE.filters.window) || 0;
  var count = windowMonths
    ? Math.max(1, Math.round(windowMonths / STEP_MONTHS[step]))
    : all.length;

  var view = all.slice(Math.max(0, all.length - count));
  var start = Math.max(0, all.length - view.length * 2);
  var previous = all.slice(start, all.length - view.length);

  return { all: all, view: view, previous: previous, step: step };
}

/* --- Загрузка ------------------------------------------------------------- */

function fetchJson(url, timeoutMs) {
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, timeoutMs);
  return fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } })
    .then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json().then(function (data) {
        return { data: data, cache: res.headers.get('x-cache') || '' };
      });
    })
    .finally(function () { clearTimeout(timer); });
}

function load(force) {
  if (STATE.loading) return Promise.resolve();
  STATE.loading = true;
  $('refresh').disabled = true;
  // Кадр не роняем: старый рендер держится приглушённым, без скелетона.
  if (STATE.months.length) $('content').classList.add('is-busy');
  setStatus(STATE.months.length ? 'Обновление…' : 'Загрузка данных…');

  var url = CONFIG.apiUrl + (force ? '?refresh=1' : '');

  return fetchJson(url, CONFIG.requestTimeoutMs)
    .then(function (result) {
      if (!result.data || result.data.ok === false || !Array.isArray(result.data.days)) {
        throw new Error((result.data && result.data.error) || 'Некорректный ответ прослойки');
      }
      apply(result.data, result.cache, null);
    })
    .catch(function (apiError) {
      // Прослойка недоступна — показываем снапшот, но честно об этом пишем.
      return fetchJson(CONFIG.fallbackUrl, CONFIG.requestTimeoutMs)
        .then(function (result) {
          apply(result.data, '', apiError);
        })
        .catch(function () {
          setStatus('Данные не загрузились');
          showBanner(
            'Не удалось получить данные ни из Cloudflare-прослойки, ни из локального снапшота. ' +
            'Проверьте /api/traffic. Причина: ' + apiError.message
          );
        });
    })
    .finally(function () {
      STATE.loading = false;
      $('refresh').disabled = false;
      $('content').classList.remove('is-busy');
    });
}

function apply(payload, cacheHeader, apiError) {
  var built = buildMonths(payload.days || []);
  STATE.months = built.months;
  STATE.partial = built.partial;
  STATE.lastDate = built.lastDate;
  STATE.engines = (payload.engines || []).map(function (row) {
    var values = {};
    ENGINES.forEach(function (e, i) { values[e.key] = Number(row[i + 1]) || 0; });
    return { key: String(row[0] || ''), values: values };
  });

  STATE.meta = {
    source: payload.source || 'unknown',
    fetchedAt: payload.fetchedAt || null,
    cache: cacheHeader,
    stale: cacheHeader === 'STALE',
  };

  if (apiError) {
    showBanner(
      'Показан локальный снапшот данных: прослойка /api/traffic недоступна (' + apiError.message + '). ' +
      'При деплое на Cloudflare Pages функция появится автоматически.'
    );
  } else if (STATE.meta.stale) {
    showBanner('Google Таблица сейчас недоступна — показан последний удачный ответ из кэша Cloudflare.');
  } else {
    hideBanner();
  }

  render();
  setStatus(describeMeta());
  $('foot-meta').textContent = describeSource();
}

function describeMeta() {
  if (!STATE.meta || !STATE.meta.fetchedAt) return 'Данные загружены';
  var date = new Date(STATE.meta.fetchedAt);
  if (isNaN(date.getTime())) return 'Данные загружены';
  return 'Обновлено ' +
    date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) + ', ' +
    date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function describeSource() {
  if (!STATE.meta) return '';
  var parts = [];
  parts.push(STATE.meta.source === 'google-sheets' ? 'Источник: Google Таблица' : 'Источник: локальный снапшот');
  if (STATE.meta.cache) parts.push('edge-кэш: ' + STATE.meta.cache);
  if (STATE.lastDate) parts.push('данные по ' + STATE.lastDate.split('-').reverse().join('.'));
  parts.push('полных месяцев: ' + nf.format(STATE.months.length));
  if (STATE.partial) {
    parts.push(
      'неполный ' + STATE.partial.label + ' (' + STATE.partial.days + ' дн.) в расчёты не входит'
    );
  }
  return parts.join(' · ');
}

function setStatus(text) { $('status').textContent = text; }

function showBanner(text) {
  var banner = $('banner');
  banner.textContent = text;
  banner.hidden = false;
}
function hideBanner() { $('banner').hidden = true; }

/* --- Рендер --------------------------------------------------------------- */

function render() {
  if (!STATE.months.length) return;

  var slice = currentSlice();
  var sources = activeSources();

  renderKpis(slice, sources);
  renderTrend(slice, sources);
  renderSplit(slice, sources);
  renderYoy(slice, sources);
  renderEngines(slice);
  renderHeat(slice, sources);
  renderTable(slice, sources);
}

function rangeLabel(buckets) {
  if (!buckets.length) return '—';
  var first = buckets[0];
  var last = buckets[buckets.length - 1];
  return first === last ? first.label : first.label + ' — ' + last.label;
}

function renderKpis(slice, sources) {
  var view = slice.view;
  var total = view.reduce(function (acc, b) { return acc + totalOf(b.values, sources); }, 0);
  var previousTotal = slice.previous.reduce(function (acc, b) { return acc + totalOf(b.values, sources); }, 0);
  var monthsCount = view.reduce(function (acc, b) { return acc + b.months.length; }, 0);

  $('kpi-total').textContent = total ? compact(total) : '—';
  $('kpi-total-hint').textContent = total
    ? nf.format(total) + ' · ' + rangeLabel(view)
    : 'под текущий фильтр данных нет';

  var delta = slice.previous.length ? deltaInfo(total, previousTotal) : { text: '—', dir: 0 };
  var deltaEl = $('kpi-delta');
  deltaEl.textContent = '';
  deltaEl.className = 'kpi__value' + (delta.dir ? ' delta--' + (delta.dir > 0 ? 'up' : 'down') : '');
  if (delta.dir) deltaEl.appendChild(node('span', { className: 'delta__arrow' }, delta.dir > 0 ? '▲' : '▼'));
  deltaEl.appendChild(document.createTextNode(delta.text));
  $('kpi-delta-hint').textContent = slice.previous.length
    ? 'было ' + compact(previousTotal) + ' · ' + rangeLabel(slice.previous)
    : 'предыдущего периода такой же длины нет';

  var searchTotal = STATE.filters.sources.search
    ? view.reduce(function (acc, b) { return acc + (b.values.search || 0); }, 0)
    : 0;
  $('kpi-search').textContent = STATE.filters.sources.search ? pct(searchTotal, total) : '—';
  $('kpi-search-hint').textContent = STATE.filters.sources.search
    ? compact(searchTotal) + ' визитов из поиска'
    : 'источник выключен в фильтре';

  $('kpi-avg').textContent = monthsCount ? compact(total / monthsCount) : '—';
  $('kpi-avg-hint').textContent = monthsCount
    ? 'за ' + monthsCount + ' ' + plural(monthsCount, 'месяц', 'месяца', 'месяцев')
    : ' ';

  var months = view.reduce(function (acc, b) { return acc.concat(b.months); }, []);
  var peak = months.reduce(function (best, month) {
    var value = totalOf(month.values, sources);
    return !best || value > best.value ? { month: month, value: value } : best;
  }, null);
  $('kpi-peak').textContent = peak ? peak.month.label : '—';
  $('kpi-peak-hint').textContent = peak ? compact(peak.value) + ' визитов' : ' ';
}

function renderTrend(slice, sources) {
  var view = slice.view;
  $('trend-sub').textContent = view.length
    ? rangeLabel(view) + ' · шаг: ' + STEP_LABEL[slice.step] +
      (STATE.partial ? ' · неполный ' + STATE.partial.label + ' не показан' : '')
    : 'под текущий фильтр данных нет';

  renderColumns($('chart-trend'), {
    buckets: view,
    series: sources,
    labelUnit: 'визитов',
  });
  renderLegend($('trend-legend'), sources, view);
}

function renderLegend(container, series, buckets) {
  container.textContent = '';
  if (series.length < 2) return;

  var totals = {};
  series.forEach(function (s) {
    totals[s.key] = buckets.reduce(function (acc, b) { return acc + (b.values[s.key] || 0); }, 0);
  });

  series.forEach(function (s) {
    var item = node('div', { className: 'legend__item' });
    item.appendChild(node('span', { className: 'legend__swatch legend__swatch--' + s.slot }));
    item.appendChild(node('span', {}, s.label + ' — '));
    item.appendChild(node('span', { className: 'legend__value' }, compact(totals[s.key])));
    container.appendChild(item);
  });
}

function renderSplit(slice, sources) {
  var container = $('chart-split');
  container.textContent = '';

  var items = sources.map(function (s) {
    return {
      source: s,
      value: slice.view.reduce(function (acc, b) { return acc + (b.values[s.key] || 0); }, 0),
    };
  });
  var total = items.reduce(function (acc, item) { return acc + item.value; }, 0);

  if (!total) {
    container.appendChild(node('p', { className: 'empty' }, 'Под текущий фильтр данных нет'));
    return;
  }

  var bar = node('div', { className: 'split' });
  items.forEach(function (item) {
    if (!item.value) return;
    var seg = node('div', { className: 'split__seg split__seg--' + item.source.slot });
    seg.style.flex = item.value + ' 1 0';
    seg.tabIndex = 0;
    bindTooltip(seg, function () {
      return {
        value: nf.format(item.value) + ' (' + pct(item.value, total) + ')',
        label: item.source.label,
        meta: rangeLabel(slice.view),
      };
    });
    bar.appendChild(seg);
  });
  container.appendChild(bar);

  // Легенда обязательна: цвет никогда не остаётся единственным носителем смысла.
  // Порядок — как в полосе, чтобы взгляд не пересобирал соответствие заново.
  var legend = node('div', { className: 'legend' });
  items.forEach(function (item) {
    var row = node('div', { className: 'legend__item' });
    row.appendChild(node('span', { className: 'legend__swatch legend__swatch--' + item.source.slot }));
    row.appendChild(node('span', {}, item.source.label + ' — '));
    row.appendChild(node('span', { className: 'legend__value' },
      pct(item.value, total) + ' · ' + compact(item.value)));
    legend.appendChild(row);
  });
  container.appendChild(legend);
}

function renderYoy(slice, sources) {
  var container = $('chart-yoy');
  container.textContent = '';

  $('yoy-sub').textContent = slice.previous.length
    ? rangeLabel(slice.view) + ' против ' + rangeLabel(slice.previous)
    : 'сравнивать не с чем: предыдущего периода такой же длины нет';

  if (!slice.previous.length || !sources.length) {
    container.appendChild(node('p', { className: 'empty' }, 'Под текущий фильтр сравнения нет'));
    return;
  }

  var rows = sources.map(function (s) {
    return {
      source: s,
      now: slice.view.reduce(function (acc, b) { return acc + (b.values[s.key] || 0); }, 0),
      was: slice.previous.reduce(function (acc, b) { return acc + (b.values[s.key] || 0); }, 0),
    };
  });
  var max = rows.reduce(function (m, r) { return Math.max(m, r.now, r.was); }, 0) || 1;

  var wrap = node('div', { className: 'pairs' });
  rows.forEach(function (row) {
    var delta = deltaInfo(row.now, row.was);
    var pair = node('div', { className: 'pair' });
    pair.tabIndex = 0;

    var label = node('div', { className: 'pair__label' });
    label.appendChild(node('span', { className: 'legend__swatch legend__swatch--' + row.source.slot }));
    var text = node('span', { className: 'pair__labeltext' }, row.source.short);
    text.title = row.source.label;
    label.appendChild(text);
    pair.appendChild(label);

    [['now', row.now], ['was', row.was]].forEach(function (entry) {
      var track = node('div', { className: 'pair__track pair__track--' + entry[0] });
      var fill = node('div', { className: 'pair__fill pair__fill--' + entry[0] });
      fill.style.width = Math.max((entry[1] / max) * 100, entry[1] > 0 ? 1 : 0) + '%';
      track.appendChild(fill);
      pair.appendChild(track);
    });

    var value = node('div', { className: 'pair__value' });
    value.appendChild(node('span', {}, compact(row.now)));
    var deltaEl = node('span', {
      className: 'pair__delta' + (delta.dir ? ' delta--' + (delta.dir > 0 ? 'up' : 'down') : ''),
    });
    if (delta.dir) deltaEl.appendChild(node('span', { className: 'delta__arrow' }, delta.dir > 0 ? '▲' : '▼'));
    deltaEl.appendChild(document.createTextNode(delta.text));
    value.appendChild(deltaEl);
    pair.appendChild(value);

    bindTooltip(pair, function () {
      return {
        value: compact(row.now) + ' → было ' + compact(row.was),
        label: row.source.label,
        meta: 'сейчас: ' + nf.format(row.now) + ' · раньше: ' + nf.format(row.was),
      };
    });

    wrap.appendChild(pair);
  });
  container.appendChild(wrap);

  var legend = node('div', { className: 'legend legend--top' });
  [['legend__swatch--1', rangeLabel(slice.view)], ['legend__swatch--muted', rangeLabel(slice.previous)]]
    .forEach(function (entry) {
      var item = node('div', { className: 'legend__item' });
      item.appendChild(node('span', { className: 'legend__swatch ' + entry[0] }));
      item.appendChild(node('span', {}, entry[1]));
      legend.appendChild(item);
    });
  container.appendChild(legend);
}

function renderEngines(slice) {
  var view = slice.view;
  var from = view.length ? view[0].from : '';
  var to = view.length ? view[view.length - 1].to : '';

  var months = STATE.engines.filter(function (row) {
    return (!from || row.key >= from) && (!to || row.key <= to);
  });

  var buckets = months.map(function (row) {
    var year = Number(row.key.slice(0, 4));
    var month = Number(row.key.slice(5, 7));
    return {
      key: row.key,
      label: monthLabel(year, month, false),
      short: monthLabel(year, month, true),
      values: row.values,
    };
  });

  var available = STATE.engines.length
    ? monthLabel(Number(STATE.engines[0].key.slice(0, 4)), Number(STATE.engines[0].key.slice(5, 7)), false)
    : '';
  $('engines-sub').textContent = buckets.length
    ? 'Из чего складываются переходы из поиска, по месяцам'
    : 'Разбивка по поисковым системам есть только с ' + (available || 'более поздних месяцев') +
      ' — расширьте период';

  renderColumns($('chart-engines'), { buckets: buckets, series: ENGINES, labelUnit: 'визитов' });
  renderLegend($('engines-legend'), ENGINES, buckets);
}

/* --- Столбцы (SVG) -------------------------------------------------------- */

var SVG_NS = 'http://www.w3.org/2000/svg';
var COL_GAP = 2;      // разделяет сегменты стопки поверхностью, а не обводкой
var COL_MAX = 24;     // столбец не заполняет слот целиком — остаток отдаём воздуху

function svgNode(tag, attrs) {
  var el = document.createElementNS(SVG_NS, tag);
  if (attrs) Object.keys(attrs).forEach(function (key) { el.setAttribute(key, attrs[key]); });
  return el;
}

function niceScale(max) {
  if (!(max > 0)) return { max: 1, ticks: [0, 1] };
  var raw = max / 4;
  var magnitude = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
  var normalized = raw / magnitude;
  var step = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10) * magnitude;
  var top = Math.ceil(max / step) * step;
  var ticks = [];
  for (var value = 0; value <= top + step / 1000; value += step) ticks.push(value);
  return { max: top, ticks: ticks };
}

/** Путь столбца: скруглённая шапка, квадратное основание. */
function columnPath(x, y, width, height, radius) {
  var r = Math.max(0, Math.min(radius, width / 2, height));
  return 'M' + x + ' ' + (y + height) +
    ' L' + x + ' ' + (y + r) +
    ' Q' + x + ' ' + y + ' ' + (x + r) + ' ' + y +
    ' L' + (x + width - r) + ' ' + y +
    ' Q' + (x + width) + ' ' + y + ' ' + (x + width) + ' ' + (y + r) +
    ' L' + (x + width) + ' ' + (y + height) + ' Z';
}

/**
 * Крайние подписи не срезаем и не даём вылезти за холст: у края текст
 * прижимается к нему и меняет якорь. 3,2px на символ — половина ширины
 * знака в 11px системном шрифте, с запасом.
 */
function fitText(x, length, width) {
  var half = length * 3.2;
  if (x - half < 2) return { x: 2, anchor: 'start' };
  if (x + half > width - 2) return { x: width - 2, anchor: 'end' };
  return { x: x, anchor: 'middle' };
}

function renderColumns(container, options) {
  container.textContent = '';

  var buckets = options.buckets || [];
  var series = options.series || [];

  if (!buckets.length || !series.length) {
    container.appendChild(node('p', { className: 'empty' }, 'Под текущий фильтр данных нет'));
    return;
  }

  var totals = buckets.map(function (bucket) { return totalOf(bucket.values, series); });
  var maxTotal = totals.reduce(function (m, v) { return Math.max(m, v); }, 0);
  var scale = niceScale(maxTotal);

  var width = Math.max(container.clientWidth || 0, 320);
  var padTop = 20;
  var padBottom = 26;
  var padRight = 26;   // место под подпись последнего столбца — её не сдвинуть влево
  var tickTexts = scale.ticks.map(function (t) { return axisFormat(t, scale.max); });
  var padLeft = Math.min(96, 14 + tickTexts.reduce(function (m, t) { return Math.max(m, t.length); }, 0) * 7);
  var height = 260;
  var plotW = Math.max(40, width - padLeft - padRight);
  var plotH = height - padTop - padBottom;
  var baseY = padTop + plotH;

  var svg = svgNode('svg', {
    viewBox: '0 0 ' + width + ' ' + height,
    width: width,
    height: height,
    class: 'col-chart',
    role: 'img',
  });
  svg.setAttribute('aria-label', 'Столбчатая диаграмма; значения продублированы в таблице ниже');
  svg.tabIndex = 0;

  var y = function (value) { return baseY - (value / scale.max) * plotH; };

  // Сетка — сплошные волосяные линии на шаг от поверхности, никаких пунктиров.
  scale.ticks.forEach(function (tick, i) {
    svg.appendChild(svgNode('line', {
      x1: padLeft, x2: padLeft + plotW, y1: y(tick), y2: y(tick),
      class: i === 0 ? 'col-chart__base' : 'col-chart__grid',
    }));
    var text = svgNode('text', { x: padLeft - 8, y: y(tick) + 4, 'text-anchor': 'end', class: 'col-chart__tick' });
    text.textContent = tickTexts[i];
    svg.appendChild(text);
  });

  // Воздух между столбцами — четверть слота, но не больше 6px: на длинных
  // рядах (127 месяцев) фиксированный отступ съедал бы сам столбец.
  var band = plotW / buckets.length;
  var colW = Math.max(1.5, Math.min(COL_MAX, band - Math.min(6, band * 0.25)));

  var bandsGroup = svgNode('g');
  var colsGroup = svgNode('g');
  var labelsGroup = svgNode('g');
  var hitsGroup = svgNode('g');
  svg.appendChild(bandsGroup);
  svg.appendChild(colsGroup);
  svg.appendChild(labelsGroup);
  svg.appendChild(hitsGroup);

  var bandRects = [];

  buckets.forEach(function (bucket, i) {
    var bandX = padLeft + band * i;
    var x = bandX + (band - colW) / 2;

    var bandRect = svgNode('rect', {
      x: bandX, y: padTop, width: band, height: plotH, rx: 3, class: 'col-chart__band',
    });
    bandsGroup.appendChild(bandRect);
    bandRects.push(bandRect);

    var drawable = series.filter(function (s) { return (bucket.values[s.key] || 0) > 0; });
    var cumulative = 0;

    drawable.forEach(function (s, index) {
      var value = bucket.values[s.key] || 0;
      var top = y(cumulative + value);
      var bottom = y(cumulative);
      var full = bottom - top;
      var isFirst = index === 0;
      var isTop = index === drawable.length - 1;
      var segHeight = isFirst ? full : full - COL_GAP;
      if (segHeight < 0.6) segHeight = 0.6;

      var attrs = { class: 'col-chart__seg col-chart__seg--' + s.slot };
      var shape;
      if (isTop) {
        attrs.d = columnPath(x, top, colW, segHeight, 4);
        shape = svgNode('path', attrs);
      } else {
        attrs.x = x; attrs.y = top; attrs.width = colW; attrs.height = segHeight;
        shape = svgNode('rect', attrs);
      }
      colsGroup.appendChild(shape);
      cumulative += value;
    });
  });

  // Подписи по X — прореживаем так, чтобы последняя всегда осталась.
  var labelStep = Math.max(1, Math.ceil(buckets.length / Math.max(1, Math.floor(plotW / 54))));
  buckets.forEach(function (bucket, i) {
    if ((buckets.length - 1 - i) % labelStep !== 0) return;
    var spot = fitText(padLeft + band * i + band / 2, bucket.short.length, width);
    var text = svgNode('text', {
      x: spot.x, y: baseY + 16, 'text-anchor': spot.anchor, class: 'col-chart__xlabel',
    });
    text.textContent = bucket.short;
    labelsGroup.appendChild(text);
  });

  // Прямые подписи — выборочно: пик и последний столбец, и только если не столкнутся.
  var peakIndex = totals.indexOf(maxTotal);
  var lastIndex = buckets.length - 1;
  var labelled = [peakIndex];
  if (lastIndex !== peakIndex && Math.abs(lastIndex - peakIndex) * band >= 56) labelled.push(lastIndex);
  labelled.forEach(function (i) {
    if (!totals[i]) return;
    var caption = compact(totals[i]);
    var spot = fitText(padLeft + band * i + band / 2, caption.length, width);
    var text = svgNode('text', {
      x: spot.x,
      y: Math.max(12, y(totals[i]) - 7),
      'text-anchor': spot.anchor,
      class: 'col-chart__value',
    });
    text.textContent = caption;
    labelsGroup.appendChild(text);
  });

  // Ховер живёт на всей полосе столбца, а не на закрашенных пикселях.
  var focusIndex = -1;
  var setActive = function (index, event) {
    bandRects.forEach(function (rect, i) { rect.classList.toggle('is-active', i === index); });
    if (index < 0) { hideTooltip(); return; }
    focusIndex = index;
    showTooltip(seriesTooltip(buckets[index], series, options.labelUnit), event, bandRects[index]);
  };

  buckets.forEach(function (bucket, i) {
    var hit = svgNode('rect', {
      x: padLeft + band * i, y: padTop, width: band, height: plotH, class: 'col-chart__hit',
    });
    hit.addEventListener('mouseenter', function (event) { setActive(i, event); });
    hit.addEventListener('mousemove', function (event) { setActive(i, event); });
    hit.addEventListener('mouseleave', function () { setActive(-1); });
    hitsGroup.appendChild(hit);
  });

  // Клавиатура: график — одна остановка табуляции, стрелки ходят по столбцам.
  svg.addEventListener('keydown', function (event) {
    var next = focusIndex;
    if (event.key === 'ArrowRight') next = Math.min(buckets.length - 1, focusIndex + 1);
    else if (event.key === 'ArrowLeft') next = Math.max(0, (focusIndex < 0 ? buckets.length : focusIndex) - 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = buckets.length - 1;
    else if (event.key === 'Escape') { setActive(-1); focusIndex = -1; return; }
    else return;
    event.preventDefault();
    setActive(next);
  });
  svg.addEventListener('blur', function () { setActive(-1); focusIndex = -1; });

  container.appendChild(svg);
}

function seriesTooltip(bucket, series, unit) {
  var rows = series
    .map(function (s) { return { series: s, value: bucket.values[s.key] || 0 }; })
    .filter(function (row) { return row.value > 0; });
  var total = rows.reduce(function (acc, row) { return acc + row.value; }, 0);
  return { title: bucket.label, rows: rows, total: total, unit: unit || '' };
}

/* --- Тепловая карта ------------------------------------------------------- */

function renderHeat(slice, sources) {
  var container = $('chart-heat');
  container.textContent = '';

  var from = slice.view.length ? slice.view[0].from : '';
  var to = slice.view.length ? slice.view[slice.view.length - 1].to : '';
  var months = STATE.months.filter(function (month) {
    return (!from || month.key >= from) && (!to || month.key <= to);
  });

  if (!months.length || !sources.length) {
    container.appendChild(node('p', { className: 'empty' }, 'Под текущий фильтр данных нет'));
    $('heat-legend').textContent = '';
    return;
  }

  var cells = {};
  var years = [];
  months.forEach(function (month) {
    if (!cells[month.year]) { cells[month.year] = {}; years.push(month.year); }
    cells[month.year][month.month] = { month: month, value: totalOf(month.values, sources) };
  });
  years.sort(function (a, b) { return b - a; });

  var values = months.map(function (month) { return totalOf(month.values, sources); });
  var bins = heatBins(values);

  var table = node('table', { className: 'heat' });
  var head = node('tr');
  head.appendChild(node('th', { scope: 'col' }, 'Год'));
  MONTH_SHORT.forEach(function (name) { head.appendChild(node('th', { scope: 'col' }, name)); });
  head.appendChild(node('th', { scope: 'col' }, 'Всего'));
  var thead = node('thead');
  thead.appendChild(head);
  table.appendChild(thead);

  var body = node('tbody');
  years.forEach(function (year) {
    var tr = node('tr');
    tr.appendChild(node('th', { scope: 'row' }, String(year)));
    var yearTotal = 0;

    for (var month = 1; month <= 12; month++) {
      var cell = cells[year][month];
      var td = node('td');
      if (!cell) {
        td.className = 'is-empty';
        td.textContent = '·';
        td.title = monthLabel(year, month, false) + ' — за пределами выбранного периода';
      } else {
        yearTotal += cell.value;
        td.className = 'l' + binOf(cell.value, bins);
        td.textContent = compact(cell.value);
        td.tabIndex = 0;
        bindTooltip(td, (function (entry) {
          return function () {
            return {
              value: nf.format(entry.value) + ' визитов',
              label: entry.month.label,
              meta: sources.map(function (s) {
                return s.short + ': ' + compact(entry.month.values[s.key] || 0);
              }).join(' · '),
            };
          };
        })(cell));
      }
      tr.appendChild(td);
    }

    tr.appendChild(node('td', { className: 'total' }, compact(yearTotal)));
    body.appendChild(tr);
  });
  table.appendChild(body);
  container.appendChild(table);

  renderHeatLegend(bins);
}

/**
 * Пороги берём по квантилям, а не равными шагами: распределение визитов
 * длиннохвостое, и на равных шагах вся карта схлопнулась бы в один оттенок.
 */
function heatBins(values) {
  var sorted = values.slice().sort(function (a, b) { return a - b; });
  var thresholds = [];
  for (var i = 1; i <= 6; i++) {
    var raw = sorted[Math.floor((sorted.length - 1) * (i / 7))];
    var rounded = roundSignificant(raw, 2);
    if (!thresholds.length || rounded > thresholds[thresholds.length - 1]) thresholds.push(rounded);
  }
  return thresholds;
}

function roundSignificant(value, digits) {
  if (!value) return 0;
  var magnitude = Math.pow(10, Math.floor(Math.log(Math.abs(value)) / Math.LN10) - (digits - 1));
  return Math.round(value / magnitude) * magnitude;
}

/** «270–350 тыс» вместо «270 тыс–350 тыс»: единицу повторять незачем. */
function rangeText(from, to) {
  var low = compact(from);
  var high = compact(to);
  var unit = / (млн|тыс)$/.exec(high);
  if (unit && low.slice(-unit[0].length) === unit[0]) {
    low = low.slice(0, -unit[0].length);
  }
  return low + '–' + high;
}

function binOf(value, bins) {
  var index = 0;
  for (var i = 0; i < bins.length; i++) if (value >= bins[i]) index = i + 1;
  return index;
}

function renderHeatLegend(bins) {
  var legend = $('heat-legend');
  legend.textContent = '';
  legend.appendChild(node('span', { className: 'legend__caption' }, 'Визитов за месяц:'));

  var labels = [];
  for (var i = 0; i <= bins.length; i++) {
    if (i === 0) labels.push('< ' + compact(bins[0]));
    else if (i === bins.length) labels.push('≥ ' + compact(bins[bins.length - 1]));
    else labels.push(rangeText(bins[i - 1], bins[i]));
  }

  labels.forEach(function (label, i) {
    var step = node('span', { className: 'scale-step' });
    var chip = node('span', { className: 'scale-step__chip' });
    chip.style.background = 'var(--h' + i + ')';
    step.appendChild(chip);
    step.appendChild(node('span', {}, label));
    legend.appendChild(step);
  });

  var empty = node('span', { className: 'scale-step' });
  var chip = node('span', { className: 'scale-step__chip' });
  chip.style.background = 'transparent';
  chip.style.boxShadow = 'inset 0 0 0 1px var(--grid)';
  empty.appendChild(chip);
  empty.appendChild(node('span', {}, 'нет месяца'));
  legend.appendChild(empty);
}

/* --- Таблица -------------------------------------------------------------- */

function tableColumns(sources) {
  var columns = [
    { key: 'period', label: 'Период', numeric: false },
    { key: 'total', label: 'Визиты', numeric: true },
  ];
  sources.forEach(function (s) {
    columns.push({ key: s.key, label: s.short, numeric: true, slot: s.slot, title: s.label });
  });
  // Доля поиска от суммы без поиска — не число, а недоразумение: колонку прячем.
  if (sources.some(function (s) { return s.key === 'search'; })) {
    columns.push({ key: 'share', label: 'Доля поиска', numeric: true });
  }
  columns.push({ key: 'delta', label: 'К пред.', numeric: true });
  return columns;
}

function tableRows(slice, sources) {
  var all = slice.all;
  var index = {};
  all.forEach(function (bucket, i) { index[bucket.key] = i; });

  return slice.view.map(function (bucket) {
    var total = totalOf(bucket.values, sources);
    var i = index[bucket.key];
    var previous = i > 0 ? all[i - 1] : null;
    var was = previous ? totalOf(previous.values, sources) : 0;
    var row = {
      period: bucket.label,
      key: bucket.key,
      total: total,
      share: total ? ((bucket.values.search || 0) / total) * 100 : 0,
      delta: previous && was ? ((total - was) / was) * 100 : null,
      deltaKnown: Boolean(previous && was),
      previousLabel: previous ? previous.label : '',
    };
    sources.forEach(function (s) { row[s.key] = bucket.values[s.key] || 0; });
    return row;
  });
}

function renderTable(slice, sources) {
  var columns = tableColumns(sources);
  var rows = tableRows(slice, sources);
  var showShare = columns.some(function (column) { return column.key === 'share'; });

  // Колонка могла уехать вместе с выключенным источником — сортировку возвращаем к периоду.
  if (!columns.some(function (column) { return column.key === STATE.sort.key; })) {
    STATE.sort = { key: 'period', dir: 'desc' };
  }

  var head = $('table-head');
  head.textContent = '';
  columns.forEach(function (column) {
    var th = node('th', { scope: 'col', class: column.numeric ? 'num' : '' });
    th.dataset.sort = column.key;
    if (column.slot) {
      th.appendChild(node('span', { className: 'head-dot head-dot--' + column.slot }));
      th.title = column.title;
    }
    th.appendChild(document.createTextNode(column.label));
    if (STATE.sort.key === column.key) {
      th.setAttribute('aria-sort', STATE.sort.dir === 'asc' ? 'ascending' : 'descending');
    }
    th.addEventListener('click', function () {
      if (STATE.sort.key === column.key) {
        STATE.sort.dir = STATE.sort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        STATE.sort.key = column.key;
        STATE.sort.dir = column.numeric || column.key === 'period' ? 'desc' : 'asc';
      }
      render();
    });
    head.appendChild(th);
  });

  var sorted = rows.slice().sort(comparator(STATE.sort));
  $('table-sub').textContent = rows.length
    ? nf.format(rows.length) + ' ' + plural(rows.length, 'период', 'периода', 'периодов') +
      ' · шаг: ' + STEP_LABEL[slice.step]
    : 'под текущий фильтр данных нет';

  var body = $('table-body');
  body.textContent = '';

  if (!sorted.length) {
    var emptyRow = node('tr');
    emptyRow.appendChild(node('td', { colSpan: columns.length, className: 'empty' }, 'Под текущий фильтр данных нет'));
    body.appendChild(emptyRow);
    return;
  }

  var fragment = document.createDocumentFragment();
  sorted.forEach(function (row) {
    var tr = node('tr');
    tr.appendChild(node('td', { className: 'period' }, row.period));
    tr.appendChild(node('td', { className: 'num' }, nf.format(row.total)));
    sources.forEach(function (s) {
      tr.appendChild(node('td', { className: 'num' + (row[s.key] ? '' : ' zero') }, nf.format(row[s.key])));
    });
    if (showShare) {
      tr.appendChild(node('td', { className: 'num' }, ru(row.share, row.share < 10 ? 1 : 0) + '%'));
    }

    var deltaCell = node('td', { className: 'num' });
    if (row.deltaKnown) {
      var dir = row.delta > 0.05 ? 1 : row.delta < -0.05 ? -1 : 0;
      var span = node('span', { className: dir ? 'delta--' + (dir > 0 ? 'up' : 'down') : '' });
      if (dir) span.appendChild(node('span', { className: 'delta__arrow' }, dir > 0 ? '▲' : '▼'));
      span.appendChild(document.createTextNode(formatDelta(row.delta, dir)));
      span.title = 'к периоду «' + row.previousLabel + '»';
      deltaCell.appendChild(span);
    } else {
      deltaCell.textContent = '—';
      deltaCell.className = 'num zero';
    }
    tr.appendChild(deltaCell);

    fragment.appendChild(tr);
  });
  body.appendChild(fragment);
}

function comparator(sort) {
  var dir = sort.dir === 'asc' ? 1 : -1;
  return function (a, b) {
    if (sort.key === 'period') return (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) * dir;
    var x = a[sort.key];
    var y = b[sort.key];
    if (x === null) x = -Infinity;
    if (y === null) y = -Infinity;
    if (typeof x === 'number' && typeof y === 'number') {
      return (x - y) * dir || (a.key < b.key ? -1 : 1);
    }
    return String(x).localeCompare(String(y), 'ru') * dir;
  };
}

/* --- Тултип --------------------------------------------------------------- */

var tooltip = null;

function tooltipContent(data) {
  tooltip.textContent = '';

  if (data.rows) {
    tooltip.appendChild(node('div', { className: 'tooltip__title' }, data.title));
    var grid = node('div', { className: 'tooltip__rows' });
    data.rows.forEach(function (row) {
      grid.appendChild(node('span', { className: 'tooltip__key tooltip__key--' + row.series.slot }));
      grid.appendChild(node('span', { className: 'tooltip__name' }, row.series.short));
      grid.appendChild(node('span', { className: 'tooltip__num' }, nf.format(row.value)));
    });
    tooltip.appendChild(grid);
    var total = node('div', { className: 'tooltip__total' });
    total.appendChild(node('span', { className: 'tooltip__name' }, 'Всего'));
    total.appendChild(node('span', { className: 'tooltip__num' }, nf.format(data.total)));
    tooltip.appendChild(total);
    return;
  }

  tooltip.appendChild(node('div', { className: 'tooltip__value' }, data.value));
  tooltip.appendChild(node('div', { className: 'tooltip__label' }, data.label));
  if (data.meta) tooltip.appendChild(node('div', { className: 'tooltip__meta' }, data.meta));
}

function showTooltip(data, event, anchor) {
  tooltipContent(data);
  tooltip.classList.add('is-visible');
  tooltip.setAttribute('aria-hidden', 'false');
  position(event, anchor);
}

function hideTooltip() {
  tooltip.classList.remove('is-visible');
  tooltip.setAttribute('aria-hidden', 'true');
}

function bindTooltip(el, getContent) {
  var show = function (event) { showTooltip(getContent(), event, el); };
  el.addEventListener('mouseenter', show);
  el.addEventListener('mousemove', function (event) { position(event, el); });
  el.addEventListener('mouseleave', hideTooltip);
  el.addEventListener('focus', show);
  el.addEventListener('blur', hideTooltip);
}

function position(event, el) {
  var rect = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
  var x = event && event.clientX ? event.clientX + 14 : rect ? rect.left + rect.width / 2 : 16;
  var y = (event && event.clientY ? event.clientY : rect ? rect.top : 16) - 8;

  tooltip.style.left = '0px';
  tooltip.style.top = '0px';
  var box = tooltip.getBoundingClientRect();

  var left = Math.min(Math.max(8, x), window.innerWidth - box.width - 8);
  var top = Math.min(Math.max(8, y - box.height), window.innerHeight - box.height - 8);
  tooltip.style.left = left + 'px';
  tooltip.style.top = top + 'px';
}

/* --- Мелочи --------------------------------------------------------------- */

function plural(n, one, few, many) {
  var mod10 = n % 10;
  var mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** Мини-хелпер для DOM: значения всегда кладём через textContent. */
function node(tag, props, text) {
  var el = document.createElement(tag);
  if (props) {
    Object.keys(props).forEach(function (key) {
      if (key === 'className') el.className = props[key];
      else if (key === 'colSpan') el.colSpan = props[key];
      else el.setAttribute(key, props[key]);
    });
  }
  if (text !== undefined && text !== null) el.textContent = text;
  return el;
}

/* --- CSV ------------------------------------------------------------------ */

function exportCsv() {
  var slice = currentSlice();
  var sources = activeSources();
  var columns = tableColumns(sources);
  var rows = tableRows(slice, sources).slice().sort(comparator(STATE.sort));

  var lines = [columns.map(function (c) { return c.label; }).join(';')];
  rows.forEach(function (row) {
    lines.push(columns.map(function (column) {
      if (column.key === 'share') return ru(row.share, 1);
      if (column.key === 'delta') return row.deltaKnown ? ru(row.delta, 1) : '';
      return row[column.key];
    }).map(csvCell).join(';'));
  });

  // BOM — чтобы Excel открыл кириллицу без плясок с кодировкой.
  var blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var link = document.createElement('a');
  link.href = url;
  link.download = 'traffic-' + STATE.filters.step + '.csv';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}

function csvCell(value) {
  var text = String(value === null || value === undefined ? '' : value);
  return /[";\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

/* --- Тема ----------------------------------------------------------------- */

function toggleTheme() {
  var root = document.documentElement;
  var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  var current = root.dataset.theme || (prefersDark ? 'dark' : 'light');
  var next = current === 'dark' ? 'light' : 'dark';
  root.dataset.theme = next;
  try { localStorage.setItem('traffic-dashboard-theme', next); } catch (e) {}
}

/* --- Инициализация -------------------------------------------------------- */

function buildSourceChecks() {
  var container = $('f-sources');
  container.textContent = '';

  SOURCES.forEach(function (s) {
    var label = node('label', { className: 'check check--' + s.slot });
    var input = node('input', { type: 'checkbox' });
    input.checked = STATE.filters.sources[s.key];
    input.addEventListener('change', function () {
      STATE.filters.sources[s.key] = input.checked;
      // Ни один источник не выбран — возвращаем последний, иначе смотреть нечего.
      if (!activeSources().length) {
        STATE.filters.sources[s.key] = true;
        input.checked = true;
      }
      render();
    });
    label.appendChild(input);
    label.appendChild(node('span', { className: 'check__dot' }));
    label.appendChild(node('span', {}, s.short));
    label.title = s.label;
    container.appendChild(label);
  });
}

function bindControls() {
  $('f-window').addEventListener('change', function (e) {
    STATE.filters.window = Number(e.target.value);
    render();
  });
  $('f-step').addEventListener('change', function (e) {
    STATE.filters.step = e.target.value;
    render();
  });

  $('reset').addEventListener('click', function () {
    STATE.filters = { window: 24, step: 'month', sources: activeAll() };
    STATE.sort = { key: 'period', dir: 'desc' };
    $('f-window').value = '24';
    $('f-step').value = 'month';
    buildSourceChecks();
    render();
  });

  $('refresh').addEventListener('click', function () { load(true); });
  $('theme').addEventListener('click', toggleTheme);
  $('export').addEventListener('click', exportCsv);

  var resizeTimer;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(render, 150);
  });
}

function init() {
  tooltip = $('tooltip');
  buildSourceChecks();
  bindControls();
  load(false);
  setInterval(function () {
    if (!document.hidden) load(false);
  }, CONFIG.autoRefreshMs);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
