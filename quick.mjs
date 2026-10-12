#!/usr/bin/env node
// Быстрая проверка сайта перед откликом: один прогон и готовый абзац с доказательством.
// Коннектов на бирже около 30 в месяц, поэтому отклик без цифры — выброшенный коннект.
//
// Запуск: node quick.mjs https://site.ru [ещё-страница]

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const urls = process.argv.slice(2).filter(a => !a.startsWith('--'))
if (!urls.length) {
  console.error('node quick.mjs https://site.ru [url2]')
  process.exit(1)
}

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'quick-'))
const r = spawnSync(process.execPath, [path.join(here, 'scan.mjs'), out, ...urls], { stdio: 'inherit' })
if (r.status !== 0) process.exit(r.status || 1)

const rows = JSON.parse(fs.readFileSync(path.join(out, 'scan.json'), 'utf8'))
const main = rows[0]
if (!main || main.error) {
  console.error('\nСканирование не удалось:', main?.error || 'нет данных')
  process.exit(1)
}

// Находки, отсортированные по тому, насколько их легко объяснить покупателю.
const facts = []
const v = main.vitals || {}
if (v.lcp > 2500) {
  facts.push({
    weight: 10,
    text: `первый экран появляется за ${(v.lcp / 1000).toFixed(1).replace('.', ',')} секунды при норме 2,5`,
  })
}
const im = main.images || {}
const worst = (im.oversized || [])[0]
if (worst) {
  facts.push({
    weight: 9,
    text: `фотографии отдаются в исходном размере: файл ${worst.natural} px показывается в ${worst.shown} px, это в ${String(worst.factor).replace('.', ',')} раза больше нужного`,
  })
}
if (im.noDimensions > 5) {
  facts.push({
    weight: 7,
    text: `у ${im.noDimensions} картинок из ${im.total} не заданы размеры, поэтому при загрузке вёрстка прыгает`,
  })
}
const t = main.tapTargets || {}
if (t.under44 > 10) {
  facts.push({ weight: 6, text: `${t.under44} кнопок и ссылок мельче 44 px — на телефоне в них трудно попасть` })
}
if ((main.inputsZoom || []).length) {
  facts.push({ weight: 5, text: 'поля ввода мельче 16 px, поэтому iPhone увеличивает страницу при наборе' })
}
const sticky = (main.sticky || []).filter(s => s.pctOfScreen >= 15)
if (sticky.length) {
  const sum = sticky.reduce((a, s) => a + s.pctOfScreen, 0)
  facts.push({ weight: 6, text: `закреплённые блоки занимают ${sum}% экрана телефона` })
}
if (main.cookieBanner && !main.cookieBanner.hasReject) {
  facts.push({ weight: 8, text: 'в плашке про cookie нет кнопки отказа, то есть согласие нельзя не дать' })
}
if ((main.lowContrast || []).length) {
  const lc = main.lowContrast[0]
  facts.push({ weight: 4, text: `контраст текста «${lc.text}» — ${lc.contrast} при норме ${lc.need}` })
}
if (main.overflowX) facts.push({ weight: 7, text: 'страница прокручивается вбок на телефоне' })
if (main.status >= 400) facts.push({ weight: 10, text: `страница отдаёт ошибку ${main.status}` })

facts.sort((a, b) => b.weight - a.weight)
const top = facts.slice(0, 3)

console.log('\n' + '='.repeat(64))
console.log(`Быстрая проверка: ${main.url}`)
console.log('='.repeat(64))
console.log(`LCP ${v.lcp} мс · CLS ${(v.cls ?? 0).toFixed(3)} · картинок ${im.total || 0} · мелких целей ${t.under44 || 0}`)
console.log(`Горизонтальная прокрутка: ${main.overflowX ? 'ЕСТЬ' : 'нет'}`)
if (main.axe && !main.axe.error) console.log(`Доступность: нарушений ${main.axe.total}, требует глаз ${main.axe.incompleteTotal}`)

if (!top.length) {
  console.log('\nЯвных проблем не нашёл. Для отклика нужно смотреть глазами: это уже сильный сайт.')
} else {
  console.log('\nАбзац для отклика (проверить и поправить под задачу клиента):\n')
  const lead = top[0].text[0].toUpperCase() + top[0].text.slice(1)
  const rest = top.slice(1).map(f => f.text)
  console.log(`Открыл сайт на телефоне (экран 390 px). ${lead}.`
    + (rest.length ? ` Ещё: ${rest.join('; ')}.` : ''))
  console.log('\nЧто дальше: назвать одну задачу клиента, цену строкой и точный срок.')
  console.log('Список решений в отклик не кладём — это товар (правило «ничего бесплатно»).')
}

console.log(`\nДанные скана: ${out}`)
