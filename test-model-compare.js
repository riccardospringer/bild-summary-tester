/**
 * Quick Model Comparison - Tests 10 articles with gpt-5, gpt-5-mini, gpt-5-nano
 * Same prompt, same articles, different models. Shows which model produces the best bullets.
 */

const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const fs = require('fs');
const path = require('path');

const LITELLM_BASE = 'https://litellm.dev.tech.as-nmt.de';
const LITELLM_TOKEN = 'sk-BIYj7SP_MwrGnL1O-j8e3Q';
const EVAL_MODEL = 'claude-sonnet-4';
const MODELS = ['gpt-5', 'gpt-5-mini', 'gpt-5-nano'];
const TEST_ARTICLES = 10;
const MIN_ARTICLE_LENGTH = 500;

const promptConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'prompts', 'default.json'), 'utf8'));
const SYSTEM_PROMPT = promptConfig.system_prompt;

const REMOVE_SELECTORS = [
  '[class*="TTS"]', '[class*="tts"]', '[class*="audio-player"]',
  '[class*="paywall"]', '[class*="Paywall"]',
  '[class*="newsletter"]', '[class*="Newsletter"]',
  '[class*="social-bar"]', '[class*="share"]',
  '[class*="related"]', '[class*="teaser"]',
  '[class*="ad-"]', '[class*="Ad-"]',
  '[class*="cookie"]', '[class*="consent"]',
  '[class*="navigation"]', '[class*="breadcrumb"]',
  '[data-component="TTS"]',
  'aside', 'nav', 'footer'
];

const STRIP_PATTERNS = [
  /TTS-Player\s*[u\u00fc]berspringen\s*/gi,
  /Artikel\s*weiterlesen\s*/gi,
  /Weiterlesen\s*mit\s*BILDplus\s*/gi,
  /BILDplus(?![-\w])\s*/g,
  /Foto:\s*[^\n]{0,60}(?:\n|$)/g,
  /\d{2}\.\d{2}\.\d{4}\s*-\s*\d{2}:\d{2}\s*Uhr\s*/g
];

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function fetchSitemapUrls() {
  const response = await fetch('https://www.bild.de/sitemap-news.xml', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
  });
  const xml = await response.text();
  const articles = [];
  const urlBlocks = xml.split('<url>').slice(1);
  for (const block of urlBlocks) {
    const locMatch = block.match(/<loc>([^<]+)<\/loc>/);
    const titleMatch = block.match(/<news:title>([^<]+)<\/news:title>/);
    if (!locMatch || !titleMatch) continue;
    const title = titleMatch[1].trim();
    if (title.match(/live-ticker|horoskop|anzeige/i)) continue; // Skip problematic types
    articles.push({ url: locMatch[1].trim(), title });
  }
  // Shuffle
  for (let i = articles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [articles[i], articles[j]] = [articles[j], articles[i]];
  }
  return articles;
}

async function fetchArticleText(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (attempt > 0) await sleep(3000 * attempt);
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'de-DE,de;q=0.9'
        }
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const html = await response.text();
      const dom = new JSDOM(html, { url });
      const doc = dom.window.document;
      for (const sel of REMOVE_SELECTORS) {
        try { doc.querySelectorAll(sel).forEach(el => el.remove()); } catch (e) {}
      }
      const reader = new Readability(doc);
      const article = reader.parse();
      if (!article || !article.textContent) throw new Error('No content');
      let text = article.textContent.trim();
      for (const p of STRIP_PATTERNS) text = text.replace(p, '');
      text = text.replace(/\n{3,}/g, '\n\n').trim();
      return { title: article.title || '', text, length: text.length };
    } catch (e) { if (attempt === 2) throw e; }
  }
}

async function generateSummary(articleText, model) {
  const start = Date.now();
  const isReasoning = model.startsWith('gpt-5');
  const maxTokens = isReasoning ? 16384 : 4096;

  const response = await fetch(LITELLM_BASE + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + LITELLM_TOKEN },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature: 0.15,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: 'Fasse folgenden Artikel zusammen:\n\n' + articleText }
      ]
    })
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  const content = data.choices?.[0]?.message?.content || '';
  if (!content.trim()) throw new Error('Empty response');
  return { summary: content.trim(), duration: ((Date.now() - start) / 1000).toFixed(1) };
}

async function evaluateSummary(articleText, summary) {
  const truncated = articleText.length > 6000 ? articleText.substring(0, 6000) + '... [gekuerzt]' : articleText;
  const evalPrompt = `Bewerte diese BILD-Teaser-Bullets (1-5 Punkte). Sei praezise und fair.

1=Schwere Fehler | 2=Deutliche Maengel | 3=Solide mit Schwaechen | 4=Gut, professionell | 5=Hervorragend

ARTIKEL:
${truncated}

ZUSAMMENFASSUNG:
${summary}

5 Perspektiven:
1. "Peter" (35, Handwerker) - Kerninfo in 5 Sekunden erfassbar? Kurze, klare Saetze?
2. "Renate" (68, Rentnerin) - Vollstaendige, elegante Saetze? Angenehmer Lesefluss?
3. "Simon" (22, Student) - Will ich weiterlesen? Bleibt Spannendes offen?
4. "Rico" (40, Journalist) - Fakten korrekt? NUR pruefen was im Artikeltext steht. Bei gekuerztem Artikel Vorteil des Zweifels.
5. "Katja" (45, Lektorin) - Elegante Sprache? Perfekte Grammatik? Journalistischer Stil?

JSON:
{"peter":{"score":X,"kommentar":"..."},"renate":{"score":X,"kommentar":"..."},"simon":{"score":X,"kommentar":"..."},"rico":{"score":X,"kommentar":"..."},"katja":{"score":X,"kommentar":"..."}}`;

  const response = await fetch(LITELLM_BASE + '/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + LITELLM_TOKEN, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: EVAL_MODEL, max_tokens: 1024, temperature: 0.1, messages: [{ role: 'user', content: evalPrompt }] })
  });
  const data = await response.json();
  const text = data.content?.[0]?.text || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  return jsonMatch ? JSON.parse(jsonMatch[0]) : null;
}

function avgScore(ev) {
  if (!ev) return 0;
  const keys = ['peter', 'renate', 'simon', 'rico', 'katja'];
  let sum = 0, count = 0;
  for (const k of keys) {
    if (ev[k]?.score) { sum += ev[k].score; count++; }
  }
  return count > 0 ? sum / count : 0;
}

async function main() {
  console.log('=== Model Comparison: ' + MODELS.join(' vs ') + ' ===');
  console.log('Artikel: ' + TEST_ARTICLES + ' | Evaluator: ' + EVAL_MODEL);
  console.log('');

  // Get articles
  const allArticles = await fetchSitemapUrls();
  console.log('Sitemap: ' + allArticles.length + ' Artikel (Horoskop/Anzeigen gefiltert)');

  // Fetch article texts first
  const articles = [];
  for (const a of allArticles) {
    if (articles.length >= TEST_ARTICLES) break;
    try {
      const data = await fetchArticleText(a.url);
      if (data.length >= MIN_ARTICLE_LENGTH) {
        articles.push({ ...a, ...data });
        console.log('Artikel ' + articles.length + ': ' + a.title.substring(0, 60) + '... (' + data.length + ' Zeichen)');
      }
      await sleep(1500);
    } catch (e) { /* skip */ }
  }

  console.log('\n' + articles.length + ' Artikel geladen. Starte Vergleich...\n');

  const results = {}; // model -> [{article, summary, eval, avg}]
  for (const model of MODELS) results[model] = [];

  for (let i = 0; i < articles.length; i++) {
    const art = articles[i];
    console.log('\n--- [' + (i+1) + '/' + articles.length + '] ' + art.title.substring(0, 55) + '... ---');

    for (const model of MODELS) {
      try {
        const sum = await generateSummary(art.text, model);
        let ev = null;
        try { ev = await evaluateSummary(art.text, sum.summary); } catch (e) {}
        const avg = avgScore(ev);
        results[model].push({ title: art.title, summary: sum.summary, duration: sum.duration, eval: ev, avg });
        const scores = ev ? `Peter:${ev.peter?.score} Renate:${ev.renate?.score} Simon:${ev.simon?.score} Rico:${ev.rico?.score} Katja:${ev.katja?.score}` : 'N/A';
        console.log('  ' + model.padEnd(12) + ' | ' + sum.duration + 's | Avg: ' + avg.toFixed(1) + ' | ' + scores);
        await sleep(1000);
      } catch (e) {
        console.log('  ' + model.padEnd(12) + ' | FEHLER: ' + e.message);
        results[model].push({ title: art.title, summary: '', duration: '0', eval: null, avg: 0 });
      }
    }
  }

  // Summary
  console.log('\n\n========= ERGEBNIS =========\n');
  console.log('| Modell       | Avg   | Peter | Renate | Simon | Rico  | Katja | Zeit  |');
  console.log('|--------------|-------|-------|--------|-------|-------|-------|-------|');

  for (const model of MODELS) {
    const r = results[model].filter(x => x.avg > 0);
    if (r.length === 0) { console.log('| ' + model.padEnd(12) + ' | N/A   |'); continue; }
    const avg = (r.reduce((s, x) => s + x.avg, 0) / r.length).toFixed(2);
    const keys = ['peter', 'renate', 'simon', 'rico', 'katja'];
    const personaAvgs = keys.map(k => {
      const scores = r.filter(x => x.eval?.[k]?.score).map(x => x.eval[k].score);
      return scores.length > 0 ? (scores.reduce((a,b) => a+b, 0) / scores.length).toFixed(1) : 'N/A';
    });
    const avgTime = (r.reduce((s, x) => s + parseFloat(x.duration), 0) / r.length).toFixed(0);
    console.log('| ' + model.padEnd(12) + ' | ' + avg.padStart(5) + ' | ' + personaAvgs.map(p => p.padStart(5)).join(' | ') + ' | ' + (avgTime+'s').padStart(5) + ' |');
  }

  // Detail: Show best and worst summaries per model
  console.log('\n\n========= BESTE ZUSAMMENFASSUNG JE MODELL =========\n');
  for (const model of MODELS) {
    const best = [...results[model]].sort((a, b) => b.avg - a.avg)[0];
    if (!best || best.avg === 0) continue;
    console.log('--- ' + model + ' (Score: ' + best.avg.toFixed(1) + ') ---');
    console.log('Artikel: ' + best.title.substring(0, 70));
    console.log(best.summary);
    console.log('');
  }

  console.log('\n========= SCHLECHTESTE ZUSAMMENFASSUNG JE MODELL =========\n');
  for (const model of MODELS) {
    const r = results[model].filter(x => x.avg > 0);
    const worst = [...r].sort((a, b) => a.avg - b.avg)[0];
    if (!worst) continue;
    console.log('--- ' + model + ' (Score: ' + worst.avg.toFixed(1) + ') ---');
    console.log('Artikel: ' + worst.title.substring(0, 70));
    console.log(worst.summary);
    if (worst.eval) {
      const keys = ['peter', 'renate', 'simon', 'rico', 'katja'];
      for (const k of keys) {
        if (worst.eval[k]?.kommentar) console.log('  ' + k + ' (' + worst.eval[k].score + '): ' + worst.eval[k].kommentar);
      }
    }
    console.log('');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
