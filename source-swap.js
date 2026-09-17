/**
 * source-swap.js — SQL-Vis "technical debt automation" module (Phase 1-4)
 * ─────────────────────────────────────────────────────────────
 *   Phase 1: source targeting — opening this page from a physical-table
 *   node click in the ERD (see script.js's showSourceSwapPrompt), with the
 *   target source pre-filled.
 *
 *   Phase 2: sample data upload — CSV/TSV parsing, a representative-subset
 *   sampler (bounded, so we never ship 10,000 raw rows to an LLM),
 *   best-effort numeric-column detection, and a preview table.
 *
 *   Phase 3: AI provider adapter (ai-providers.js) — send the query +
 *   samples + the AST-extracted filter/numeric-column context to the
 *   user's chosen provider, get back a rewritten query + column mapping.
 *
 *   Phase 4: comparison-query-generator.js turns the AI's mapping into a
 *   ready-to-run Snowflake validation query (row count + SUM per numeric
 *   column, old source vs. new).
 *
 * This file owns DOM wiring + orchestration only — the actual AI transport
 * lives in ai-providers.js and the actual query-building logic lives in
 * comparison-query-generator.js, both pure and independently testable.
 * Coupling with script.js stays one-directional: script.js calls
 * `window.SourceSwap.open(tableName, queryContext)`; nothing here reaches
 * back into script.js's parser/graph model.
 * ─────────────────────────────────────────────────────────────
 */

/* ═════════════════════════════════════════════════════════════
   MODULE A — DELIMITED-TEXT (CSV/TSV) PARSER
   A small hand-written state machine rather than a naive `line.split(',')`
   — naive splitting breaks the moment a field contains a quoted comma,
   an embedded newline, or an escaped quote ("" inside a quoted field),
   all of which are common in real warehouse exports.
   ═════════════════════════════════════════════════════════════ */

/**
 * detectDelimiter
 * Uses the file extension when available, otherwise sniffs the first
 * line by comparing tab vs. comma counts (outside quotes).
 * @param {string} fileName
 * @param {string} sampleText - first ~2KB is enough to sniff from
 * @returns {','|'\t'}
 */
function detectDelimiter(fileName, sampleText) {
  const lower = (fileName || '').toLowerCase();
  if (lower.endsWith('.tsv')) return '\t';
  if (lower.endsWith('.csv')) return ',';

  const firstLine = sampleText.slice(0, 2000).split(/\r?\n/)[0] || '';
  const tabCount = (firstLine.match(/\t/g) || []).length;
  const commaCount = (firstLine.match(/,/g) || []).length;
  return tabCount > commaCount ? '\t' : ',';
}

/**
 * parseDelimitedText
 * RFC4180-ish parser: handles quoted fields, embedded delimiters/newlines
 * inside quotes, and doubled-quote escaping (`""` -> `"`).
 *
 * @param {string} text
 * @param {string} delimiter - ',' or '\t'
 * @returns {{ columns: string[], rows: string[][] }}
 */
function parseDelimitedText(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };

  while (i < len) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; } // escaped quote
        inQuotes = false; i += 1; continue;
      }
      field += ch; i += 1; continue;
    }

    if (ch === '"') { inQuotes = true; i += 1; continue; }
    if (ch === delimiter) { pushField(); i += 1; continue; }
    if (ch === '\r') { i += 1; continue; } // normalize CRLF -> LF
    if (ch === '\n') { pushRow(); i += 1; continue; }
    field += ch; i += 1;
  }
  // Trailing field/row (files don't always end with a newline)
  if (field.length > 0 || row.length > 0) pushRow();

  // Drop fully-empty trailing rows (common with a trailing blank line)
  while (rows.length && rows[rows.length - 1].every(v => v === '')) rows.pop();

  if (rows.length === 0) return { columns: [], rows: [] };
  const [columns, ...dataRows] = rows;
  return { columns, rows: dataRows };
}

/* ═════════════════════════════════════════════════════════════
   MODULE B — REPRESENTATIVE SAMPLING
   The user may upload up to ~10,000 rows (good — more rows means more
   reliable column-type detection), but the AI request should only ever
   carry a small, bounded subset: detecting a column-structure difference
   needs variety, not volume, and shipping thousands of rows into a
   prompt wastes tokens/cost without adding real signal (row-count and
   sum-level validation happens separately, via the generated comparison
   query run directly in Snowflake against the FULL data).
   ═════════════════════════════════════════════════════════════ */

const MAX_ROWS_SENT_TO_AI = 30;

/**
 * selectRepresentativeSample
 * Deliberately seeks out rows that showcase each column's edge cases
 * (nulls/empties) rather than just taking the first N — a plain "first N
 * rows" sample can accidentally look fully populated when a column is
 * actually nullable, which would mislead the numeric/type heuristic.
 *
 * Strategy: first few + last few (bookend context) + one row per column
 * that has a blank in that column (nullability signal) + an evenly
 * spaced stride across the rest to keep overall variety, de-duplicated
 * and capped at maxRows.
 *
 * @param {string[][]} rows
 * @param {number} maxRows
 * @returns {string[][]}
 */
function selectRepresentativeSample(rows, maxRows = MAX_ROWS_SENT_TO_AI) {
  if (rows.length <= maxRows) return rows;

  const chosenIdx = new Set();
  const HEAD = Math.min(8, Math.ceil(maxRows * 0.3));
  const TAIL = Math.min(4, Math.ceil(maxRows * 0.15));

  for (let i = 0; i < HEAD; i++) chosenIdx.add(i);
  for (let i = rows.length - TAIL; i < rows.length; i++) if (i >= 0) chosenIdx.add(i);

  // One row per column that demonstrates a blank/null value, budget-capped.
  const columnCount = rows[0] ? rows[0].length : 0;
  const nullBudget = Math.max(0, maxRows - chosenIdx.size - 4); // keep room for the stride fill below
  let nullsFound = 0;
  outer:
  for (let col = 0; col < columnCount; col++) {
    for (let r = 0; r < rows.length; r++) {
      if (chosenIdx.has(r)) continue;
      if ((rows[r][col] ?? '').trim() === '') {
        chosenIdx.add(r);
        nullsFound += 1;
        break;
      }
      if (nullsFound >= nullBudget) break outer;
    }
  }

  // Fill remaining budget with an even stride across the full set for
  // general variety (formats, magnitudes, distinct categorical values).
  const remaining = maxRows - chosenIdx.size;
  if (remaining > 0) {
    const stride = Math.max(1, Math.floor(rows.length / remaining));
    for (let i = 0; i < rows.length && chosenIdx.size < maxRows; i += stride) {
      chosenIdx.add(i);
    }
  }

  return [...chosenIdx].sort((a, b) => a - b).slice(0, maxRows).map(i => rows[i]);
}

/* ═════════════════════════════════════════════════════════════
   MODULE C — COLUMN TYPE INFERENCE
   Best-effort, from sample VALUES (not from an AST/schema — a CSV has no
   type information of its own). This only needs to be good enough to (a)
   show the user a helpful preview and (b) later scope which columns the
   comparison-query generator treats as summable metrics; it is not a
   claim of ground truth, and the preview always shows its work.
   ═════════════════════════════════════════════════════════════ */

// Strict numeric literal: optional sign, digits, optional decimal part,
// optional exponent. Deliberately stricter than `Number(x)` — that would
// also accept things like "" (=> 0), "  12  ", or "0x1F", which we don't
// want silently treated as numeric.
const NUMERIC_RE = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

/**
 * looksNumeric
 * @param {string} value
 * @returns {boolean}
 */
function looksNumeric(value) {
  if (!NUMERIC_RE.test(value)) return false;
  // Leading-zero heuristic: "007" reads as a code/ID, not a measure —
  // "0" and "0.5" are still fine (the zero isn't "leading" in those).
  const intPart = value.replace('-', '').split('.')[0];
  if (intPart.length > 1 && intPart[0] === '0') return false;
  return true;
}

/**
 * inferColumnTypes
 * @param {string[]} columns
 * @param {string[][]} rows - the FULL uploaded set (not just the AI sample)
 *                            so the null-rate/type read is as informed as
 *                            possible.
 * @returns {Array<{ name: string, type: 'numeric'|'text'|'unknown', nullCount: number, sampleValue: string }>}
 */
function inferColumnTypes(columns, rows) {
  return columns.map((name, colIdx) => {
    let nullCount = 0;
    let numericCount = 0;
    let nonEmptyCount = 0;
    let sampleValue = '';

    for (const row of rows) {
      const raw = (row[colIdx] ?? '').trim();
      if (raw === '') { nullCount += 1; continue; }
      nonEmptyCount += 1;
      if (!sampleValue) sampleValue = raw;
      if (looksNumeric(raw)) numericCount += 1;
    }

    let type = 'unknown';
    if (nonEmptyCount > 0) type = (numericCount === nonEmptyCount) ? 'numeric' : 'text';

    return { name, type, nullCount, sampleValue };
  });
}

/* ═════════════════════════════════════════════════════════════
   MODULE D — PAGE STATE + DOM WIRING
   ═════════════════════════════════════════════════════════════ */

const state = {
  targetTableName: '',
  old: null, // { fileName, columns, allRows, sampleRows, columnTypes }
  new: null, // same shape
  queryContext: null, // { formattedSql, dialect, usageContext } — passed in from script.js's open()
};

// DOM refs — resolved lazily (this script loads after script.js but the
// elements it needs live in index.html regardless of load order; grabbing
// them at call-time rather than at parse-time avoids any ordering
// assumption between the two scripts).
function els() {
  return {
    appMain: document.querySelector('.app-main'),
    page: document.getElementById('view-source-swap'),
    backBtn: document.getElementById('source-swap-back'),
    targetNameLabel: document.getElementById('source-swap-target-name'),
    cteHintEl: document.getElementById('source-swap-cte-hint'),
    columnsRow: document.getElementById('source-swap-columns-row'),
    columnsToAdjustInput: document.getElementById('source-swap-columns-to-adjust'),
    oldNameLabelEl: document.getElementById('source-swap-old-name-label'),
    oldSampleLabelEl: document.getElementById('source-swap-old-sample-label'),
    cteTestTableRequiredEl: document.getElementById('source-swap-cte-test-table-required'),
    oldNameInput: document.getElementById('source-swap-old-name'),
    newNameInput: document.getElementById('source-swap-new-name'),
    oldFileInput: document.getElementById('source-swap-old-file'),
    newFileInput: document.getElementById('source-swap-new-file'),
    oldDropzone: document.getElementById('source-swap-old-dropzone'),
    newDropzone: document.getElementById('source-swap-new-dropzone'),
    oldPreview: document.getElementById('source-swap-old-preview'),
    newPreview: document.getElementById('source-swap-new-preview'),
    providerSelect: document.getElementById('source-swap-provider'),
    modelInput: document.getElementById('source-swap-model'),
    useSharedCheckbox: document.getElementById('source-swap-use-shared'),
    apiKeyLabelEl: document.getElementById('source-swap-api-key-label'),
    keyHintEl: document.getElementById('source-swap-key-hint'),
    sharedHintEl: document.getElementById('source-swap-shared-hint'),
    apiKeyInput: document.getElementById('source-swap-api-key'),
    generateBtn: document.getElementById('source-swap-generate'),
    generateStatus: document.getElementById('source-swap-generate-status'),
    oldTestTableInput: document.getElementById('source-swap-old-test-table'),
    newTestTableInput: document.getElementById('source-swap-new-test-table'),
    resultsSection: document.getElementById('source-swap-results'),
    rewrittenQueryEl: document.getElementById('source-swap-rewritten-query'),
    playgroundResultsEl: document.getElementById('source-swap-playground-results'),
    oldTestTableSqlEl: document.getElementById('source-swap-old-test-table-sql'),
    newTestTableSqlEl: document.getElementById('source-swap-new-test-table-sql'),
    aiNotesEl: document.getElementById('source-swap-ai-notes'),
    comparisonQueryLabelEl: document.getElementById('source-swap-comparison-query-label'),
    comparisonQueryEl: document.getElementById('source-swap-comparison-query'),
  };
}

function escapeHtmlLocal(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * renderPreview
 * Shows row-count context (uploaded vs. sent-to-AI), then a scrollable
 * table of the SAMPLED rows with an inferred-type badge per column.
 * @param {HTMLElement} container
 * @param {{fileName, columns, allRows, sampleRows, columnTypes}} parsed
 */
function renderPreview(container, parsed) {
  const { fileName, columns, allRows, sampleRows, columnTypes } = parsed;
  const typeByName = new Map(columnTypes.map(c => [c.name, c]));

  const metaLine = `<div class="source-swap-preview__meta">
    <strong>${escapeHtmlLocal(fileName)}</strong> — ${allRows.length.toLocaleString()} rows uploaded,
    ${sampleRows.length.toLocaleString()} sent to AI for structure detection
  </div>`;

  const headerCells = columns.map(name => {
    const t = typeByName.get(name);
    const typeClass = t.type === 'numeric' ? 'col-type--numeric' : (t.type === 'text' ? 'col-type--text' : '');
    return `<th>${escapeHtmlLocal(name)}<span class="col-type ${typeClass}">${t.type}</span></th>`;
  }).join('');

  const bodyRows = sampleRows.slice(0, 12).map(row =>
    `<tr>${row.map(v => `<td>${escapeHtmlLocal(v === '' ? '∅' : v)}</td>`).join('')}</tr>`
  ).join('');

  container.innerHTML = `
    ${metaLine}
    <div class="source-swap-preview-table-wrap">
      <table class="source-swap-preview-table">
        <thead><tr>${headerCells}</tr></thead>
        <tbody>${bodyRows}</tbody>
      </table>
    </div>
  `;
  container.hidden = false;
}

function renderPreviewError(container, message) {
  container.innerHTML = `<div class="source-swap-preview-error">${escapeHtmlLocal(message)}</div>`;
  container.hidden = false;
}

/**
 * handleFile
 * Reads, parses, samples, and infers types for one uploaded file, then
 * stores the result in `state` and renders its preview.
 * @param {File} file
 * @param {'old'|'new'} which
 */
function handleFile(file, which) {
  const { oldDropzone, newDropzone, oldPreview, newPreview } = els();
  const dropzone = which === 'old' ? oldDropzone : newDropzone;
  const previewEl = which === 'old' ? oldPreview : newPreview;

  const reader = new FileReader();
  reader.onload = () => {
    try {
      const text = String(reader.result);
      const delimiter = detectDelimiter(file.name, text);
      const { columns, rows } = parseDelimitedText(text, delimiter);

      if (columns.length === 0 || rows.length === 0) {
        throw new Error('No data rows found — is this file empty, or using a delimiter other than comma/tab?');
      }

      const sampleRows = selectRepresentativeSample(rows, MAX_ROWS_SENT_TO_AI);
      const columnTypes = inferColumnTypes(columns, rows);

      state[which] = { fileName: file.name, columns, allRows: rows, sampleRows, columnTypes };

      dropzone.classList.add('has-file');
      dropzone.querySelector('span').textContent = `${file.name} (${rows.length.toLocaleString()} rows) — click to replace`;
      renderPreview(previewEl, state[which]);
    } catch (err) {
      state[which] = null;
      renderPreviewError(previewEl, `Could not read this file: ${err.message}`);
    }
    updateGenerateReadiness();
  };
  reader.onerror = () => {
    state[which] = null;
    renderPreviewError(previewEl, 'Could not read this file (browser file-read error).');
    updateGenerateReadiness();
  };
  reader.readAsText(file);
}

/**
 * updateGenerateReadiness
 * The Generate button needs the NEW sample uploaded AND a new-source name
 * typed in. The OLD sample is normally required too — except in CTE-target
 * mode (see state.queryContext.isCte), where the CTE's own body is already
 * the old-side ground truth and an old sample is just optional extra
 * context. API key/provider are validated at click-time instead (so the
 * button doesn't flicker enabled/disabled while the user is mid-paste of a
 * key), with the error surfaced in generateStatus.
 */
function updateGenerateReadiness() {
  const { generateBtn, newNameInput } = els();
  const isCte = Boolean(state.queryContext && state.queryContext.isCte);
  const oldReady = isCte || Boolean(state.old);
  generateBtn.disabled = !(oldReady && state.new && newNameInput.value.trim());
}

function wireDropzone(dropzoneEl, fileInputEl, which) {
  dropzoneEl.addEventListener('click', () => fileInputEl.click());
  fileInputEl.addEventListener('change', () => {
    if (fileInputEl.files[0]) handleFile(fileInputEl.files[0], which);
  });
  dropzoneEl.addEventListener('dragover', evt => { evt.preventDefault(); dropzoneEl.classList.add('drag-over'); });
  dropzoneEl.addEventListener('dragleave', () => dropzoneEl.classList.remove('drag-over'));
  dropzoneEl.addEventListener('drop', evt => {
    evt.preventDefault();
    dropzoneEl.classList.remove('drag-over');
    const file = evt.dataTransfer.files[0];
    if (file) handleFile(file, which);
  });
}

/* ═════════════════════════════════════════════════════════════
   MODULE D — AI GENERATE + RESULTS (Phase 3 + 4)
   Orchestration only: builds the payload ai-providers.js needs, hands the
   response to comparison-query-generator.js, and renders both outputs.
   Neither of those modules touches the DOM themselves — kept that way so
   they stay unit-testable outside a browser.
   ═════════════════════════════════════════════════════════════ */

/**
 * showGenerateStatus
 * @param {string} message
 * @param {'loading'|'error'|'success'} kind
 */
function showGenerateStatus(message, kind) {
  const { generateStatus } = els();
  generateStatus.textContent = message;
  generateStatus.className = `source-swap-status source-swap-status--${kind}`;
  generateStatus.hidden = false;
}

/**
 * renderResults
 * @param {object} aiResult - ai-providers.js rewriteQuery() result
 * @param {string} comparisonQuery - comparison-query-generator.js output
 */
/**
 * renderResults
 * @param {object} aiResult - ai-providers.js rewriteQuery() result
 * @param {string} comparisonQuery
 * @param {{oldSql: string, newSql: string}|null} playgroundTables - present
 *   only in playground-table mode (see handleGenerateClick) — the two
 *   generated "CREATE OR REPLACE TABLE" statements to show alongside the
 *   comparison query.
 */
function renderResults(aiResult, comparisonQuery, playgroundTables) {
  const {
    resultsSection, rewrittenQueryEl, aiNotesEl, comparisonQueryEl,
    playgroundResultsEl, oldTestTableSqlEl, newTestTableSqlEl, comparisonQueryLabelEl,
  } = els();

  rewrittenQueryEl.textContent = aiResult.rewrittenQuery;
  comparisonQueryEl.textContent = comparisonQuery;

  if (playgroundTables) {
    oldTestTableSqlEl.textContent = playgroundTables.oldSql;
    newTestTableSqlEl.textContent = playgroundTables.newSql;
    playgroundResultsEl.hidden = false;
    comparisonQueryLabelEl.textContent = 'Validation query — full-pipeline output comparison between the two test tables above, run this in Snowflake';
  } else {
    playgroundResultsEl.hidden = true;
    comparisonQueryLabelEl.textContent = 'Validation query — row count & SUM comparison, run this in Snowflake';
  }

  const groups = [];
  if (aiResult.columnMappings && aiResult.columnMappings.length) {
    groups.push(`<div class="source-swap-ai-notes__group">
      <h3>Column mapping</h3>
      <ul>${aiResult.columnMappings.map(m =>
        `<li><code>${escapeHtmlLocal(m.oldColumn)}</code> → <code>${escapeHtmlLocal(m.newColumn ?? '(dropped)')}</code>${m.note ? ` — ${escapeHtmlLocal(m.note)}` : ''}</li>`
      ).join('')}</ul>
    </div>`);
  }
  if (aiResult.addedFilters && aiResult.addedFilters.length) {
    groups.push(`<div class="source-swap-ai-notes__group">
      <h3>Filters added for the new source</h3>
      <ul>${aiResult.addedFilters.map(f => `<li>${escapeHtmlLocal(f)}</li>`).join('')}</ul>
    </div>`);
  }
  if (aiResult.warnings && aiResult.warnings.length) {
    groups.push(`<div class="source-swap-ai-notes__group source-swap-ai-notes__group--warning">
      <h3>Worth double-checking</h3>
      <ul>${aiResult.warnings.map(w => `<li>${escapeHtmlLocal(w)}</li>`).join('')}</ul>
    </div>`);
  }
  aiNotesEl.innerHTML = groups.join('');

  resultsSection.hidden = false;
  resultsSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/**
 * handleGenerateClick
 * Validates inputs synchronously (provider/key/original-query presence)
 * before making any network call, then: AI rewrite → comparison query →
 * render. Both failure paths (bad key, network error, malformed AI
 * response) land in the same status line rather than throwing to the
 * console silently, since this is the one action in the whole workflow
 * that can fail for reasons entirely outside SQL-Vis's control.
 */
async function handleGenerateClick() {
  const {
    providerSelect, modelInput, apiKeyInput, useSharedCheckbox, newNameInput, oldNameInput, generateBtn, resultsSection,
    oldTestTableInput, newTestTableInput, columnsToAdjustInput,
  } = els();

  let provider;
  try {
    // Shared mode: apiKeyInput actually holds the team PASSWORD (see
    // applySharedModeUI) — createSharedProvider routes through
    // api/rewrite.js instead of calling the AI provider directly.
    provider = useSharedCheckbox.checked
      ? window.AIProviders.createSharedProvider(apiKeyInput.value, providerSelect.value, modelInput.value)
      : window.AIProviders.createProvider(providerSelect.value, apiKeyInput.value, modelInput.value);
  } catch (err) {
    showGenerateStatus(err.message, 'error');
    return;
  }

  const queryContext = state.queryContext || {};
  if (!queryContext.formattedSql) {
    showGenerateStatus('No original query found for this table — open this page via "Edit source →" from a visualized query, not standalone.', 'error');
    return;
  }

  const oldSourceName = oldNameInput.value.trim();
  const newSourceName = newNameInput.value.trim();
  const usageContext = queryContext.usageContext || null;
  const isCte = Boolean(queryContext.isCte);

  const oldTestTable = oldTestTableInput.value.trim();
  const newTestTable = newTestTableInput.value.trim();

  // CTE-target mode has no single physical "old source" to diff raw — a
  // CTE can't be queried standalone the way a table can — so playground
  // test tables aren't optional here the way they are for a table target.
  if (isCte && !(oldTestTable && newTestTable)) {
    showGenerateStatus('This is a CTE target — name both test tables in section 4 before generating (the raw-source comparison isn\'t available for a CTE).', 'error');
    return;
  }

  generateBtn.disabled = true;
  resultsSection.hidden = true;
  showGenerateStatus(`Calling ${providerSelect.options[providerSelect.selectedIndex].text}… this can take up to a minute.`, 'loading');

  try {
    const oldSamplePayload = state.old ? { fileName: state.old.fileName, columns: state.old.columns, sampleRows: state.old.sampleRows } : null;
    const newSamplePayload = { fileName: state.new.fileName, columns: state.new.columns, sampleRows: state.new.sampleRows };

    // Non-empty -> "augment" mode: ADD the new source via LEFT JOIN and
    // move only these columns to it, leaving the rest of the CTE (and its
    // original source) untouched. Empty -> the original "full replace"
    // framing, unchanged.
    const columnsToAdjust = columnsToAdjustInput.value.split(',').map(s => s.trim()).filter(Boolean);

    const aiResult = await provider.rewriteQuery(isCte ? {
      cteTarget: true,
      originalQuery: queryContext.formattedSql,
      dialect: queryContext.dialect || 'ansi',
      cteName: oldSourceName,
      cteBody: queryContext.cteBody,
      newSourceName,
      columnsToAdjust,
      oldSample: oldSamplePayload,
      newSample: newSamplePayload,
    } : {
      originalQuery: queryContext.formattedSql,
      dialect: queryContext.dialect || 'ansi',
      targetTable: { oldName: oldSourceName, newName: newSourceName },
      oldSample: oldSamplePayload,
      newSample: newSamplePayload,
      extractedContext: usageContext,
    });

    // Playground-table mode: both test-table names given -> materialize
    // the ORIGINAL and REWRITTEN queries as two full tables and diff THEIR
    // output (covers every join/CASE/COALESCE in the pipeline, not just
    // the swapped source) — required in CTE mode (validated above), and
    // optional in table mode (leave either blank there to fall back to
    // the raw-source comparison, diffing old/new SOURCE tables directly).
    const usePlaygroundMode = Boolean(oldTestTable && newTestTable);

    let comparisonQuery, playgroundTables;
    if (usePlaygroundMode) {
      playgroundTables = {
        oldSql: window.ComparisonQueryGenerator.wrapAsPlaygroundTable(queryContext.formattedSql, oldTestTable),
        newSql: window.ComparisonQueryGenerator.wrapAsPlaygroundTable(aiResult.rewrittenQuery, newTestTable),
      };
      comparisonQuery = window.ComparisonQueryGenerator.buildPlaygroundComparisonQuery({
        oldTestTable,
        newTestTable,
        numericColumns: aiResult.finalOutputNumericColumns,
      });
    } else {
      playgroundTables = null;
      comparisonQuery = window.ComparisonQueryGenerator.generateComparisonQuery({
        oldSource: oldSourceName,
        newSource: newSourceName,
        usageContext,
        oldColumnTypes: state.old.columnTypes,
        aiResult,
      });
    }

    renderResults(aiResult, comparisonQuery, playgroundTables);
    showGenerateStatus('Done — review the rewritten query and warnings below before running anything.', 'success');
  } catch (err) {
    console.error('[SQL-Vis] source-swap generate failed', err);
    showGenerateStatus(`Could not generate a rewrite: ${err.message}`, 'error');
  } finally {
    updateGenerateReadiness();
  }
}

/**
 * wireCopyButtons
 * One delegated listener on document rather than one per button — both
 * copy buttons are static markup in index.html, so this isn't strictly
 * necessary yet, but it means a future result block can be added without
 * remembering to wire its copy button separately.
 */
function wireCopyButtons() {
  document.addEventListener('click', evt => {
    const btn = evt.target.closest('[data-copy-target]');
    if (!btn) return;
    const target = document.getElementById(btn.dataset.copyTarget);
    if (!target) return;
    navigator.clipboard.writeText(target.textContent).then(() => {
      const original = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = original; }, 1500);
    }).catch(err => console.warn('[SQL-Vis] Copy to clipboard failed', err));
  });
}

/**
 * open
 * Public entry point, called from script.js when the user clicks
 * "Edit source →" on a physical table node.
 * @param {string} tableName
 * @param {{formattedSql: string, dialect: string, usageContext: object|null}} [queryContext]
 *   `usageContext` is script.js's extractTargetUsageContext() result — the
 *   alias-scoped WHERE filter and raw numeric-column candidates pulled
 *   directly from the original query's AST. May be null (e.g. the ERD is
 *   opened standalone, or extraction hit an unrecognized AST shape); every
 *   downstream consumer must degrade gracefully rather than assume it's set.
 */
function open(tableName, queryContext) {
  const { appMain, page, oldNameInput, newNameInput, targetNameLabel,
          oldFileInput, newFileInput, oldDropzone, newDropzone, oldPreview, newPreview,
          providerSelect, useSharedCheckbox, resultsSection, generateStatus,
          oldTestTableInput, newTestTableInput,
          cteHintEl, columnsRow, columnsToAdjustInput,
          oldNameLabelEl, oldSampleLabelEl, cteTestTableRequiredEl } = els();

  state.targetTableName = tableName;
  state.old = null;
  state.new = null;
  state.queryContext = queryContext || null;

  const isCte = Boolean(queryContext && queryContext.isCte);
  cteHintEl.hidden = !isCte;
  columnsRow.hidden = !isCte;
  columnsToAdjustInput.value = '';
  cteTestTableRequiredEl.hidden = !isCte;
  oldNameLabelEl.textContent = isCte ? 'CTE to replace' : 'Table to replace';
  oldSampleLabelEl.textContent = isCte ? 'Sample from OLD source (optional)' : 'Sample from OLD table';

  targetNameLabel.textContent = tableName;
  oldNameInput.value = tableName;
  newNameInput.value = '';
  oldFileInput.value = '';
  newFileInput.value = '';
  oldDropzone.classList.remove('has-file');
  newDropzone.classList.remove('has-file');
  oldDropzone.querySelector('span').textContent = 'Click or drop a .csv/.tsv file';
  newDropzone.querySelector('span').textContent = 'Click or drop a .csv/.tsv file';
  oldPreview.hidden = true;
  newPreview.hidden = true;
  oldTestTableInput.value = '';
  newTestTableInput.value = '';

  // Optional local-dev convenience — .env (only loads when served over
  // http(s), see loadDotEnvConfig) wins if it loaded; config.local.js is
  // the fallback that works even when opened via file://. Never
  // auto-submitted; just saves re-pasting the same key every reload.
  // Switching the Provider dropdown afterward re-applies this per-provider
  // (see applyProviderPrefill), so both providers can be pre-filled at once.
  const localConfig = envConfig || window.SQLVIS_LOCAL_CONFIG;
  if (localConfig && localConfig.defaultProvider) providerSelect.value = localConfig.defaultProvider;
  useSharedCheckbox.checked = false; // always starts unchecked — an explicit opt-in each time, not remembered
  applySharedModeUI();
  applyProviderPrefill();

  resultsSection.hidden = true;
  generateStatus.hidden = true;
  updateGenerateReadiness();

  appMain.hidden = true;
  page.hidden = false;
}

/** Returns to the ERD/editor view. */
function close() {
  const { appMain, page } = els();
  page.hidden = true;
  appMain.hidden = false;
}

/* ═════════════════════════════════════════════════════════════
   MODULE (local-dev only) — .env LOADER
   Best-effort: fetch('.env') only succeeds when SQL-Vis is served over
   http(s) — a local static server, or once deployed to Vercel. Browsers
   block fetch() of local files when a page is opened via file://, which is
   how this app is most often run day-to-day, so this is expected to
   silently fail there — config.local.js (see its own header) is the
   fallback for exactly that case; open() below prefers whichever loaded.
   ═════════════════════════════════════════════════════════════ */
let envConfig = null; // populated by loadDotEnvConfig() if/when it succeeds

/**
 * parseDotEnv
 * Minimal KEY=VALUE parser: skips blank lines and "#" comments, strips one
 * layer of surrounding quotes. Deliberately not a full dotenv
 * implementation (no multi-line values, no variable expansion, no export
 * prefix) — the only consumer is the fixed handful of keys read below.
 * @param {string} text
 * @returns {Record<string,string>}
 */
function parseDotEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

async function loadDotEnvConfig() {
  try {
    const res = await fetch('.env', { cache: 'no-store' });
    if (!res.ok) return; // no .env present — not an error, just nothing to load
    const vars = parseDotEnv(await res.text());
    // BOTH providers' key/model are captured here, regardless of
    // AI_PROVIDER — that setting only picks which one the dropdown starts
    // on. Capturing only the "active" one was the bug: switching the
    // dropdown to the other provider had nothing to pull in, leaving its
    // fields blank even when that provider's key WAS filled in .env.
    envConfig = {
      defaultProvider: vars.AI_PROVIDER || 'gemini',
      gemini: { model: vars.GEMINI_MODEL || '', apiKey: vars.GEMINI_API_KEY || '' },
      claude: { model: vars.CLAUDE_MODEL || '', apiKey: vars.CLAUDE_API_KEY || '' },
    };
  } catch (err) {
    // Expected and harmless when opened via file:// (browsers block this
    // fetch there) or when .env doesn't exist — config.local.js remains
    // the fallback, see open()'s use of envConfig below.
    console.info('[SQL-Vis] .env not loaded — normal when opening index.html directly via file:// (see config.local.js instead):', err.message);
  }
}

/**
 * applyProviderPrefill
 * Sets modelInput/apiKeyInput from whichever local config (.env, or
 * config.local.js as the file:// fallback) has data for the CURRENTLY
 * selected provider. Called once when the page opens and again every time
 * the Provider dropdown changes, so switching providers pulls in that
 * provider's own stored key/model instead of leaving the previous
 * provider's values sitting in the fields — or leaving them blank, which
 * was the bug this fixes.
 */
function applyProviderPrefill() {
  const { providerSelect, modelInput, apiKeyInput, useSharedCheckbox } = els();
  // Shared mode's key field holds a team PASSWORD, not a per-provider API
  // key — prefilling it from .env/config.local.js here would silently
  // overwrite whatever the user just typed with the wrong kind of value.
  if (useSharedCheckbox.checked) return;
  const localConfig = envConfig || window.SQLVIS_LOCAL_CONFIG;
  const providerConfig = localConfig && localConfig[providerSelect.value];
  modelInput.value = (providerConfig && providerConfig.model) || '';
  apiKeyInput.value = (providerConfig && providerConfig.apiKey) || '';
}

/**
 * applySharedModeUI
 * Toggles the API-key field's label/placeholder/hint text between
 * "personal API key" (default — calls the provider directly from this
 * browser) and "team password" (routes through api/rewrite.js instead —
 * see SharedProvider in ai-providers.js) based on the shared-access
 * checkbox.
 */
function applySharedModeUI() {
  const { useSharedCheckbox, apiKeyLabelEl, apiKeyInput, keyHintEl, sharedHintEl } = els();
  const shared = useSharedCheckbox.checked;
  apiKeyLabelEl.textContent = shared ? 'Team password' : 'API key';
  apiKeyInput.placeholder = shared ? 'Paste the shared team password' : 'Paste your API key';
  keyHintEl.hidden = shared;
  sharedHintEl.hidden = !shared;
}

function init() {
  const {
    backBtn, oldDropzone, newDropzone, oldFileInput, newFileInput, newNameInput, generateBtn,
    providerSelect, useSharedCheckbox, apiKeyInput,
  } = els();
  backBtn.addEventListener('click', close);
  wireDropzone(oldDropzone, oldFileInput, 'old');
  wireDropzone(newDropzone, newFileInput, 'new');
  newNameInput.addEventListener('input', updateGenerateReadiness);
  generateBtn.addEventListener('click', handleGenerateClick);
  providerSelect.addEventListener('change', applyProviderPrefill);
  useSharedCheckbox.addEventListener('change', () => {
    applySharedModeUI();
    apiKeyInput.value = ''; // switching modes: a value that meant "API key" doesn't mean "password", and vice versa
  });
  wireCopyButtons();
  loadDotEnvConfig(); // fire-and-forget — open() reads envConfig whenever it resolves
}

init();

// Public surface consumed by script.js — see showSourceSwapPrompt().
window.SourceSwap = { open, close };
