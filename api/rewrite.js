/**
 * api/rewrite.js — Vercel Serverless Function
 * ─────────────────────────────────────────────────────────────
 * The ONE place in this project that's allowed to hold a real Gemini/
 * Claude API key server-side. Everything else in SQL-Vis is still 100%
 * client-side (see script.js's own header) — this single endpoint exists
 * ONLY so a team can share one AI provider key without every teammate
 * needing (or being able to see) that key themselves.
 *
 * How it fits together:
 *   - ai-providers.js's SharedProvider (browser side) posts here with a
 *     shared TEAM PASSWORD instead of an API key.
 *   - This function checks that password against SQLVIS_ACCESS_PASSWORD
 *     (a Vercel project environment variable — set it in the Vercel
 *     dashboard, never commit it to the repo).
 *   - If it matches, this function builds a REAL provider instance using
 *     GEMINI_API_KEY / CLAUDE_API_KEY (also Vercel env vars) and calls it
 *     — reusing the EXACT SAME GeminiProvider/ClaudeProvider classes and
 *     prompt-building logic from ai-providers.js, since that file is
 *     written to also work when require()'d from Node (see its own
 *     dual-export tail) instead of loaded as a <script>.
 *
 * IMPORTANT — what this does and doesn't protect against:
 *   - The real API key never reaches the browser, in this mode, at all —
 *     that's the whole point, and it's real protection.
 *   - The shared PASSWORD is not strong access control — anyone who has
 *     it (or intercepts it, though HTTPS already protects that in
 *     transit) can call this endpoint. It's meant to keep random internet
 *     traffic off your API bill, not to gate genuinely sensitive access.
 *     There's no rate-limiting here either — a teammate accidentally
 *     looping requests still spends your quota. Add real rate-limiting
 *     (or Vercel's own deployment protection) if that risk matters to you.
 * ─────────────────────────────────────────────────────────────
 */
const { createProvider } = require('../ai-providers.js');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed — POST only.' });
    return;
  }

  const { password, provider, model, payload } = req.body || {};

  const expectedPassword = process.env.SQLVIS_ACCESS_PASSWORD;
  if (!expectedPassword) {
    res.status(500).json({ error: 'Server is missing the SQLVIS_ACCESS_PASSWORD environment variable — set it in the Vercel project settings.' });
    return;
  }
  if (!password || password !== expectedPassword) {
    res.status(401).json({ error: 'Incorrect team password.' });
    return;
  }

  if (!payload || typeof payload !== 'object') {
    res.status(400).json({ error: 'Missing "payload" in request body.' });
    return;
  }

  const envKeyName = provider === 'claude' ? 'CLAUDE_API_KEY' : 'GEMINI_API_KEY';
  const apiKey = process.env[envKeyName];
  if (!apiKey) {
    res.status(500).json({ error: `Server is missing the ${envKeyName} environment variable — set it in the Vercel project settings.` });
    return;
  }

  try {
    const aiProvider = createProvider(provider === 'claude' ? 'claude' : 'gemini', apiKey, model);
    const result = await aiProvider.rewriteQuery(payload);
    res.status(200).json(result);
  } catch (err) {
    console.error('[api/rewrite]', err);
    res.status(502).json({ error: err.message || 'The AI request failed.' });
  }
};
