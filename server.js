require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(__dirname));

// Health check - Railway braucht das
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Anthropic Client lazy init (crasht nicht beim Start wenn Key fehlt)
let anthropic = null;
function getAnthropicClient() {
  if (!anthropic) {
    anthropic = new Anthropic.default({
      apiKey: process.env.ANTHROPIC_API_KEY,
      baseURL: process.env.ANTHROPIC_BASE_URL || undefined
    });
  }
  return anthropic;
}

// Artikel von URL holen und Text extrahieren
app.post('/api/fetch-article', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL fehlt' });

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'de-DE,de;q=0.9'
      }
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: 'Artikel konnte nicht geladen werden: ' + response.statusText });
    }

    const html = await response.text();
    const dom = new JSDOM(html, { url });
    const doc = dom.window.document;

    // BILD-spezifische UI-Elemente vor Readability entfernen
    const removeSelectors = [
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
    for (const sel of removeSelectors) {
      try { doc.querySelectorAll(sel).forEach(el => el.remove()); } catch (e) {}
    }

    const reader = new Readability(doc);
    const article = reader.parse();

    if (!article || !article.textContent) {
      return res.status(422).json({ error: 'Artikeltext konnte nicht extrahiert werden' });
    }

    // Artikeltext nachbereinigen: BILD-UI-Artefakte entfernen
    let cleanText = article.textContent.trim();
    const stripPatterns = [
      /TTS-Player\s*[uü]berspringen\s*/gi,
      /Artikel\s*weiterlesen\s*/gi,
      /Artikel\s*lesen\s*/gi,
      /Weiterlesen\s*mit\s*BILDplus\s*/gi,
      /Jetzt\s*mit\s*BILDplus\s*lesen\s*/gi,
      /BILDplus(?![-\w])\s*/g,
      /Foto:\s*[^\n]{0,60}(?:\n|$)/g,
      /Quelle:\s*BILD\s*/gi,
      /Mehr\s*zum\s*Video\s*anzeigen\s*/gi,
      /Wir\s*haben\s*personalisierte\s*Videos\s*f[uü]r\s*dich!.*?(?:Zustimmung\.|$)/gi,
      /Um\s*mit\s*Inhalten\s*von\s*Drittanbietern\s*zu\s*interagieren.*?(?:Zustimmung\.|$)/gi,
      /brauchen\s*wir\s*deine\s*Zustimmung\.\s*/gi,
      /Aktiviere\s*externe\s*Inhalte.*?(?:\.\s|$)/gi,
      /Externer\s*Inhalt\s*/gi,
      /Ich\s*bin\s*damit\s*einverstanden.*?(?:\.\s|$)/gi,
      /Datenschutzerkl[aä]rung\s*/gi,
      /Mehr\s*Informationen\s*dazu\s*findest\s*du\s*in\s*unserer\s*/gi,
      /Um\s*eingebettete\s*Inhalte\s*anzuzeigen.*?(?:DSGVO\)\.?\s*Mit|$)/gis,
      /Mit\s*dem\s*Klick\s*auf\s*den\s*Schalter.*?(?:Tracking\s*und\s*Cookies|einverstanden)/gis,
      /Widerruf\s*Tracking\s*und\s*Cookies\s*/gi,
      /Dabei\s*k[oö]nnen\s*Daten\s*in\s*Drittl[aä]nder.*?(?:\.\s|$)/gi,
      /^\s*Teilen\s*$/gm,
      /^\s*Kommentare\s*$/gm,
      /^\s*Empfehlungen\s*$/gm,
      /^\s*Auch\s*interessant\s*$/gm,
      /^\s*Lesen\s*Sie\s*auch\s*$/gm,
      /^\s*BILD\s*Deals\s*$/gm,
      /^\s*Newsletter\s*$/gm,
      /\d{2}\.\d{2}\.\d{4}\s*-\s*\d{2}:\d{2}\s*Uhr\s*/g
    ];
    for (const pattern of stripPatterns) {
      cleanText = cleanText.replace(pattern, '');
    }
    // Mehrfache Leerzeilen zusammenfassen
    cleanText = cleanText.replace(/\n{3,}/g, '\n\n').trim();

    res.json({
      title: article.title || '',
      text: cleanText,
      excerpt: article.excerpt || '',
      length: cleanText.length
    });
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Laden: ' + err.message });
  }
});

// Zusammenfassung generieren (Anthropic + OpenAI via LiteLLM)
app.post('/api/summarize', async (req, res) => {
  try {
    const { text, system_prompt, model, max_tokens, temperature } = req.body;
    const selectedModel = model || 'claude-sonnet-4';

    if (!text) return res.status(400).json({ error: 'Text fehlt' });
    if (!system_prompt) return res.status(400).json({ error: 'System Prompt fehlt' });

    const isOpenAIFormat = selectedModel.startsWith('gpt-') || selectedModel.startsWith('o1') || selectedModel.startsWith('o3') || selectedModel.startsWith('gemini-');

    if (isOpenAIFormat) {
      // OpenAI/Gemini-Modelle: /v1/chat/completions via LiteLLM
      const baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://litellm.dev.tech.as-nmt.de';
      const apiKey = process.env.ANTHROPIC_API_KEY;
      const isReasoning = selectedModel.startsWith('gpt-5');
      const maxTok = isReasoning ? Math.max(max_tokens || 1024, 16384) : (max_tokens || 1024);
      const llmRes = await fetch(baseUrl + '/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey
        },
        body: JSON.stringify({
          model: selectedModel,
          max_tokens: maxTok,
          temperature: temperature || 0.2,
          messages: [
            { role: 'system', content: system_prompt },
            { role: 'user', content: 'Fasse folgenden Artikel zusammen:\n\n' + text }
          ]
        })
      });
      const llmData = await llmRes.json();
      if (llmData.error) {
        return res.status(500).json({ error: 'API Fehler (' + selectedModel + '): ' + (llmData.error.message || JSON.stringify(llmData.error)) });
      }
      const content = llmData.choices[0].message.content || '';
      if (!content.trim()) {
        return res.status(500).json({ error: 'Modell ' + selectedModel + ' hat leere Antwort geliefert' });
      }
      res.json({
        summary: content,
        model: llmData.model,
        usage: {
          input_tokens: llmData.usage.prompt_tokens,
          output_tokens: llmData.usage.completion_tokens
        }
      });
    } else {
      // Anthropic-Modelle: Messages API
      const message = await getAnthropicClient().messages.create({
        model: selectedModel,
        max_tokens: max_tokens || 1024,
        temperature: temperature || 0.3,
        system: system_prompt,
        messages: [
          { role: 'user', content: 'Fasse folgenden Artikel zusammen:\n\n' + text }
        ]
      });
      res.json({
        summary: message.content[0].text,
        model: message.model,
        usage: message.usage
      });
    }
  } catch (err) {
    res.status(500).json({ error: 'API Fehler: ' + err.message });
  }
});

// BILD Feed: News-Sitemap fuer aktuelle Artikel-URLs
app.get('/api/feed', async (req, res) => {
  try {
    const response = await fetch('https://www.bild.de/sitemap-news.xml', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/xml,text/xml'
      }
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: 'BILD News-Sitemap nicht erreichbar' });
    }

    const xml = await response.text();

    // XML-Namespaces machen JSDOM querySelector unzuverlaessig,
    // daher Regex-basiertes Parsing der Sitemap
    const seen = new Set();
    const articles = [];
    const urlBlocks = xml.split('<url>').slice(1);

    for (const block of urlBlocks) {
      if (articles.length >= 15) break;

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
    }

    res.json({ articles, count: articles.length });
  } catch (err) {
    res.status(500).json({ error: 'Feed-Fehler: ' + err.message });
  }
});

// Prompts laden/speichern
app.get('/api/prompts', (req, res) => {
  const promptDir = path.join(__dirname, 'prompts');
  const files = fs.readdirSync(promptDir).filter(f => f.endsWith('.json'));
  const prompts = files.map(f => {
    const data = JSON.parse(fs.readFileSync(path.join(promptDir, f), 'utf8'));
    data.filename = f;
    return data;
  });
  res.json(prompts);
});

app.post('/api/prompts', (req, res) => {
  const { name, system_prompt, model, max_tokens, temperature } = req.body;
  const filename = name.toLowerCase().replace(/[^a-z0-9]+/g, '_') + '.json';
  const filepath = path.join(__dirname, 'prompts', filename);
  fs.writeFileSync(filepath, JSON.stringify({ name, model, max_tokens, temperature, system_prompt }, null, 2));
  res.json({ saved: filename });
});

// ── Job Queue (Relay fuer Cloud-Deployment) ──
const jobs = {};

// Frontend: Auftrag einreichen
app.post('/api/queue', (req, res) => {
  const id = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
  jobs[id] = { request: req.body, status: 'pending', result: null, created: Date.now() };
  res.json({ id });
});

// Worker: Offene Auftraege abholen
app.get('/api/pending', (req, res) => {
  const pending = [];
  for (const [id, job] of Object.entries(jobs)) {
    if (job.status === 'pending') {
      job.status = 'processing';
      pending.push({ id, ...job.request });
    }
  }
  res.json(pending);
});

// Worker: Ergebnis zurueckschicken
app.post('/api/result/:id', (req, res) => {
  if (jobs[req.params.id]) {
    jobs[req.params.id].result = req.body;
    jobs[req.params.id].status = 'done';
  }
  res.json({ ok: true });
});

// Frontend: Ergebnis abfragen
app.get('/api/result/:id', (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.json({ status: 'not_found' });
  if (job.status === 'done') {
    const result = job.result;
    delete jobs[req.params.id];
    return res.json({ status: 'done', result });
  }
  res.json({ status: job.status });
});

// Alte Jobs aufraeumen (alle 60s, max 5 Min alt)
setInterval(() => {
  const now = Date.now();
  for (const id of Object.keys(jobs)) {
    if (now - jobs[id].created > 300000) delete jobs[id];
  }
}, 60000);

// Feedback speichern + per E-Mail senden
const feedbackFile = path.join(process.env.RAILWAY_ENVIRONMENT ? '/tmp' : __dirname, 'feedback.json');

app.post('/api/feedback', async (req, res) => {
  try {
    const { articleTitle, articleUrl, promptName, model, summary, rating, comment } = req.body;

    const entry = {
      timestamp: new Date().toISOString(),
      articleTitle: articleTitle || '',
      articleUrl: articleUrl || '',
      promptName: promptName || '',
      model: model || '',
      summary: summary || '',
      rating: rating || '',
      comment: comment || ''
    };

    // Lokal speichern
    let feedback = [];
    if (fs.existsSync(feedbackFile)) {
      feedback = JSON.parse(fs.readFileSync(feedbackFile, 'utf8'));
    }
    feedback.push(entry);
    fs.writeFileSync(feedbackFile, JSON.stringify(feedback, null, 2));

    // E-Mail senden (wenn SMTP konfiguriert)
    let emailSent = false;
    if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.FEEDBACK_EMAIL) {
      try {
        const transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: parseInt(process.env.SMTP_PORT) || 587,
          secure: false,
          auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS
          }
        });

        const ratingEmoji = rating === 'good' ? '&#9989;' : rating === 'bad' ? '&#10060;' : '&#9898;';
        const ratingText = rating === 'good' ? 'Gut' : rating === 'bad' ? 'Schlecht' : 'Neutral';

        await transporter.sendMail({
          from: process.env.SMTP_USER,
          to: process.env.FEEDBACK_EMAIL,
          subject: 'Summary Feedback: ' + ratingText + ' - ' + (articleTitle || '').substring(0, 60),
          html: `
            <div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto;">
              <div style="background: #c41e1e; color: #fff; padding: 16px 20px; font-weight: 900; font-size: 18px;">
                BILD Summary Tester - Feedback
              </div>
              <div style="padding: 20px; background: #fff; border: 1px solid #e0e0e0;">
                <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
                  <tr>
                    <td style="padding: 8px 0; color: #999; width: 100px; vertical-align: top;">Bewertung</td>
                    <td style="padding: 8px 0; font-weight: 700; font-size: 16px;">${ratingEmoji} ${ratingText}</td>
                  </tr>
                  <tr>
                    <td style="padding: 8px 0; color: #999; vertical-align: top;">Artikel</td>
                    <td style="padding: 8px 0;"><a href="${articleUrl}" style="color: #c41e1e;">${articleTitle || articleUrl}</a></td>
                  </tr>
                  <tr>
                    <td style="padding: 8px 0; color: #999; vertical-align: top;">Prompt</td>
                    <td style="padding: 8px 0;">${promptName}</td>
                  </tr>
                  <tr>
                    <td style="padding: 8px 0; color: #999; vertical-align: top;">Modell</td>
                    <td style="padding: 8px 0;">${model}</td>
                  </tr>
                </table>
                <div style="margin-top: 16px; padding-top: 16px; border-top: 1px solid #eee;">
                  <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #999; margin-bottom: 6px;">Zusammenfassung</div>
                  <div style="background: #f8f8f8; border-left: 4px solid #c41e1e; padding: 12px 16px; font-size: 14px; line-height: 1.6;">
                    ${(summary || '').replace(/\n/g, '<br>')}
                  </div>
                </div>
                ${comment ? `
                <div style="margin-top: 16px; padding-top: 16px; border-top: 1px solid #eee;">
                  <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #999; margin-bottom: 6px;">Kommentar</div>
                  <div style="background: #fff8e1; border-left: 4px solid #f9a825; padding: 12px 16px; font-size: 14px; line-height: 1.6;">
                    ${comment.replace(/\n/g, '<br>')}
                  </div>
                </div>
                ` : ''}
                <div style="margin-top: 20px; font-size: 11px; color: #bbb;">
                  ${new Date().toLocaleString('de-DE')} | BILD Summary Tester
                </div>
              </div>
            </div>
          `
        });
        emailSent = true;
      } catch (emailErr) {
        console.error('E-Mail Fehler:', emailErr.message);
      }
    }

    res.json({ saved: true, emailSent, total: feedback.length });
  } catch (err) {
    res.status(500).json({ error: 'Feedback-Fehler: ' + err.message });
  }
});

// Feedback-Verlauf laden
app.get('/api/feedback', (req, res) => {
  if (!fs.existsSync(feedbackFile)) return res.json([]);
  const feedback = JSON.parse(fs.readFileSync(feedbackFile, 'utf8'));
  res.json(feedback);
});

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = '0.0.0.0';

const server = app.listen(PORT, HOST, () => {
  console.log('Summary Tester gestartet');
  console.log('PORT: ' + PORT);
  console.log('HOST: ' + HOST);
  console.log('ANTHROPIC_BASE_URL: ' + (process.env.ANTHROPIC_BASE_URL || 'nicht gesetzt'));
  console.log('ANTHROPIC_API_KEY: ' + (process.env.ANTHROPIC_API_KEY ? 'gesetzt' : 'FEHLT!'));
});

server.on('error', (err) => {
  console.error('Server-Fehler:', err.message);
  process.exit(1);
});
