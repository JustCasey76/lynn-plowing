// Lynn Plowing — minimal static server + OpenAI proxy.
// Static files served from project root. POST /api/explain proxies to OpenAI.
// Requires Node 18+ (uses global fetch).

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8000;
const ROOT = __dirname;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
  '.txt':  'text/plain; charset=utf-8',
  '.map':  'application/json; charset=utf-8'
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function readBody(req, max = 1_000_000) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (c) => {
      total += c.length;
      if (total > max) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleExplain(req, res) {
  if (!OPENAI_API_KEY) {
    return send(res, 500,
      JSON.stringify({ error: 'OPENAI_API_KEY not set on server' }),
      { 'Content-Type': 'application/json' });
  }
  let payload;
  try {
    const raw = await readBody(req);
    payload = JSON.parse(raw);
  } catch (e) {
    return send(res, 400, JSON.stringify({ error: 'invalid JSON body' }), { 'Content-Type': 'application/json' });
  }
  const { best, runnerUps, totalTested } = payload || {};
  if (!best || !best.metrics || !best.inputs) {
    return send(res, 400, JSON.stringify({ error: 'missing best scenario' }), { 'Content-Type': 'application/json' });
  }

  const fmtTime = (m) => {
    if (!isFinite(m)) return '—';
    const h = Math.floor(m / 60), mm = Math.floor(m % 60);
    return h > 0 ? `${h}h ${mm}m` : `${mm}m`;
  };
  const summarize = (s) => `
- name: ${s.name}
- score: ${s.metrics.score.toFixed(1)} (lower is better)
- estimated total completion: ${fmtTime(s.metrics.totalCompletionTimeMinutes)}
- high-priority roads done at: ${fmtTime(s.metrics.highPriorityCompletionTimeMinutes)}
- total miles plowed: ${s.metrics.totalMilesPlowed.toFixed(1)}
- deadhead miles: ${s.metrics.deadheadMiles.toFixed(1)}
- avg plow utilization: ${(s.metrics.averagePlowUtilization * 100).toFixed(0)}%
- route overlap: ${s.metrics.routeOverlapPercent.toFixed(1)}%
- active plows: ${s.inputs.activePlows} (DPW ${s.inputs.dpwOwnedEquipment} / contractors ${s.inputs.contractedEquipment})
- clustering: ${s.inputs.clusteringStrategy}
- assignment: ${s.inputs.assignmentStrategy}
- routing: ${s.inputs.routingStrategy}
- priority strategy: ${s.inputs.priorityStrategy}
- plow speed: ${s.inputs.plowSpeedMph} mph
- storm severity: ${s.inputs.stormSeverity}
`.trim();

  const sys = `You are a snow-plow operations analyst writing for a public-works director.
Explain in plain language why the BEST simulated scenario beat the runner-ups.
Be specific: cite the actual numbers. Do not claim mathematical optimality —
this is the best simulated scenario found across the tested batch. Keep it tight.

Output strict JSON with these keys:
{
  "headline": "one short sentence with the estimated total time",
  "why_fastest": ["3-5 short bullet reasons grounded in the input/metric differences"],
  "tradeoffs": ["1-3 short bullets of risks or things being traded away"],
  "operator_actions": ["2-4 plain-language actions the public-works team should take if running this plan"]
}
No markdown, no preamble — JSON only.`;

  const user = `Total scenarios tested: ${totalTested ?? 'unknown'}.

BEST SCENARIO:
${summarize(best)}

RUNNER-UPS (for contrast):
${(runnerUps || []).slice(0, 3).map(summarize).join('\n\n')}`;

  try {
    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: user }
        ],
        temperature: 0.4,
        response_format: { type: 'json_object' }
      })
    });
    if (!aiRes.ok) {
      const t = await aiRes.text();
      return send(res, 502, JSON.stringify({ error: 'openai error', status: aiRes.status, detail: t.slice(0, 800) }),
        { 'Content-Type': 'application/json' });
    }
    const data = await aiRes.json();
    const content = data?.choices?.[0]?.message?.content || '{}';
    let parsed;
    try { parsed = JSON.parse(content); } catch { parsed = { raw: content }; }
    return send(res, 200, JSON.stringify(parsed), { 'Content-Type': 'application/json' });
  } catch (e) {
    return send(res, 500, JSON.stringify({ error: String(e.message || e) }), { 'Content-Type': 'application/json' });
  }
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
  // prevent path traversal
  const safe = path.normalize(urlPath).replace(/^([\\/])+/, '');
  const full = path.join(ROOT, safe);
  if (!full.startsWith(ROOT)) return send(res, 403, 'forbidden');
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'not found');
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(full).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/api/explain') return handleExplain(req, res);
  if (req.method === 'GET' && req.url === '/api/health') {
    return send(res, 200, JSON.stringify({ ok: true, openaiConfigured: !!OPENAI_API_KEY, model: MODEL }),
      { 'Content-Type': 'application/json' });
  }
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
  send(res, 405, 'method not allowed');
});

server.listen(PORT, () => {
  console.log(`Lynn plowing serving on :${PORT} (openai ${OPENAI_API_KEY ? 'enabled' : 'NOT configured'})`);
});
