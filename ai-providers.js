/**
 * ai-providers.js — SQL-Vis "technical debt automation" module (Phase 3)
 * ─────────────────────────────────────────────────────────────
 * Adapter layer between source-swap.js and an external AI API (Gemini or
 * Claude), chosen by the user at runtime. Nothing here is coupled to the
 * DOM or to source-swap.js's state — it's a pure request/response layer:
 * `createProvider(name, apiKey, model)` returns an object with one method,
 * `rewriteQuery(payload) -> Promise<AiRewriteResult>`, and that's the
 * entire surface source-swap.js depends on. Adding a third provider later
 * means adding one more class here and one more entry in PROVIDERS below —
 * nothing else in the app needs to change.
 *
 * IMPORTANT — this is a client-only app (no backend, no proxy). The API
 * key the user enters is used directly from the browser, which means:
 *   - It is visible in this browser tab's Network tab for this session.
 *   - For Claude, calling api.anthropic.com directly from a browser origin
 *     requires the `anthropic-dangerous-direct-browser-access: true`
 *     header (Anthropic blocks browser-origin calls without it) — sent
 *     below. This is Anthropic's own documented opt-in for exactly this
 *     "no backend" use case, not a workaround of anything.
 *   - The key is kept ONLY in memory for the current page session (see
 *     source-swap.js's state) — never written to localStorage/sessionStorage
 *     or sent anywhere except directly to the provider the user picked.
 * ─────────────────────────────────────────────────────────────
 */

/* ═════════════════════════════════════════════════════════════
   SHARED RESPONSE SCHEMA
   Both providers are forced (via Gemini's responseSchema / Claude's
   tool_choice) to return exactly this shape, so source-swap.js never has
   to guess at or free-text-parse a model's reply.
   ═════════════════════════════════════════════════════════════ */

const AI_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    rewrittenQuery: {
      type: 'string',
      description: 'The full original query, rewritten so every reference to the old source is replaced by the new source — renamed columns, adjusted join keys, and any additional filters the new source needs. Must preserve the original query\'s formatting/indentation/line breaks exactly except where a token must change, and must never rename or remove any existing "AS <alias>" — see STRICT RULES in the prompt.',
    },
    columnMappings: {
      type: 'array',
      description: 'Every old column (from the old source) mapped to its new-source equivalent, including columns you determined have no equivalent (newColumn: null).',
      items: {
        type: 'object',
        properties: {
          oldColumn: { type: 'string' },
          newColumn: { type: 'string' },
          note: { type: 'string', description: 'Why this mapping was made, or what changed (type/format/semantics) — empty string if a plain rename.' },
        },
        required: ['oldColumn', 'newColumn', 'note'],
      },
    },
    addedFilters: {
      type: 'array',
      description: 'Human-readable description of each NEW filter condition you introduced that did not exist against the old source (e.g. "material_type_code = \'ZFRT\' — new source mixes in non-material rows the old table never had").',
      items: { type: 'string' },
    },
    newFilterSql: {
      type: ['string', 'null'],
      description: 'The equivalent of the given "filter conditions scoped to the old source" (see prompt), rewritten to be valid on its own against a bare "FROM <new_source> AS src" query — renamed columns plus any addedFilters. Null only if the old filter was also null/none.',
    },
    newNumericColumns: {
      type: 'array',
      description: 'For EXACTLY the "numeric columns" list given in the prompt (no more, no fewer), the corresponding new-source column name, or null if that measure does not exist on the new source.',
      items: {
        type: 'object',
        properties: {
          oldColumn: { type: 'string' },
          newColumn: { type: ['string', 'null'] },
        },
        required: ['oldColumn', 'newColumn'],
      },
    },
    warnings: {
      type: 'array',
      description: 'Any ambiguity, assumption, or thing the user should double-check by eye before running the rewritten query (e.g. "old source had no equivalent of korporat_code beyond a fuzzy name match").',
      items: { type: 'string' },
    },
    finalOutputNumericColumns: {
      type: 'array',
      description: 'Column ALIASES from the ORIGINAL QUERY\'s own outermost/final SELECT list (not the raw source) that are very likely numeric, summable business measures — guessed from naming convention (e.g. containing "quantity", "qty", "amount", "amt", "total", "sum", "count", "price", "value", "cost", "weight", "duration", "hours", "days", "num", "jumlah") and cross-checked against the sample data where an alias maps directly to a source column you were shown. Since every existing alias is preserved unchanged (see STRICT RULES), this exact list of names is valid on BOTH the old and new versions of the query — this is independent of the old/new SOURCE numeric-column list above. Include every plausible one; an empty array is fine only if truly nothing looks numeric.',
      items: { type: 'string' },
    },
  },
  required: ['rewrittenQuery', 'columnMappings', 'addedFilters', 'newFilterSql', 'newNumericColumns', 'warnings', 'finalOutputNumericColumns'],
};

/* ═════════════════════════════════════════════════════════════
   PROMPT BUILDER (shared by both providers — only the transport and the
   structured-output mechanism differ between Gemini and Claude)
   ═════════════════════════════════════════════════════════════ */

function sampleRowsToText(columns, sampleRows, maxRows = 30) {
  const header = columns.join(' | ');
  const rows = sampleRows.slice(0, maxRows).map(row =>
    row.map(v => (v === '' ? '∅' : v)).join(' | ')
  );
  return [header, ...rows].join('\n');
}

/**
 * buildPromptText
 * Dispatches on payload shape: `payload.cteTarget` means a CTE is being
 * consolidated onto a single new source (see buildCtePromptText); anything
 * else is the original single-physical-table swap mode.
 * @param {object} payload - see rewriteQuery() jsdoc below for shape
 * @returns {string}
 */
function buildPromptText(payload) {
  return payload.cteTarget ? buildCtePromptText(payload) : buildTablePromptText(payload);
}

/**
 * buildTablePromptText
 * @param {object} payload - see rewriteQuery() jsdoc below for shape
 * @returns {string}
 */
function buildTablePromptText(payload) {
  const { originalQuery, dialect, targetTable, oldSample, newSample, extractedContext } = payload;
  const ctx = extractedContext || {};

  const droppedNote = ctx.droppedConjuncts
    ? `\n  (${ctx.droppedConjuncts} other WHERE condition(s) were excluded from this list because they also reference a different table in a JOIN — those stay untouched in the rewrite and you don't need to translate them.)`
    : '';

  const numericColumnsLine = ctx.selectStar
    ? '(this scope selects * — infer numeric columns yourself from the OLD sample data\'s column types)'
    : (ctx.oldNumericColumnCandidates && ctx.oldNumericColumnCandidates.length
        ? ctx.oldNumericColumnCandidates.join(', ')
        : '(none detected)');

  return `You are assisting with a SQL "source swap" — replacing one table/CTE source with a structurally different replacement, inside a larger query, without breaking the query's logic. This is a recurring technical-debt task: the query's real intent must be preserved even though the new source has different column names, value formats, and possibly needs extra filters the old source didn't.

ORIGINAL QUERY (dialect: ${dialect}):
\`\`\`sql
${originalQuery}
\`\`\`

TARGET SOURCE TO REPLACE: ${targetTable.oldName} (alias in the query: ${ctx.targetAlias || '(alias unknown — search the query text)'})
REPLACEMENT SOURCE: ${targetTable.newName}

SAMPLE ROWS FROM THE OLD SOURCE (file: ${oldSample.fileName}):
${sampleRowsToText(oldSample.columns, oldSample.sampleRows)}

SAMPLE ROWS FROM THE NEW SOURCE (file: ${newSample.fileName}):
${sampleRowsToText(newSample.columns, newSample.sampleRows)}

DETERMINISTICALLY EXTRACTED FROM THE ORIGINAL QUERY'S AST (ground truth — do not recompute, just use it):
- Filter conditions that apply to ${targetTable.oldName} alone: ${ctx.oldFilterSql || '(none found)'}${droppedNote}
- Numeric columns read directly from ${targetTable.oldName} in this query: ${numericColumnsLine}

STRICT RULES FOR THE REWRITE (violating these makes the rewrite unusable, even if the SQL logic is otherwise correct):
- Preserve the original query's formatting as closely as possible — same line breaks, same indentation, same statement structure. Touch only the tokens that must change (the source reference, column names/types that no longer exist, filter conditions). Do not reformat, reflow, reindent, re-order clauses, or "clean up" any part of the query that doesn't need to change.
- Every existing "AS <alias>" already in the query is a stable output contract that something downstream depends on — never rename, remove, or alter an existing alias, no matter how the underlying expression changes. Only the expression BEFORE "AS" may change to reference the new source.
- If a column reference has NO explicit alias (e.g. a bare "dp.product_code") and its column name must change on the new source, add an explicit "AS product_code" using the ORIGINAL bare column name — so every output column name is identical before and after the swap, even for columns that didn't need an alias before.

YOUR TASK:
1. Compare the two sample data structures. Identify renamed columns (even when names change completely, not just cosmetically), value/type/format differences, join-key changes, and any additional filter condition the NEW source appears to need that the OLD source didn't (e.g. a status/type/deletion flag present and clearly meaningful on the new source but absent on the old one).
2. Produce a full rewrite of the ORIGINAL QUERY with every reference to ${targetTable.oldName} replaced by ${targetTable.newName} — including renamed columns, adjusted join keys, adjusted COALESCE/derived logic, and any additional filters from step 1 — following the STRICT RULES above exactly. The result must be valid, logically equivalent ${dialect} SQL.
3. Map the given numeric-column list (and only that list) to their new-source equivalents.
4. Rewrite the given old-source filter into an equivalent standalone filter valid against "FROM ${targetTable.newName} AS src" alone.
5. Separately, look at the ORIGINAL QUERY's own outermost/final SELECT list (not the raw source) and identify which output column ALIASES look like numeric, summable business metrics purely from naming convention (things like "quantity", "qty", "amount", "total", "count", "price", "value", "cost", "sum", "num", "hours", "days" in the name). List them in finalOutputNumericColumns. This is a separate concern from step 3 — it's about the query's own final output columns, which keep identical names on both the old and new version of the query (per the STRICT RULES), so this same list works for validating either one.

Respond using only the structured fields you're given — no prose outside them.`;
}

/**
 * buildCtePromptText
 * CTE-target mode: the "old source" isn't one physical table with a
 * single alias/filter — it's a CTE's own SQL body, which may join several
 * raw sources together (the exact case this mode exists for: consolidating
 * several old raw tables into one new source). The CTE's body IS the
 * old-side ground truth, so there's no AST-extracted filter/numeric-
 * candidate section the way buildTablePromptText has one — an old-source
 * sample is optional context here, not a requirement.
 * @param {object} payload - see rewriteQuery() jsdoc below for shape
 * @returns {string}
 */
function buildCtePromptText(payload) {
  const { originalQuery, dialect, cteName, cteBody, newSourceName, oldSample, newSample, columnsToAdjust } = payload;
  const isAugment = Array.isArray(columnsToAdjust) && columnsToAdjust.length > 0;

  const oldSampleBlock = oldSample
    ? `SAMPLE ROWS FROM ONE OF THE OLD RAW SOURCES (file: ${oldSample.fileName}) — optional extra context; the CTE body above is the real ground truth for what the old logic reads:\n${sampleRowsToText(oldSample.columns, oldSample.sampleRows)}`
    : '(no old-source sample was provided — rely on the CTE body above to understand the old structure)';

  const sharedHeader = `FULL ORIGINAL QUERY (dialect: ${dialect}), for context — the CTE you're rewriting is just one piece of it:
\`\`\`sql
${originalQuery}
\`\`\`

TARGET CTE: "${cteName}"

THE CTE'S CURRENT BODY (read it carefully, it may join multiple raw tables):
\`\`\`sql
${cteBody}
\`\`\`

${oldSampleBlock}

SAMPLE ROWS FROM THE NEW SOURCE (file: ${newSample.fileName}):
${sampleRowsToText(newSample.columns, newSample.sampleRows)}`;

  if (isAugment) {
    return `You are assisting with a SQL "source augmentation" — a CTE gets ONE OR TWO of its columns corrected from a new, more authoritative source, while everything else about the CTE (its other columns, its existing joins, its output shape) stays exactly as it is. This is a recurring technical-debt task: a couple of fields (e.g. a reorder point, a safety-stock quantity) turn out to live more reliably in a different table, and the query needs to start reading just those from it — not do a wholesale source swap.

${sharedHeader}

NEW SOURCE TO ADD (via LEFT JOIN — this SUPPLEMENTS the CTE's existing source(s), it does not replace them): ${newSourceName}

COLUMNS TO MOVE TO THE NEW SOURCE (every other column in the CTE keeps its exact current source expression): ${columnsToAdjust.join(', ')}

STRICT RULES FOR THE REWRITE (violating these makes the rewrite unusable, even if the SQL logic is otherwise correct):
- Preserve the original query's formatting as closely as possible — same line breaks, same indentation, same statement structure, everywhere OUTSIDE the target CTE. Touch only what must change.
- Do NOT remove or modify the CTE's existing FROM/JOIN for its current source(s) — they stay exactly as they are. ADD a new JOIN to ${newSourceName} alongside them.
- Always use LEFT JOIN for the new source, never INNER JOIN — a row with no match in ${newSourceName} must still survive with NULLs for the adjusted columns, not get silently dropped from the result.
- Infer the join key(s) between the CTE's existing source and ${newSourceName} from matching identifier columns you can see in the CTE body and the new sample's columns (e.g. a shared product/plant/material code). If you aren't confident in the join key, say so explicitly in warnings rather than silently guessing.
- Re-point ONLY the listed columns (${columnsToAdjust.join(', ')}) to read from the new source's alias. Every other column in the CTE's SELECT list must keep its EXACT original source expression, untouched.
- The CTE's own output column list (its SELECT list aliases) must stay EXACTLY the same — every CTE/query downstream of "${cteName}" reads it by those names and must keep working unchanged.

YOUR TASK:
1. Compare the new source's sample data against the CTE's current body. Identify which new-source column corresponds to each of the listed columns-to-adjust, and which columns look like the right join key between the CTE's existing source and the new one.
2. Produce a full rewrite of the ENTIRE ORIGINAL QUERY with the "${cteName}" CTE modified to add a LEFT JOIN to ${newSourceName} and re-point only the listed columns to it — following the STRICT RULES above exactly. Everything else in the query (other CTEs, the final SELECT, the CTE's other columns, etc.) must be byte-for-byte unchanged. The result must be valid, logically equivalent ${dialect} SQL.
3. Separately, look at the ORIGINAL QUERY's own outermost/final SELECT list (not any one CTE) and identify which output column ALIASES look like numeric, summable business metrics purely from naming convention (things like "quantity", "qty", "amount", "total", "count", "price", "value", "cost", "sum", "num", "hours", "days" in the name). List them in finalOutputNumericColumns.
4. Set columnMappings to the old-column → new-source-column pairs for just the columns you moved, and addedFilters to any new filter conditions the new source needs (e.g. an expiry/active-flag check). Set newFilterSql to null and newNumericColumns to an empty array — those two are only meaningful for a single-physical-table swap, not this augmentation mode.

Respond using only the structured fields you're given — no prose outside them.`;
  }

  return `You are assisting with a SQL "source consolidation" — a CTE currently reads from one or more raw tables (possibly joining several together) and needs to be rewritten to read from a SINGLE new, already-consolidated source instead, while the CTE's own output columns stay exactly the same so everything downstream keeps working unchanged. This is a recurring technical-debt task: a data team replaces several raw/staging tables with one clean table, and every query that built its own version of that consolidation needs to switch over to it.

${sharedHeader}

REPLACEMENT SOURCE (the ONE new consolidated table to read from instead of whatever the CTE currently joins): ${newSourceName}

STRICT RULES FOR THE REWRITE (violating these makes the rewrite unusable, even if the SQL logic is otherwise correct):
- Preserve the original query's formatting as closely as possible — same line breaks, same indentation, same statement structure, everywhere OUTSIDE the target CTE. Touch only what must change.
- The CTE's own output column list (its SELECT list aliases) must stay EXACTLY the same — every CTE/query downstream of "${cteName}" reads it by those names and must keep working unchanged. Only the CTE's internal FROM/JOIN/WHERE logic changes to read from ${newSourceName} instead.
- If a column in the CTE's SELECT list has NO explicit alias and its source expression must change, add an explicit alias matching its ORIGINAL implicit name, for the same reason.
- Rewrite the CTE's body to read ONLY from ${newSourceName} — every raw table it currently joins should disappear from the rewritten CTE (their columns/filters get re-derived from the new source's columns instead). If any of those raw tables are also used elsewhere in the query OUTSIDE this CTE, leave those other usages untouched.

YOUR TASK:
1. Compare the CTE's current body against the new source's sample data. Identify which new-source column corresponds to each column the CTE currently reads (across all the raw tables it joins), including any additional filter condition the new source needs that wasn't needed before.
2. Produce a full rewrite of the ENTIRE ORIGINAL QUERY with ONLY the "${cteName}" CTE's body replaced by a query against ${newSourceName} — following the STRICT RULES above exactly. Everything else in the query (other CTEs, the final SELECT, etc.) must be byte-for-byte unchanged. The result must be valid, logically equivalent ${dialect} SQL.
3. Separately, look at the ORIGINAL QUERY's own outermost/final SELECT list (not any one CTE) and identify which output column ALIASES look like numeric, summable business metrics purely from naming convention (things like "quantity", "qty", "amount", "total", "count", "price", "value", "cost", "sum", "num", "hours", "days" in the name). List them in finalOutputNumericColumns.
4. Set columnMappings to the old-CTE-column → new-source-column pairs you used, and addedFilters to any new filter conditions you introduced. Set newFilterSql to null and newNumericColumns to an empty array — those two are only meaningful for a single-physical-table swap, not this CTE-consolidation mode.

Respond using only the structured fields you're given — no prose outside them.`;
}

/**
 * validateAiResponseShape
 * Manual, dependency-free check against AI_RESPONSE_SCHEMA's required
 * fields — thin on purpose (this isn't a general JSON-schema validator),
 * just enough to fail loudly with a clear message instead of source-swap.js
 * hitting a confusing `undefined` deep in the comparison-query generator.
 * @param {any} obj
 * @throws {Error}
 */
function validateAiResponseShape(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('AI response was not a JSON object.');
  for (const field of AI_RESPONSE_SCHEMA.required) {
    if (!(field in obj)) throw new Error(`AI response is missing required field "${field}".`);
  }
  if (typeof obj.rewrittenQuery !== 'string' || !obj.rewrittenQuery.trim()) {
    throw new Error('AI response\'s "rewrittenQuery" was empty.');
  }
  if (!Array.isArray(obj.columnMappings) || !Array.isArray(obj.newNumericColumns) || !Array.isArray(obj.warnings)
    || !Array.isArray(obj.addedFilters) || !Array.isArray(obj.finalOutputNumericColumns)) {
    throw new Error('AI response had a wrong-typed array field.');
  }
}

/**
 * toGeminiResponseSchema
 * Gemini's `responseSchema` is NOT full JSON Schema — it's Google's own
 * restricted OpenAPI-3.0-style Schema proto, which does not support `type`
 * as an array (JSON Schema's usual way to express "string or null"; Gemini
 * rejects it with "Proto field is not repeating, cannot start list").
 * Nullability there is instead a separate `nullable: true` boolean next to
 * a single scalar `type`. This recursively rewrites every
 * `type: [X, 'null']` into `{ type: X, nullable: true }` — applied only for
 * the Gemini request; AI_RESPONSE_SCHEMA itself stays real JSON Schema,
 * since Claude's tool `input_schema` (below) accepts the array form as-is.
 * @param {object} schema
 * @returns {object}
 */
function toGeminiResponseSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const out = { ...schema };

  if (Array.isArray(out.type)) {
    out.nullable = out.type.includes('null');
    out.type = out.type.find(t => t !== 'null');
  }
  if (out.properties) {
    out.properties = Object.fromEntries(
      Object.entries(out.properties).map(([key, value]) => [key, toGeminiResponseSchema(value)])
    );
  }
  if (out.items) out.items = toGeminiResponseSchema(out.items);

  return out;
}

/**
 * fetchWithRetry
 * Retries only on transient provider errors — 429 (rate-limited) and 503
 * (overloaded), both of which real-world Gemini/Claude traffic hits under
 * normal load and which usually clear within seconds. Any other status
 * (400 bad request, 401 unauthorized, 404 unknown model, etc.) is returned
 * immediately — retrying those would just repeat the same failure.
 * @param {string} url
 * @param {RequestInit} options
 * @param {number} [maxAttempts]
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(url, options, maxAttempts = 3) {
  const RETRYABLE_STATUSES = new Set([429, 503]);
  let res;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    res = await fetch(url, options);
    if (res.ok || !RETRYABLE_STATUSES.has(res.status) || attempt === maxAttempts) return res;
    await new Promise(resolve => setTimeout(resolve, attempt * 2000)); // 2s, then 4s
  }
  return res;
}

/* ═════════════════════════════════════════════════════════════
   PROVIDER: GEMINI
   REST endpoint supports CORS from a browser origin directly — no special
   header needed (unlike Claude below).
   ═════════════════════════════════════════════════════════════ */

class GeminiProvider {
  constructor(apiKey, model) {
    this.apiKey = apiKey;
    this.model = model || 'gemini-3.6-flash'; // editable in the UI — Google's model catalog moves independently of this app
  }

  async rewriteQuery(payload) {
    const promptText = buildPromptText(payload);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;

    const res = await fetchWithRetry(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: promptText }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: toGeminiResponseSchema(AI_RESPONSE_SCHEMA),
          // The response has to echo the ENTIRE original query back (not
          // just the part that changed) plus every other field — a
          // few-hundred-line real-world query can need many thousands of
          // output tokens on its own. Too low a cap here doesn't error
          // cleanly, it truncates mid-JSON, which then fails validation
          // with a confusing "missing field" error instead — see the
          // finishReason check below for surfacing that clearly when it
          // still happens even at this size.
          maxOutputTokens: 16384,
        },
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Gemini API error ${res.status}: ${body.slice(0, 500)}`);
    }

    const data = await res.json();
    const candidate = data && data.candidates && data.candidates[0];
    const text = candidate && candidate.content && candidate.content.parts && candidate.content.parts[0]
      && candidate.content.parts[0].text;

    if (!text) {
      if (candidate && candidate.finishReason === 'MAX_TOKENS') {
        throw new Error('Gemini cut its response off before finishing (hit the output token limit) — this can happen with a very large query. Try again, or try Claude/a different model.');
      }
      throw new Error('Gemini response did not contain the expected content.parts[0].text.');
    }

    let parsed;
    try { parsed = JSON.parse(text); }
    catch (err) {
      const hint = candidate.finishReason === 'MAX_TOKENS'
        ? ' (Gemini\'s response was cut off before finishing — try again, or try Claude/a different model for very large queries.)'
        : '';
      throw new Error(`Gemini returned non-JSON despite responseMimeType=application/json: ${err.message}${hint}`);
    }

    try {
      validateAiResponseShape(parsed);
    } catch (err) {
      if (candidate.finishReason === 'MAX_TOKENS') {
        throw new Error(`Gemini's response was cut off before finishing (hit the output token limit), so the rewrite is incomplete: ${err.message}`);
      }
      throw err;
    }
    return parsed;
  }
}

/* ═════════════════════════════════════════════════════════════
   PROVIDER: CLAUDE
   Forces structured output via a single tool + tool_choice, rather than
   asking for JSON in prose — this makes the parse step trivial (no
   markdown-fence stripping) and matches Anthropic's documented pattern for
   "I want strict JSON back."
   ═════════════════════════════════════════════════════════════ */

class ClaudeProvider {
  constructor(apiKey, model) {
    this.apiKey = apiKey;
    this.model = model || 'claude-sonnet-5';
  }

  async rewriteQuery(payload) {
    const promptText = buildPromptText(payload);
    const toolName = 'submit_source_swap_rewrite';

    const res = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        // Required for any browser-origin (as opposed to server-side) call —
        // see the file header note on why this app calls the API directly.
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: this.model,
        // The response has to echo the ENTIRE original query back (not
        // just the part that changed) plus every other field — a
        // few-hundred-line real-world query can need many thousands of
        // output tokens on its own. Too low a cap here doesn't error
        // cleanly, it truncates mid-JSON, which then fails validation
        // with a confusing "missing field" error instead — see the
        // stop_reason check below for surfacing that clearly when it
        // still happens even at this size.
        max_tokens: 16384,
        messages: [{ role: 'user', content: promptText }],
        tools: [{ name: toolName, description: 'Submit the source-swap query rewrite.', input_schema: AI_RESPONSE_SCHEMA }],
        tool_choice: { type: 'tool', name: toolName },
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Claude API error ${res.status}: ${body.slice(0, 500)}`);
    }

    const data = await res.json();
    const toolBlock = Array.isArray(data.content) && data.content.find(b => b.type === 'tool_use' && b.name === toolName);
    if (!toolBlock) {
      if (data.stop_reason === 'max_tokens') {
        throw new Error('Claude cut its response off before finishing (hit the output token limit) — this can happen with a very large query. Try again, or try a different model.');
      }
      throw new Error('Claude response did not contain the expected tool_use block.');
    }

    try {
      validateAiResponseShape(toolBlock.input);
    } catch (err) {
      if (data.stop_reason === 'max_tokens') {
        throw new Error(`Claude's response was cut off before finishing (hit the output token limit), so the rewrite is incomplete: ${err.message}`);
      }
      throw err;
    }
    return toolBlock.input;
  }
}

/* ═════════════════════════════════════════════════════════════
   FACTORY
   ═════════════════════════════════════════════════════════════ */

const PROVIDERS = {
  gemini: { label: 'Google Gemini', ctor: GeminiProvider, defaultModel: 'gemini-3.6-flash' },
  claude: { label: 'Anthropic Claude', ctor: ClaudeProvider, defaultModel: 'claude-sonnet-5' },
};

/**
 * createProvider
 * @param {'gemini'|'claude'} name
 * @param {string} apiKey
 * @param {string} [model] - falls back to the provider's default if omitted
 * @returns {{ rewriteQuery: (payload: object) => Promise<object> }}
 */
function createProvider(name, apiKey, model) {
  const entry = PROVIDERS[name];
  if (!entry) throw new Error(`Unknown AI provider "${name}".`);
  if (!apiKey || !apiKey.trim()) throw new Error('An API key is required.');
  return new entry.ctor(apiKey.trim(), model && model.trim() ? model.trim() : undefined);
}

/**
 * SharedProvider
 * Client-side counterpart to api/rewrite.js: sends the SAME payload shape
 * the direct providers build a prompt from, but to this app's own Vercel
 * endpoint with a shared team PASSWORD instead of a personal API key —
 * the endpoint holds the real key server-side and never returns it (see
 * that file's header for the full picture). Only works once deployed
 * somewhere that endpoint actually exists (Vercel, or `vercel dev`
 * locally) — plain static hosting (e.g. `npx serve .`) has no /api route
 * to call, so this will fail there with a 404.
 */
class SharedProvider {
  constructor(password, underlyingProvider, model) {
    this.password = password;
    this.underlyingProvider = underlyingProvider; // 'gemini' | 'claude' — which server-side key the endpoint should use
    this.model = model;
  }

  async rewriteQuery(payload) {
    const res = await fetchWithRetry('/api/rewrite', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        password: this.password,
        provider: this.underlyingProvider,
        model: this.model,
        payload,
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `Shared-access request failed (${res.status}).`);
    }

    validateAiResponseShape(data);
    return data;
  }
}

/**
 * createSharedProvider
 * @param {string} password
 * @param {'gemini'|'claude'} underlyingProvider
 * @param {string} [model]
 * @returns {{ rewriteQuery: (payload: object) => Promise<object> }}
 */
function createSharedProvider(password, underlyingProvider, model) {
  if (!password || !password.trim()) throw new Error('The team password is required.');
  if (!PROVIDERS[underlyingProvider]) throw new Error(`Unknown AI provider "${underlyingProvider}".`);
  return new SharedProvider(password.trim(), underlyingProvider, model && model.trim() ? model.trim() : undefined);
}

const AIProviders = { createProvider, createSharedProvider, PROVIDERS, AI_RESPONSE_SCHEMA, buildPromptText };

// Dual-mode export: loaded via <script> in the browser (defines
// window.AIProviders, unchanged from before), OR required() from a Vercel
// serverless function (api/rewrite.js) that reuses this exact same
// prompt-building + fetch-and-parse logic server-side, just with a
// server-held key instead of a user-typed one — see that file's header
// for why. `window`/`module` are checked rather than assumed so the same
// file works in both places without edits.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AIProviders;
} else {
  window.AIProviders = AIProviders;
}
