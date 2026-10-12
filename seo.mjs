#!/usr/bin/env node
// Проверка поисковой базы сайта: то, что можно исправить руками и проверить глазами.
// Нужна для двух вещей: повод для письма клиенту и список работ, если он согласится.
//
// Запуск: node seo.mjs https://site.ru

import { chromium } from 'playwright'

const url = process.argv[2]
if (!url) {
  console.error('node seo.mjs https://site.ru')
  process.exit(1)
}
const origin = new URL(url).origin

const ok = []
const bad = []
const note = []

const b = await chromium.launch()
const ctx = await b.newContext({ locale: 'ru-RU' })
const p = await ctx.newPage()

let status = 0
try {
  const resp = await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })
  status = resp ? resp.status() : 0
} catch (e) {
  console.error('Не открылось:', String(e).slice(0, 120))
  await b.close()
  process.exit(1)
}
await p.waitForTimeout(1500)

const data = await p.evaluate(() => {
  const meta = n => document.querySelector(`meta[name="${n}"]`)?.content?.trim() || ''
  const og = n => document.querySelector(`meta[property="og:${n}"]`)?.content?.trim() || ''
  const ld = [...document.querySelectorAll('script[type="application/ld+json"]')].map(s => {
    try { return JSON.parse(s.textContent) } catch (e) { return { __error: true } }
  })
  const types = []
  const walk = o => {
    if (!o || typeof o !== 'object') return
    if (Array.isArray(o)) return o.forEach(walk)
    if (o['@type']) types.push(String(o['@type']))
    Object.values(o).forEach(walk)
  }
  ld.forEach(walk)
  return {
    title: document.title.trim(),
    description: meta('description'),
    robotsMeta: meta('robots'),
    viewport: meta('viewport'),
    lang: document.documentElement.lang || '',
    h1: [...document.querySelectorAll('h1')].map(h => h.innerText.trim()).filter(Boolean),
    canonical: document.querySelector('link[rel=canonical]')?.href || '',
    favicon: !!document.querySelector('link[rel*=icon]'),
    og: { title: og('title'), description: og('description'), image: og('image') },
    ldCount: ld.length,
    ldBroken: ld.some(x => x && x.__error),
    ldTypes: [...new Set(types)],
    imgs: document.images.length,
    imgsNoAlt: [...document.images].filter(i => !i.alt).length,
  }
})

// ── проверки страницы ───────────────────────────────────────────────────
const check = (cond, good, badText, hint = '') => (cond ? ok : bad).push(cond ? good : `${badText}${hint ? ' → ' + hint : ''}`)

check(status === 200, `страница отвечает ${status}`, `страница отвечает ${status}`, 'исправить до всего остального')
check(data.title.length >= 10 && data.title.length <= 70, `заголовок вкладки ${data.title.length} знаков`,
  `заголовок вкладки ${data.title.length} знаков`, '10–70 знаков, с названием и сутью')
check(data.description.length >= 50 && data.description.length <= 180, `описание ${data.description.length} знаков`,
  data.description ? `описание ${data.description.length} знаков` : 'описания страницы нет', '50–180 знаков')
check(data.h1.length === 1, 'один заголовок H1', `заголовков H1: ${data.h1.length}`, 'должен быть ровно один')
check(!!data.canonical, 'канонический адрес указан', 'нет канонического адреса', 'спасает от дублей страниц')
check(!!data.viewport, 'есть мета viewport', 'нет меты viewport', 'без неё сайт не адаптивный для поисковика')
check(!!data.lang, `язык страницы: ${data.lang}`, 'не указан язык страницы', 'атрибут lang у html')
check(!!data.og.title && !!data.og.image, 'есть картинка и заголовок для соцсетей',
  data.og.title ? 'в разметке для соцсетей нет картинки (og:image)' : 'нет разметки для соцсетей (Open Graph)',
  'ссылка в мессенджере выглядит пусто')
check(data.ldCount > 0 && !data.ldBroken, data.ldCount ? `разметка Schema.org: ${data.ldTypes.join(', ') || 'без типов'}` : '',
  data.ldBroken ? 'разметка Schema.org сломана (не разбирается)' : 'нет разметки Schema.org',
  'её читают карты и голосовые помощники')
check(!!data.favicon, 'значок сайта есть', 'нет значка сайта')
if (data.imgs) {
  check(data.imgsNoAlt === 0, `у всех ${data.imgs} картинок есть подпись alt`,
    `${data.imgsNoAlt} картинок из ${data.imgs} без подписи alt`, 'важно для поиска по картинкам и для незрячих')
}
if (/noindex/i.test(data.robotsMeta)) bad.push('страница закрыта от индексации (noindex) → проверить, так ли задумано')

// ── файлы и перенаправления ─────────────────────────────────────────────
const fetchStatus = async (u) => {
  try {
    const r = await p.request.get(u, { timeout: 15000, maxRedirects: 0 })
    return { status: r.status(), body: r.status() === 200 ? (await r.text()).slice(0, 4000) : '' }
  } catch (e) { return { status: 0, body: '' } }
}

// Код 200 ещё не значит, что файл есть: многие сайты на любой адрес отдают главную (05.10, supra).
// Поэтому смотрим и содержимое: в robots.txt нет HTML, в карте сайта есть <urlset> или <sitemapindex>.
const htmlVmesto = b => /^\s*<(!doctype|html)/i.test(b)
const robots = await fetchStatus(origin + '/robots.txt')
const robotsOk = robots.status === 200 && !htmlVmesto(robots.body)
check(robotsOk, 'robots.txt на месте', robots.status === 200 ? 'вместо robots.txt сайт отдаёт HTML-страницу' : 'нет robots.txt',
  'поисковик не знает правил обхода')
const sitemapInRobots = robotsOk && /sitemap:/i.test(robots.body)
const sitemap = await fetchStatus(origin + '/sitemap.xml')
const sitemapOk = sitemap.status === 200 && /<(urlset|sitemapindex)/i.test(sitemap.body)
check(sitemapOk || sitemapInRobots, 'карта сайта есть',
  sitemap.status === 200 && !sitemapOk ? 'вместо sitemap.xml сайт отдаёт HTML-страницу' : 'карты сайта нет',
  'новые страницы находятся дольше')
if (sitemapOk) {
  const n = (sitemap.body.match(/<loc>/g) || []).length
  note.push(`в карте сайта видно ссылок (первые 4 КБ): ${n}`)
}

const notFound = await fetchStatus(origin + '/stranica-kotoroy-net-' + Date.now())
check(notFound.status === 404, 'несуществующий адрес отдаёт 404',
  `несуществующий адрес отдаёт ${notFound.status}`, 'поисковик считает такие страницы дублями')

if (url.startsWith('https://')) {
  const httpTry = await fetchStatus(url.replace('https://', 'http://'))
  check([301, 302, 307, 308].includes(httpTry.status), 'http перенаправляется на https',
    `http отвечает ${httpTry.status} без перенаправления`, 'дубли и предупреждение в браузере')
}

await b.close()

// ── вывод ───────────────────────────────────────────────────────────────
console.log(`\nПоисковая база: ${url}\n`)
for (const s of ok) console.log('  ✓ ' + s)
for (const s of bad) console.log('  ✗ ' + s)
for (const s of note) console.log('  · ' + s)

console.log(`\nВ порядке: ${ok.length}, требует правки: ${bad.length}`)

if (bad.length) {
  const up = s => s.charAt(0).toUpperCase() + s.slice(1)
  const top = bad.slice(0, 2).map(s => s.split(' → ')[0])
  console.log('\nПовод для письма (проверить глазами и переписать под клиента):\n')
  console.log(`Открыл ваш сайт и заглянул в техническую часть. ${up(top[0])}.`
    + (top[1] ? ` ${up(top[1])}.` : ''))
  console.log(top.length > 1
    ? 'Обе вещи чинятся за вечер и влияют на то, как сайт выглядит в поиске и в мессенджерах.'
    : 'Это чинится за вечер и влияет на то, как сайт выглядит в поиске и в мессенджерах.')
  console.log('\nСписок работ и решения — внутри заказа, в письме только факты.')
}
