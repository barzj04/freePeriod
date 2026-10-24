// FreePeriod shared AI server (Cloudflare Worker).
// Lets people use FreePeriod's AI without their own API key, while keeping your key secret.
//
// Settings in Cloudflare (Worker → Settings → Variables and Secrets):
//   ANTHROPIC_API_KEY  (Secret, required)  your Anthropic key
//   ALLOWED_ORIGINS    (optional)  comma-separated sites allowed to use it. Default: https://barzj04.github.io
//   MODEL              (optional)  default: claude-haiku-5-5
//   PER_IP_DAILY       (optional)  requests per person per day. Default: 40
//   GLOBAL_DAILY       (optional)  requests per day for everyone together. Default: 400
// Optional KV namespace binding named LIMITS turns on the daily limits.
// Also set a monthly spend limit in the Anthropic Console as a final safety net.

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || 'https://barzj04.github.io').split(',').map((s) => s.trim());
    const okOrigin = allowed.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    const cors = {
      'Access-Control-Allow-Origin': okOrigin ? origin : allowed[0],
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type',
      'Vary': 'Origin'
    };
    const reply = (obj, status) => new Response(JSON.stringify(obj), { status, headers: { ...cors, 'content-type': 'application/json' } });

    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (req.method !== 'POST') return reply({ error: { message: 'Use POST.' } }, 405);
    if (!okOrigin) return reply({ error: { message: 'This site is not allowed to use this server.' } }, 403);
    if (!env.ANTHROPIC_API_KEY) return reply({ error: { message: 'Server is missing its API key.' } }, 500);
    if (+(req.headers.get('content-length') || 0) > 6_000_000) return reply({ error: { message: 'Upload is too big (max about 4 MB).' } }, 413);

    // Daily limits (only if a KV namespace called LIMITS is bound)
    if (env.LIMITS) {
      const day = new Date().toISOString().slice(0, 10);
      const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
      const ipKey = `${day}:${ip}`, allKey = `${day}:all`;
      const [ipN, allN] = await Promise.all([env.LIMITS.get(ipKey), env.LIMITS.get(allKey)]).then((v) => v.map((x) => +(x || 0)));
      if (ipN >= +(env.PER_IP_DAILY || 40) || allN >= +(env.GLOBAL_DAILY || 400)) {
        return reply({ error: { message: 'Daily limit reached. Try again tomorrow, or add your own key in Settings.' } }, 429);
      }
      await Promise.all([
        env.LIMITS.put(ipKey, String(ipN + 1), { expirationTtl: 172800 }),
        env.LIMITS.put(allKey, String(allN + 1), { expirationTtl: 172800 })
      ]);
    }

    let body;
    try { body = await req.json(); } catch { return reply({ error: { message: 'Bad request.' } }, 400); }
    const messages = Array.isArray(body.messages) ? body.messages : null;
    if (!messages || messages.length !== 1 || messages[0].role !== 'user') return reply({ error: { message: 'Bad request.' } }, 400);

    // The model and token cap are fixed here, so nobody can use your key for something bigger.
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: env.MODEL || 'claude-haiku-5-5', max_tokens: Math.min(+body.max_tokens || 1500, 3000), messages })
    });
    return new Response(await upstream.text(), { status: upstream.status, headers: { ...cors, 'content-type': 'application/json' } });
  }
};
