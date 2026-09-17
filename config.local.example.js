/**
 * config.local.example.js — template for local development convenience only.
 * ─────────────────────────────────────────────────────────────
 * SQL-Vis has NO backend and NO build step (see script.js's own header) —
 * a static HTML page cannot read a traditional `.env` file, because there
 * is no process running to load one. This file is the closest equivalent
 * that actually works for a plain <script> tag setup: a plain JS file that
 * sets one global object, loaded like any other script.
 *
 * HOW TO USE:
 *   1. Copy this file to "config.local.js" (same folder).
 *   2. Paste your own API key(s) below — fill in whichever provider(s)
 *      you actually use; leaving one blank is fine.
 *   3. Reload index.html — the "AI provider" section on the source-swap
 *      page will come pre-filled with these values every time you open it.
 *      Both providers' key/model are kept, not just the default one —
 *      switching the Provider dropdown pulls in that provider's own
 *      stored key/model instead of leaving the other one's values behind.
 *
 * "config.local.js" is listed in .gitignore — it never gets committed.
 *
 * IMPORTANT — this is a convenience, not a secret store: the key ends up
 * in this plain-text file on your own disk, and is used from the browser
 * exactly the same way as if you'd typed it into the field yourself (see
 * ai-providers.js's file header for what that means — visible in this
 * browser's Network tab, sent directly to the provider you chose, never
 * touching any SQL-Vis server because there isn't one). Don't commit this
 * file, don't put a production/shared key in it, and don't paste its
 * contents anywhere public.
 * ─────────────────────────────────────────────────────────────
 */
window.SQLVIS_LOCAL_CONFIG = {
  defaultProvider: 'gemini', // which provider the dropdown starts on: 'gemini' or 'claude'
  gemini: { model: '', apiKey: '' }, // model optional — blank uses the provider's default
  claude: { model: '', apiKey: '' },
};
