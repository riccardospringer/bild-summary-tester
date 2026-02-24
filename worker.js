// Worker: Laeuft auf Riccardos Mac, holt Jobs von Render, ruft LiteLLM auf
require('dotenv').config();

const RENDER_URL = 'https://bild-summary-tester.onrender.com';
const LITELLM_URL = process.env.ANTHROPIC_BASE_URL || 'https://litellm.dev.tech.as-nmt.de';
const LITELLM_KEY = process.env.ANTHROPIC_API_KEY || 'sk-BIYj7SP_MwrGnL1O-j8e3Q';
const POLL_INTERVAL = 3000;

let active = false;

async function poll() {
  if (active) return;
  active = true;
  try {
    const res = await fetch(RENDER_URL + '/api/pending');
    if (!res.ok) { active = false; return; }
    const pending = await res.json();

    for (const job of pending) {
      console.log('Job ' + job.id + ': ' + (job.text || '').substring(0, 60) + '...');
      try {
        const llmRes = await fetch(LITELLM_URL + '/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + LITELLM_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: job.model || 'claude-sonnet-4',
            max_tokens: job.max_tokens || 1024,
            temperature: job.temperature || 0.2,
            system: job.system_prompt,
            messages: [{ role: 'user', content: 'Fasse folgenden Artikel zusammen:\n\n' + job.text }]
          })
        });

        const llmData = await llmRes.json();

        if (llmData.error) {
          await postResult(job.id, { error: llmData.error.message || JSON.stringify(llmData.error) });
        } else {
          await postResult(job.id, {
            summary: llmData.content[0].text,
            model: llmData.model,
            usage: llmData.usage
          });
          console.log('Job ' + job.id + ': fertig');
        }
      } catch (err) {
        console.error('Job ' + job.id + ' Fehler:', err.message);
        await postResult(job.id, { error: 'Worker-Fehler: ' + err.message });
      }
    }
  } catch (err) {
    // Render nicht erreichbar - naechster Versuch
  }
  active = false;
}

async function postResult(id, result) {
  await fetch(RENDER_URL + '/api/result/' + id, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(result)
  });
}

setInterval(poll, POLL_INTERVAL);
poll();
console.log('Worker gestartet - pollt ' + RENDER_URL + ' alle ' + (POLL_INTERVAL / 1000) + 's');
