/**
 * READING SQL WITHOUT A DATABASE
 * ==============================
 *
 * The security gate has to answer questions about a schema it cannot run: is row
 * level security on for this table, what does this policy actually allow, can a
 * signed-in user write the column that says an order was paid. Those questions
 * are answered by reading the migration files, because a schema is the only
 * place the answer exists — and a gate that needs a live database is a gate that
 * runs late, or not at all.
 *
 * What this reads, and how carefully:
 *
 *   Statements   Split on semicolons, except inside strings, quoted identifiers,
 *                comments and dollar-quoted function bodies. `$$ ... $$` and
 *                `$tag$ ... $tag$` are the two forms migrations actually use,
 *                and a naive split on ';' turns one function into a dozen
 *                statements that parse as nonsense.
 *   Text         Comments are removed before matching, so a commented-out
 *                `alter table ... enable row level security` is not mistaken for
 *                the real thing. That is precisely the mistake that would let a
 *                table ship unprotected with a green tick next to it.
 *   Folders      Files are read in name order, because that is the order a
 *                migration runner applies them in, and a later statement can
 *                legitimately change an earlier one.
 *
 * What it does not do: understand SQL. It recognises the shapes that carry
 * security meaning and reports the rest as `other`. It is a reader, not a
 * parser, and every rule built on it only claims what those shapes say.
 */

/* ── text handling ────────────────────────────────────────────────────────── */

/**
 * Remove comments, keeping the text so offsets stay meaningful.
 *
 * Comments are replaced by a single space rather than deleted, so a statement
 * that had a comment in the middle does not have its two halves welded together
 * into something that matches nothing.
 */
export function stripSqlComments(sql) {
  let out = '';
  let i = 0;
  const s = String(sql);
  while (i < s.length) {
    const ch = s[i];
    if (ch === '-' && s[i + 1] === '-') {
      const end = s.indexOf('\n', i);
      out += ' ';
      i = end === -1 ? s.length : end;
      continue;
    }
    if (ch === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      out += ' ';
      i = end === -1 ? s.length : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const close = findStringEnd(s, i);
      out += s.slice(i, close);
      i = close;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Index just past a quoted run, honouring the doubled-quote escape. */
function findStringEnd(s, start) {
  const quote = s[start];
  let i = start + 1;
  while (i < s.length) {
    if (s[i] === quote) {
      if (s[i + 1] === quote) { i += 2; continue; }   // '' inside a literal
      return i + 1;
    }
    i += 1;
  }
  return s.length;
}

/** Index just past a dollar-quoted body, or -1 if the tag does not open one. */
function findDollarEnd(s, start) {
  const tagMatch = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(s.slice(start));
  if (!tagMatch) return -1;
  const tag = tagMatch[0];
  const end = s.indexOf(tag, start + tag.length);
  return end === -1 ? s.length : end + tag.length;
}

/**
 * Split a migration into statements.
 *
 * Each statement carries the file and line it started on, because "table X has
 * no policy" is not actionable without knowing which file to open, and a person
 * reading a report should not have to grep for it.
 */
export function splitStatements(sql, file = '(sql)') {
  const s = String(sql);
  const out = [];
  let start = 0;
  let i = 0;

  const push = (end) => {
    const raw = s.slice(start, end);
    const text = raw.trim();
    if (!text) return;
    // A statement made only of comments produces nothing after stripping.
    const code = stripSqlComments(text).trim();
    if (!code) return;
    const line = s.slice(0, start).split('\n').length;
    out.push({ raw: text, code, file, line, start });
  };

  while (i < s.length) {
    const ch = s[i];
    if (ch === '-' && s[i + 1] === '-') {
      const end = s.indexOf('\n', i);
      i = end === -1 ? s.length : end;
      continue;
    }
    if (ch === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      i = end === -1 ? s.length : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"') { i = findStringEnd(s, i); continue; }
    if (ch === '$') {
      const end = findDollarEnd(s, i);
      if (end !== -1) { i = end; continue; }
    }
    if (ch === ';') { push(i); i += 1; start = i; continue; }
    i += 1;
  }
  push(s.length);
  return out;
}

/** `public.orders` and `orders` are the same table. */
export function normaliseTable(name) {
  const clean = String(name || '').trim().replace(/^"|"$/g, '');
  const parts = clean.split('.').map((p) => p.replace(/^"|"$/g, '').trim());
  if (parts.length === 1) return { schema: 'public', table: parts[0], full: `public.${parts[0]}` };
  return { schema: parts[0], table: parts[1], full: `${parts[0]}.${parts[1]}` };
}

/* ── statement shapes ─────────────────────────────────────────────────────── */

const ident = '(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)';
const tableRef = `(${ident}(?:\\s*\\.\\s*${ident})?)`;

/** Collapse whitespace so patterns do not have to care about line breaks. */
const flat = (s) => String(s).replace(/\s+/g, ' ').trim();

/**
 * Everything about one migration file, in the order a database would see it.
 *
 * The facts are deliberately coarse — a table, whether RLS is on, a list of
 * policies, a list of functions — because that is the level at which the
 * security rules are written, and a more detailed model would be a model that
 * can be wrong.
 */
export function readSchema(files) {
  const tables = new Map();     // full name -> { schema, name, rls, forceRls, columns, policies, grants }
  const functions = [];
  const statements = [];
  const other = [];

  const table = (raw) => {
    const { schema, table: name, full } = normaliseTable(raw);
    if (!tables.has(full)) {
      tables.set(full, {
        schema, name, full, rls: false, forceRls: false,
        columns: [], policies: [], grants: [], file: null, line: null,
        enableCount: 0, disableCount: 0, policyCount: 0,
      });
    }
    return tables.get(full);
  };

  for (const file of files) {
    for (const st of splitStatements(file.sql, file.path)) {
      statements.push(st);
      const code = flat(st.code);
      let matched = false;

      // ── create table
      let m = new RegExp(`^create\\s+(?:unlogged\\s+)?table\\s+(?:if\\s+not\\s+exists\\s+)?${tableRef}\\s*\\(`, 'i').exec(code);
      if (m) {
        const t = table(m[1]);
        t.file = t.file || st.file;
        t.line = t.line || st.line;
        t.columns.push(...readColumns(st.code.slice(st.code.indexOf('('))));
        matched = true;
      }

      // ── alter table ... enable/disable row level security
      if (!matched) {
        m = new RegExp(`^alter\\s+table\\s+(?:only\\s+)?${tableRef}\\s+(.*)$`, 'i').exec(code);
        if (m) {
          const t = table(m[1]);
          t.file = t.file || st.file;
          t.line = t.line || st.line;
          const actions = m[2];
          if (/\benable\s+row\s+level\s+security\b/i.test(actions)) {
            t.rls = true; t.enableCount += 1;
          }
          if (/\bdisable\s+row\s+level\s+security\b/i.test(actions)) {
            t.rls = false; t.disableCount += 1;
          }
          if (/\bforce\s+row\s+level\s+security\b/i.test(actions)) t.forceRls = true;
          if (/\bno\s+force\s+row\s+level\s+security\b/i.test(actions)) t.forceRls = false;
          for (const g of actions.matchAll(/\bgrant\s+([^;]+?)\s+on\b/gi)) t.grants.push(flat(g[1]));
          matched = true;
        }
      }

      // ── create policy
      if (!matched) {
        m = new RegExp(`^create\\s+policy\\s+(?:if\\s+not\\s+exists\\s+)?("?[^"]+"?|${ident})\\s+on\\s+${tableRef}\\s*(.*)$`, 'i').exec(code);
        if (m) {
          const t = table(m[2]);
          t.file = t.file || st.file;
          t.line = t.line || st.line;
          const rest = m[3] || '';
          const policy = {
            name: m[1].replace(/^"|"$/g, ''),
            table: t.full,
            file: st.file,
            line: st.line,
            command: readCommand(rest),
            roles: readRoles(rest),
            using: readClause(rest, 'using'),
            check: readClause(rest, 'with check'),
            permissive: !/\bas\s+restrictive\b/i.test(rest),
            raw: code,
          };
          t.policies.push(policy);
          t.policyCount += 1;
          matched = true;
        }
      }

      // ── drop policy (a later statement can remove an earlier one)
      if (!matched) {
        m = /^drop\s+policy\s+(?:if\s+exists\s+)?("?[^"]+"?)\s+on\s+/i.exec(code);
        if (m) {
          const name = m[1].replace(/^"|"$/g, '');
          for (const t of tables.values()) t.policies = t.policies.filter((p) => p.name !== name);
          matched = true;
        }
      }

      // ── drop table
      if (!matched) {
        m = new RegExp(`^drop\\s+table\\s+(?:if\\s+exists\\s+)?${tableRef}`, 'i').exec(code);
        if (m) { tables.delete(normaliseTable(m[1]).full); matched = true; }
      }

      // ── create function / procedure
      if (!matched) {
        m = new RegExp(`^create\\s+(?:or\\s+replace\\s+)?(?:function|procedure)\\s+(${ident}(?:\\s*\\.\\s*${ident})?)\\s*\\(`, 'i').exec(code);
        if (m) {
          const { full } = normaliseTable(m[1].replace(/\s*\.\s*/, '.'));
          functions.push({
            name: full.split('.').pop(),
            full,
            file: st.file,
            line: st.line,
            securityDefiner: /\bsecurity\s+definer\b/i.test(code),
            securityInvoker: /\bsecurity\s+invoker\b/i.test(code),
            setsSearchPath: /\bset\s+search_path\b/i.test(code),
            language: (/\blanguage\s+(\w+)/i.exec(code) || [])[1] || null,
            writesStatus: /\b(?:update|insert\s+into)\b[\s\S]{0,200}\bstatus\b/i.test(code),
            body: code,
          });
          matched = true;
        }
      }

      // ── grant / revoke at the statement level
      if (!matched && /^(grant|revoke)\b/i.test(code)) {
        const g = /^(grant|revoke)\s+([\s\S]+?)\s+on\s+([\s\S]+?)(?:\s+to\s+([\s\S]+))?$/i.exec(code);
        if (g) {
          other.push({ kind: 'grant', verb: g[1].toLowerCase(), what: flat(g[2]), on: flat(g[3]), to: g[4] ? flat(g[4]) : null, file: st.file, line: st.line });
        }
        matched = true;
      }

      // ── everything else, kept so a rule can look for a pattern later
      if (!matched) {
        other.push({ kind: 'other', text: code, file: st.file, line: st.line });
      }
    }
  }

  return {
    tables: [...tables.values()].sort((a, b) => a.full.localeCompare(b.full)),
    functions,
    statements,
    other,
  };
}

function readCommand(rest) {
  const m = /\bfor\s+(all|select|insert|update|delete)\b/i.exec(rest);
  return m ? m[1].toLowerCase() : 'all';
}

function readRoles(rest) {
  // `to public` and `to authenticated, anon` are both common.
  const m = /\bto\s+([^)]+?)(?=\s+(?:using|with\s+check)\b|$)/i.exec(rest);
  if (!m) return ['public'];
  return m[1].split(',').map((r) => r.trim().toLowerCase()).filter(Boolean);
}

function readClause(rest, keyword) {
  const re = new RegExp(`\\b${keyword}\\s*\\(`, 'i');
  const m = re.exec(rest);
  if (!m) return null;
  // Walk the parentheses so a nested pair inside the expression does not end it
  // early: `using (owner = auth.uid())` is simple, but `using ((a and b) or c)`
  // is legal and a naive match stops inside it.
  let depth = 0;
  let i = m.index + m[0].length - 1;
  const start = i;
  for (; i < rest.length; i += 1) {
    if (rest[i] === '(') depth += 1;
    else if (rest[i] === ')') {
      depth -= 1;
      if (depth === 0) return flat(rest.slice(start + 1, i));
    }
  }
  return flat(rest.slice(start + 1));
}

/** Column names and types from a create-table body. */
function readColumns(body) {
  // Only the top level: a `primary key (a, b)` line and nested parens are not
  // columns, and treating them as ones invents columns that do not exist.
  let depth = 0;
  let current = '';
  const parts = [];
  for (const ch of String(body)) {
    if (ch === '(') depth += 1;
    if (ch === ')') { depth -= 1; if (depth === 0 && current) { /* closing the table */ } }
    if (ch === ',' && depth === 1) { parts.push(current); current = ''; continue; }
    current += ch;
    if (depth === 0 && parts.length) break;
  }
  if (current) parts.push(current);

  const columns = [];
  for (const raw of parts) {
    const line = flat(raw.replace(/^\(/, '')).trim();
    if (!line) continue;
    if (/^(primary|unique|foreign|check|constraint|exclude|like)\b/i.test(line)) continue;
    const m = /^("?[A-Za-z_][A-Za-z0-9_$]*"?)\s+([A-Za-z][A-Za-z0-9_ ()]*?)(?:\s+(default|not null|primary key|unique|references|check|generated)\b[\s\S]*)?$/i.exec(line);
    if (!m) continue;
    const name = m[1].replace(/^"|"$/g, '');
    if (!name) continue;
    columns.push({
      name,
      type: flat(m[2] || '').toLowerCase(),
      notNull: /\bnot\s+null\b/i.test(line),
      primaryKey: /\bprimary\s+key\b/i.test(line),
      default: (/default\s+([^,]+?)(?:\s+(?:not\s+null|primary\s+key|unique|references|check)|$)/i.exec(line) || [])[1] || null,
      references: (/references\s+([A-Za-z0-9_."]+)/i.exec(line) || [])[1] || null,
      line: line.slice(0, 120),
    });
  }
  return columns;
}
