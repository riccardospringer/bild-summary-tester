/**
 * BILD Summary Tester - 100 Article Batch Test
 *
 * Tests GPT-5 Mini summary generation on up to 100 BILD articles,
 * then evaluates each summary via Claude Sonnet 4 from 5 reader personas.
 * Generates a detailed Markdown report.
 *
 * Usage: node test-100.js
 */

const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const fs = require('fs');
const path = require('path');

// ── Configuration ──────────────────────────────────────────────────────────────

const LITELLM_BASE = 'https://litellm.dev.tech.as-nmt.de';
const LITELLM_TOKEN = 'sk-BIYj7SP_MwrGnL1O-j8e3Q';
const SUMMARY_MODEL = 'gpt-5-mini';
const EVAL_MODEL = 'claude-sonnet-4';
const MAX_ARTICLES = 100;
const MIN_ARTICLE_LENGTH = 300;
const DELAY_BETWEEN_ARTICLES_MS = 1000;

const PROMPT_PATH = path.join(__dirname, 'prompts', 'default.json');
const REPORT_PATH = path.join(__dirname, 'test-report-100-v2.md');

// ── Load system prompt ─────────────────────────────────────────────────────────

const promptConfig = JSON.parse(fs.readFileSync(PROMPT_PATH, 'utf8'));
const SYSTEM_PROMPT = promptConfig.system_prompt;

// ── BILD-specific cleanup patterns (mirrored from server.js) ───────────────────

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
  /Artikel\s*lesen\s*/gi,
  /Weiterlesen\s*mit\s*BILDplus\s*/gi,
  /Jetzt\s*mit\s*BILDplus\s*lesen\s*/gi,
  /BILDplus\s*/g,
  /Foto:\s*[^\n]{0,60}(?:\n|$)/g,
  /Quelle:\s*BILD\s*/gi,
  /Mehr\s*zum\s*Video\s*anzeigen\s*/gi,
  /Wir\s*haben\s*personalisierte\s*Videos\s*f[u\u00fc]r\s*dich!.*?(?:Zustimmung\.|$)/gi,
  /Um\s*mit\s*Inhalten\s*von\s*Drittanbietern\s*zu\s*interagieren.*?(?:Zustimmung\.|$)/gi,
  /brauchen\s*wir\s*deine\s*Zustimmung\.\s*/gi,
  /Aktiviere\s*externe\s*Inhalte.*?(?:\.\s|$)/gi,
  /Externer\s*Inhalt\s*/gi,
  /Ich\s*bin\s*damit\s*einverstanden.*?(?:\.\s|$)/gi,
  /Datenschutzerkl[a\u00e4]rung\s*/gi,
  /Mehr\s*Informationen\s*dazu\s*findest\s*du\s*in\s*unserer\s*/gi,
  /Um\s*eingebettete\s*Inhalte\s*anzuzeigen.*?(?:DSGVO\)\.?\s*Mit|$)/gis,
  /Mit\s*dem\s*Klick\s*auf\s*den\s*Schalter.*?(?:Tracking\s*und\s*Cookies|einverstanden)/gis,
  /Widerruf\s*Tracking\s*und\s*Cookies\s*/gi,
  /Dabei\s*k[o\u00f6]nnen\s*Daten\s*in\s*Drittl[a\u00e4]nder.*?(?:\.\s|$)/gi,
  /^\s*Teilen\s*$/gm,
  /^\s*Kommentare\s*$/gm,
  /^\s*Empfehlungen\s*$/gm,
  /^\s*Auch\s*interessant\s*$/gm,
  /^\s*Lesen\s*Sie\s*auch\s*$/gm,
  /^\s*BILD\s*Deals\s*$/gm,
  /^\s*Newsletter\s*$/gm,
  /\d{2}\.\d{2}\.\d{4}\s*-\s*\d{2}:\d{2}\s*Uhr\s*/g
];

// ── Helper: sleep ──────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Step 1: Fetch article URLs from BILD sitemap ──────────────────────────────

async function fetchSitemapUrls() {
  console.log('Lade BILD News-Sitemap...');
  const response = await fetch('https://www.bild.de/sitemap-news.xml', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'application/xml,text/xml'
    }
  });

  if (!response.ok) {
    throw new Error('Sitemap nicht erreichbar: ' + response.statusText);
  }

  const xml = await response.text();
  const seen = new Set();
  const articles = [];
  const urlBlocks = xml.split('<url>').slice(1);

  for (const block of urlBlocks) {
    const locMatch = block.match(/<loc>([^<]+)<\/loc>/);
    const titleMatch = block.match(/<news:title>([^<]+)<\/news:title>/);
    const dateMatch = block.match(/<news:publication_date>([^<]+)<\/news:publication_date>/);

    if (!locMatch || !titleMatch) continue;

    const url = locMatch[1].trim();
    let title = titleMatch[1].trim();

    if (!title || title.length < 10) continue;
    if (seen.has(url)) continue;
    if (title.match(/live-ticker/i)) continue;

    seen.add(url);

    const pubDate = dateMatch ? dateMatch[1].trim() : '';
    articles.push({
      url,
      title: title.length > 150 ? title.substring(0, 147) + '...' : title,
      date: pubDate
    });

    if (articles.length >= MAX_ARTICLES) break;
  }

  // Shuffle articles to get a different set each run
  for (let i = articles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [articles[i], articles[j]] = [articles[j], articles[i]];
  }

  console.log('Gefunden: ' + articles.length + ' Artikel (max ' + MAX_ARTICLES + ', zufaellig sortiert)');
  return articles;
}

// ── Step 2: Fetch and clean article text (same as server.js) ──────────────────

async function fetchArticleText(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'de-DE,de;q=0.9'
    }
  });

  if (!response.ok) {
    throw new Error('HTTP ' + response.status + ': ' + response.statusText);
  }

  const html = await response.text();
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;

  // Remove BILD-specific UI elements before Readability
  for (const sel of REMOVE_SELECTORS) {
    try {
      doc.querySelectorAll(sel).forEach(el => el.remove());
    } catch (e) { /* ignore selector errors */ }
  }

  const reader = new Readability(doc);
  const article = reader.parse();

  if (!article || !article.textContent) {
    throw new Error('Artikeltext konnte nicht extrahiert werden');
  }

  // Clean text: remove BILD UI artifacts
  let cleanText = article.textContent.trim();
  for (const pattern of STRIP_PATTERNS) {
    cleanText = cleanText.replace(pattern, '');
  }
  // Collapse multiple blank lines
  cleanText = cleanText.replace(/\n{3,}/g, '\n\n').trim();

  return {
    title: article.title || '',
    text: cleanText,
    length: cleanText.length
  };
}

// ── Step 3: Generate summary via GPT-5 Mini (OpenAI format) ───────────────────

async function generateSummary(articleText) {
  const startTime = Date.now();

  const response = await fetch(LITELLM_BASE + '/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + LITELLM_TOKEN
    },
    body: JSON.stringify({
      model: SUMMARY_MODEL,
      max_tokens: 4096,
      temperature: 0.2,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: 'Fasse folgenden Artikel zusammen:\n\n' + articleText }
      ]
    })
  });

  const data = await response.json();

  if (data.error) {
    throw new Error('API Fehler: ' + (data.error.message || JSON.stringify(data.error)));
  }

  const content = data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content || ''
    : '';

  if (!content.trim()) {
    throw new Error('Leere Antwort vom Modell');
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  return {
    summary: content.trim(),
    duration_s: parseFloat(elapsed),
    usage: data.usage || {}
  };
}

// ── Step 4: Evaluate summary via Claude Sonnet 4 (Anthropic format) ───────────

async function evaluateSummary(articleText, summary) {
  // Truncate article text to first 3000 chars for evaluation (more context for fact-checking)
  const truncatedArticle = articleText.length > 3000
    ? articleText.substring(0, 3000) + '...'
    : articleText;

  const evalPrompt = `Du bist ein strenger, objektiver Qualitaetspruefer fuer journalistische Zusammenfassungen. Bewerte die folgende Zusammenfassung KRITISCH und EHRLICH aus 5 verschiedenen Perspektiven (1-5 Punkte). Sei nicht nachsichtig - vergib nur dann 4 oder 5 Punkte, wenn die Qualitaet wirklich herausragend ist.

BEWERTUNGSMASSSTAB:
1 = Inakzeptabel (schwere Maengel, unbrauchbar)
2 = Mangelhaft (deutliche Probleme, muss ueberarbeitet werden)
3 = Befriedigend (funktional, aber mit klaren Schwaechen)
4 = Gut (professionell, nur kleine Verbesserungen moeglich)
5 = Exzellent (vorbildlich, keine Kritik)

ORIGINALARTIKEL:
${truncatedArticle}

ZUSAMMENFASSUNG (zu bewerten):
${summary}

Die 5 Perspektiven - bewerte JEDE unabhaengig voneinander:

1. "Pendler-Peter" (35, Handwerker, liest in der S-Bahn)
   Bewertet NUR: Ist die Kerninfo in 5 Sekunden erfassbar? Sind die Saetze kurz und klar? Gibt es Fremdwoerter oder Fachbegriffe die stoeren?
   Abzug bei: Schachtelsaetzen, zu vielen Details, unklarer Struktur.

2. "Rentnerin Renate" (68, liest beim Fruehstueck die Zeitung)
   Bewertet NUR: Sind es vollstaendige, angenehm lesbare Saetze? Gibt es stoerende Abkuerzungen? Ist der Ton respektvoll und serioes?
   Abzug bei: Stichworten statt Saetzen, SMS-Stil, Bandwurmsaetzen, Semikolons, Klammer-Einschueben.

3. "Student Simon" (22, scrollt am Handy)
   Bewertet NUR: Will ich nach dem Lesen der Bullets den ganzen Artikel lesen? Wird meine Neugier geweckt? Bleibt etwas offen?
   Abzug bei: Alles schon verraten, kein Cliffhanger, langweilig/trocken, kein emotionaler Hook.

4. "Redakteur Rico" (40, BILD-Journalist, Faktencheck)
   Bewertet NUR: Stimmen ALLE Fakten mit dem Originalartikel ueberein? Sind Quellen korrekt zugeordnet? Wurden Daten, Zahlen oder Zitate korrekt wiedergegeben?
   STRENG PRUEFEN: Vergleiche jede Zahl, jedes Datum, jeden Namen, jedes Zitat mit dem Originalartikel. Jeder erfundene oder falsche Fakt = sofort maximal 2 Punkte.

5. "Korrektorin Katja" (45, Lektorin, sprachliche Qualitaet)
   Bewertet NUR: Sprachliches Niveau der Saetze. Eleganz, Praezision, Lesbarkeit. Korrekte Grammatik und Rechtschreibung. Redaktioneller Stil auf BILD-Niveau.
   Abzug bei: Semikolons, Bandwurmsaetzen, abgehacktem Stil, falscher Grammatik, holprigen Formulierungen, unvollstaendigen Saetzen.

WICHTIG: Jede Persona bewertet NUR ihren Bereich. Die Scores duerfen sich stark unterscheiden - eine Zusammenfassung kann sprachlich perfekt sein (Katja: 5) aber faktisch falsch (Rico: 1).

Antworte als JSON:
{
  "pendler_peter": {"score": X, "kommentar": "Maximal 2 Saetze Begruendung."},
  "rentnerin_renate": {"score": X, "kommentar": "Maximal 2 Saetze Begruendung."},
  "student_simon": {"score": X, "kommentar": "Maximal 2 Saetze Begruendung."},
  "redakteur_rico": {"score": X, "kommentar": "Maximal 2 Saetze Begruendung."},
  "korrektorin_katja": {"score": X, "kommentar": "Maximal 2 Saetze Begruendung."}
}
Nur das JSON, kein anderer Text.`;

  const response = await fetch(LITELLM_BASE + '/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + LITELLM_TOKEN,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: EVAL_MODEL,
      max_tokens: 1024,
      temperature: 0.1,
      messages: [
        { role: 'user', content: evalPrompt }
      ]
    })
  });

  const data = await response.json();

  if (data.error) {
    throw new Error('Eval API Fehler: ' + (data.error.message || JSON.stringify(data.error)));
  }

  const text = data.content && data.content[0] ? data.content[0].text : '';

  if (!text.trim()) {
    throw new Error('Leere Bewertung');
  }

  // Parse JSON from response (handle possible markdown code blocks)
  let jsonStr = text.trim();
  const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    jsonStr = jsonMatch[0];
  }

  const evaluation = JSON.parse(jsonStr);
  return evaluation;
}

// ── Helper: Calculate average score from evaluation ───────────────────────────

function avgScore(evaluation) {
  const personas = ['pendler_peter', 'rentnerin_renate', 'student_simon', 'redakteur_rico', 'korrektorin_katja'];
  let sum = 0;
  let count = 0;
  for (const p of personas) {
    if (evaluation[p] && typeof evaluation[p].score === 'number') {
      sum += evaluation[p].score;
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
}

// ── Step 5: Generate Markdown report ──────────────────────────────────────────

function generateReport(results, failures, startTime, endTime) {
  const totalDuration = ((endTime - startTime) / 1000 / 60).toFixed(1);
  const successCount = results.length;
  const failCount = failures.length;
  const totalCount = successCount + failCount;
  const successRate = totalCount > 0 ? ((successCount / totalCount) * 100).toFixed(1) : '0';

  const personas = ['pendler_peter', 'rentnerin_renate', 'student_simon', 'redakteur_rico', 'korrektorin_katja'];
  const personaLabels = {
    pendler_peter: 'Pendler-Peter (35, Handwerker)',
    rentnerin_renate: 'Rentnerin Renate (68, Rentnerin)',
    student_simon: 'Student Simon (22, BWL-Student)',
    redakteur_rico: 'Redakteur Rico (40, BILD-Journalist)',
    korrektorin_katja: 'Korrektorin Katja (45, Lektorin)'
  };

  // Calculate overall average
  const overallAvg = results.length > 0
    ? (results.reduce((s, r) => s + r.avgScore, 0) / results.length).toFixed(2)
    : '0';

  // Per-persona averages
  const personaAvgs = {};
  for (const p of personas) {
    const scores = results
      .filter(r => r.evaluation && r.evaluation[p] && typeof r.evaluation[p].score === 'number')
      .map(r => r.evaluation[p].score);
    personaAvgs[p] = scores.length > 0
      ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2)
      : 'N/A';
  }

  // Top 5 best
  const sorted = [...results].sort((a, b) => b.avgScore - a.avgScore);
  const top5 = sorted.slice(0, 5);
  const bottom5 = sorted.slice(-5).reverse();

  // Collect all comments for aggregation
  const allComments = {};
  for (const p of personas) {
    allComments[p] = results
      .filter(r => r.evaluation && r.evaluation[p] && r.evaluation[p].kommentar)
      .map(r => r.evaluation[p].kommentar);
  }

  // Average summary generation time
  const avgGenTime = results.length > 0
    ? (results.reduce((s, r) => s + r.summaryDuration, 0) / results.length).toFixed(1)
    : '0';

  // Build report
  let report = '';

  report += '# BILD Summary Tester - Testergebnis (100-Artikel-Batch)\n\n';
  report += '**Datum:** ' + new Date().toLocaleDateString('de-DE') + '  \n';
  report += '**Modell Zusammenfassung:** ' + SUMMARY_MODEL + '  \n';
  report += '**Modell Bewertung:** ' + EVAL_MODEL + '  \n';
  report += '**Prompt:** ' + promptConfig.name + '  \n';
  report += '**Gesamtlaufzeit:** ' + totalDuration + ' Minuten\n\n';

  report += '---\n\n';

  // Gesamtueberblick
  report += '## Gesamtueberblick\n\n';
  report += '| Metrik | Wert |\n';
  report += '|--------|------|\n';
  report += '| Getestete Artikel | ' + totalCount + ' |\n';
  report += '| Erfolgreich | ' + successCount + ' |\n';
  report += '| Fehlgeschlagen | ' + failCount + ' |\n';
  report += '| Erfolgsquote | ' + successRate + '% |\n';
  report += '| Durchschnittsbewertung (alle Personas) | **' + overallAvg + ' / 5** |\n';
  report += '| Durchschnittliche Generierungszeit | ' + avgGenTime + 's |\n';
  report += '\n';

  // Persona-Auswertung
  report += '## Persona-Auswertung\n\n';
  report += '| Persona | Durchschnittsscore | Interpretation |\n';
  report += '|---------|-------------------|----------------|\n';
  for (const p of personas) {
    const score = parseFloat(personaAvgs[p]);
    let interpretation = '';
    if (isNaN(score)) {
      interpretation = 'Keine Daten';
    } else if (score >= 4.5) {
      interpretation = 'Exzellent';
    } else if (score >= 4.0) {
      interpretation = 'Sehr gut';
    } else if (score >= 3.5) {
      interpretation = 'Gut';
    } else if (score >= 3.0) {
      interpretation = 'Befriedigend';
    } else if (score >= 2.0) {
      interpretation = 'Verbesserungswuerdig';
    } else {
      interpretation = 'Kritisch';
    }
    report += '| ' + personaLabels[p] + ' | **' + personaAvgs[p] + '** | ' + interpretation + ' |\n';
  }
  report += '\n';

  // Top 5 beste
  report += '## Top 5 beste Zusammenfassungen\n\n';
  for (let i = 0; i < top5.length; i++) {
    const r = top5[i];
    report += '### ' + (i + 1) + '. ' + r.title + '\n';
    report += '**URL:** ' + r.url + '  \n';
    report += '**Durchschnittsscore:** ' + r.avgScore.toFixed(2) + '/5  \n';
    report += '**Scores:** ';
    const scoreparts = [];
    for (const p of personas) {
      if (r.evaluation && r.evaluation[p]) {
        scoreparts.push(personaLabels[p].split(' (')[0] + ': ' + r.evaluation[p].score);
      }
    }
    report += scoreparts.join(' | ') + '  \n';
    report += '**Zusammenfassung:**\n';
    report += '> ' + r.summary.replace(/\n/g, '\n> ') + '\n\n';
  }

  // Top 5 schlechteste
  report += '## Top 5 schlechteste Zusammenfassungen\n\n';
  for (let i = 0; i < bottom5.length; i++) {
    const r = bottom5[i];
    report += '### ' + (i + 1) + '. ' + r.title + '\n';
    report += '**URL:** ' + r.url + '  \n';
    report += '**Durchschnittsscore:** ' + r.avgScore.toFixed(2) + '/5  \n';
    report += '**Scores:** ';
    const scoreparts = [];
    for (const p of personas) {
      if (r.evaluation && r.evaluation[p]) {
        scoreparts.push(personaLabels[p].split(' (')[0] + ': ' + r.evaluation[p].score);
      }
    }
    report += scoreparts.join(' | ') + '  \n';
    if (r.evaluation) {
      report += '**Kritik:**\n';
      for (const p of personas) {
        if (r.evaluation[p] && r.evaluation[p].kommentar) {
          report += '- **' + personaLabels[p].split(' (')[0] + ':** ' + r.evaluation[p].kommentar + '\n';
        }
      }
    }
    report += '**Zusammenfassung:**\n';
    report += '> ' + r.summary.replace(/\n/g, '\n> ') + '\n\n';
  }

  // Haeufigste Kritikpunkte
  report += '## Haeufigste Kritikpunkte (aggregiert)\n\n';
  for (const p of personas) {
    report += '### ' + personaLabels[p] + '\n';
    // Show comments from the lowest-scored articles for this persona
    const personaResults = results
      .filter(r => r.evaluation && r.evaluation[p] && typeof r.evaluation[p].score === 'number')
      .sort((a, b) => a.evaluation[p].score - b.evaluation[p].score);
    const lowScored = personaResults.filter(r => r.evaluation[p].score <= 3).slice(0, 5);
    if (lowScored.length === 0) {
      report += 'Keine niedrigen Bewertungen (alle > 3).\n\n';
    } else {
      for (const r of lowScored) {
        report += '- (Score ' + r.evaluation[p].score + ') ' + r.evaluation[p].kommentar + '\n';
      }
      report += '\n';
    }
  }

  // Detailtabelle
  report += '## Detailtabelle: Alle Artikel\n\n';
  report += '| # | Artikel | Peter | Renate | Simon | Rico | Katja | Avg | Zeit |\n';
  report += '|---|---------|-------|--------|-------|------|-------|-----|------|\n';
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const shortTitle = r.title.length > 50 ? r.title.substring(0, 47) + '...' : r.title;
    // Escape pipe characters in title
    const safeTitle = shortTitle.replace(/\|/g, '/');
    const scores = personas.map(p =>
      r.evaluation && r.evaluation[p] && typeof r.evaluation[p].score === 'number'
        ? r.evaluation[p].score.toString()
        : '-'
    );
    report += '| ' + (i + 1) + ' | ' + safeTitle + ' | ' + scores.join(' | ') + ' | ' + r.avgScore.toFixed(1) + ' | ' + r.summaryDuration.toFixed(1) + 's |\n';
  }
  report += '\n';

  // Fehlgeschlagene Artikel
  if (failures.length > 0) {
    report += '## Fehlgeschlagene Artikel\n\n';
    report += '| # | URL | Fehler |\n';
    report += '|---|-----|--------|\n';
    for (let i = 0; i < failures.length; i++) {
      const f = failures[i];
      const safeError = f.error.replace(/\|/g, '/').replace(/\n/g, ' ');
      report += '| ' + (i + 1) + ' | ' + f.url + ' | ' + safeError + ' |\n';
    }
    report += '\n';
  }

  // Fazit und Empfehlungen
  report += '## Fazit und Empfehlungen\n\n';

  const overallNum = parseFloat(overallAvg);
  if (overallNum >= 4.0) {
    report += 'Die Zusammenfassungen erreichen insgesamt ein **sehr gutes Niveau** (' + overallAvg + '/5). ';
    report += 'Das Modell ' + SUMMARY_MODEL + ' liefert zuverlaessig brauchbare Teaser-Bullets fuer BILD-Artikel.\n\n';
  } else if (overallNum >= 3.5) {
    report += 'Die Zusammenfassungen erreichen ein **gutes Niveau** (' + overallAvg + '/5), mit Raum fuer Verbesserungen. ';
    report += 'Einige Artikeltypen werden besser verarbeitet als andere.\n\n';
  } else if (overallNum >= 3.0) {
    report += 'Die Zusammenfassungen erreichen ein **befriedigendes Niveau** (' + overallAvg + '/5). ';
    report += 'Es gibt deutlichen Verbesserungsbedarf, insbesondere bei den unten genannten Kritikpunkten.\n\n';
  } else {
    report += 'Die Zusammenfassungen erreichen ein **verbesserungswuerdiges Niveau** (' + overallAvg + '/5). ';
    report += 'Eine Ueberarbeitung des Prompts und/oder Modellwechsel wird empfohlen.\n\n';
  }

  // Persona-specific recommendations
  report += '### Empfehlungen nach Persona\n\n';
  for (const p of personas) {
    const score = parseFloat(personaAvgs[p]);
    if (isNaN(score)) continue;
    if (score < 3.5) {
      report += '- **' + personaLabels[p].split(' (')[0] + '** (Score: ' + personaAvgs[p] + '): Optimierungsbedarf. ';
      if (p === 'pendler_peter') report += 'Bullets muessen knapper und schneller erfassbar sein.\n';
      else if (p === 'rentnerin_renate') report += 'Saetze sollten vollstaendiger und lesbarer formuliert werden.\n';
      else if (p === 'student_simon') report += 'Neugier-Faktor erhoehen - mehr Teaser-Qualitaet.\n';
      else if (p === 'redakteur_rico') report += 'Faktentreue und Quellennennung verbessern.\n';
      else if (p === 'korrektorin_katja') report += 'Sprachliche Qualitaet und Stil ueberarbeiten.\n';
    }
  }
  report += '\n';

  report += '### Allgemeine Empfehlungen\n\n';
  report += '1. **Prompt-Optimierung:** Kritikpunkte der niedrigsten Bewertungen in den System-Prompt einfliessen lassen.\n';
  report += '2. **Artikeltyp-Analyse:** Pruefen, ob bestimmte Artikeltypen (Sport, Politik, Boulevard) systematisch schlechter abschneiden.\n';
  report += '3. **Modellvergleich:** Test mit weiteren Modellen (GPT-5, Claude Sonnet 4) fuer direkten Vergleich.\n';
  report += '4. **Prompt-Iterationen:** A/B-Tests mit angepassten Prompts basierend auf den Persona-Kritikpunkten.\n';

  report += '\n---\n\n';
  report += '*Generiert am ' + new Date().toLocaleString('de-DE') + ' mit dem BILD Summary Tester Batch-Script.*\n';

  return report;
}

// ── Main execution ────────────────────────────────────────────────────────────

async function main() {
  console.log('=== BILD Summary Tester - 100 Artikel Batch-Test ===');
  console.log('Modell Zusammenfassung: ' + SUMMARY_MODEL);
  console.log('Modell Bewertung: ' + EVAL_MODEL);
  console.log('Prompt: ' + promptConfig.name);
  console.log('');

  const globalStart = Date.now();

  // Step 1: Get article URLs
  let articles;
  try {
    articles = await fetchSitemapUrls();
  } catch (err) {
    console.error('FATAL: Sitemap konnte nicht geladen werden: ' + err.message);
    process.exit(1);
  }

  if (articles.length === 0) {
    console.error('FATAL: Keine Artikel in der Sitemap gefunden.');
    process.exit(1);
  }

  if (articles.length < MAX_ARTICLES) {
    console.log('HINWEIS: Nur ' + articles.length + ' Artikel verfuegbar (statt ' + MAX_ARTICLES + ').');
  }

  const results = [];
  const failures = [];
  let processed = 0;

  // Step 2-4: Process each article
  for (const article of articles) {
    processed++;
    const prefix = '[' + processed + '/' + articles.length + ']';

    try {
      // Fetch article text
      const articleData = await fetchArticleText(article.url);

      // Skip short articles
      if (articleData.length < MIN_ARTICLE_LENGTH) {
        console.log(prefix + ' SKIP (zu kurz: ' + articleData.length + ' Zeichen): "' + article.title.substring(0, 60) + '..."');
        failures.push({
          url: article.url,
          title: article.title,
          error: 'Artikel zu kurz (' + articleData.length + ' Zeichen, Minimum: ' + MIN_ARTICLE_LENGTH + ')'
        });
        await sleep(DELAY_BETWEEN_ARTICLES_MS);
        continue;
      }

      // Generate summary
      const summaryResult = await generateSummary(articleData.text);

      // Evaluate summary
      let evaluation = null;
      let evalAvg = 0;
      try {
        evaluation = await evaluateSummary(articleData.text, summaryResult.summary);
        evalAvg = avgScore(evaluation);
      } catch (evalErr) {
        console.log(prefix + ' Bewertungsfehler: ' + evalErr.message);
        evaluation = null;
        evalAvg = 0;
      }

      const result = {
        url: article.url,
        title: articleData.title || article.title,
        date: article.date,
        articleLength: articleData.length,
        summary: summaryResult.summary,
        summaryDuration: summaryResult.duration_s,
        evaluation: evaluation,
        avgScore: evalAvg
      };
      results.push(result);

      const scoreStr = evalAvg > 0 ? evalAvg.toFixed(1) + '/5' : 'N/A';
      const titleShort = (articleData.title || article.title).substring(0, 60);
      console.log(prefix + ' Artikel: "' + titleShort + '..." - ' + SUMMARY_MODEL + ': ' + summaryResult.duration_s + 's - Bewertung: ' + scoreStr);

    } catch (err) {
      console.log(prefix + ' FEHLER: "' + article.title.substring(0, 50) + '..." - ' + err.message);
      failures.push({
        url: article.url,
        title: article.title,
        error: err.message
      });
    }

    // Rate limiting delay
    await sleep(DELAY_BETWEEN_ARTICLES_MS);
  }

  const globalEnd = Date.now();

  // Step 5: Generate report
  console.log('');
  console.log('=== Ergebnis ===');
  console.log('Erfolgreich: ' + results.length + '/' + articles.length);
  console.log('Fehlgeschlagen: ' + failures.length);

  if (results.length > 0) {
    const overallAvg = (results.reduce((s, r) => s + r.avgScore, 0) / results.length).toFixed(2);
    console.log('Durchschnittsbewertung: ' + overallAvg + '/5');
  }

  const report = generateReport(results, failures, globalStart, globalEnd);
  fs.writeFileSync(REPORT_PATH, report, 'utf8');
  console.log('');
  console.log('Report geschrieben: ' + REPORT_PATH);
  console.log('Gesamtlaufzeit: ' + ((globalEnd - globalStart) / 1000 / 60).toFixed(1) + ' Minuten');
}

main().catch(err => {
  console.error('Unerwarteter Fehler: ' + err.message);
  console.error(err.stack);
  process.exit(1);
});
