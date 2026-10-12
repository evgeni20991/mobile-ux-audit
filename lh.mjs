// Лабораторный замер скорости своим Lighthouse (без ключей и чужих квот).
// Запуск: node lh.mjs <url> [--desktop] [--runs=3] [--out=папка]
// Печатает оценку, метрики и главные возможности экономии; сохраняет JSON по каждому прогону.
import fs from 'node:fs';
import path from 'node:path';
import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith('--'));
const flags = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => a.replace(/^--/, '').split('=')));
if (!url) {
  console.error('node lh.mjs <url> [--desktop] [--runs=3] [--out=папка]');
  process.exit(1);
}
const runs = Number(flags.runs || 1);
const out = flags.out ? path.resolve(flags.out) : null;
if (out) fs.mkdirSync(out, { recursive: true });

const chrome = await chromeLauncher.launch({ chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu'] });
const results = [];
try {
  for (let i = 1; i <= runs; i++) {
    const r = await lighthouse(url, {
      port: chrome.port,
      output: 'json',
      logLevel: 'error',
      onlyCategories: ['performance'],
      formFactor: flags.desktop !== undefined ? 'desktop' : 'mobile',
      screenEmulation: flags.desktop !== undefined
        ? { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1, disabled: false }
        : { mobile: true, width: 390, height: 844, deviceScaleFactor: 3, disabled: false },
      locale: 'ru',
    });
    const lhr = r.lhr;
    if (out) fs.writeFileSync(path.join(out, `lh-${i}.json`), r.report);
    const a = lhr.audits;
    const row = {
      run: i,
      score: Math.round((lhr.categories.performance.score || 0) * 100),
      lcp: a['largest-contentful-paint']?.numericValue,
      cls: a['cumulative-layout-shift']?.numericValue,
      tbt: a['total-blocking-time']?.numericValue,
      fcp: a['first-contentful-paint']?.numericValue,
      si: a['speed-index']?.numericValue,
      lcpEl: a['largest-contentful-paint-element']?.details?.items?.[0]?.items?.[0]?.node?.snippet?.slice(0, 80),
      weightKb: Math.round((a['total-byte-weight']?.numericValue || 0) / 1024),
      serverMs: Math.round(a['server-response-time']?.numericValue || 0),
      heavy: (a['total-byte-weight']?.details?.items || []).slice(0, 5)
        .map((x) => ({ url: String(x.url).split('/').pop().slice(0, 42), kb: Math.round((x.totalBytes || 0) / 1024) })),
      savings: Object.values(a)
        .filter((x) => x?.details?.type === 'opportunity' && x.details.overallSavingsMs > 150)
        .map((x) => ({ id: x.id, title: x.title, ms: Math.round(x.details.overallSavingsMs), kb: Math.round((x.details.overallSavingsBytes || 0) / 1024) }))
        .sort((x, y) => y.ms - x.ms)
        .slice(0, 6),
    };
    results.push(row);
    console.log(`прогон ${i}: оценка ${row.score}, LCP ${Math.round(row.lcp)} мс, CLS ${row.cls.toFixed(3)}, TBT ${Math.round(row.tbt)} мс, вес ${row.weightKb} КБ, ответ сервера ${row.serverMs} мс`);
  }
} finally {
  try { await chrome.kill(); } catch (e) { /* Windows не всегда отдаёт временную папку — не мешает результату */ }
}

const med = (key) => {
  const v = results.map((r) => r[key]).sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)];
};
console.log('\nмедиана по прогонам:');
console.log(`  оценка ${med('score')}, LCP ${Math.round(med('lcp'))} мс, CLS ${med('cls').toFixed(3)}, TBT ${Math.round(med('tbt'))} мс, Speed Index ${Math.round(med('si'))} мс`);
if (results[0].lcpEl) console.log(`  элемент LCP: ${results[0].lcpEl}`);
console.log(`  вес страницы: ${med('weightKb')} КБ, ответ сервера: ${med('serverMs')} мс`);
if (results[0].heavy?.length) {
  console.log('  самые тяжёлые файлы:');
  for (const h of results[0].heavy) console.log(`    ${h.url} — ${h.kb} КБ`);
}
console.log('\nчто даст больше всего:');
for (const s of results[0].savings) console.log(`  ${s.title}: до ${s.ms} мс${s.kb ? `, ${s.kb} КБ` : ''}`);
if (out) {
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(results, null, 1));
  console.log('\nотчёты:', out);
}
