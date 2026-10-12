// Снимки-доказательства для клиента: страница глазами телефона, проблемное место обведено,
// в подписи — живой замер (размер, шрифт, контраст), а не число из старого отчёта.
//
// Запуск: node dokazatelstva.mjs <план.json> <папка для снимков>
// Итог: PNG по плану и <папка>/zamery.json — что намерено на каждом снимке.
//
// План — массив снимков:
// {
//   "fail": "02-cookie.png", "url": "https://…",
//   "kadr": "ekran" | "vyrez" | "stranica",   ekran — видимый экран; vyrez — только обведённое;
//                                             stranica — верх страницы высотой "visota"
//   "prokrutka": false,        не прокручивать к элементу (для первого экрана)
//   "cookie": "ubrat",         нажать «Согласен» перед снимком, чтобы плашка не закрывала вид
//   "zagolovok": "текст",      красная полоса с текстом поверх верха снимка
//   "sgib": true,              пунктир на границе первого экрана (для kadr: stranica)
//   "obvesti": [{ "sel": "css", "tekst": "часть текста", "vse": false,
//                 "vybor": "maxRaz" | "vidimyi",   самая переразмеренная картинка | больше всех видна на экране
//                 "podpisGde": "niz" | "verh",     где подпись относительно рамки
//                 "podpis": "шрифт {shrift} px" }]
// }
// Подстановки в подписи (по первому найденному элементу): {w} {h} {top} {vh} {ekran} (% высоты экрана)
// {shrift} {kontrast} {nw} {dw} {dw3} {raz} (картинка: файл, показ, нужно при плотности 3, во сколько раз)
// {vsego} {vsehImg} {tekstEl}
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'

const [planFail, papka] = process.argv.slice(2)
if (!planFail || !papka) {
  console.error('node dokazatelstva.mjs <план.json> <папка>')
  process.exit(2)
}
const plan = JSON.parse(fs.readFileSync(planFail, 'utf8'))
fs.mkdirSync(papka, { recursive: true })

const TELEFON = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
const brauzer = await chromium.launch()
const zamery = []

for (const snimok of plan) {
  const ctx = await brauzer.newContext(TELEFON)
  const p = await ctx.newPage()
  // Карусель с автопрокруткой ловится посреди перелистывания (так испортился кадр 27.09).
  // "bezAvtoprokrutki": true — setInterval не срабатывает, на экране остаётся первый слайд.
  if (snimok.bezAvtoprokrutki) await p.addInitScript(() => { window.setInterval = () => 0 })
  const otvet = await p.goto(snimok.url, { waitUntil: 'load', timeout: 90000 }).catch(() => null)
  await p.waitForTimeout(3000)
  if (snimok.bezAvtoprokrutki) {
    // Swiper листает через setTimeout, заглушка setInterval его не держит (магазин заказчика, 27.09):
    // останавливаем явно, мгновенно ставим нужный слайд и ждём конца начатого перехода.
    // "slaid": "fenrir" — слайд, в разметке которого есть эта строка (адрес ссылки, картинки, alt); без него первый.
    const slaid = await p.evaluate(stroka => [...document.querySelectorAll('.swiper')].map(s => {
      const sw = s.swiper
      if (!sw) return null
      sw.autoplay?.stop()
      const slaidy = [...sw.slides]
      const nomer = stroka ? slaidy.findIndex(e => e.outerHTML.toLowerCase().includes(stroka.toLowerCase())) : 0
      if (nomer < 0) return 'не найден'
      const nastoyashchii = Number(slaidy[nomer].dataset.swiperSlideIndex ?? nomer)
      if (sw.params.loop) sw.slideToLoop(nastoyashchii, 0); else sw.slideTo(nomer, 0)
      return nastoyashchii
    }), snimok.slaid ?? null)
    if (snimok.slaid && !slaid.some(n => typeof n === 'number')) console.log(`${snimok.fail}  СЛАЙД «${snimok.slaid}» НЕ НАЙДЕН`)
    await p.waitForTimeout(800)
  }

  if (snimok.cookie === 'ubrat') {
    // Старая плашка — «Согласен», новая (магазин заказчика после правок) — «Принять» / «Отклонить» или одна «Понятно».
    // Для снимков «стало» жмём отказ: так на экране нет ни плашки, ни счётчиков.
    for (const imya of ['Согласен', 'Отклонить', 'Понятно']) {
      const knopka = p.getByRole('button', { name: imya, exact: true })
      if (await knopka.count()) { await knopka.first().click().catch(() => {}); await p.waitForTimeout(500); break }
    }
  }

  // "prokrutkaNa": 600 — прокрутить страницу на столько пикселей (сжатая шапка,
  // полоса покупки и всё, что появляется только при прокрутке). Колесом, как пальцем.
  if (snimok.prokrutkaNa) {
    await p.mouse.move(195, 500)
    for (let proideno = 0; proideno < snimok.prokrutkaNa; proideno += 100) {
      await p.mouse.wheel(0, Math.min(100, snimok.prokrutkaNa - proideno))
      await p.waitForTimeout(40)
    }
    await p.waitForTimeout(1200)
  }

  // Прокрутить к первому элементу и дать ленивым картинкам догрузиться.
  const pervyi = snimok.obvesti?.[0]
  if (pervyi && snimok.prokrutka !== false && snimok.kadr !== 'stranica') {
    await p.evaluate(({ sel, tekst }) => {
      const el = [...document.querySelectorAll(sel)].find(e => e.getBoundingClientRect().width > 0 && (!tekst || e.textContent.includes(tekst)))
      el?.scrollIntoView({ block: 'center' })
    }, pervyi)
    await p.waitForTimeout(1500)
  }

  const itog = await p.evaluate(({ obvesti = [], zagolovok, sgib, kadr }) => {
    const KRASNYI = '#e11d48'
    // Цвет любого формата (rgb, oklch, lab, color()) → [r, g, b, a] через canvas браузера.
    // Раньше числа выдирались из строки — и oklch(0.985 0.008 60) считался как RGB: контраст 1,03 вместо ~3 (поймано 27.09.2026).
    const holst = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
    holst.canvas.width = holst.canvas.height = 1
    const rgb = s => {
      holst.clearRect(0, 0, 1, 1)
      holst.fillStyle = '#000'
      holst.fillStyle = s
      holst.fillRect(0, 0, 1, 1)
      const [r, g, b, a] = holst.getImageData(0, 0, 1, 1).data
      return a === 0 ? [r, g, b, 0] : [r, g, b, a / 255]
    }
    const yarkost = ([r, g, b]) => {
      const k = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
      return 0.2126 * k(r) + 0.7152 * k(g) + 0.0722 * k(b)
    }
    const fon = el => {
      for (let e = el; e; e = e.parentElement) {
        const c = rgb(getComputedStyle(e).backgroundColor)
        if (c[3] > 0.5) return c.slice(0, 3)
      }
      return [255, 255, 255]
    }
    const zapyataya = n => String(n).replace('.', ',')
    const zamer = (el, vse) => {
      const r = el.getBoundingClientRect()
      const img = el.tagName === 'IMG' ? el : el.querySelector('img')
      const l1 = yarkost(rgb(getComputedStyle(el).color)), l2 = yarkost(fon(el))
      const kontrast = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
      return {
        w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top + scrollY), vh: innerHeight,
        ekran: Math.round(r.height / innerHeight * 100),
        shrift: zapyataya(Math.round(parseFloat(getComputedStyle(el).fontSize) * 10) / 10),
        kontrast: zapyataya(Math.round(kontrast * 100) / 100),
        nw: img?.naturalWidth || 0, dw: img ? Math.round(img.getBoundingClientRect().width) : 0,
        // сколько точек нужно самому чёткому экрану телефона (плотность 3), округлено до десятков
        dw3: img ? Math.round(img.getBoundingClientRect().width * 3 / 10) * 10 : 0,
        raz: img && img.getBoundingClientRect().width ? zapyataya(Math.round(img.naturalWidth / img.getBoundingClientRect().width * 10) / 10) : '',
        vsego: vse.length, vsehImg: document.images.length, tekstEl: el.textContent.trim().slice(0, 40),
      }
    }
    const sloi = document.createElement('div')
    sloi.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none'
    document.body.append(sloi)
    const narisovat = (x, y, w, h) => {
      // Рамку прижимаем к краям экрана: у элемента во всю ширину (шапка) она иначе уходит за край,
      // и на снимке видна одна нижняя линия.
      const L = Math.max(x - 4, scrollX + 2), R = Math.min(x + w + 4, scrollX + innerWidth - 2)
      const T = Math.max(y - 4, 2), B = y + h + 4
      const d = document.createElement('div')
      d.style.cssText = `position:absolute;left:${L}px;top:${T}px;width:${R - L}px;height:${B - T}px;box-sizing:border-box;` +
        `border:3px solid ${KRASNYI};border-radius:6px;box-shadow:0 0 0 2px #fff`
      sloi.append(d)
    }
    const nadpis = (x, y, tekst) => {
      const d = document.createElement('div')
      d.textContent = tekst
      // width:max-content — иначе подпись сжимается до ширины слоя (0) и идёт столбиком в одно слово
      d.style.cssText = `position:absolute;left:${Math.max(4, Math.min(x, innerWidth - 300))}px;top:${y}px;width:max-content;max-width:292px;` +
        `background:${KRASNYI};color:#fff;font:600 13px/1.3 system-ui,sans-serif;padding:4px 8px;border-radius:4px`
      sloi.append(d)
      return d
    }
    const rezultat = []
    const ramki = []
    for (const o of obvesti) {
      let vse = [...document.querySelectorAll(o.sel)]
        .filter(e => e.getBoundingClientRect().width > 0 && (!o.tekst || e.textContent.includes(o.tekst)))
      if (o.vybor === 'maxRaz') {
        const raz = e => { const i = e.tagName === 'IMG' ? e : e.querySelector('img'); return i ? i.naturalWidth / (i.getBoundingClientRect().width || 1) : 0 }
        vse = vse.sort((a, b) => raz(b) - raz(a))
      }
      if (o.vybor === 'vidimyi') {
        // Карусель держит соседние слайды за краем экрана: берём тот, что виден больше всех.
        const vidno = e => {
          const r = e.getBoundingClientRect()
          return Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0))
        }
        vse = vse.sort((a, b) => vidno(b) - vidno(a))
      }
      if (!vse.length) { rezultat.push({ sel: o.sel, naideno: 0 }); continue }
      const cel = o.vse ? vse : [vse[0]]
      const z = zamer(vse[0], vse)
      for (const el of cel) {
        const r = el.getBoundingClientRect()
        narisovat(r.left + scrollX, r.top + scrollY, r.width, r.height)
        ramki.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })
      }
      if (o.podpis) {
        const tekst = o.podpis.replace(/\{(\w+)\}/g, (_, k) => z[k] ?? '')
        const r = vse[0].getBoundingClientRect()
        const nizhe = o.podpisGde ? o.podpisGde === 'niz' : r.top < 40
        const d = nadpis(r.left + scrollX, 0, tekst)
        const vys = d.getBoundingClientRect().height
        d.style.top = `${(nizhe ? r.bottom + 10 : r.top - vys - 10) + scrollY}px`
        const rd = d.getBoundingClientRect()
        ramki.push({ left: rd.left, top: rd.top, right: rd.right, bottom: rd.bottom })
        rezultat.push({ sel: o.sel, naideno: vse.length, podpis: tekst, ...z })
      } else {
        rezultat.push({ sel: o.sel, naideno: vse.length, ...z })
      }
    }
    if (sgib) {
      const d = document.createElement('div')
      d.style.cssText = `position:absolute;left:0;top:${innerHeight}px;width:${innerWidth}px;border-top:3px dashed ${KRASNYI}`
      sloi.append(d)
      nadpis(8, innerHeight + 6, 'конец первого экрана телефона')
    }
    if (zagolovok) {
      const d = nadpis(0, scrollY, zagolovok)
      // ширина явно по экрану: 100% считалось бы от слоя нулевой ширины
      d.style.cssText += `;left:0;width:${innerWidth}px;max-width:none;box-sizing:border-box;border-radius:0;font-size:15px;padding:10px 12px`
    }
    const soyuz = ramki.length && kadr === 'vyrez' ? {
      x: Math.max(0, Math.min(...ramki.map(r => r.left)) - 16),
      y: Math.max(0, Math.min(...ramki.map(r => r.top)) - 16),
      right: Math.min(innerWidth, Math.max(...ramki.map(r => r.right)) + 16),
      bottom: Math.min(innerHeight, Math.max(...ramki.map(r => r.bottom)) + 16),
    } : null
    return { rezultat, vyrez: soyuz && { x: soyuz.x, y: soyuz.y, width: soyuz.right - soyuz.x, height: soyuz.bottom - soyuz.y } }
  }, snimok)

  const put = path.join(papka, snimok.fail)
  if (snimok.kadr === 'vyrez' && itog.vyrez) await p.screenshot({ path: put, clip: itog.vyrez })
  else if (snimok.kadr === 'stranica') await p.screenshot({ path: put, fullPage: true, clip: { x: 0, y: 0, width: 390, height: snimok.visota || 1400 } })
  else await p.screenshot({ path: put })

  const zapis = { fail: snimok.fail, url: snimok.url, status: otvet?.status() ?? null, obvedeno: itog.rezultat }
  zamery.push(zapis)
  const net = itog.rezultat.filter(r => !r.naideno).map(r => r.sel)
  console.log(`${snimok.fail}  ${zapis.status}  ${net.length ? 'НЕ НАЙДЕНО: ' + net.join(', ') : itog.rezultat.map(r => r.podpis || r.sel).join(' | ')}`)
  await ctx.close()
}

fs.writeFileSync(path.join(papka, 'zamery.json'), JSON.stringify(zamery, null, 2))
await brauzer.close()
