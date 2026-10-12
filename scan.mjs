// Сканер мобильного UX: находит то, на чём сайты теряют покупателей, и меряет Core Web Vitals.
// Проверки собраны по исследованиям Baymard (мобильный e-commerce), WCAG 2.2 (размер цели 24 px,
// рекомендация Apple 44 pt / Material 48 dp) и web.dev (LCP < 2,5 c, CLS < 0,1).
// Запуск: node scan.mjs <out-dir> <url> [url2 ...] [--views=phone,phone-small,tablet] [--wait=2500]
// Результат: <out-dir>/scan.json + скриншоты (полная страница и первый экран).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url'; // кириллица в пути ломает обычный URL.pathname
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => a.replace(/^--/, '').split('=')));
const [OUT, ...urls] = args.filter((a) => !a.startsWith('--'));
if (!OUT || !urls.length) {
  console.error('node scan.mjs <out-dir> <url> [url2 ...] [--views=phone,tablet] [--wait=2500] [--tormoz]');
  process.exit(1);
}
const WAIT = Number(flags.wait || 2500);
// --tormoz: мерить как у покупателя (медленный 4G, процессор в 4 раза медленнее).
// Без него числа получаются оптимистичными, см. комментарий у настройки CDP ниже.
const TORMOZ = 'tormoz' in flags;
const VIEWS = {
  'phone-small': { width: 360, height: 780 },
  phone: { width: 390, height: 844 },
  tablet: { width: 768, height: 1024 },
  pc: { width: 1366, height: 900 },
};
const views = (flags.views || 'phone').split(',').map((v) => v.trim()).filter((v) => VIEWS[v]);
fs.mkdirSync(OUT, { recursive: true });

// собирается до загрузки страницы: LCP, CLS и длинные задачи
const VITALS = `
window.__vitals = { cls: 0, shifts: [], lcp: 0, lcpEl: '', longTasks: 0 };
try {
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) {
      if (e.hadRecentInput) continue;
      window.__vitals.cls += e.value;
      const src = (e.sources || []).map((s) => s.node && s.node.nodeName ? s.node.nodeName.toLowerCase() + (s.node.className && typeof s.node.className === 'string' ? '.' + s.node.className.trim().split(/\\s+/).slice(0,2).join('.') : '') : '?');
      if (e.value > 0.01) window.__vitals.shifts.push({ v: +e.value.toFixed(3), src: src.slice(0, 2) });
    }
  }).observe({ type: 'layout-shift', buffered: true });
  new PerformanceObserver((l) => {
    const e = l.getEntries().at(-1);
    if (!e) return;
    window.__vitals.lcp = Math.round(e.startTime);
    const n = e.element;
    window.__vitals.lcpEl = n ? (n.nodeName.toLowerCase() + (n.id ? '#' + n.id : '') + (n.className && typeof n.className === 'string' ? '.' + n.className.trim().split(/\\s+/).slice(0,2).join('.') : '')) : (e.url || '');
  }).observe({ type: 'largest-contentful-paint', buffered: true });
  new PerformanceObserver((l) => { window.__vitals.longTasks += l.getEntries().length; }).observe({ type: 'longtask', buffered: true });
} catch (e) {}
`;

const AUDIT = () => {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const sel = (el) => {
    if (!el || !el.nodeName) return '?';
    const cls = typeof el.className === 'string' && el.className.trim()
      ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
      : '';
    return el.nodeName.toLowerCase() + (el.id ? '#' + el.id : '') + cls;
  };
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity > 0.05;
  };
  const rgb = (v) => {
    const m = (v || '').match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(',').map((x) => parseFloat(x));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = (c) => {
    const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const bgOf = (el) => {
    let n = el;
    while (n && n.nodeType === 1) {
      const c = rgb(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0.5) return c;
      n = n.parentElement;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };
  const contrast = (a, b) => {
    const l1 = lum(a);
    const l2 = lum(b);
    return +(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05))).toFixed(2);
  };

  const all = [...document.querySelectorAll('*')];
  const res = {
    url: location.href,
    viewport: [W, H],
    scrollWidth: document.documentElement.scrollWidth,
    docHeight: document.documentElement.scrollHeight,
    overflowX: document.documentElement.scrollWidth > W + 1,
  };

  // 1. блоки, вылезающие за экран.
  // Важно: элемент за краем экрана — ещё не проблема. Слайды карусели лежат за краем
  // внутри контейнера с overflow: hidden, и страница вбок не прокручивается.
  // Проблема — только то, что НЕ обрезано предком. Проверено 24.09.2026 на магазине заказчика,
  // где 15 «вылезающих» блоков оказались нормальной каруселью.
  const clippedByAncestor = (el) => {
    const r = el.getBoundingClientRect();
    for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      const ps = getComputedStyle(p);
      const ox = ps.overflowX;
      if (ox === 'hidden' || ox === 'clip' || ox === 'auto' || ox === 'scroll') {
        const pr = p.getBoundingClientRect();
        if (r.right > pr.right - 1 || r.left < pr.left + 1) return true;
      }
    }
    return false;
  };

  res.overflow = all.filter((el) => {
    if (!vis(el)) return false;
    const s = getComputedStyle(el);
    if (s.position === 'fixed') return false;
    const r = el.getBoundingClientRect();
    const out = r.width > 2 && (r.right > W + 2 || r.left < -2) && r.width <= document.documentElement.scrollWidth + 2;
    return out && !clippedByAncestor(el);
  }).map((el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    // Подсказка, из-за чего вылезло: три самые частые причины на телефоне.
    const why = [];
    const cssW = el.style.width || '';
    if (/vw/.test(cssW) || /vw/.test(s.minWidth)) why.push('ширина в vw (включает полосу прокрутки)');
    if (/^\d+px$/.test(cssW) && parseInt(cssW, 10) > W) why.push(`жёсткая ширина ${cssW}`);
    if (parseFloat(s.marginLeft) < 0 || parseFloat(s.marginRight) < 0) why.push('отрицательный отступ');
    if (s.position === 'absolute' && parseFloat(s.left) > W * 0.8) why.push('абсолютное позиционирование');
    if (r.width > W && s.display.includes('flex') && s.flexWrap === 'nowrap') why.push('flex без переноса');
    return {
      sel: sel(el),
      w: Math.round(r.width),
      right: Math.round(r.right),
      why: why.join('; '),
      text: (el.innerText || '').trim().slice(0, 40),
    };
  }).slice(0, 15);

  // 2. мелкие цели нажатия (WCAG 2.5.8 — минимум 24, Apple 44, Material 48)
  const clickables = all.filter((el) => {
    const t = el.nodeName.toLowerCase();
    const role = el.getAttribute && el.getAttribute('role');
    const ok = ['a', 'button', 'select', 'summary'].includes(t) || (t === 'input' && !['hidden'].includes(el.type)) ||
      role === 'button' || role === 'link' || (el.onclick != null);
    return ok && vis(el);
  });
  // У критерия 2.5.8 есть исключения, и без них инструмент врёт.
  // «Строчное» — ссылка внутри предложения: под исключение попадает и размером 12 px.
  const inlineInText = (el) => {
    const d = getComputedStyle(el).display;
    if (!d.startsWith('inline')) return false;
    const p = el.parentElement;
    if (!p) return false;
    const own = (el.textContent || '').trim().length;
    const around = (p.textContent || '').trim().length;
    return around > own + 5;
  };
  const boxes = clickables.map((el) => {
    const r = el.getBoundingClientRect();
    return { l: r.left, t: r.top, rt: r.right, b: r.bottom, cx: r.left + r.width / 2, cy: r.top + r.height / 2, min: Math.min(r.width, r.height) };
  });
  // «Расстояние» по букве критерия: вокруг маленькой цели рисуем круг диаметром 24 px.
  // Он не должен задевать ни соседнюю цель целиком, ни круг вокруг другой маленькой цели.
  // Сравнивать одни только центры нельзя: рядом может стоять большая кнопка,
  // её центр далеко, а край — вплотную.
  const spacedOk = (i) => {
    const a = boxes[i];
    for (let j = 0; j < boxes.length; j++) {
      if (j === i) continue;
      const b = boxes[j];
      if (b.min < 24) {
        if (Math.hypot(a.cx - b.cx, a.cy - b.cy) < 24) return false;
      } else {
        const dx = Math.max(b.l - a.cx, 0, a.cx - b.rt);
        const dy = Math.max(b.t - a.cy, 0, a.cy - b.b);
        if (Math.hypot(dx, dy) < 12) return false;
      }
    }
    return true;
  };
  const small = clickables.map((el, i) => {
    const r = el.getBoundingClientRect();
    const min = Math.round(Math.min(r.width, r.height));
    let isklyuchenie = null;
    if (min < 24) {
      if (inlineInText(el)) isklyuchenie = 'строчная ссылка в тексте';
      else if (spacedOk(i)) isklyuchenie = 'соседние цели дальше 24 px';
    }
    return {
      sel: sel(el),
      w: Math.round(r.width),
      h: Math.round(r.height),
      isklyuchenie,
      text: (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 30),
    };
  }).filter((x) => Math.min(x.w, x.h) < 44);
  const narusheniya = small.filter((x) => Math.min(x.w, x.h) < 24 && !x.isklyuchenie);
  res.tapTargets = {
    total: clickables.length,
    under44: small.length,
    under24: small.filter((x) => Math.min(x.w, x.h) < 24).length,
    narusheniyaAA: narusheniya.length,
    poIsklyucheniyu: small.filter((x) => x.isklyuchenie).length,
    worst: small.sort((a, b) => Math.min(a.w, a.h) - Math.min(b.w, b.h)).slice(0, 12),
  };

  // 3. мелкий текст и поля, из-за которых iOS увеличивает страницу
  const texts = all.filter((el) => vis(el) && el.children.length === 0 && (el.innerText || '').trim().length > 8);
  res.smallText = texts.map((el) => ({ sel: sel(el), size: parseFloat(getComputedStyle(el).fontSize), text: el.innerText.trim().slice(0, 40) }))
    .filter((x) => x.size < 12).slice(0, 12);
  res.inputsZoom = [...document.querySelectorAll('input, select, textarea')].filter(vis)
    .map((el) => ({ sel: sel(el), size: parseFloat(getComputedStyle(el).fontSize), type: el.type || el.nodeName.toLowerCase() }))
    .filter((x) => x.size < 16);

  // 4. низкий контраст текста (WCAG AA: 4.5 для обычного, 3 для крупного/жирного)
  res.lowContrast = texts.map((el) => {
    const s = getComputedStyle(el);
    const fg = rgb(s.color);
    if (!fg) return null;
    const size = parseFloat(s.fontSize);
    const bold = parseInt(s.fontWeight, 10) >= 700;
    const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
    const c = contrast(fg, bgOf(el));
    return c < need ? { sel: sel(el), contrast: c, need, size, text: el.innerText.trim().slice(0, 40) } : null;
  }).filter(Boolean).slice(0, 12);

  // 5. картинки: без размеров (прыгает вёрстка) и сильно больше, чем показаны
  const imgs = [...document.querySelectorAll('img')].filter(vis);
  res.images = {
    total: imgs.length,
    noDimensions: imgs.filter((i) => !(i.getAttribute('width') && i.getAttribute('height')) && getComputedStyle(i).aspectRatio === 'auto').length,
    oversized: imgs.map((i) => {
      const r = i.getBoundingClientRect();
      const factor = i.naturalWidth && r.width ? +(i.naturalWidth / (r.width * devicePixelRatio)).toFixed(1) : 0;
      return { src: (i.currentSrc || i.src || '').split('/').pop().slice(0, 40), shown: Math.round(r.width), natural: i.naturalWidth, factor };
    }).filter((x) => x.factor >= 2).sort((a, b) => b.factor - a.factor).slice(0, 8),
    lazyAboveFold: imgs.filter((i) => i.loading === 'lazy' && i.getBoundingClientRect().top < H).length,
  };

  // 6. закреплённые панели: сколько экрана они съедают
  res.sticky = all.filter((el) => {
    if (!vis(el)) return false;
    const s = getComputedStyle(el);
    return (s.position === 'fixed' || s.position === 'sticky') && el.getBoundingClientRect().height > 20;
  }).map((el) => {
    const r = el.getBoundingClientRect();
    return { sel: sel(el), h: Math.round(r.height), top: Math.round(r.top), pctOfScreen: Math.round((r.height / H) * 100), text: (el.innerText || '').trim().slice(0, 50) };
  }).sort((a, b) => b.h - a.h).slice(0, 8);

  // 7. плашка cookie: где стоит и сколько закрывает
  const cookieEl = all.find((el) => {
    if (!vis(el)) return false;
    const s = getComputedStyle(el);
    if (s.position !== 'fixed' && s.position !== 'sticky') return false;
    const t = (el.innerText || '').toLowerCase();
    return (t.includes('cookie') || t.includes('куки') || t.includes('файлы cookie')) && t.length < 600;
  });
  res.cookieBanner = cookieEl ? (() => {
    const r = cookieEl.getBoundingClientRect();
    const place = r.top < H * 0.25 ? 'сверху' : r.bottom > H * 0.75 ? 'снизу' : 'посередине';
    const btns = [...cookieEl.querySelectorAll('button, a, [role=button]')].map((b) => (b.innerText || '').trim()).filter(Boolean);
    return { sel: sel(cookieEl), place, coverPct: Math.round(((r.height * r.width) / (W * H)) * 100), buttons: btns.slice(0, 6), hasReject: btns.some((b) => /отклон|только необходим|reject|нет/i.test(b)) };
  })() : null;

  // 8. формы: понятны ли поля и удобная ли клавиатура на телефоне
  res.forms = [...document.querySelectorAll('input, select, textarea')].filter(vis).map((el) => {
    const id = el.id;
    const labelled = !!(el.getAttribute('aria-label') || el.getAttribute('placeholder') || (id && document.querySelector(`label[for="${CSS.escape(id)}"]`)) || el.closest('label'));
    return { sel: sel(el), type: el.type || el.nodeName.toLowerCase(), labelled, autocomplete: el.getAttribute('autocomplete') || '', inputmode: el.getAttribute('inputmode') || '' };
  });

  // 9. мета viewport: не запрещено ли увеличение
  const vp = document.querySelector('meta[name=viewport]');
  res.viewportMeta = vp ? vp.getAttribute('content') : null;
  res.zoomBlocked = !!(res.viewportMeta && /user-scalable\s*=\s*(no|0)|maximum-scale\s*=\s*1/.test(res.viewportMeta));

  // 11. анимация: что именно двигается и уважают ли настройку «меньше движения».
  // Плавно идут только transform и opacity — остальное пересчитывает раскладку на каждом кадре.
  const DESHEVYE = new Set(['transform', 'opacity', 'translate', 'rotate', 'scale', 'filter',
    'color', 'background-color', 'border-color', 'box-shadow', 'visibility', 'outline-color']);
  const dorogie = new Set();
  // Отсев шума: свои переменные, служебные свойства самой анимации и вендорные приставки.
  // Без него в список попадали --can-scroll и animation-timing-function (поймано 24.09.2026).
  const dobavit = (s) => {
    if (!s || s.startsWith('--')) return;
    const imya = s.replace(/^-(webkit|moz|ms|o)-/, '');
    if (imya.startsWith('animation-') || imya.startsWith('transition-')) return;
    if (!DESHEVYE.has(imya)) dorogie.add(imya);
  };
  let vsegoAnimaciy = 0;
  try {
    for (const a of document.getAnimations()) {
      vsegoAnimaciy++;
      const eff = a.effect;
      const svoystva = typeof eff?.getKeyframes === 'function'
        ? [...new Set(eff.getKeyframes().flatMap((k) => Object.keys(k)))]
        : [];
      for (const s of svoystva) {
        if (['offset', 'computedOffset', 'easing', 'composite'].includes(s)) continue;
        // имена приходят в виде borderRadius, приводим к виду border-radius
        dobavit(s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()));
      }
    }
  } catch { /* getAnimations есть не везде */ }

  // Ищем в стилях страницы упоминание настройки «меньше движения».
  // Чужие таблицы стилей читать нельзя, поэтому считаем только свои и встроенные.
  // Заодно смотрим сами правила: getAnimations() видит только то, что бежит прямо сейчас,
  // а переход по наведению в этот момент не бежит. Без разбора стилей проверка почти пустая.
  let uvazhaetNastroyku = false;
  let stileyNeProchitano = 0;
  const obhod = (rules) => {
    for (const rule of rules) {
      if (rule.conditionText && rule.conditionText.includes('prefers-reduced-motion')) uvazhaetNastroyku = true;
      const st = rule.style;
      if (st) {
        const perehod = st.transitionProperty || '';
        for (const s of perehod.split(',').map((x) => x.trim()).filter(Boolean)) {
          if (s !== 'all' && s !== 'none') dobavit(s);
        }
      }
      if (rule.cssRules) obhod(rule.cssRules);            // @media и вложенные
      if (typeof rule.length === 'number' && rule.name) { // @keyframes
        for (const kadr of rule.cssRules || []) {
          for (const s of kadr.style || []) dobavit(s);
        }
      }
    }
  };
  for (const sheet of document.styleSheets) {
    try { obhod(sheet.cssRules); } catch { stileyNeProchitano++; }
  }
  res.animaciya = {
    vsego: vsegoAnimaciy,
    dorogieSvoystva: [...dorogie].slice(0, 8),
    uvazhaetNastroyku,
    stileyNeProchitano,
  };

  // 10. заголовки и alt — для поиска и доступности
  res.h1 = [...document.querySelectorAll('h1')].map((h) => h.innerText.trim().slice(0, 60));
  res.imgNoAlt = imgs.filter((i) => !i.getAttribute('alt')).length;
  res.title = document.title;
  res.vitals = window.__vitals || null;
  return res;
};

const b = await chromium.launch();
const rows = [];
// Проверка доступности через axe-core. Ловит 30–57% нарушений WCAG —
// это пол, а не потолок: клавиатуру и экранный диктор всё равно смотрим руками.
const AXE_SRC = (() => {
  for (const p of ['../shot/node_modules/axe-core/axe.min.js', 'node_modules/axe-core/axe.min.js']) {
    const f = path.join(path.dirname(fileURLToPath(import.meta.url)), p);
    if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
  }
  return null;
})();

async function runAxe (page) {
  if (!AXE_SRC) return { error: 'axe-core не найден' };
  try {
    await page.addScriptTag({ content: AXE_SRC });
    const r = await page.evaluate(async () => {
      const map = v => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        count: v.nodes.length,
        example: (v.nodes[0]?.target || []).join(' ').slice(0, 90),
      });
      const res = await window.axe.run(document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
      });
      // incomplete — то, что axe не смог решить сам: контраст поверх картинки,
      // скрытые состояния. Это не «всё хорошо», это «посмотри глазами».
      return { violations: res.violations.map(map), incomplete: res.incomplete.map(map) };
    });
    const weight = { critical: 4, serious: 3, moderate: 2, minor: 1 };
    const bySeverity = (a, b) => (weight[b.impact] || 0) - (weight[a.impact] || 0) || b.count - a.count;
    r.violations.sort(bySeverity);
    r.incomplete.sort(bySeverity);
    return {
      violations: r.violations.slice(0, 15),
      total: r.violations.reduce((s, v) => s + v.count, 0),
      incomplete: r.incomplete.slice(0, 10),
      incompleteTotal: r.incomplete.reduce((s, v) => s + v.count, 0),
    };
  } catch (e) {
    return { error: String(e).slice(0, 120) };
  }
}

for (const url of urls) {
  for (const view of views) {
    const vp = VIEWS[view];
    const isPhone = vp.width < 768;
    const ctx = await b.newContext({
      viewport: vp,
      locale: 'ru-RU',
      deviceScaleFactor: isPhone ? 3 : 1,
      isMobile: isPhone,
      hasTouch: isPhone,
      userAgent: isPhone
        ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
        : undefined,
    });
    await ctx.addInitScript(VITALS);
    const p = await ctx.newPage();

    // Торможение до условий покупателя. Без него замеры получаются оптимистичными:
    // 25.09.2026 на магазине заказчика наш LCP был 4,1–4,8 с, а с торможением 5,79 с,
    // и CLS из 0,000 превратился в 0,061. Числа клиенту берём отсюда.
    if (TORMOZ) {
      const cdp = await ctx.newCDPSession(p);
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: 150,               // «медленный 4G»
        downloadThroughput: 1.6 * 1024 * 1024 / 8,
        uploadThroughput: 750 * 1024 / 8,
      });
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    }
    const errors = [];
    p.on('pageerror', (e) => errors.push('JS: ' + String(e).slice(0, 120)));
    p.on('response', (r) => { if (r.status() >= 400) errors.push(`${r.status()}: ${r.url().slice(0, 90)}`); });
    const slug = (url.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '_').slice(0, 50)) + '.' + view;
    try {
      const t0 = Date.now();
      const resp = await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await p.waitForTimeout(WAIT);
      const data = await p.evaluate(AUDIT);
      data.status = resp ? resp.status() : 0;
      data.loadMs = Date.now() - t0;
      data.view = view;
      data.tormoz = TORMOZ;   // с торможением числа честные, без него оптимистичные
      data.errors = [...new Set(errors)].slice(0, 8);
      data.axe = await runAxe(p);
      await p.screenshot({ path: path.join(OUT, slug + '.fold.png') });
      await p.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 500) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 60)); } window.scrollTo(0, 0); });
      await p.waitForTimeout(600);
      await p.screenshot({ path: path.join(OUT, slug + '.full.png'), fullPage: true });
      rows.push(data);
      console.log(`${view.padEnd(11)} ${url} — overflow:${data.overflow.length} мелких целей:${data.tapTargets.under44} LCP:${data.vitals?.lcp}ms CLS:${data.vitals?.cls?.toFixed(3)}`);
    } catch (e) {
      rows.push({ url, view, error: String(e).slice(0, 160) });
      console.log(`${view.padEnd(11)} ${url} — ОШИБКА ${String(e).slice(0, 80)}`);
    }
    await ctx.close();
  }
}
fs.writeFileSync(path.join(OUT, 'scan.json'), JSON.stringify(rows, null, 1));
await b.close();
console.log('готово:', path.join(OUT, 'scan.json'));
