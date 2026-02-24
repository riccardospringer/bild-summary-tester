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
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    if (!article || !article.textContent) {
      return res.status(422).json({ error: 'Artikeltext konnte nicht extrahiert werden' });
    }

    res.json({
      title: article.title || '',
      text: article.textContent.trim(),
      excerpt: article.excerpt || '',
      length: article.length || 0
    });
  } catch (err) {
    res.status(500).json({ error: 'Fehler beim Laden: ' + err.message });
  }
});

// Zusammenfassung generieren
app.post('/api/summarize', async (req, res) => {
  try {
    const { text, system_prompt, model, max_tokens, temperature } = req.body;

    if (!text) return res.status(400).json({ error: 'Text fehlt' });
    if (!system_prompt) return res.status(400).json({ error: 'System Prompt fehlt' });

    const message = await getAnthropicClient().messages.create({
      model: model || 'claude-sonnet-4',
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
  } catch (err) {
    res.status(500).json({ error: 'Claude API Fehler: ' + err.message });
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
