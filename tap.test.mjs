// Проверка правила «мелкая цель нажатия» на заранее известной странице.
// Смысл: у критерия WCAG 2.5.8 есть исключения, и сканер обязан их учитывать.
// Без этого теста мы уже один раз написали клиенту неверный пункт (карусель вместо переполнения).
//
// Запуск: node --test tap.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tap-'));

// Страница со всеми случаями сразу.
// Отступы подобраны так, чтобы каждый случай проверял ровно одно правило.
const HTML = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { margin: 0; font: 16px/1.5 system-ui; }
  .zona { padding: 60px 20px; }
  .malenkaya { display: inline-block; width: 20px; height: 20px; background: #ccc; }
  .bolshaya { display: inline-block; width: 48px; height: 48px; background: #999; }
  .ryadom { margin-right: 2px; }
  /* вплотную: край большой кнопки ближе 12 px к центру мелкой цели.
     Ровно 12 px — это граница, на ней цель ещё проходит, поэтому в опыте берём меньше. */
  .vplotnuyu { margin-right: 0; }
</style></head>
<body>
  <!-- 1. одинокая мелкая цель: проходит по расстоянию -->
  <div class="zona"><a href="#" class="malenkaya" aria-label="одинокая"></a></div>

  <!-- 2. две мелкие цели вплотную: нарушение -->
  <div class="zona">
    <a href="#" class="malenkaya ryadom" aria-label="первая из пары"></a><a href="#" class="malenkaya" aria-label="вторая из пары"></a>
  </div>

  <!-- 3. мелкая цель вплотную к большой кнопке: нарушение,
       хотя центры далеко друг от друга -->
  <div class="zona">
    <a href="#" class="malenkaya vplotnuyu" aria-label="мелкая у большой"></a><button class="bolshaya">ОК</button>
  </div>

  <!-- 4. строчная ссылка в предложении: исключение, размер не нормируется -->
  <div class="zona"><p style="font-size:12px">Обычный текст, внутри которого стоит
    <a href="#">строчная ссылка</a>, и дальше текст продолжается.</p></div>

  <!-- 5. крупная кнопка: в список мелких вообще не попадает -->
  <div class="zona"><button class="bolshaya">Купить</button></div>
</body></html>`;

const file = path.join(tmp, 'tap.html');
fs.writeFileSync(file, HTML, 'utf8');

const out = path.join(tmp, 'out');
execFileSync(process.execPath, [path.join(here, 'scan.mjs'), out, pathToFileURL(file).href, '--views=phone', '--wait=300'], { stdio: 'pipe' });

const raw = JSON.parse(fs.readFileSync(path.join(out, 'scan.json'), 'utf8'));
const rows = Array.isArray(raw) ? raw : (raw.pages || raw.rows || []);
const t = rows[0].tapTargets;

test('крупная кнопка в список мелких не попадает', () => {
  const krupnye = t.worst.filter((x) => Math.min(x.w, x.h) >= 44);
  assert.equal(krupnye.length, 0);
});

test('мелкие цели найдены', () => {
  assert.ok(t.under24 >= 5, `ожидали не меньше пяти целей меньше 24 px, нашли ${t.under24}`);
});

test('строчная ссылка в тексте проходит по исключению', () => {
  const stroka = t.worst.find((x) => (x.text || '').includes('строчная'));
  assert.ok(stroka, 'строчная ссылка не найдена в списке');
  assert.equal(stroka.isklyuchenie, 'строчная ссылка в тексте');
});

test('одинокая мелкая цель проходит по расстоянию', () => {
  const odinokaya = t.worst.find((x) => (x.text || '').includes('одинокая'));
  assert.ok(odinokaya, 'одинокая цель не найдена');
  assert.equal(odinokaya.isklyuchenie, 'соседние цели дальше 24 px');
});

test('две мелкие цели вплотную — нарушение', () => {
  const para = t.worst.filter((x) => (x.text || '').includes('из пары'));
  assert.equal(para.length, 2);
  for (const c of para) assert.equal(c.isklyuchenie, null);
});

test('мелкая цель вплотную к большой кнопке — тоже нарушение', () => {
  const u = t.worst.find((x) => (x.text || '').includes('мелкая у большой'));
  assert.ok(u, 'цель рядом с большой кнопкой не найдена');
  assert.equal(u.isklyuchenie, null, 'центры далеко, но край большой кнопки рядом');
});

test('итоговый счётчик нарушений совпадает', () => {
  assert.equal(t.narusheniyaAA, 3);
});
