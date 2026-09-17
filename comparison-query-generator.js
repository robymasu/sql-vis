/**
 * comparison-query-generator.js — SQL-Vis "technical debt automation" module (Phase 4)
 * ─────────────────────────────────────────────────────────────
 * Pure, dependency-free logic: given (a) the numeric columns the original
 * query actually reads off the target source, (b) the AI's rename mapping
 * for those columns, and (c) the old/new filter SQL, builds one ready-to-run
 * Snowflake validation query comparing COUNT(*) and SUM(...) per numeric
 * column between the old and new source.
 *
 * Deliberately NOT AI-driven: which columns are "numeric" is decided here
 * from the original query's own SELECT list + the uploaded sample data's
 * inferred types (both already computed elsewhere — see script.js's
 * extractTargetUsageContext and source-swap.js's inferColumnTypes). The AI
 * is only trusted for the one thing that genuinely needs its judgment: the
 * new-source column name for each of those columns, and the new-source
 * equivalent filter (see ai-providers.js's newNumericColumns/newFilterSql).
 * ─────────────────────────────────────────────────────────────
 */

/**
 * resolveNumericColumnsForComparison
 * Decides the final "numeric columns to SUM()" list for the validation
 * query and pairs each with its new-source name.
 *
 * @param {object|null} usageContext - script.js extractTargetUsageContext() result
 * @param {Array<{name,type,nullCount,sampleValue}>} oldColumnTypes - source-swap.js inferColumnTypes() for the OLD sample
 * @param {Array<{oldColumn:string,newColumn:string|null}>} aiNewNumericColumns - AI's mapping
 * @returns {Array<{oldColumn:string, newColumn:string|null}>}
 */
function resolveNumericColumnsForComparison(usageContext, oldColumnTypes, aiNewNumericColumns) {
  const numericOldNames = new Set(oldColumnTypes.filter(c => c.type === 'numeric').map(c => c.name));

  let candidateOldColumns;
  if (!usageContext || usageContext.selectStar || !usageContext.oldNumericColumnCandidates.length) {
    // No AST-detected candidates (SELECT * scope, or the AST extraction was
    // unavailable for this query) — fall back to every column the OLD
    // sample itself infers as numeric, since we have no narrower signal.
    candidateOldColumns = [...numericOldNames];
  } else {
    // Intersect: a column must be BOTH actually selected off this source in
    // the original query AND numeric per the CSV sample — a selected
    // column that's really a text/code field (e.g. "product_code") must
    // not get SUM()'d just because it appeared in the SELECT list.
    candidateOldColumns = usageContext.oldNumericColumnCandidates.filter(name => numericOldNames.has(name));
  }

  const newNameByOld = new Map((aiNewNumericColumns || []).map(m => [m.oldColumn, m.newColumn]));
  return candidateOldColumns.map(oldColumn => ({
    oldColumn,
    newColumn: newNameByOld.has(oldColumn) ? newNameByOld.get(oldColumn) : null,
  }));
}

/**
 * sqlIdentifier
 * Quotes an identifier only when it isn't already a safe bare identifier —
 * targets Snowflake specifically (per the requested comparison-query
 * template), where double-quoting is always a safe escape hatch for
 * mixed-case names, reserved words, or names carried over verbatim from a
 * CSV header.
 * @param {string} name
 * @returns {string}
 */
function sqlIdentifier(name) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

/**
 * buildComparisonQuery
 * @param {object} args
 * @param {string} args.oldSource - fully qualified old table name
 * @param {string} args.newSource - fully qualified new table name
 * @param {string|null} args.oldFilterSql - already alias-scoped to "src." (see script.js extractTargetUsageContext)
 * @param {string|null} args.newFilterSql - AI-provided equivalent, also "src."-scoped
 * @param {Array<{oldColumn:string,newColumn:string|null}>} args.numericColumns
 * @returns {string} - ready-to-copy Snowflake SQL
 */
function buildComparisonQuery({ oldSource, newSource, oldFilterSql, newFilterSql, numericColumns }) {
  // A column with no new-source equivalent can't be SUM()'d on the new
  // side at all — excluded from both CTEs (not just one), so the union
  // stays aligned 1:1, and called out in a leading comment so the user
  // isn't left wondering why a metric they expected is missing.
  const usable = numericColumns.filter(c => c.newColumn);
  const dropped = numericColumns.filter(c => !c.newColumn);

  function sumBlock(pickColumnName) {
    if (usable.length === 0) return '';
    const lines = usable.map(c =>
      `        SUM(${sqlIdentifier(pickColumnName(c))}) AS ${sqlIdentifier('sum_' + c.oldColumn)}`
    );
    return ',\n' + lines.join(',\n');
  }

  const oldWhere = oldFilterSql ? `\n    WHERE ${oldFilterSql}` : '';
  const newWhere = newFilterSql ? `\n    WHERE ${newFilterSql}` : '';

  const unionLines = usable.map(c => {
    const alias = 'sum_' + c.oldColumn;
    return `    UNION ALL SELECT '${alias.replace(/'/g, "''")}', n.${sqlIdentifier(alias)}, o.${sqlIdentifier(alias)} FROM new_summary n, orig_summary o`;
  }).join('\n');

  const droppedComment = dropped.length
    ? `-- NOTE: ${dropped.length} numeric column(s) detected in the original query have no equivalent on the new source (per the AI's mapping) and are excluded from this validation: ${dropped.map(c => c.oldColumn).join(', ')}\n`
    : '';

  return `${droppedComment}WITH new_summary AS (
    SELECT
        COUNT(*) AS row_count${sumBlock(c => c.newColumn)}
    FROM ${newSource} AS src${newWhere}
),
orig_summary AS (
    SELECT
        COUNT(*) AS row_count${sumBlock(c => c.oldColumn)}
    FROM ${oldSource} AS src${oldWhere}
)
SELECT metric, new_value, original_value
FROM (
    SELECT 'row_count' AS metric, n.row_count AS new_value, o.row_count AS original_value FROM new_summary n, orig_summary o
${unionLines ? unionLines + '\n' : ''});`;
}

/**
 * generateComparisonQuery
 * Top-level entry point wired from source-swap.js after the AI response
 * comes back.
 * @param {object} args
 * @param {string} args.oldSource
 * @param {string} args.newSource
 * @param {object|null} args.usageContext - script.js extractTargetUsageContext() result
 * @param {Array} args.oldColumnTypes - source-swap.js inferColumnTypes() for the OLD sample
 * @param {object} args.aiResult - ai-providers.js rewriteQuery() result
 * @returns {string}
 */
function generateComparisonQuery({ oldSource, newSource, usageContext, oldColumnTypes, aiResult }) {
  const numericColumns = resolveNumericColumnsForComparison(usageContext, oldColumnTypes, aiResult.newNumericColumns);
  return buildComparisonQuery({
    oldSource,
    newSource,
    oldFilterSql: usageContext ? usageContext.oldFilterSql : null,
    newFilterSql: aiResult.newFilterSql,
    numericColumns,
  });
}

/* ═════════════════════════════════════════════════════════════
   PLAYGROUND-TABLE MODE (alternative to the raw-source comparison above)
   Some validation workflows don't diff the raw old/new SOURCE tables —
   they materialize the ORIGINAL query and the AI-REWRITTEN query as two
   full tables in a scratch/playground schema first, then diff THOSE. This
   is a stronger check (it covers every join/CASE/COALESCE in the pipeline,
   not just the swapped source), and it's simpler to generate: since every
   existing "AS <alias>" is preserved unchanged (see ai-providers.js's
   STRICT RULES), both materialized tables share IDENTICAL column names —
   no per-side renaming or filter-translation needed at all.
   ═════════════════════════════════════════════════════════════ */

// Leading comments/whitespace this file's header-matching regexes tolerate
// before the keyword they're actually looking for — real pipelines often
// carry a stray "-- create or replace table ... as" note-to-self comment,
// or similar, before the statement that's actually live.
const LEADING_TRIVIA = '(?:\\s|--[^\\n]*\\n|/\\*[\\s\\S]*?\\*/)*';
const CREATE_TABLE_RE = new RegExp('^(' + LEADING_TRIVIA + 'CREATE\\s+(?:OR\\s+REPLACE\\s+)?TABLE\\s+)([A-Za-z0-9_.$"]+)', 'i');
const INSERT_INTO_RE = new RegExp('^' + LEADING_TRIVIA + 'INSERT\\s+INTO\\s+[A-Za-z0-9_.$"]+\\s*', 'i');

/**
 * wrapAsPlaygroundTable
 * Produces a standalone "CREATE OR REPLACE TABLE <playgroundName> AS (...)"
 * statement, handling three shapes of `sqlText`:
 *   - Already "CREATE [OR REPLACE] TABLE <name> AS/IS ..." — only <name> is
 *     swapped for playgroundName; every other token (including all
 *     original formatting) is left byte-for-byte untouched.
 *   - "INSERT INTO <target> [WITH ...] SELECT ..." — a fresh playground
 *     table can't be the target of an INSERT (it doesn't exist yet), so
 *     the "INSERT INTO <target>" prefix is stripped entirely and what's
 *     left (the WITH/SELECT body) is wrapped as a CREATE TABLE instead.
 *   - Anything else (a bare SELECT/WITH) — wrapped fresh, unchanged.
 *
 * Regex-based, not AST-based, on purpose: this file stays a pure,
 * dependency-free module (no node-sql-parser) — and both CREATE [OR
 * REPLACE] TABLE and INSERT INTO are standard syntax across Snowflake/
 * Postgres/MySQL/SQLite alike, narrow and unambiguous enough for a regex
 * to handle reliably.
 *
 * @param {string} sqlText
 * @param {string} playgroundName
 * @returns {string}
 */
function wrapAsPlaygroundTable(sqlText, playgroundName) {
  const createMatch = CREATE_TABLE_RE.exec(sqlText);
  if (createMatch) {
    return createMatch[1] + playgroundName + sqlText.slice(createMatch[0].length);
  }

  const insertMatch = INSERT_INTO_RE.exec(sqlText);
  const body = insertMatch ? sqlText.slice(insertMatch[0].length) : sqlText;

  const trimmed = body.trim().replace(/;\s*$/, '');
  return `CREATE OR REPLACE TABLE ${playgroundName} AS (\n${trimmed}\n);`;
}

/**
 * buildPlaygroundComparisonQuery
 * @param {object} args
 * @param {string} args.oldTestTable - fully qualified playground table name (materialized original query)
 * @param {string} args.newTestTable - fully qualified playground table name (materialized rewritten query)
 * @param {string[]} args.numericColumns - final-output column aliases (same on both sides — see file header)
 * @returns {string}
 */
function buildPlaygroundComparisonQuery({ oldTestTable, newTestTable, numericColumns }) {
  const cols = numericColumns || [];

  function sumBlock() {
    if (cols.length === 0) return '';
    const lines = cols.map(c => `        SUM(${sqlIdentifier(c)}) AS ${sqlIdentifier('total_' + c.toLowerCase())}`);
    return ',\n' + lines.join(',\n');
  }

  const unionLines = cols.map(c => {
    const alias = 'total_' + c.toLowerCase();
    return `    UNION ALL SELECT '${alias.replace(/'/g, "''")}', n.${sqlIdentifier(alias)}, o.${sqlIdentifier(alias)} FROM new_summary n, orig_summary o`;
  }).join('\n');

  return `WITH new_summary AS (
    SELECT
        COUNT(*) AS row_count${sumBlock()}
    FROM ${newTestTable}
),
orig_summary AS (
    SELECT
        COUNT(*) AS row_count${sumBlock()}
    FROM ${oldTestTable}
)
SELECT metric, new_value, original_value
FROM (
    SELECT 'row_count' AS metric, n.row_count AS new_value, o.row_count AS original_value FROM new_summary n, orig_summary o
${unionLines ? unionLines + '\n' : ''});`;
}

window.ComparisonQueryGenerator = {
  resolveNumericColumnsForComparison,
  buildComparisonQuery,
  generateComparisonQuery,
  wrapAsPlaygroundTable,
  buildPlaygroundComparisonQuery,
  sqlIdentifier,
};
