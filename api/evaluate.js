import { createClient } from 'redis';

let redis;
async function getRedis() {
  if (redis && redis.isOpen) return redis;
  redis = createClient({ url: process.env.REDIS_URL });
  redis.on('error', () => {});
  await redis.connect();
  return redis;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);
    if (!body) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString());
    }

    const { action } = body;

    // ============================================================
    // ACTION: AI EVALUATION
    // ============================================================
    if (!action || action === 'evaluate') {
      const { systemPrompt, userMessage } = body;
      if (!systemPrompt || !userMessage) {
        return res.status(400).json({ error: 'Missing fields' });
      }

      const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 600,
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
        }),
      });

      const data = await apiRes.json();

      if (!apiRes.ok) {
        return res.status(200).json({
          _debugError: true,
          anthropicStatus: apiRes.status,
          anthropicResponse: data,
        });
      }

      return res.status(200).json(data);
    }

    // ============================================================
    // ACTION: ADD POINTS
    // ============================================================
    if (action === 'addPoints') {
      const { user, points } = body;
      if (!user || typeof points !== 'number') {
        return res.status(400).json({ error: 'Missing user or points' });
      }
      const r = await getRedis();
      const total = await r.incrBy(`pts:${user}`, points);
      return res.status(200).json({ ok: true, total });
    }

    // ============================================================
    // ACTION: GET LEADERBOARD
    // ============================================================
    if (action === 'getLeaderboard') {
      const r = await getRedis();
      const keys = await r.keys('pts:*');
      const entries = [];
      for (const k of keys) {
        const name = k.substring(4);
        const pts = await r.get(k);
        if (pts !== null) entries.push([name, Number(pts)]);
      }
      entries.sort((a, b) => b[1] - a[1]);
      return res.status(200).json({ leaderboard: entries });
    }

    // ============================================================
    // ACTION: SUBMIT TEST
    // ============================================================
    if (action === 'submitTest') {
      const { user, score, total, pct, durationSec } = body;
      if (!user || typeof score !== 'number') {
        return res.status(400).json({ error: 'Missing test data' });
      }
      const r = await getRedis();
      const raw = await r.get('tests:all');
      let tests = raw ? JSON.parse(raw) : [];
      tests.push({ name: user, score, total, pct, durationSec, ts: Date.now() });
      tests.sort((a, b) => b.pct - a.pct || a.durationSec - b.durationSec);
      const top30 = tests.slice(0, 30);
      await r.set('tests:all', JSON.stringify(top30));
      return res.status(200).json({ ok: true, tests: top30 });
    }

    // ============================================================
    // ACTION: GET TESTS
    // ============================================================
    if (action === 'getTests') {
      const r = await getRedis();
      const raw = await r.get('tests:all');
      const tests = raw ? JSON.parse(raw) : [];
      return res.status(200).json({ tests });
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (error) {
    return res.status(200).json({
      _debugError: true,
      catchError: error.message,
      stack: error.stack
    });
  }
}
