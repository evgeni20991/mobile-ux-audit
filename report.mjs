#!/usr/bin/env node
// Превращает scan.json в готовый отчёт на русском.
// Раньше отчёт писался руками по полчаса на заказ — теперь собирается за секунду.
//
// Запуск: node report.mjs <папка-скана> [> отчёт.md]

import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('node report.mjs <папка-скана>');
  process.exit(1);
}
const rows = JSON.parse(fs.readFileSync(path.join(dir, 'scan.json'), 'utf8'));

const L = [];
const say = (s = '') => L.push(s);
const num = n => (typeof n === 'number' ? n.toLocaleString('ru-RU') : n);
const sec = ms => (ms / 1000).toFixed(1).replace('.', ',') + ' с';

say(`# Отчёт сканера мобильного UX — ${new Date().toLocaleDateString('ru-RU')}`);
say('');
say('Инструмент: `scan.mjs`. Пороги: LCP < 2,5 с, CLS < 0,1 (web.dev),');
say('цель нажатия — минимум 24×24 px (WCAG 2.5.8 AA), рекомендация Apple 44 pt, Material 48 dp.');
say('Проверка доступности — axe-core по правилам WCAG 2.0–2.2 уровня AA.');
say('');

let problems = 0;
for (const r of rows) {
  say(`## ${r.url} (${r.view || 'phone'})`);
  say('');
  if (r.error) { say(`- Ошибка сканирования: ${r.error}`); say(''); continue; }
  if (r.status && r.status >= 400) say(`- **Страница отдаёт ${r.status}**`);

  say(r.tormoz
    ? '- Замер **с торможением**: медленный 4G, процессор в 4 раза медленнее — как у покупателя.'
    : '- Замер **без торможения**: быстрый интернет. Числа оптимистичные, клиенту так не называем.');

  const v = r.vitals || {};
  const lcpBad = v.lcp > 2500;
  say(`- Загрузка: ${num(r.loadMs)} мс, LCP ${lcpBad ? '**' : ''}${num(v.lcp)} мс${lcpBad ? '**' : ''}, `
    + `CLS ${(v.cls ?? 0).toFixed(3)}, длинных задач ${v.longTasks ?? 0}`);
  if (lcpBad) problems++;

  const t = r.tapTargets || {};
  if (t.under44) {
    const nar = t.narusheniyaAA ?? t.under24;
    say(`- Цели нажатия: всего ${t.total}, меньше 44 px — **${t.under44}**, меньше 24 px — ${t.under24}, `
      + `из них нарушают WCAG AA — **${nar}** (остальные проходят по исключению: строчная ссылка или расстояние)`);
    for (const w of (t.worst || []).slice(0, 6)) {
      say(`    - \`${w.sel}\` ${w.w}×${w.h} px — «${(w.text || '').slice(0, 40)}»${w.isklyuchenie ? ` (исключение: ${w.isklyuchenie})` : ''}`);
    }
    problems++;
  }

  const an = r.animaciya;
  if (an) {
    const zamechaniya = [];
    if (an.dorogieSvoystva?.length) {
      zamechaniya.push(`анимируются свойства, пересчитывающие раскладку: **${an.dorogieSvoystva.join(', ')}**`);
    }
    if (!an.uvazhaetNastroyku) zamechaniya.push('**нет блока `prefers-reduced-motion`**');
    if (zamechaniya.length) {
      say(`- Анимация: ${zamechaniya.join('; ')}`);
      say('    - плавно идут только `transform` и `opacity`; остальное считается на каждом кадре');
      if (an.stileyNeProchitano) say(`    - таблиц стилей с чужих доменов не прочитано: ${an.stileyNeProchitano}`);
      problems++;
    }
  }

  const im = r.images || {};
  if (im.total) {
    const bad = [];
    if (im.noDimensions) bad.push(`без width/height — **${im.noDimensions}**`);
    if (im.lazyAboveFold) bad.push(`отложенных на первом экране — **${im.lazyAboveFold}**`);
    say(`- Картинки: ${im.total}${bad.length ? ', ' + bad.join(', ') : ''}`);
    for (const o of (im.oversized || []).slice(0, 4)) {
      say(`    - \`${o.src}\`: показывается ${o.shown} px, файл ${o.natural} px — в ${o.factor} раза больше нужного`);
    }
    if (im.noDimensions || (im.oversized || []).length) problems++;
  }

  for (const s of r.sticky || []) {
    say(`- Закреплённый блок \`${s.sel}\`: ${s.h} px (${s.pctOfScreen}% экрана)`);
    if (s.pctOfScreen >= 15) problems++;
  }

  const c = r.cookieBanner;
  if (c) {
    say(`- Плашка cookie: \`${c.sel}\`, ${c.place}, закрывает ${c.coverPct}% экрана, `
      + `кнопка отказа: **${c.hasReject ? 'есть' : 'нет'}**`);
    if (!c.hasReject || c.coverPct > 12) problems++;
  }

  // Главный признак — реальная прокрутка страницы (overflowX), а не длина списка.
  if (r.overflowX) {
    const first = (r.overflow || [])[0];
    say(`- **Страница прокручивается вбок** (ширина ${r.scrollWidth} px при экране ${(r.viewport || [])[0]} px)`
      + (first ? `, например \`${first.sel}\` (${first.w} px${first.why ? ', ' + first.why : ''})` : ''));
    problems++;
  } else if ((r.overflow || []).length) {
    say(`- За краем экрана ${r.overflow.length} элементов, но страница вбок не прокручивается — проверить глазами`);
  } else {
    say('- Горизонтальной прокрутки нет');
  }
  for (const lc of r.lowContrast || []) {
    say(`- Низкий контраст: «${lc.text}» — ${lc.contrast} при норме ${lc.need}`);
    problems++;
  }
  if ((r.smallText || []).length) {
    say(`- Текст мельче 12 px: ${r.smallText.length} мест, например «${r.smallText[0].text}» (${r.smallText[0].size} px)`);
    problems++;
  }
  for (const i of r.inputsZoom || []) {
    say(`- Поле с текстом ${i.size} px — iOS увеличит страницу при вводе (\`${i.sel}\`)`);
    problems++;
  }

  const ax = r.axe;
  if (ax && !ax.error) {
    say(`- Доступность (axe): нарушений ${ax.total}, требует проверки глазами ${ax.incompleteTotal}`);
    for (const a of ax.violations || []) say(`    - [${a.impact}] ${a.id} ×${a.count} — ${a.help}`);
    for (const a of (ax.incomplete || []).slice(0, 3)) say(`    - не смог проверить: ${a.id} ×${a.count} — ${a.help}`);
    problems += (ax.violations || []).length;
  } else if (ax?.error) {
    say(`- Доступность: не проверено (${ax.error})`);
  }

  if ((r.errors || []).length) say(`- Ошибки запросов: ${r.errors.join('; ')}`);
  say('');
}

say('---');
say('');
say(`Всего замечаний по страницам: **${problems}**.`);
say('');
say('Автоматика ловит от 30 до 57% нарушений доступности — остальное смотрим глазами:');
say('клавиатура, порядок фокуса, чтение экранным диктором, контраст текста поверх картинок.');

const out = L.join('\n') + '\n';
const file = path.join(dir, 'otchet-skanera.md');
fs.writeFileSync(file, out);
console.log(out);
console.error('сохранено: ' + file);
