/**
 * SQL-Vis — script.js
 * ─────────────────────────────────────────────────────────────
 * 100% client-side. No backend, no build step.
 *
 *   0. Editor      → live syntax highlighting + line numbers (query + read-only formatted view)
 *   1. Detect      → guess the SQL dialect (Snowflake / PostgreSQL / MySQL / SQLite)
 *   2. Format      → sql-formatter cleans up the raw query
 *   3. Parse       → node-sql-parser turns the SQL into an AST
 *   4. Extract     → walk every CTE body + the final SELECT's FROM/JOIN
 *   4b. Locate     → map each CTE name back to its [start,end] position in the
 *                    formatted SQL text, so a diagram node can jump to it
 *   5. Graph model → tables/relations → typed nodes/edges + topological depth
 *   6. Layout      → depth → x/y (a starting position; nodes are draggable after)
 *   7. Render      → hand-built, draggable/pannable/zoomable SVG (not mermaid.js —
 *                    mermaid's static output can't be repositioned or animated
 *                    the way this app needs)
 *   8. Export      → SVG / PNG / JPG / PDF
 * ─────────────────────────────────────────────────────────────
 */

/* node-sql-parser ships a UMD global called `NodeSQLParser` */
// Constructed lazily (see getSqlParser) rather than at top-level: if the
// CDN script hasn't finished loading yet, this must not crash before the
// editor's own event listeners get attached further down.
let sqlParserInstance = null;
function getSqlParser() {
  if (!sqlParserInstance) sqlParserInstance = new NodeSQLParser.Parser();
  return sqlParserInstance;
}
const SVG_NS = 'http://www.w3.org/2000/svg';

/* ─────────────────────────────────────────────────────────────
   DOM REFERENCES
   ───────────────────────────────────────────────────────────── */
const sqlInput            = document.getElementById('sql-input');
const sqlHighlightCode     = document.querySelector('#sql-highlight code');
const sqlHighlightPre      = document.getElementById('sql-highlight');
const lineNumbers          = document.getElementById('line-numbers');

const formattedHighlightCode = document.querySelector('#formatted-highlight code');
const formattedScroll        = document.getElementById('formatted-scroll');
const formattedLineNumbers   = document.getElementById('formatted-line-numbers');

const viewQueryEl      = document.getElementById('view-query');
const viewFormattedEl  = document.getElementById('view-formatted');
const viewTabBtns      = document.querySelectorAll('.view-tab');

const btnVisualize     = document.getElementById('btn-visualize');
const btnClear         = document.getElementById('btn-clear');
const btnDownload      = document.getElementById('btn-download');
const exportFormatSel  = document.getElementById('export-format');

const errorState       = document.getElementById('error-state');
const errorMessage     = document.getElementById('error-message');
const diagramContainer = document.getElementById('diagram-container');
const diagramCanvasEl  = document.getElementById('diagram-canvas');
const diagramHint      = document.getElementById('diagram-hint');
const relationsMeta    = document.getElementById('relations-meta');
const relationsResizer = document.getElementById('relations-resizer');
const detectedBadge    = document.getElementById('detected-dialect');
const dialectBtns      = document.querySelectorAll('.dialect-btn');
const themeSelect      = document.getElementById('theme-select');

/* ─────────────────────────────────────────────────────────────
   STATE
   ───────────────────────────────────────────────────────────── */
let activeDialect       = 'snowflake'; // concrete dialect used for format/parse — always kept in sync with detection
let currentFormattedSql = '';          // used by the read-only view + jump-to-query scroll
let currentAst          = null;        // last parseToAST() result — reused by the source-swap handoff instead of re-parsing
let cteRangesByEntity   = new Map();   // sanitized entity name -> { start, end } in currentFormattedSql (for scroll target)
let cteSnippetByEntity  = new Map();   // sanitized entity name -> short preview text (hover tooltip)
let graphNodes = [];                   // current diagram's node models (world coords)
let graphEdges = [];                   // current diagram's edge models
let pinnedNodeId = null;               // clicking a node "pins" its connection highlight until canvas/another click

/* ═════════════════════════════════════════════════════════════
   MODULE 0 — EDITOR: SYNTAX HIGHLIGHTING + LINE NUMBERS
   Shared by both the editable "SQL Query" view and the read-only
   "Formatted SQL" view.
   ═════════════════════════════════════════════════════════════ */

const SQL_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'JOIN', 'LEFT', 'RIGHT', 'FULL', 'INNER', 'OUTER', 'CROSS',
  'ON', 'AND', 'OR', 'NOT', 'AS', 'WITH', 'GROUP', 'BY', 'ORDER', 'HAVING', 'CASE', 'WHEN',
  'THEN', 'ELSE', 'END', 'DISTINCT', 'UNION', 'ALL', 'IN', 'EXISTS', 'NULL', 'IS', 'LIKE',
  'ANY', 'BETWEEN', 'OVER', 'PARTITION', 'QUALIFY', 'CREATE', 'REPLACE', 'TABLE', 'VIEW',
  'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'LIMIT', 'OFFSET', 'ASC', 'DESC',
  'CAST', 'EXTRACT', 'INTERVAL', 'TRUE', 'FALSE', 'DATE', 'TIMESTAMP', 'IF', 'ELSEIF',
];

const TOKEN_RE = new RegExp(
  [
    '(/\\*[\\s\\S]*?\\*/)',                       // 1 block comment
    '(--[^\\n]*|//[^\\n]*)',                      // 2 line comment (-- or //, Snowflake allows both)
    "('(?:[^'\\\\]|\\\\.)*')",                     // 3 single-quoted string
    '(\\$[A-Za-z_][A-Za-z0-9_]*)',                 // 4 Airflow-style macro var, e.g. $TSTART, $DSTART
    '(\\b\\d+\\.?\\d*\\b)',                        // 5 number
    '(\\b(?:' + SQL_KEYWORDS.join('|') + ')\\b)',  // 6 keyword
    '([A-Za-z_][A-Za-z0-9_]*)(?=\\s*\\()',         // 7 function name immediately before "("
  ].join('|'),
  'gi'
);

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * highlightSQL
 * @param {string} rawSql
 * @returns {string} HTML string with <span class="tok-*"> wrappers
 */
function highlightSQL(rawSql) {
  const escaped = escapeHtml(rawSql);
  let result = '';
  let lastIndex = 0;
  TOKEN_RE.lastIndex = 0;

  let match;
  while ((match = TOKEN_RE.exec(escaped))) {
    result += escaped.slice(lastIndex, match.index);
    const [full, blockComment, lineComment, str, macro, num, kw, fn] = match;

    if (blockComment)      result += `<span class="tok-comment">${blockComment}</span>`;
    else if (lineComment)  result += `<span class="tok-comment">${lineComment}</span>`;
    else if (str)          result += `<span class="tok-string">${str}</span>`;
    else if (macro)        result += `<span class="tok-macro">${macro}</span>`;
    else if (num)          result += `<span class="tok-number">${num}</span>`;
    else if (kw)           result += `<span class="tok-keyword">${kw}</span>`;
    else if (fn)           result += `<span class="tok-function">${fn}</span>`;

    lastIndex = match.index + full.length;
  }
  result += escaped.slice(lastIndex);
  return result + '\n'; // trailing newline so the last visual line has height
}

function lineNumberText(rawSql) {
  const lineCount = rawSql.split('\n').length;
  const lines = [];
  for (let i = 1; i <= lineCount; i++) lines.push(i);
  return lines.join('\n');
}

/** Re-highlights + re-numbers the editable query editor to match its current value. */
function syncQueryEditor() {
  const value = sqlInput.value;
  sqlHighlightCode.innerHTML = highlightSQL(value);
  lineNumbers.textContent = lineNumberText(value);
}

/** Keeps the highlight layer + line-number gutter scrolled with the (real) textarea. */
function syncQueryEditorScroll() {
  sqlHighlightPre.scrollTop  = sqlInput.scrollTop;
  sqlHighlightPre.scrollLeft = sqlInput.scrollLeft;
  lineNumbers.scrollTop      = sqlInput.scrollTop;
}

/**
 * renderFormattedView
 * Renders the read-only "Formatted SQL" page — just the highlighted,
 * non-editable text. No highlight marks: clicking a CTE node jumps to
 * the SQL Query page instead (see jumpToCte), this view is purely for
 * reading the cleaned-up query.
 */
function renderFormattedView() {
  formattedHighlightCode.innerHTML = highlightSQL(currentFormattedSql);
  formattedLineNumbers.textContent = lineNumberText(currentFormattedSql);
}

function syncFormattedScroll() {
  formattedLineNumbers.scrollTop = formattedScroll.scrollTop;
}

/* ═════════════════════════════════════════════════════════════
   MODULE 1 — DIALECT AUTO-DETECTION
   ═════════════════════════════════════════════════════════════ */

const DIALECT_SIGNALS = {
  snowflake: [
    { re: /\bcreate\s+(or\s+replace\s+)?table\s+.+\bas\s*\(/i, weight: 3 },
    { re: /\bqualify\b/i, weight: 3 },
    { re: /\bgroup\s+by\s+all\b/i, weight: 3 },
    { re: /::\s*(variant|timestamp_ntz|timestamp_tz|timestamp_ltz|geography|object)\b/i, weight: 3 },
    { re: /\blike\s+(any|all)\s*\(/i, weight: 2 },
    { re: /\b(lateral\s+)?flatten\s*\(/i, weight: 2 },
    { re: /\$[A-Za-z_][A-Za-z0-9_]*/, weight: 2 },
    { re: /\/\/[^\n]*/, weight: 1 },
    { re: /\b\w+\.\w+\.\w+\b/, weight: 1 },
  ],
  mysql: [
    { re: /`[^`]+`/, weight: 3 },
    { re: /\bauto_increment\b/i, weight: 3 },
    { re: /\bengine\s*=\s*\w+/i, weight: 3 },
    { re: /\blimit\s+\d+\s*,\s*\d+/i, weight: 2 },
    { re: /\bunsigned\b/i, weight: 2 },
  ],
  postgresql: [
    { re: /\breturning\b/i, weight: 2 },
    { re: /\bserial\b/i, weight: 2 },
    { re: /\$\d+\b/, weight: 2 },
    { re: /\bilike\b/i, weight: 1 },
    { re: /::\w+/, weight: 1 },
  ],
  sqlite: [
    { re: /\bpragma\s+\w+/i, weight: 3 },
    { re: /\bautoincrement\b/i, weight: 3 }, // one word — MySQL's is AUTO_INCREMENT
    { re: /\bwithout\s+rowid\b/i, weight: 3 },
    { re: /\bsqlite_master\b/i, weight: 3 },
    { re: /\battach\s+database\b/i, weight: 2 },
  ],
};

/**
 * detectDialect
 * @param {string} rawSql
 * @returns {{ dialect: string, scores: object }}
 */
function detectDialect(rawSql) {
  const scores = { snowflake: 0, mysql: 0, postgresql: 0, sqlite: 0 };
  for (const [dialect, signals] of Object.entries(DIALECT_SIGNALS)) {
    for (const { re, weight } of signals) {
      if (re.test(rawSql)) scores[dialect] += weight;
    }
  }
  let best = 'postgresql'; // closest thing to plain ANSI SQL here — sane default on ties/no signal
  let bestScore = scores.postgresql;
  for (const d of ['snowflake', 'mysql', 'sqlite']) {
    if (scores[d] > bestScore) { best = d; bestScore = scores[d]; }
  }
  return { dialect: best, scores };
}

/* ═════════════════════════════════════════════════════════════
   MODULE 2 — SQL FORMATTER
   ═════════════════════════════════════════════════════════════ */

function formatSQL(sql, dialect) {
  return sqlFormatter.format(sql, {
    language: dialect, // sql-formatter accepts 'snowflake'/'postgresql'/'mysql'/'sqlite' directly
    tabWidth: 2,
    keywordCase: 'upper',
    identifierCase: 'lower',
    linesBetweenQueries: 1,
  });
}

/* ═════════════════════════════════════════════════════════════
   MODULE 3 — AST PARSER
   ═════════════════════════════════════════════════════════════ */

function parseToAST(sql, dialect) {
  const ast = getSqlParser().astify(sql, { database: dialect });
  return Array.isArray(ast) ? ast[0] : ast; // take the first statement of a batch
}

/* ═════════════════════════════════════════════════════════════
   MODULE 4 — RELATION EXTRACTOR (multi-scope: CTEs + final SELECT)
   Walks every CTE body + the final SELECT recursively, producing one
   merged entity/relation graph. See the long-form design note kept
   inline below each helper — unchanged in spirit from earlier builds:
   JOIN edges (solid, resolved via the ON clause's real referenced
   alias) plus lineage edges (dotted, "this CTE is built on top of
   its first FROM item") so a whole multi-CTE pipeline reads as one
   connected graph instead of isolated islands.
   ═════════════════════════════════════════════════════════════ */

function columnRefToName(column) {
  if (typeof column === 'string') return column;
  if (column && column.expr && column.expr.value !== undefined) return String(column.expr.value);
  return String(column);
}

function exprToString(expr) {
  if (!expr) return '';
  switch (expr.type) {
    case 'binary_expr':
      return `${exprToString(expr.left)} ${expr.operator} ${exprToString(expr.right)}`;
    case 'column_ref': {
      const columnName = columnRefToName(expr.column);
      return expr.table ? `${expr.table}.${columnName}` : columnName;
    }
    case 'function': {
      const fnName = expr.name && expr.name.name
        ? expr.name.name.map(part => part.value).join('.')
        : 'FUNC';
      const args = expr.args && Array.isArray(expr.args.value)
        ? expr.args.value.map(exprToString).join(', ')
        : '';
      return `${fnName}(${args})`;
    }
    case 'number':
    case 'single_quote_string':
    case 'string':
      return String(expr.value);
    default:
      return expr.value !== undefined ? String(expr.value) : '<expr>';
  }
}

function getTableLabel(fromItem) {
  // Prefer the REAL table/CTE name; alias is only a scope-local lookup key
  // (see aliasToEntity below) — using it here would show meaningless
  // single-letter node names like "M" instead of "MAT".
  //
  // Must be the FULLY qualified name, not just fromItem.table: node-sql-parser
  // splits "db.schema.table" into separate .db/.schema/.table fields, with
  // .table holding ONLY the last segment. Using .table alone means a
  // physical source like integration.commercial.dim_product collapses onto
  // any CTE that happens to share its last segment's name — e.g. the very
  // common `dim_product AS (SELECT * FROM integration.commercial.dim_product ...)`
  // staging-CTE convention, which would otherwise merge two genuinely
  // different entities into one node and corrupt the whole graph.
  if (fromItem.table) {
    const parts = [fromItem.db, fromItem.schema, fromItem.table].filter(Boolean);
    return parts.join('.');
  }
  return String(fromItem.as || 'unknown_table');
}

function getReferencedAliases(expr, acc = new Set()) {
  if (!expr) return acc;
  if (expr.type === 'binary_expr') {
    getReferencedAliases(expr.left, acc);
    getReferencedAliases(expr.right, acc);
  } else if (expr.type === 'column_ref' && expr.table) {
    acc.add(expr.table);
  } else if (expr.type === 'function' && expr.args && Array.isArray(expr.args.value)) {
    expr.args.value.forEach(arg => getReferencedAliases(arg, acc));
  }
  return acc;
}

function sanitizeEntityName(name) {
  return name.replace(/[^a-zA-Z0-9_]/g, '_').toUpperCase();
}

function joinTypeToRelationType(joinType) {
  // Every real JOIN...ON becomes a solid "join" edge, regardless of
  // LEFT/RIGHT/FULL/INNER — see buildGraphModel for how it's drawn.
  return 'join';
}

/**
 * getCteBodyAst
 * node-sql-parser's CTE body shape differs by dialect:
 *   - Snowflake / MySQL / SQLite: cte.stmt = { tableList, columnList, ast: <select> }
 *   - PostgreSQL:                 cte.stmt IS the <select> AST directly (no .ast wrapper)
 * Normalizing here means every other dialect-agnostic code path in this
 * file can just call this once instead of guessing per dialect.
 * @param {object} cte
 * @returns {object|null}
 */
function getCteBodyAst(cte) {
  if (!cte || !cte.stmt) return null;
  return cte.stmt.ast || cte.stmt;
}

/**
 * unwrapToQueryExpr
 * Peels off statement wrappers that aren't themselves a SELECT/WITH body,
 * to find the actual query structure this app extracts relations from:
 *   - CREATE ... AS <query_expr>       -> node-sql-parser nests it under `query_expr`
 *   - INSERT INTO <target> [WITH ...] SELECT ... -> nests the whole
 *     WITH/SELECT body under `values` (with `values.from`/`values.with`
 *     etc. directly, not a further-nested `.ast`) — `values` there IS the
 *     select-shaped node, so no extra unwrapping is needed once reached.
 */
function unwrapToQueryExpr(ast) {
  let node = ast;
  let guard = 0;
  while (node && guard < 5) {
    if (node.type === 'create' && node.query_expr) { node = node.query_expr; guard += 1; continue; }
    if (node.type === 'insert' && node.values) { node = node.values; guard += 1; continue; }
    break;
  }
  return node;
}

/**
 * extractAllRelations
 * @param {object} rootAst - Raw astify() output (single statement).
 * @returns {{
 *   tables: string[],
 *   relations: Array<{from:string,to:string,label:string,type:'join'|'lineage'}>,
 *   cteNames: Set<string>,
 *   cteRawNameByEntity: Map<string,string>
 * }}
 */
function extractAllRelations(rootAst) {
  const tables       = [];
  const seenTables   = new Set();
  const relations    = [];
  const cteNames     = new Set();
  const cteRawNameByEntity = new Map(); // sanitized entity -> original CTE name (for text lookup)
  // Sanitized entity -> its real, dotted, case-preserved name (e.g.
  // "integration.corporate.fact_purchase_requisition") straight from the
  // FROM clause. The sanitized entity id (upper-cased, underscored) only
  // exists to be a safe, collision-free graph-node key/CSS-id — it is NOT
  // a valid SQL identifier on its own (the dots that separate db/schema/
  // table become underscores), so anything that needs to reference this
  // table in RE-EXECUTABLE SQL (the source-swap workflow) must use this
  // map, never the sanitized id.
  const physicalRawNameByEntity = new Map();

  function registerTable(entityName) {
    if (!seenTables.has(entityName)) {
      seenTables.add(entityName);
      tables.push(entityName);
    }
  }

  function processFromArray(fromArray, ownerEntity) {
    if (!Array.isArray(fromArray)) return;
    const aliasToEntity = new Map();

    fromArray.forEach((item, index) => {
      if (!item || typeof item !== 'object' || (!item.table && !item.expr)) return;

      const rawKey     = item.as || item.table || `table_${index}`;
      const entityName = sanitizeEntityName(getTableLabel(item));

      if (!aliasToEntity.has(rawKey)) {
        aliasToEntity.set(rawKey, entityName);
        registerTable(entityName);
        if (item.table && !physicalRawNameByEntity.has(entityName)) {
          physicalRawNameByEntity.set(entityName, getTableLabel(item));
        }
      }

      if (ownerEntity && entityName !== ownerEntity) {
        // Lineage edge (dotted): EVERY item in this FROM list is a direct
        // input this CTE is built from — not just the first one. This is
        // what makes hierarchy depth (computeDepths) come out correct: a
        // CTE that joins two prior CTEs together sits one layer below BOTH
        // of them, not just below whichever happened to be listed first.
        relations.push({ from: entityName, to: ownerEntity, label: 'source', type: 'lineage' });
      }

      if (index > 0 && item.join) {
        const referenced = [...getReferencedAliases(item.on)].filter(a => a !== rawKey);
        const fromAlias  = referenced.find(a => aliasToEntity.has(a))
          || getTableLabel(fromArray[index - 1]);
        const fromEntity = aliasToEntity.get(fromAlias) || sanitizeEntityName(fromAlias);

        relations.push({
          from:  fromEntity,
          to:    entityName,
          label: exprToString(item.on) || 'joined on',
          type:  joinTypeToRelationType(item.join),
        });
      }
    });
  }

  function processStatement(stmtAst) {
    if (!stmtAst || typeof stmtAst !== 'object') return;

    if (Array.isArray(stmtAst.with)) {
      stmtAst.with.forEach(cte => {
        const cteEntity = sanitizeEntityName(cte.name.value);
        registerTable(cteEntity);
        cteNames.add(cteEntity);
        cteRawNameByEntity.set(cteEntity, cte.name.value);
        if (cte.stmt && getCteBodyAst(cte)) processStatement(getCteBodyAst(cte));
      });
    }

    if (Array.isArray(stmtAst.from)) {
      processFromArray(stmtAst.from, stmtAst.__ownerEntity || null);
    }

    if (stmtAst._next) processStatement(stmtAst._next);
  }

  function tagOwners(stmtAst) {
    if (!stmtAst || typeof stmtAst !== 'object' || !Array.isArray(stmtAst.with)) return;
    stmtAst.with.forEach(cte => {
      const body = getCteBodyAst(cte);
      if (body) {
        body.__ownerEntity = sanitizeEntityName(cte.name.value);
        tagOwners(body);
      }
    });
  }

  const root = unwrapToQueryExpr(rootAst);
  if (!root || (!Array.isArray(root.from) && !Array.isArray(root.with))) {
    throw new Error('No FROM clause found. SQL-Vis needs a SELECT ... FROM ... query.');
  }

  tagOwners(root);
  processStatement(root);

  return { tables, relations, cteNames, cteRawNameByEntity, physicalRawNameByEntity };
}

/* ═════════════════════════════════════════════════════════════
   MODULE 4a — TARGET-USAGE CONTEXT (for the source-swap workflow)
   Given a physical table's sanitized entity name, finds the one scope
   (a CTE body, or the final SELECT) that reads DIRECTLY off it, and pulls
   out just enough re-executable SQL — the alias-scoped WHERE conjuncts and
   the raw column names selected off it — for source-swap.js to build an AI
   payload and, later, a validation query. This is deliberately separate
   from extractAllRelations: that function's job is the JOIN/lineage graph,
   this one's job is "what does the query actually read from this one
   table," which needs WHERE/columns that the graph extractor never looks at.
   ═════════════════════════════════════════════════════════════ */

/**
 * findAliasForEntityInFrom
 * @param {Array} fromArray
 * @param {string} targetEntity - sanitized entity name
 * @returns {string|null} the alias (or bare table name if unaliased) used
 *   for targetEntity in this FROM list, or null if it isn't listed here.
 */
function findAliasForEntityInFrom(fromArray, targetEntity) {
  if (!Array.isArray(fromArray)) return null;
  for (const item of fromArray) {
    if (!item || !item.table) continue;
    if (sanitizeEntityName(getTableLabel(item)) === targetEntity) return item.as || item.table;
  }
  return null;
}

/**
 * findTargetUsageScopes
 * Walks CTEs depth-first (same document order as extractAllRelations'
 * processStatement: each `with` entry fully recursed before the statement's
 * own FROM is checked), collecting every scope where targetEntity is
 * listed directly in FROM — i.e. a "base" read straight off the physical
 * source, as opposed to a downstream CTE that only inherits it through
 * another CTE.
 * @param {object} rootAst
 * @param {string} targetEntity
 * @returns {Array<{scopeAst: object, alias: string}>}
 */
function findTargetUsageScopes(rootAst, targetEntity) {
  const scopes = [];

  function visit(stmtAst) {
    if (!stmtAst || typeof stmtAst !== 'object') return;

    if (Array.isArray(stmtAst.with)) {
      stmtAst.with.forEach(cte => {
        const body = getCteBodyAst(cte);
        if (body) visit(body);
      });
    }

    if (Array.isArray(stmtAst.from)) {
      const alias = findAliasForEntityInFrom(stmtAst.from, targetEntity);
      if (alias) scopes.push({ scopeAst: stmtAst, alias });
    }

    if (stmtAst._next) visit(stmtAst._next);
  }

  visit(unwrapToQueryExpr(rootAst));
  return scopes;
}

/**
 * splitWhereIntoAliasScopedConjuncts
 * Descends through AND nodes only — OR changes semantics if split apart,
 * so an OR subtree is kept or dropped as one whole leaf. A leaf survives
 * only if every alias it references is targetAlias (or no alias at all,
 * e.g. a literal-only condition); a leaf that also touches another table's
 * alias can't be evaluated standalone against the raw source table, so
 * it's dropped and counted rather than silently included/omitted.
 * @param {object} whereAst
 * @param {string} targetAlias
 * @returns {{kept: object[], dropped: number}}
 */
function splitWhereIntoAliasScopedConjuncts(whereAst, targetAlias) {
  const kept = [];
  let dropped = 0;

  function visit(node) {
    if (!node) return;
    if (node.type === 'binary_expr' && node.operator === 'AND') {
      visit(node.left);
      visit(node.right);
      return;
    }
    const aliases = [...getReferencedAliases(node)];
    const onlyTarget = aliases.every(a => a === targetAlias);
    if (onlyTarget) kept.push(node);
    else dropped += 1;
  }

  visit(whereAst);
  return { kept, dropped };
}

/**
 * exprToSql
 * Renders an AST expression back into syntactically valid, RE-EXECUTABLE
 * SQL — unlike exprToString above (used only for human-readable edge
 * labels, where an approximation is fine), this has to produce something
 * Snowflake can actually run: string literals keep their quotes, IN/BETWEEN
 * get their special-form syntax, and a node type this function doesn't
 * recognize is surfaced as a visible `/* UNRECOGNIZED *\/` placeholder
 * (via the `unrecognized` flag) instead of being silently guessed at or
 * dropped — an unfamiliar node here usually means a dialect-specific
 * construct this parser build doesn't model the same way across
 * Snowflake/Postgres/MySQL/SQLite, and that ambiguity should surface to
 * the user, not get papered over.
 * @param {object} expr
 * @param {{from: string, to: string}} [aliasRewrite] - rewrite targetAlias
 *   references to a canonical alias (source-swap.js uses "src") so the
 *   extracted filter can be pasted straight into a standalone
 *   `FROM <source> AS src` query.
 * @returns {{sql: string, unrecognized: boolean}}
 */
function exprToSql(expr, aliasRewrite) {
  if (!expr) return { sql: '', unrecognized: false };
  let unrecognized = false;
  const rec = (e) => {
    const r = exprToSql(e, aliasRewrite);
    if (r.unrecognized) unrecognized = true;
    return r.sql;
  };

  switch (expr.type) {
    case 'binary_expr': {
      const op = expr.operator;
      if (op === 'BETWEEN' || op === 'NOT BETWEEN') {
        const [a, b] = (expr.right && expr.right.value) || [];
        return { sql: `${rec(expr.left)} ${op} ${rec(a)} AND ${rec(b)}`, unrecognized };
      }
      if (op === 'IN' || op === 'NOT IN') {
        const list = (expr.right && Array.isArray(expr.right.value))
          ? expr.right.value.map(rec).join(', ')
          : rec(expr.right);
        return { sql: `${rec(expr.left)} ${op} (${list})`, unrecognized };
      }
      return { sql: `${rec(expr.left)} ${op} ${rec(expr.right)}`, unrecognized };
    }
    case 'unary_expr':
      return { sql: `${expr.operator} ${rec(expr.expr)}`, unrecognized };
    case 'column_ref': {
      const columnName = columnRefToName(expr.column);
      const table = (aliasRewrite && expr.table === aliasRewrite.from) ? aliasRewrite.to : expr.table;
      return { sql: table ? `${table}.${columnName}` : columnName, unrecognized };
    }
    case 'function': {
      const fnName = expr.name && expr.name.name
        ? expr.name.name.map(part => part.value).join('.')
        : (typeof expr.name === 'string' ? expr.name : 'FUNC');
      const args = expr.args && Array.isArray(expr.args.value)
        ? expr.args.value.map(rec).join(', ')
        : '';
      return { sql: `${fnName}(${args})`, unrecognized };
    }
    case 'aggr_func': {
      const fnName = String(expr.name || 'FUNC');
      const distinct = expr.args && expr.args.distinct ? 'DISTINCT ' : '';
      const argSql = expr.args && expr.args.expr ? rec(expr.args.expr)
        : (expr.args && Array.isArray(expr.args.value) ? expr.args.value.map(rec).join(', ') : '*');
      return { sql: `${fnName}(${distinct}${argSql})`, unrecognized };
    }
    case 'number':
      return { sql: String(expr.value), unrecognized };
    case 'bool':
      return { sql: expr.value ? 'TRUE' : 'FALSE', unrecognized };
    case 'null':
      return { sql: 'NULL', unrecognized };
    case 'single_quote_string':
    case 'string':
      return { sql: `'${String(expr.value).replace(/'/g, "''")}'`, unrecognized };
    case 'double_quote_string':
      return { sql: `"${String(expr.value).replace(/"/g, '""')}"`, unrecognized };
    case 'expr_list':
      return { sql: (expr.value || []).map(rec).join(', '), unrecognized };
    case 'cast':
      return { sql: `CAST(${rec(expr.expr)} AS ${expr.target && expr.target[0] ? expr.target[0].dataType : ''})`, unrecognized };
    default:
      return { sql: `/* UNRECOGNIZED EXPR: ${expr.type || typeof expr} */`, unrecognized: true };
  }
}

/**
 * extractTargetUsageContext
 * @param {object} rootAst
 * @param {string} targetEntity - sanitized entity name (matches a node.id
 *   from buildGraphModel)
 * @returns {{
 *   found: boolean,
 *   targetAlias: string|null,
 *   oldFilterSql: string|null,        // alias-scoped WHERE conjuncts, alias rewritten to "src"; null if none
 *   droppedConjuncts: number,         // WHERE conjuncts excluded because they also touched another table
 *   selectStar: boolean,              // this scope is "SELECT *" (or "alias.*") — numeric candidates deferred entirely to the CSV sample
 *   oldNumericColumnCandidates: string[], // raw old-table column names read directly off targetAlias in this scope's SELECT list
 *   multipleUsageScopes: number,      // how many scopes read this table directly; only the first is used (see findTargetUsageScopes)
 *   unrecognizedExprWarning: boolean, // true if any kept WHERE conjunct contained a node type exprToSql didn't recognize
 * }}
 */
function extractTargetUsageContext(rootAst, targetEntity) {
  const empty = {
    found: false, targetAlias: null, oldFilterSql: null, droppedConjuncts: 0,
    selectStar: false, oldNumericColumnCandidates: [], multipleUsageScopes: 0,
    unrecognizedExprWarning: false,
  };

  const scopes = findTargetUsageScopes(rootAst, targetEntity);
  if (scopes.length === 0) return empty;

  const { scopeAst, alias } = scopes[0];
  const aliasRewrite = { from: alias, to: 'src' };

  let oldFilterSql = null;
  let droppedConjuncts = 0;
  let unrecognizedExprWarning = false;
  if (scopeAst.where) {
    const { kept, dropped } = splitWhereIntoAliasScopedConjuncts(scopeAst.where, alias);
    droppedConjuncts = dropped;
    if (kept.length > 0) {
      oldFilterSql = kept.map(node => {
        const { sql, unrecognized } = exprToSql(node, aliasRewrite);
        if (unrecognized) unrecognizedExprWarning = true;
        return sql;
      }).join('\n    AND ');
    }
  }

  let selectStar = false;
  const oldNumericColumnCandidates = [];
  const singleSourceScope = Array.isArray(scopeAst.from) && scopeAst.from.length === 1;
  if (Array.isArray(scopeAst.columns)) {
    scopeAst.columns.forEach(col => {
      const expr = col && col.expr;
      if (!expr || expr.type !== 'column_ref') return;
      if (expr.column === '*') { selectStar = true; return; }
      if (expr.table === alias || (!expr.table && singleSourceScope)) {
        oldNumericColumnCandidates.push(columnRefToName(expr.column));
      }
    });
  }

  return {
    found: true,
    targetAlias: alias,
    oldFilterSql,
    droppedConjuncts,
    selectStar,
    oldNumericColumnCandidates,
    multipleUsageScopes: scopes.length,
    unrecognizedExprWarning,
  };
}

/* ═════════════════════════════════════════════════════════════
   MODULE 4b — CTE TEXT-RANGE LOCATOR
   Finds each CTE's [start,end] character span in the FORMATTED sql
   text (not the AST) via a simple bracket-depth walk from
   "<name> AS (" to its matching close-paren. Text-based rather than
   AST-location-based on purpose: it's dialect-agnostic and doesn't
   depend on node-sql-parser exposing source positions.
   ═════════════════════════════════════════════════════════════ */

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * findCteTextRange
 * @param {string} formattedSql
 * @param {string} rawCteName - the CTE's original (lowercase) name
 * @returns {{start:number,end:number}|null}
 */
function findCteTextRange(formattedSql, rawCteName) {
  const re = new RegExp('\\b' + escapeRegExp(rawCteName) + '\\s+as\\s*\\(', 'i');
  const match = re.exec(formattedSql);
  if (!match) return null;

  const openParenIdx = match.index + match[0].length - 1;
  let depth = 0;
  for (let i = openParenIdx; i < formattedSql.length; i++) {
    if (formattedSql[i] === '(') depth++;
    else if (formattedSql[i] === ')') {
      depth--;
      if (depth === 0) return { start: match.index, end: i + 1 };
    }
  }
  return null; // unbalanced — leave this CTE without a clickable range
}

/**
 * computeCteRanges
 * @param {string} formattedSql
 * @param {Map<string,string>} cteRawNameByEntity
 * @returns {{ ranges: Map<string,{start,end}>, snippets: Map<string,string> }}
 */
function computeCteRanges(formattedSql, cteRawNameByEntity) {
  const ranges = new Map();
  const snippets = new Map();
  for (const [entity, rawName] of cteRawNameByEntity.entries()) {
    const range = findCteTextRange(formattedSql, rawName);
    if (!range) continue;
    ranges.set(entity, range);

    const fullText = formattedSql.slice(range.start, range.end);
    const lines = fullText.split('\n').slice(0, 6);
    let snippet = lines.join('\n');
    if (fullText.split('\n').length > 6) snippet += '\n  …';
    snippets.set(entity, snippet);
  }
  return { ranges, snippets };
}

/* ═════════════════════════════════════════════════════════════
   MODULE 5 — GRAPH MODEL (nodes/edges + topological depth)
   ═════════════════════════════════════════════════════════════ */

/**
 * computeDepths
 * Longest-path-from-root layering over the DAG (Kahn's algorithm with
 * relaxation) — physical source tables settle at depth 0, each CTE
 * sits one layer below whatever it's built from.
 *
 * @param {string[]} tables
 * @param {Array<{from,to}>} relations
 * @returns {Map<string,number>}
 */
function computeDepths(tables, relations) {
  const depth    = new Map(tables.map(t => [t, 0]));
  const adj      = new Map(tables.map(t => [t, []]));
  const indegree = new Map(tables.map(t => [t, 0]));

  relations.forEach(r => {
    if (adj.has(r.from)) adj.get(r.from).push(r.to);
    if (indegree.has(r.to)) indegree.set(r.to, indegree.get(r.to) + 1);
  });

  const queue = tables.filter(t => indegree.get(t) === 0);
  const processed = new Set();
  let guard = 0;
  while (queue.length && guard < 100000) {
    guard += 1;
    const node = queue.shift();
    if (processed.has(node)) continue;
    processed.add(node);
    for (const next of adj.get(node) || []) {
      depth.set(next, Math.max(depth.get(next), depth.get(node) + 1));
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  // Any node left unprocessed (e.g. a recursive CTE cycle) just keeps depth 0 —
  // rare in practice and not worth a dedicated cycle-breaking pass here.
  return depth;
}

/**
 * buildGraphModel
 * @returns {{ nodes: Array, edges: Array }}
 */
function buildGraphModel(tables, relations, cteNames, cteRangesByEntityLocal, cteSnippetsByEntityLocal, physicalRawNameByEntityLocal) {
  // Depth/hierarchy is driven only by lineage edges ("this is built from
  // that"). JOIN edges are a peer relationship (two already-available
  // inputs being combined) and would otherwise wrongly make one look like
  // it depends on the other just because of which side an ON clause named.
  const lineageOnly = relations.filter(r => r.type === 'lineage');
  const depths = computeDepths(tables, lineageOnly);

  const nodes = tables.map(id => ({
    id,
    label: id,
    isCte: cteNames.has(id),
    // The real, dotted SQL identifier (e.g. "INTEGRATION.CORPORATE.
    // FACT_TABLE") — `id`/`label` are a sanitized graph-node key (dots
    // become underscores) and must never be fed back into generated SQL;
    // this is. A CTE has no schema qualification of its own, so its
    // sanitized id already IS its correct displayable name.
    qualifiedName: cteNames.has(id)
      ? id
      : (physicalRawNameByEntityLocal.get(id) || id).toUpperCase(),
    depth: depths.get(id) || 0,
    range: cteRangesByEntityLocal.get(id) || null,
    snippet: cteSnippetsByEntityLocal.get(id) || '',
    x: 0, y: 0, w: 0, h: 0, // filled in by computeLayout
  }));

  // Only lineage ("this feeds that CTE") edges are actually drawn — join
  // edges used to be rendered too, but between the two of them the same
  // small cluster of nodes often ended up connected by two/three
  // overlapping curves at once (e.g. A and B both feeding C, PLUS a
  // separate A-B join edge), reading as visual clutter rather than useful
  // structure. Join relations are still computed above (still used for
  // computeDepths and available for any future feature that wants the
  // actual join-key condition) — just not drawn as their own path anymore.
  const edges = lineageOnly.map(r => ({ from: r.from, to: r.to, label: r.label, type: r.type }));

  return { nodes, edges };
}

/* ═════════════════════════════════════════════════════════════
   MODULE 6 — LAYOUT (depth → starting x/y; nodes are draggable after)
   ═════════════════════════════════════════════════════════════ */

const NODE_HEIGHT  = 46;
const NODE_GAP_X   = 32;
const LAYER_GAP_Y  = 120;
const CANVAS_MARGIN = 60;
// Generous enough that a realistic fully-qualified "db.schema.table" name
// (30-40 chars) fits on one line without truncation — was 240, which cut
// off almost every physical-table label at ~22 chars.
const NODE_MAX_WIDTH = 320;

function estimateNodeWidth(label) {
  return Math.min(NODE_MAX_WIDTH, Math.max(110, label.length * 8 + 46));
}

/**
 * maxLabelCharsForWidth
 * Inverts estimateNodeWidth's formula so buildNodeEl's truncation
 * threshold is always DERIVED from a node's actual box width, instead of
 * a separate hardcoded character count that can silently drift out of
 * sync with it (which is exactly how the old 240px cap + a fixed 22-char
 * cutoff ended up truncating almost every label, even ones well under
 * the box's own visual capacity).
 * @param {number} width
 * @returns {number}
 */
function maxLabelCharsForWidth(width) {
  return Math.max(1, Math.floor((width - 46) / 8));
}

/**
 * computeLayout
 * Mutates each node with x/y/w/h. Rows are centered so shorter layers
 * don't hug the left edge.
 * @param {Array} nodes
 */
function computeLayout(nodes) {
  const byDepth = new Map();
  nodes.forEach(n => {
    n.w = estimateNodeWidth(n.label);
    n.h = NODE_HEIGHT;
    if (!byDepth.has(n.depth)) byDepth.set(n.depth, []);
    byDepth.get(n.depth).push(n);
  });

  const rowWidths = new Map();
  for (const [depth, rowNodes] of byDepth.entries()) {
    const width = rowNodes.reduce((sum, n) => sum + n.w, 0) + NODE_GAP_X * (rowNodes.length - 1);
    rowWidths.set(depth, width);
  }
  const maxRowWidth = Math.max(...rowWidths.values(), 0);

  for (const [depth, rowNodes] of byDepth.entries()) {
    const rowWidth = rowWidths.get(depth);
    let x = CANVAS_MARGIN + (maxRowWidth - rowWidth) / 2;
    const y = CANVAS_MARGIN + depth * (NODE_HEIGHT + LAYER_GAP_Y);
    for (const n of rowNodes) {
      n.x = x;
      n.y = y;
      x += n.w + NODE_GAP_X;
    }
  }
}

/**
 * computeContentBBox
 * @param {Array} nodes
 * @returns {{minX,minY,maxX,maxY,width,height}}
 */
function computeContentBBox(nodes) {
  if (nodes.length === 0) return { minX: 0, minY: 0, maxX: 400, maxY: 300, width: 400, height: 300 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.w);
    maxY = Math.max(maxY, n.y + n.h);
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/* ═════════════════════════════════════════════════════════════
   MODULE 7 — INTERACTIVE SVG RENDERER
   A hand-built canvas: viewBox-driven pan/zoom, per-node drag (which
   live-updates every attached edge path), animated "data flow" dashes,
   database/CTE icons, a hover preview, and click-to-jump for CTEs.
   ═════════════════════════════════════════════════════════════ */

let svgEl = null;
let edgeGroupEl = null;
let nodeGroupEl = null;
let viewBoxState = { x: 0, y: 0, w: 800, h: 600 };
let panState = null;   // { startClientX, startClientY, startVB }
let dragState = null;  // { node, startClientX, startClientY, startX, startY, moved }
let tooltipEl = null;

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function applyViewBox() {
  svgEl.setAttribute('viewBox', `${viewBoxState.x} ${viewBoxState.y} ${viewBoxState.w} ${viewBoxState.h}`);
}

function screenToSvgPoint(clientX, clientY) {
  const rect = svgEl.getBoundingClientRect();
  const scaleX = viewBoxState.w / rect.width;
  const scaleY = viewBoxState.h / rect.height;
  return {
    x: viewBoxState.x + (clientX - rect.left) * scaleX,
    y: viewBoxState.y + (clientY - rect.top) * scaleY,
  };
}

/** Rebuilds the 'd' path + label position for one edge, given current node positions. */
function updateEdgeGeometry(edgeEl, fromNode, toNode) {
  const x1 = fromNode.x + fromNode.w / 2, y1 = fromNode.y + fromNode.h;
  const x2 = toNode.x + toNode.w / 2,     y2 = toNode.y;
  const dy = Math.max(36, Math.abs(y2 - y1) / 2);
  const d = `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`;
  edgeEl.path.setAttribute('d', d);
  edgeEl.hitArea.setAttribute('d', d);
}

function createSvgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

/**
 * showTooltip / hideTooltip
/**
 * showTooltip / hideTooltip
 * A small floating preview shown on hover — used both for a CTE's SQL
 * snippet and for an edge's full (untruncated) JOIN/lineage condition.
 */
function showTooltip(title, body, clientX, clientY) {
  hideTooltip();
  tooltipEl = document.createElement('div');
  tooltipEl.className = 'erd-tooltip';
  tooltipEl.innerHTML = `<span class="erd-tooltip__title">${escapeHtml(title)}</span>${escapeHtml(body)}`;
  diagramContainer.appendChild(tooltipEl);

  const containerRect = diagramContainer.getBoundingClientRect();
  const left = clamp(clientX - containerRect.left + 14, 4, containerRect.width - 360);
  const top  = clamp(clientY - containerRect.top + 14, 4, containerRect.height - 40);
  tooltipEl.style.left = `${left}px`;
  tooltipEl.style.top  = `${top}px`;
}

function hideTooltip() {
  if (tooltipEl) { tooltipEl.remove(); tooltipEl = null; }
}

/* ── Source-swap entry point ────────────────────────────────────────────
   A small floating prompt shown when a PHYSICAL (non-CTE) table node is
   pinned — this is the only integration point with source-swap.js. Kept
   here (rather than in source-swap.js) because it needs the node model
   and the same floating-positioning logic as the tooltip; source-swap.js
   owns everything that happens *after* the user clicks through.
   ──────────────────────────────────────────────────────────────────── */
let sourceSwapPromptEl = null;

function showSourceSwapPrompt(node, clientX, clientY) {
  hideSourceSwapPrompt();
  sourceSwapPromptEl = document.createElement('div');
  sourceSwapPromptEl.className = 'source-swap-prompt';
  sourceSwapPromptEl.innerHTML = `
    <span class="source-swap-prompt__label">Edit source: <strong>${escapeHtml(node.qualifiedName)}</strong></span>
    <button type="button" class="source-swap-prompt__btn">Edit source →</button>
  `;
  diagramContainer.appendChild(sourceSwapPromptEl);

  // Measure the box's REAL rendered size (it varies a lot — qualifiedName
  // can be a short CTE name or a long fully-qualified table path) rather
  // than clamping against a guessed constant, which is what let the box
  // hang off the right edge for long names.
  const containerRect = diagramContainer.getBoundingClientRect();
  const promptRect = sourceSwapPromptEl.getBoundingClientRect();
  const left = clamp(clientX - containerRect.left + 10, 4, containerRect.width - promptRect.width - 4);
  const top  = clamp(clientY - containerRect.top + 10, 4, containerRect.height - promptRect.height - 4);
  sourceSwapPromptEl.style.left = `${left}px`;
  sourceSwapPromptEl.style.top  = `${top}px`;

  sourceSwapPromptEl.querySelector('.source-swap-prompt__btn').addEventListener('click', () => {
    // Guarded: the ERD still works standalone if source-swap.js isn't loaded.
    if (window.SourceSwap && typeof window.SourceSwap.open === 'function') {
      let usageContext = null;
      let cteBody = null;

      if (node.isCte) {
        // CTE-target mode: there's no single alias/filter to scope to (a
        // CTE that consolidates several raw sources joins all of them) —
        // the CTE's own full body text IS the "old logic" ground truth,
        // already available via the same range this app uses for the
        // jump-to-query/tooltip feature.
        const range = cteRangesByEntity.get(node.id);
        cteBody = range ? currentFormattedSql.slice(range.start, range.end) : null;
      } else {
        // usageContext may be null (e.g. AST re-shape edge case) —
        // source-swap.js must degrade gracefully (no pre-filled
        // filter/numeric columns) rather than assume it's always present.
        try {
          if (currentAst) usageContext = extractTargetUsageContext(currentAst, node.id);
        } catch (err) {
          console.warn('[SQL-Vis] Could not extract source-usage context for', node.id, err);
        }
      }

      // node.id (sanitized, dots->underscores) is only a graph-node key — it
      // must never be fed into generated SQL. node.qualifiedName is the real
      // dotted identifier (e.g. "INTEGRATION.CORPORATE.FACT_TABLE"), or the
      // CTE's own name as-is.
      window.SourceSwap.open(node.qualifiedName, {
        formattedSql: currentFormattedSql,
        dialect: activeDialect,
        isCte: node.isCte,
        usageContext,
        cteBody,
      });
    } else {
      console.warn('[SQL-Vis] source-swap.js not loaded — cannot open the source-swap page.');
    }
  });
}

function hideSourceSwapPrompt() {
  if (sourceSwapPromptEl) { sourceSwapPromptEl.remove(); sourceSwapPromptEl = null; }
}

/* ── Connection tracing: hover/click a node to see everything it's
   connected to (both directions — "what feeds this" and "what this
   feeds"), dimming and pausing the flow animation on everything else. ── */

/**
 * computeConnectedComponent
 * BFS over the graph treating edges as undirected, so hovering either a
 * source table or a CTE reveals its whole connected cluster in one pass.
 * @param {string} nodeId
 * @param {Array<{from,to}>} edges
 * @returns {Set<string>}
 */
function computeConnectedComponent(nodeId, edges) {
  const adj = new Map();
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    if (!adj.has(e.to)) adj.set(e.to, []);
    adj.get(e.from).push(e.to);
    adj.get(e.to).push(e.from);
  }
  const visited = new Set([nodeId]);
  const queue = [nodeId];
  while (queue.length) {
    const current = queue.shift();
    for (const next of adj.get(current) || []) {
      if (!visited.has(next)) { visited.add(next); queue.push(next); }
    }
  }
  return visited;
}

function highlightSubgraph(nodeId) {
  const connected = computeConnectedComponent(nodeId, graphEdges);
  nodeGroupEl.querySelectorAll('.erd-node').forEach(g => {
    const id = g.dataset.id;
    g.classList.toggle('dimmed', !connected.has(id));
    g.classList.toggle('highlighted', connected.has(id) && id !== nodeId);
  });
  edgeGroupEl.querySelectorAll('.erd-edge').forEach(g => {
    const relevant = connected.has(g.dataset.from) && connected.has(g.dataset.to);
    g.classList.toggle('dimmed', !relevant);
    g.classList.toggle('active-flow', relevant);
  });
}

function clearSubgraphHighlight() {
  nodeGroupEl.querySelectorAll('.erd-node').forEach(g => g.classList.remove('dimmed', 'highlighted'));
  edgeGroupEl.querySelectorAll('.erd-edge').forEach(g => g.classList.remove('dimmed', 'active-flow'));
}

/**
 * jumpToCte
 * Switches to the "SQL Query" page and scrolls it near the clicked CTE's
 * definition — no highlight mark, per the "SQL Query / Formatted SQL are
 * just two pages of the same paper" design: this just turns to the right
 * spot on the front page, it doesn't decorate it.
 */
function jumpToCte(node) {
  hideTooltip();
  if (!node.range) return;
  switchView('query');
  const before = sqlInput.value.slice(0, node.range.start);
  const lineIndex = before.split('\n').length - 1;
  const lineHeight = 13 * 1.7; // matches .sql-textarea's font-size * line-height
  sqlInput.scrollTop = Math.max(0, lineIndex * lineHeight - sqlInput.clientHeight / 2);
  sqlInput.selectionStart = sqlInput.selectionEnd = node.range.start;
  syncQueryEditorScroll();
}

/** Builds one <g class="erd-node"> for a node model. */
function buildNodeEl(node) {
  const g = createSvgEl('g', { class: `erd-node${node.isCte ? ' is-cte' : ''}`, 'data-id': node.id });
  const box = createSvgEl('rect', {
    class: 'erd-node-box', x: 0, y: 0, width: node.w, height: node.h, rx: 8, ry: 8,
  });
  const icon = createSvgEl('use', {
    href: node.isCte ? '#icon-cte' : '#icon-db', x: 10, y: node.h / 2 - 8, width: 16, height: 16,
  });
  icon.setAttribute('class', 'erd-node-icon');
  const label = createSvgEl('text', {
    class: 'erd-node-label', x: 34, y: node.h / 2 + 4,
  });
  // Truncation threshold is DERIVED from this node's own box width
  // (node.w, set by computeLayout via estimateNodeWidth) rather than a
  // separate hardcoded character count — so a box that's already wide
  // enough to show the full name never truncates it.
  const maxChars = maxLabelCharsForWidth(node.w);
  label.textContent = node.qualifiedName.length > maxChars
    ? node.qualifiedName.slice(0, Math.max(1, maxChars - 1)) + '…'
    : node.qualifiedName;

  g.append(box, icon, label);
  g.setAttribute('transform', `translate(${node.x}, ${node.y})`);

  // ── Drag + click handling ──
  g.addEventListener('pointerdown', evt => {
    evt.stopPropagation();
    try { g.setPointerCapture(evt.pointerId); } catch { /* not supported everywhere — drag still works without it */ }
    dragState = { node, startClientX: evt.clientX, startClientY: evt.clientY, startX: node.x, startY: node.y, moved: false };
    g.classList.add('dragging');
  });
  g.addEventListener('pointermove', evt => {
    if (!dragState || dragState.node !== node) return;
    const rect = svgEl.getBoundingClientRect();
    const scale = viewBoxState.w / rect.width;
    const dx = (evt.clientX - dragState.startClientX) * scale;
    const dy = (evt.clientY - dragState.startClientY) * scale;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) dragState.moved = true;
    node.x = dragState.startX + dx;
    node.y = dragState.startY + dy;
    g.setAttribute('transform', `translate(${node.x}, ${node.y})`);
    refreshEdgesForNode(node.id);
  });
  g.addEventListener('pointerup', evt => {
    if (!dragState || dragState.node !== node) return;
    const wasClick = !dragState.moved;
    dragState = null;
    g.classList.remove('dragging');
    if (!wasClick) return;

    // Click: toggle a "pinned" connection trace for this node (stays lit
    // even after the mouse leaves — click empty canvas or the same node
    // again to release it).
    pinnedNodeId = pinnedNodeId === node.id ? null : node.id;
    if (pinnedNodeId) highlightSubgraph(node.id); else clearSubgraphHighlight();

    // A CTE still jumps to its definition in the query editor (unchanged),
    // but — like a physical table — it can ALSO be targeted for a source
    // swap: a CTE that consolidates several raw sources into one (see
    // source-swap.js's CTE-target mode) is targeted by clicking the CTE
    // node itself, not any one of the raw tables feeding it.
    if (node.isCte) jumpToCte(node);

    if (pinnedNodeId === node.id) {
      // Now pinned — offer the source-swap entry point. source-swap.js is
      // a separate, optional module (see MODULE integration note at the
      // top of this file); guard the call so the ERD still works
      // standalone if that script isn't loaded.
      showSourceSwapPrompt(node, evt.clientX, evt.clientY);
    } else {
      hideSourceSwapPrompt();
    }
  });

  // Hover: preview the connection trace (unless a different node is pinned).
  g.addEventListener('pointerenter', evt => {
    if (!pinnedNodeId) highlightSubgraph(node.id);
    if (node.isCte && node.snippet) showTooltip(`${node.label} — click to jump to query`, node.snippet, evt.clientX, evt.clientY);
  });
  g.addEventListener('pointermove', evt => {
    if (tooltipEl && node.isCte && node.snippet) showTooltip(`${node.label} — click to jump to query`, node.snippet, evt.clientX, evt.clientY);
  });
  g.addEventListener('pointerleave', () => {
    hideTooltip();
    if (!pinnedNodeId) clearSubgraphHighlight();
    else if (pinnedNodeId !== node.id) { /* keep the pinned node's trace showing */ }
  });

  return g;
}

/** Builds one edge (a visible dashed path + a fat invisible "hit area"
 *  path so hovering the thin line is easy, plus a hover tooltip showing
 *  the FULL join/lineage condition — no permanently-rendered, truncated
 *  label cluttering the canvas). */
function buildEdgeEl(edge, nodesById) {
  const fromNode = nodesById.get(edge.from);
  const toNode   = nodesById.get(edge.to);
  if (!fromNode || !toNode) return null;

  const path = createSvgEl('path', { class: `erd-edge-path${edge.type === 'lineage' ? ' lineage' : ''}` });
  const hitArea = createSvgEl('path', {
    class: 'erd-edge-hit', fill: 'none', stroke: 'transparent', 'stroke-width': 16,
  });

  const g = createSvgEl('g', {
    class: 'erd-edge', 'data-from': edge.from, 'data-to': edge.to,
  });
  g.append(hitArea, path);

  const edgeEl = { path, hitArea };
  updateEdgeGeometry(edgeEl, fromNode, toNode);

  const title = edge.type === 'lineage' ? 'CTE source' : 'JOIN ... ON';
  hitArea.addEventListener('pointerenter', evt => showTooltip(title, edge.label, evt.clientX, evt.clientY));
  hitArea.addEventListener('pointermove', evt => { if (tooltipEl) showTooltip(title, edge.label, evt.clientX, evt.clientY); });
  hitArea.addEventListener('pointerleave', hideTooltip);

  return { g, edgeEl, from: edge.from, to: edge.to };
}

let liveEdges = []; // { g, edgeEl, from, to } — kept so drags can refresh just the affected ones
let liveNodesById = new Map();

function refreshEdgesForNode(nodeId) {
  for (const e of liveEdges) {
    if (e.from === nodeId || e.to === nodeId) {
      updateEdgeGeometry(e.edgeEl, liveNodesById.get(e.from), liveNodesById.get(e.to));
    }
  }
}

/**
 * renderInteractiveDiagram
 * Clears and rebuilds the whole SVG canvas from the current graph model.
 * @param {Array} nodes
 * @param {Array} edges
 */
function renderInteractiveDiagram(nodes, edges) {
  diagramCanvasEl.innerHTML = '';
  hideTooltip();
  hideSourceSwapPrompt();
  pinnedNodeId = null;

  const bbox = computeContentBBox(nodes);
  viewBoxState = {
    x: bbox.minX - 40,
    y: bbox.minY - 40,
    w: bbox.width + 80,
    h: bbox.height + 80,
  };

  svgEl = createSvgEl('svg', { class: 'erd-svg' });
  applyViewBox();

  // Full-size rect so empty canvas area is a reliable pan target — painted
  // with the blueprint grid pattern (see index.html's <defs>) rather than
  // left transparent, so the grid lives INSIDE this zoomable SVG and scales
  // with viewBoxState the same way every node/edge does. (.diagram-container's
  // CSS background-image is only the idle, pre-visualize fallback — this
  // rect fully covers it the moment a diagram actually renders.)
  const bg = createSvgEl('rect', {
    x: viewBoxState.x - 5000, y: viewBoxState.y - 5000, width: 10000, height: 10000, fill: 'url(#erd-grid-pattern)',
  });
  edgeGroupEl = createSvgEl('g', { class: 'erd-edges' });
  nodeGroupEl = createSvgEl('g', { class: 'erd-nodes' });
  svgEl.append(bg, edgeGroupEl, nodeGroupEl);
  diagramCanvasEl.appendChild(svgEl);

  liveNodesById = new Map(nodes.map(n => [n.id, n]));
  liveEdges = [];

  for (const edge of edges) {
    const built = buildEdgeEl(edge, liveNodesById);
    if (built) { edgeGroupEl.appendChild(built.g); liveEdges.push(built); }
  }
  for (const node of nodes) {
    nodeGroupEl.appendChild(buildNodeEl(node));
  }

  // ── Canvas pan (drag on empty background) ──
  svgEl.addEventListener('pointerdown', evt => {
    if (evt.target !== bg) return; // only pan when starting on empty canvas
    pinnedNodeId = null;
    hideSourceSwapPrompt();
    clearSubgraphHighlight();
    try { svgEl.setPointerCapture(evt.pointerId); } catch { /* not supported everywhere — pan still works without it */ }
    panState = { startClientX: evt.clientX, startClientY: evt.clientY, startVB: { ...viewBoxState } };
    svgEl.classList.add('panning');
  });
  svgEl.addEventListener('pointermove', evt => {
    if (!panState) return;
    const rect = svgEl.getBoundingClientRect();
    const scaleX = panState.startVB.w / rect.width;
    const scaleY = panState.startVB.h / rect.height;
    const dx = (evt.clientX - panState.startClientX) * scaleX;
    const dy = (evt.clientY - panState.startClientY) * scaleY;
    viewBoxState.x = panState.startVB.x - dx;
    viewBoxState.y = panState.startVB.y - dy;
    applyViewBox();
  });
  svgEl.addEventListener('pointerup', () => { panState = null; svgEl.classList.remove('panning'); });

  // ── Wheel: plain scroll (mouse wheel OR two-finger trackpad swipe) PANS;
  // Ctrl/Cmd+scroll (or trackpad pinch, which browsers report as wheel
  // events with ctrlKey:true) ZOOMS, keeping the point under the cursor
  // fixed. This matches Figma/Google-Maps-style canvases and is what
  // stops an ordinary two-finger scroll from being mistaken for a pinch. ──
  svgEl.addEventListener('wheel', evt => {
    evt.preventDefault();
    if (evt.ctrlKey || evt.metaKey) {
      const factor = evt.deltaY > 0 ? 1.1 : 0.9;
      const before = screenToSvgPoint(evt.clientX, evt.clientY);
      const newW = clamp(viewBoxState.w * factor, bbox.width * 0.15, bbox.width * 6 + 800);
      const newH = clamp(viewBoxState.h * factor, bbox.height * 0.15, bbox.height * 6 + 800);
      const actualFactor = newW / viewBoxState.w;
      viewBoxState.x = before.x - (before.x - viewBoxState.x) * actualFactor;
      viewBoxState.y = before.y - (before.y - viewBoxState.y) * actualFactor;
      viewBoxState.w = newW;
      viewBoxState.h = newH;
    } else {
      const rect = svgEl.getBoundingClientRect();
      const scaleX = viewBoxState.w / rect.width;
      const scaleY = viewBoxState.h / rect.height;
      viewBoxState.x += evt.deltaX * scaleX;
      viewBoxState.y += evt.deltaY * scaleY;
    }
    applyViewBox();
  }, { passive: false });
}

/* ═════════════════════════════════════════════════════════════
   MODULE 8 — EXPORT (SVG / PNG / JPG / PDF)
   Always exports the FULL diagram content (fit-to-content), independent
   of the current on-screen pan/zoom — a clone's viewBox is reset to the
   content bounding box before serializing.
   ═════════════════════════════════════════════════════════════ */

function getExportableSvgString() {
  if (!svgEl) return null;
  const clone = svgEl.cloneNode(true);
  const bbox = computeContentBBox(graphNodes);
  const pad = 40;
  clone.setAttribute('viewBox', `${bbox.minX - pad} ${bbox.minY - pad} ${bbox.width + pad * 2} ${bbox.height + pad * 2}`);
  clone.setAttribute('width', Math.round(bbox.width + pad * 2));
  clone.setAttribute('height', Math.round(bbox.height + pad * 2));
  clone.setAttribute('xmlns', SVG_NS);

  // The <use href="#icon-db|#icon-cte"> elements reference <symbol> defs that
  // live in a separate shared <svg> in the page — a standalone exported file
  // needs its own copy of those defs, or the icons render as nothing.
  const sharedDefs = document.querySelector('body > svg defs');
  if (sharedDefs) clone.insertBefore(sharedDefs.cloneNode(true), clone.firstChild);

  // CSS custom properties (var(--x)) don't resolve outside this page, so bake
  // the current theme's actual colors directly onto each element instead of
  // relying on any stylesheet being present in the exported file.
  const computed       = getComputedStyle(document.documentElement);
  const nodeFillTable  = computed.getPropertyValue('--node-table-fill').trim();
  const nodeBorderTable= computed.getPropertyValue('--node-table-border').trim();
  const nodeFillCte    = computed.getPropertyValue('--node-cte-fill').trim();
  const nodeBorderCte  = computed.getPropertyValue('--node-cte-border').trim();
  const edgeJoin       = computed.getPropertyValue('--edge-join').trim();
  const textPrimary    = computed.getPropertyValue('--text-primary').trim();
  const textSecondary  = computed.getPropertyValue('--text-secondary').trim();
  const bgBase         = computed.getPropertyValue('--bg-base').trim() || '#0a0e14';

  clone.querySelectorAll('.erd-node').forEach(g => {
    const isCte = g.classList.contains('is-cte');
    const box = g.querySelector('.erd-node-box');
    if (box) { box.setAttribute('fill', isCte ? nodeFillCte : nodeFillTable); box.setAttribute('stroke', isCte ? nodeBorderCte : nodeBorderTable); box.removeAttribute('class'); }
    const icon = g.querySelector('.erd-node-icon');
    if (icon) { icon.setAttribute('style', `color:${isCte ? nodeBorderCte : textSecondary}`); icon.removeAttribute('class'); }
    const label = g.querySelector('.erd-node-label');
    if (label) { label.setAttribute('fill', textPrimary); label.removeAttribute('class'); }
    g.removeAttribute('class');
  });
  clone.querySelectorAll('.erd-edge-path').forEach(el => {
    // Only lineage edges are ever rendered now (see buildGraphModel), all
    // using the one prominent style — no more join/lineage split to bake in.
    el.setAttribute('stroke', edgeJoin);
    el.setAttribute('stroke-width', '1.75');
    el.setAttribute('stroke-dasharray', '8 5');
    el.setAttribute('fill', 'none');
    el.removeAttribute('class'); // static export — no animation to preserve
  });
  clone.querySelectorAll('.erd-edge-label').forEach(el => { el.setAttribute('fill', textSecondary); el.removeAttribute('class'); });
  clone.querySelectorAll('.erd-edge-label-bg').forEach(el => { el.setAttribute('fill', bgBase); el.setAttribute('opacity', '0.85'); el.removeAttribute('class'); });

  const bgRect = document.createElementNS(SVG_NS, 'rect');
  bgRect.setAttribute('x', bbox.minX - pad);
  bgRect.setAttribute('y', bbox.minY - pad);
  bgRect.setAttribute('width', bbox.width + pad * 2);
  bgRect.setAttribute('height', bbox.height + pad * 2);
  bgRect.setAttribute('fill', bgBase);
  clone.insertBefore(bgRect, clone.firstChild);

  return { svgString: new XMLSerializer().serializeToString(clone), width: bbox.width + pad * 2, height: bbox.height + pad * 2 };
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}

function svgStringToCanvas(svgString, width, height) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const scale = 2; // export at 2x for crisper PNG/JPG/PDF output
      canvas.width = width * scale;
      canvas.height = height * scale;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas);
    };
    img.onerror = reject;
    img.src = url;
  });
}

async function exportDiagram(format) {
  const exported = getExportableSvgString();
  if (!exported) return;
  const { svgString, width, height } = exported;

  if (format === 'svg') {
    downloadBlob(new Blob([svgString], { type: 'image/svg+xml' }), 'erd-diagram.svg');
    return;
  }

  const canvas = await svgStringToCanvas(svgString, width, height);

  if (format === 'png' || format === 'jpg') {
    const mime = format === 'jpg' ? 'image/jpeg' : 'image/png';
    canvas.toBlob(blob => downloadBlob(blob, `erd-diagram.${format}`), mime, 0.95);
    return;
  }

  if (format === 'pdf') {
    const { jsPDF } = window.jspdf;
    const orientation = width >= height ? 'landscape' : 'portrait';
    const pdf = new jsPDF({ orientation, unit: 'pt', format: [width, height] });
    const dataUrl = canvas.toDataURL('image/png', 1.0);
    pdf.addImage(dataUrl, 'PNG', 0, 0, width, height);
    pdf.save('erd-diagram.pdf');
  }
}

/* ─────────────────────────────────────────────────────────────
   UI HELPERS
   ───────────────────────────────────────────────────────────── */

/**
 * setRelationsMetaVisible
 * Keeps #relations-resizer's visibility in lockstep with #relations-meta —
 * a resize handle for a hidden (zero-height) strip has nothing to grab.
 * @param {boolean} visible
 */
function setRelationsMetaVisible(visible) {
  relationsMeta.hidden = !visible;
  relationsResizer.hidden = !visible;
}

function showError(msg) {
  errorState.hidden = false;
  diagramHint.hidden = true;
  setRelationsMetaVisible(false);
  btnDownload.disabled = true;
  errorMessage.textContent = msg;
}

function showDiagram() {
  errorState.hidden = true;
  btnDownload.disabled = false;
  diagramHint.hidden = true;
}

/**
 * renderMetaStrip
 * @param {Array} nodes - buildGraphModel() nodes (carries qualifiedName —
 *   the real dotted identifier — not just the sanitized graph-node id)
 * @param {number} relationCount
 */
function renderMetaStrip(nodes, relationCount) {
  relationsMeta.innerHTML = '';
  if (nodes.length === 0) { setRelationsMetaVisible(false); return; }

  const label = document.createElement('span');
  label.className = 'relations-meta__label';
  label.textContent = `${nodes.length} entities · ${relationCount} relations`;
  relationsMeta.appendChild(label);

  for (const node of nodes) {
    const tag = document.createElement('span');
    tag.className = 'relation-tag';
    tag.textContent = node.isCte ? `◌ ${node.qualifiedName}` : node.qualifiedName;
    tag.title = node.isCte ? 'CTE (click its node to jump to the query)' : 'Physical table';
    relationsMeta.appendChild(tag);
  }
  setRelationsMetaVisible(true);
}

function renderDetectedBadge(dialect, note) {
  detectedBadge.hidden = false;
  detectedBadge.innerHTML = `Detected: <strong>${dialect}</strong>${note ? ` <span class="detected-dialect__note">· ${escapeHtml(note)}</span>` : ''}`;
}

/* ═════════════════════════════════════════════════════════════
   MODULE 9 — VIEW TABS (SQL Query / Formatted SQL)
   ═════════════════════════════════════════════════════════════ */

function switchView(view) {
  const isQuery = view === 'query';
  viewQueryEl.hidden = !isQuery;
  viewFormattedEl.hidden = isQuery;
  viewTabBtns.forEach(btn => {
    const active = btn.dataset.view === view;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
}

/* ─────────────────────────────────────────────────────────────
   MAIN PIPELINE
   ───────────────────────────────────────────────────────────── */

function setActiveDialectButton(dialect) {
  dialectBtns.forEach(btn => btn.classList.toggle('active', btn.dataset.dialect === dialect));
}

/**
 * normalizeSqlText
 * Copy-pasting from Word, Notion, Slack, Confluence, etc. often silently
 * swaps straight quotes for "smart" typographic ones, regular hyphens for
 * en/em dashes, and regular spaces for non-breaking spaces — all of which
 * look identical on screen but make the SQL grammar reject the query with
 * a confusing "unexpected token" error. Normalize them back before we do
 * anything else.
 * @param {string} sql
 * @returns {string}
 */
function normalizeSqlText(sql) {
  return sql
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[\u00A0\u2007\u202F]/g, ' ');
}

// A comma with nothing but whitespace/comments between it and a following
// clause keyword or a closing paren \u2014 i.e. a trailing comma left behind
// after removing the last column from a SELECT/GROUP BY/ORDER BY list, or
// from a parenthesized value list. Deliberately dialect-agnostic (every
// mainstream engine \u2014 Snowflake, Postgres, MySQL, SQLite \u2014 rejects this
// the same way), so this isn't guessing at one dialect's grammar.
const TRAILING_COMMA_RE = new RegExp(
  ',(\\s*(?:--[^\\n]*\\n\\s*|/\\*[\\s\\S]*?\\*/\\s*)*)' +
  '(?=\\b(?:FROM|WHERE|GROUP\\s+BY|ORDER\\s+BY|HAVING|QUALIFY|WINDOW|LIMIT|' +
  'UNION(?:\\s+ALL)?|INTERSECT|EXCEPT|CONNECT\\s+BY)\\b|\\))',
  'gi'
);

/**
 * normalizeTrailingCommas
 * Strips exactly the comma itself (keeping any whitespace/comments after
 * it intact) wherever TRAILING_COMMA_RE matches \u2014 recovering from what's
 * almost always a harmless copy-paste/edit artifact rather than a query
 * the user actually intended to be invalid. Every mainstream dialect
 * rejects this the same way sql-formatter/node-sql-parser do, so silently
 * dropping it changes nothing about the query's meaning.
 * @param {string} sql
 * @returns {{sql: string, removedCount: number}}
 */
function normalizeTrailingCommas(sql) {
  let removedCount = 0;
  const cleaned = sql.replace(TRAILING_COMMA_RE, (_match, gapAfterComma) => {
    removedCount += 1;
    return gapAfterComma;
  });
  return { sql: cleaned, removedCount };
}

/**
 * sanitizeForAstParsing
 * Produces a THROWAWAY variant of the formatted SQL used ONLY to build the
 * AST for relationship extraction — never shown to the user, never sent to
 * the AI, never used for CTE-range lookup (all of those keep using the
 * real, untouched formatted text; see currentFormattedSql).
 *
 * Some dialect-specific expression syntax isn't understood by this build
 * of node-sql-parser and would otherwise fail the WHOLE visualization over
 * one expression deep inside a CTE, even though that expression's actual
 * VALUE has no bearing on the FROM/JOIN/WITH structure this app needs from
 * the AST. Currently handled: Snowflake/BigQuery-style array/object
 * subscript access after a value expression — e.g. `split(a, ' ')[0]` or
 * `col['key']` — which this parser build rejects outright.
 *
 * ASSUMPTION (stated, not silently made): the bracket subscript is DROPPED
 * entirely rather than preserved — safe for relationship extraction, but
 * means a WHERE condition that happens to use subscript access won't
 * round-trip through exprToSql with full fidelity into the generated
 * comparison-query filter. Narrow enough (and rare enough in a WHERE
 * clause specifically) to call out here rather than engineer around.
 *
 * Only strips a "[...]" that immediately follows something that looks like
 * the END of a value expression — this is what distinguishes subscript
 * access from an array LITERAL (`[1, 2, 3]`), which Snowflake also allows
 * and must NOT be touched. Two cases, with different whitespace rules:
 *   - After a closing paren `)`, whitespace before "[" IS allowed — matches
 *     the real-world `func(...) [0]` shape.
 *   - After a bare identifier/quoted-identifier, only a TIGHT (no-space)
 *     "[" counts as a subscript — a SPACE there usually means the previous
 *     token was actually a keyword (e.g. "SELECT [1, 2, 3]", "THEN [1, 2]")
 *     and the bracket starts a fresh array literal, not a subscript.
 *
 * Also handles two more dialect quirks this parser build trips on:
 *   - `TRY_CAST(expr AS type)` — Snowflake's null-safe CAST variant uses the
 *     exact same "expr AS type" grammar as plain CAST, which this parser
 *     DOES understand; it just doesn't recognize TRY_CAST as a synonym for
 *     it. Renaming to CAST for parsing only is semantically inert here —
 *     nothing in this app's relationship extraction depends on the
 *     null-vs-error behavior CAST/TRY_CAST differ on at runtime.
 *   - `<expr> + interval '...'` as the LAST condition inside a JOIN ... ON
 *     clause, directly followed by WHERE — this parser's ON-clause grammar
 *     loses track of where the expression ends right at that boundary
 *     (confirmed: the identical expression parses fine in a WHERE clause,
 *     or in an ON clause followed by another AND, or already parenthesized
 *     — only "ON <expr ending in interval literal> WHERE" fails). Wrapping
 *     every interval literal in an extra parenthesis resolves it and is a
 *     no-op everywhere else parentheses are already harmless.
 * @param {string} formattedSql
 * @returns {string}
 */
function sanitizeForAstParsing(formattedSql) {
  let sql = formattedSql.replace(
    /\)\s*\[[^\[\]]*\]|([A-Za-z0-9_"$])\[[^\[\]]*\]/g,
    (match, identChar) => (identChar !== undefined ? identChar : ')')
  );
  sql = sql.replace(/\bTRY_CAST\s*\(/gi, 'CAST(');
  sql = sql.replace(/\binterval\s+('(?:[^'\\]|\\.)*')/gi, '(interval $1)');
  return sql;
}

async function runPipeline() {
  const pastedSql = normalizeSqlText(sqlInput.value.trim());
  if (!pastedSql) {
    showError('No SQL found. Paste a query into the input panel.');
    return;
  }
  const { sql: rawSql, removedCount: trailingCommasRemoved } = normalizeTrailingCommas(pastedSql);

  try {
    // ── Step 1: Detect dialect — always runs, even if the user manually
    // clicked a different dialect button earlier. That earlier click was
    // just a preview; the real query's content always wins here. ──
    const { dialect } = detectDialect(rawSql);
    activeDialect = dialect;
    renderDetectedBadge(dialect, trailingCommasRemoved
      ? `auto-removed ${trailingCommasRemoved} trailing comma${trailingCommasRemoved > 1 ? 's' : ''}`
      : null);
    setActiveDialectButton(dialect);

    // ── Step 2: Format ──
    const formatted = formatSQL(rawSql, activeDialect);
    sqlInput.value = formatted;
    syncQueryEditor();
    currentFormattedSql = formatted;

    // ── Step 3: Parse to AST ──
    // Parses a sanitized THROWAWAY copy (see sanitizeForAstParsing) — the
    // real `formatted` text above stays untouched for display/CTE-ranges/AI.
    const ast = parseToAST(sanitizeForAstParsing(formatted), activeDialect);
    currentAst = ast;

    // ── Step 4: Extract tables + CTE lineage + JOIN relations ──
    const { tables, relations, cteNames, cteRawNameByEntity, physicalRawNameByEntity } = extractAllRelations(ast);
    if (tables.length === 0) {
      showError('No tables detected in the FROM clause.');
      return;
    }

    // ── Step 4b: Locate each CTE's span in the formatted text ──
    const { ranges, snippets } = computeCteRanges(formatted, cteRawNameByEntity);
    cteRangesByEntity = ranges;
    cteSnippetByEntity = snippets;

    // ── Step 5+6: Build graph model + layout ──
    const { nodes, edges } = buildGraphModel(tables, relations, cteNames, ranges, snippets, physicalRawNameByEntity);
    computeLayout(nodes);
    graphNodes = nodes;
    graphEdges = edges;

    // ── Step 7: Render ──
    renderInteractiveDiagram(nodes, edges);
    showDiagram();
    renderMetaStrip(nodes, edges.length);
    renderFormattedView();
    switchView('formatted'); // show the cleaned-up query right after visualizing

  } catch (err) {
    console.error('[SQL-Vis]', err);
    // node-sql-parser's SyntaxError carries a `location` (line/column into the
    // FORMATTED sql text it was actually parsing) — surfacing it turns a
    // generic PEG-grammar message into something the user can actually go
    // find in their query, instead of scanning the whole thing by eye.
    const location = err && err.location && err.location.start
      ? ` (near line ${err.location.start.line}, column ${err.location.start.column} of the formatted SQL)`
      : '';
    showError(`Could not process this query.\n\n${err.message}${location}`);
  }
}

/* ─────────────────────────────────────────────────────────────
   SECONDARY ACTIONS
   ───────────────────────────────────────────────────────────── */

function clearAll() {
  sqlInput.value = '';
  syncQueryEditor();
  currentFormattedSql = '';
  renderFormattedView();
  diagramCanvasEl.innerHTML = '';
  diagramHint.hidden = false;
  setRelationsMetaVisible(false);
  errorState.hidden = true;
  btnDownload.disabled = true;
  detectedBadge.hidden = true;
  graphNodes = [];
  graphEdges = [];
  currentAst = null;
  pinnedNodeId = null;
  hideSourceSwapPrompt();
  switchView('query');
  sqlInput.focus();
}

function switchDialect(btn) {
  // A manual click previews that dialect right away, but it doesn't "stick":
  // the next Format & Visualize always re-detects from the query's actual
  // content and will move the highlight again if it disagrees.
  activeDialect = btn.dataset.dialect;
  setActiveDialectButton(activeDialect);
  detectedBadge.hidden = true;
}

/* ─────────────────────────────────────────────────────────────
   RESIZABLE PANELS
   Two independent splitters, each remembered across reloads (same
   localStorage pattern as THEME below): the main SQL/ERD panel width
   split, and the ERD-canvas/entities-list height split within the right
   panel. Both default to today's fixed proportions until the user
   actually drags one — nothing changes unless they ask for it.
   ───────────────────────────────────────────────────────────── */

const PANEL_SPLIT_STORAGE_KEY     = 'sqlvis-panel-split';
const RELATIONS_SPLIT_STORAGE_KEY = 'sqlvis-relations-split';
const MIN_PANEL_WIDTH_PX = 280; // keeps either side from being dragged into an unusable sliver

/**
 * wireDragHandle
 * Low-level pointer-drag plumbing shared by both splitters below — it
 * only reports movement deltas via pointer capture (so the drag keeps
 * tracking even once the cursor leaves the thin handle), leaving all
 * layout math to the caller.
 * @param {HTMLElement} handleEl
 * @param {(deltaX:number, deltaY:number) => void} onDrag
 * @param {() => void} [onEnd]
 */
function wireDragHandle(handleEl, onDrag, onEnd) {
  handleEl.addEventListener('pointerdown', evt => {
    evt.preventDefault();
    handleEl.setPointerCapture(evt.pointerId);
    handleEl.classList.add('is-dragging');
    let lastX = evt.clientX;
    let lastY = evt.clientY;

    const onMove = moveEvt => {
      onDrag(moveEvt.clientX - lastX, moveEvt.clientY - lastY);
      lastX = moveEvt.clientX;
      lastY = moveEvt.clientY;
    };
    const onUp = () => {
      handleEl.classList.remove('is-dragging');
      handleEl.removeEventListener('pointermove', onMove);
      handleEl.removeEventListener('pointerup', onUp);
      if (onEnd) onEnd();
    };
    handleEl.addEventListener('pointermove', onMove);
    handleEl.addEventListener('pointerup', onUp);
  });
}

/**
 * initPanelSplitter
 * Drags the width boundary between the SQL panel and the ERD panel.
 * Implemented as a pixel width on the LEFT column only (`--panel-split`);
 * the right column stays `1fr` (fills whatever's left), so a window
 * resize after a manual drag keeps growing/shrinking the right panel
 * rather than fighting the user's chosen split.
 */
function initPanelSplitter() {
  const resizer = document.getElementById('panel-resizer');
  const main = document.querySelector('.app-main');
  const leftPanel = document.querySelector('.panel--input');
  if (!resizer || !main || !leftPanel) return;

  let saved = null;
  try { saved = localStorage.getItem(PANEL_SPLIT_STORAGE_KEY); } catch { /* ignore */ }
  if (saved) main.style.setProperty('--panel-split', saved);

  wireDragHandle(resizer, dx => {
    const mainRect = main.getBoundingClientRect();
    const currentLeftPx = leftPanel.getBoundingClientRect().width;
    const maxLeftPx = mainRect.width - MIN_PANEL_WIDTH_PX - resizer.getBoundingClientRect().width;
    const newLeftPx = clamp(currentLeftPx + dx, MIN_PANEL_WIDTH_PX, Math.max(MIN_PANEL_WIDTH_PX, maxLeftPx));
    main.style.setProperty('--panel-split', `${newLeftPx}px`);
  }, () => {
    try { localStorage.setItem(PANEL_SPLIT_STORAGE_KEY, main.style.getPropertyValue('--panel-split')); }
    catch { /* storage unavailable — split just won't persist */ }
  });
}

/**
 * initRelationsSplitter
 * Drags the height boundary between the ERD canvas and the entities/
 * relations strip below it — an explicit height on #relations-meta
 * (flex-basis, effectively) rather than touching the canvas directly,
 * since the canvas already just fills whatever's left via `flex: 1`.
 */
function initRelationsSplitter() {
  if (!relationsResizer) return;
  const outputPanel = document.querySelector('.panel--output');

  let saved = null;
  try { saved = localStorage.getItem(RELATIONS_SPLIT_STORAGE_KEY); } catch { /* ignore */ }
  if (saved) relationsMeta.style.height = saved;

  wireDragHandle(relationsResizer, (dx, dy) => {
    const currentHeight = relationsMeta.getBoundingClientRect().height;
    const panelHeight = outputPanel.getBoundingClientRect().height;
    // Dragging UP (dy < 0) hands the strip below MORE space, not less.
    const newHeight = clamp(currentHeight - dy, 32, Math.max(32, panelHeight - 160));
    relationsMeta.style.height = `${newHeight}px`;
  }, () => {
    try { localStorage.setItem(RELATIONS_SPLIT_STORAGE_KEY, relationsMeta.style.height); }
    catch { /* storage unavailable — split just won't persist */ }
  });
}

/* ─────────────────────────────────────────────────────────────
   THEME (dropdown, persisted to localStorage — this is a plain
   static site, not a sandboxed preview, so normal browser storage
   is expected and safe here)
   ───────────────────────────────────────────────────────────── */

const THEME_STORAGE_KEY = 'sqlvis-theme';

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  themeSelect.value = theme;
  try { localStorage.setItem(THEME_STORAGE_KEY, theme); } catch { /* storage unavailable — theme just won't persist */ }
}

function loadSavedTheme() {
  let saved = null;
  try { saved = localStorage.getItem(THEME_STORAGE_KEY); } catch { /* ignore */ }
  applyTheme(saved || 'dark');
}

/* ─────────────────────────────────────────────────────────────
   EVENT BINDINGS
   ───────────────────────────────────────────────────────────── */
btnVisualize.addEventListener('click', runPipeline);
btnClear.addEventListener('click', clearAll);
btnDownload.addEventListener('click', () => exportDiagram(exportFormatSel.value));

sqlInput.addEventListener('input', syncQueryEditor);
sqlInput.addEventListener('scroll', syncQueryEditorScroll);
sqlInput.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    runPipeline();
  }
  if (e.key === 'Tab') {
    e.preventDefault();
    const { selectionStart: start, selectionEnd: end } = sqlInput;
    sqlInput.value = sqlInput.value.slice(0, start) + '  ' + sqlInput.value.slice(end);
    sqlInput.selectionStart = sqlInput.selectionEnd = start + 2;
    syncQueryEditor();
  }
});

formattedScroll.addEventListener('scroll', syncFormattedScroll);

dialectBtns.forEach(btn => btn.addEventListener('click', () => switchDialect(btn)));
viewTabBtns.forEach(btn => btn.addEventListener('click', () => switchView(btn.dataset.view)));
themeSelect.addEventListener('change', () => applyTheme(themeSelect.value));

/* ─────────────────────────────────────────────────────────────
   INIT
   ───────────────────────────────────────────────────────────── */
loadSavedTheme();
syncQueryEditor();
renderFormattedView();
setActiveDialectButton(activeDialect);
switchView('query');
initPanelSplitter();
initRelationsSplitter();
