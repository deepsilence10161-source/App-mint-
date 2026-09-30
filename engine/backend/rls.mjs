/**
 * THE ROW LEVEL SECURITY GATE
 * ===========================
 *
 * A mobile app cannot keep a secret. Its key is inside the app, on a phone
 * anybody can take apart, so every rule about who may read and write what has to
 * live in the database. That makes row level security the only thing standing
 * between a published app and everyone else's data — and it is exactly the part
 * nobody can check by looking at the app.
 *
 * This gate reads the migrations and answers the questions that decide whether
 * the backend is safe:
 *
 *   Is every table protected?        RLS off is not "less strict", it is "open".
 *   Who can write, and to what?      A write policy for an anonymous role is a
 *                                    public API for changing other people's data.
 *   Can a signed-in user move their  The classic hole: an update policy without
 *   own row out of their own scope?  a WITH CHECK lets a client rewrite the very
 *                                    column the policy trusts.
 *   Can a client say "this is paid"? Money has to be decided by the server that
 *                                    saw the payment, never by the client.
 *   Are the functions trustworthy?   SECURITY DEFINER without a fixed
 *                                    search_path can be made to run other code.
 *
 * Two things this deliberately is not:
 *
 *   It is not a substitute for testing against a real database. It reads text,
 *   and text can be wrong in ways only a database notices — a policy that
 *   references a missing function, a column with a confusing name.
 *
 *   It is not a claim that a schema is secure. It is a claim that these
 *   particular holes are not present. Every finding says what it saw, so it can
 *   be argued with; nothing here says "secure" without saying what was checked.
 */

import { readSchema, normaliseTable } from './sql.mjs';

const F = (code, level, title, detail, action, evidence = []) => ({ code, level, title, detail, action, evidence });

/** Columns whose name means "who is allowed to touch this row". */
const OWNER_COLUMNS = ['owner', 'owner_id', 'user_id', 'uid', 'account_id', 'profile_id', 'created_by', 'author_id', 'customer_id'];

/** Columns whose name means "this row has been paid for". */
const MONEY_COLUMNS = ['status', 'payment_status', 'paid', 'is_paid', 'state', 'order_status'];

const CLIENT_ROLES = new Set(['public', 'anon', 'authenticated']);

const levelRank = (l) => ({ blocking: 0, warning: 1, info: 2 }[l] ?? 3);

/**
 * Where a client can put a value of its own choosing into a payment column.
 *
 * Split out because two rules need the same answer — the rule that reports the
 * hole, and the rule that checks the specification against it — and a second
 * implementation of "can the client write this" is a second answer that can
 * differ from the first.
 */
export function paymentExposure(schema) {
  const open = [];
  const pinned = [];

  for (const t of schema.tables) {
    const money = t.columns.map((c) => c.name).filter((n) => MONEY_COLUMNS.includes(n.toLowerCase()));
    if (!money.length) continue;

    for (const p of t.policies) {
      if (!isWriteCommand(p.command)) continue;
      if (!p.roles.some((r) => CLIENT_ROLES.has(r))) continue;
      if (isUnconditional(p.using) || isUnconditional(p.check)) {
        open.push({ table: t.full, columns: money, policy: p, values: [] });
        continue;
      }

      // What the new row must look like. For an UPDATE the WITH CHECK decides
      // the state the row may end in, which is the one that matters.
      const constraint = p.check ?? (p.command === 'insert' ? p.using : null);
      const values = {};
      const free = [];
      for (const col of money) {
        const pin = pinnedValues(constraint, col);
        if (pin.length) values[col] = pin; else free.push(col);
      }
      if (free.length) open.push({ table: t.full, columns: free, policy: p, values: [] });
      else pinned.push({ table: t.full, columns: money, policy: p, values: [...new Set(Object.values(values).flat())] });
    }
  }
  return { open, pinned };
}

/**
 * The literal values a policy pins a column to.
 *
 * `status = 'awaiting_payment'`, `status in ('a','b')`, `paid = false`. Returns
 * an empty list when the column is compared to something a caller supplies,
 * which is the case that matters: no literal means the client chooses.
 */
function pinnedValues(expression, column) {
  if (!expression) return [];
  const e = String(expression);
  const name = column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const out = [];

  for (const m of e.matchAll(new RegExp(`\\b${name}\\s*=\\s*('([^']*)'|true|false|\\d+)`, 'gi'))) out.push(m[1].replace(/^'|'$/g, ''));
  for (const m of e.matchAll(new RegExp(`\\b${name}\\s+in\\s*\\(([^)]*)\\)`, 'gi'))) {
    for (const v of m[1].split(',')) {
      const clean = v.trim().replace(/^'|'$/g, '');
      if (clean) out.push(clean);
    }
  }
  return out;
}


/**
 * Literally always true.
 *
 * `using (true)` and `using (1 = 1)` mean the policy permits everything for the
 * roles it names: it looks like a policy and behaves like no policy at all.
 * Only whole-expression forms count — `using (owner = auth.uid() or true)` is
 * also always true and is caught separately, because a fragment test would miss
 * it and a fragment test that catches it by accident would also flag
 * `using (is_public or owner = auth.uid())`, which is legitimate.
 */
function isUnconditional(expression) {
  if (expression === null || expression === undefined) return false;
  const e = String(expression).trim().toLowerCase().replace(/^\((.*)\)$/s, '$1').trim();
  if (e === 'true') return true;
  if (/^(1\s*=\s*1|0\s*=\s*0\s*or\s*true|true\s*or\s*false)$/.test(e)) return true;
  // `a or true`, in any arrangement, is true whenever a is.
  if (/\bor\s+true\b/.test(e)) return true;
  return false;
}

function mentionsUserScope(expression) {
  if (!expression) return false;
  return /auth\.uid\s*\(|auth\.jwt\s*\(|current_setting\s*\(\s*'request\.jwt|auth\.role\s*\(/i.test(expression);
}

const isWriteCommand = (command) => command === 'all' || command === 'insert' || command === 'update' || command === 'delete';

/** Does this policy's expression name one of these columns at all? */
function mentionsAny(expression, names) {
  if (!expression) return false;
  const e = String(expression).toLowerCase();
  return names.some((n) => new RegExp(`(?:^|[^a-z0-9_])${n}(?:[^a-z0-9_]|$)`, 'i').test(e));
}

/* ── the rules ────────────────────────────────────────────────────────────── */

/**
 * Every rule, run over a schema.
 *
 * Each rule is separate and named, so a report can be argued with a rule at a
 * time, and so a test can prove that one rule fires without the others helping.
 */
export function rulesFor(schema, { spec = null } = {}) {
  const found = [];

  for (const t of schema.tables) {
    const where = t.file ? `${t.file}${t.line ? `:${t.line}` : ''}` : null;
    const isAuthTable = t.schema === 'auth' || t.schema === 'storage';
    // Supabase's own tables are managed by the platform; the gate is about the
    // schema this project owns.
    if (isAuthTable) continue;

    // ── RLS is not on at all
    if (!t.rls && t.enableCount === 0) {
      found.push(F('RLS_MISSING', 'blocking', `${t.full} has row level security switched off`,
        `Every row in ${t.full} is readable and writable by anyone holding the app's key, which is everyone who installs the app. Row level security is off until it is explicitly switched on.`,
        `Add: alter table ${t.full} enable row level security; and policies for the operations the app needs.`,
        where ? [where] : []));
    }

    // ── RLS was switched on and later off
    if (!t.rls && t.enableCount > 0) {
      found.push(F('RLS_DISABLED_AGAIN', 'blocking', `${t.full} had row level security switched off again`,
        `A later statement disables row level security on ${t.full}. The table looks protected to anyone reading the first migration, and is not protected at all.`,
        `Remove the disable statement, or the table's data is public.`,
        where ? [where] : []));
    }

    if (t.rls) {
      if (!t.policies.length) {
        found.push(F('RLS_NO_POLICY', 'warning', `${t.full} is protected but unusable`,
          `Row level security is on for ${t.full} and no policy grants anything, so every query returns nothing and every write is refused — for the app as well.`,
          `Add policies for the operations the app performs.`,
          where ? [where] : []));
      }
      if (!t.forceRls) {
        found.push(F('RLS_NOT_FORCED', 'info', `${t.full} does not force row level security`,
          `The table's owner still bypasses its own policies. That is usually what you want, and it is worth knowing: anything running as the owner has full access regardless of the policies below.`,
          `Add: alter table ${t.full} force row level security; if not even the owner should bypass them.`,
          where ? [where] : []));
      }
    }

    // ── the policies themselves
    for (const p of t.policies) {
      const at = `${p.file}${p.line ? `:${p.line}` : ''}`;
      const anonymous = p.roles.some((r) => r === 'anon' || r === 'public');
      const write = isWriteCommand(p.command);

      /*
       * Each clause is judged on its own.
       *
       * The first version joined USING and WITH CHECK with "and" and tested the
       * result, so `using (true) with check (true)` became "true and true" and
       * stopped looking unconditional — the rule missed the exact policy it was
       * written for. Two clauses joined by a conjunction are not one condition.
       */
      const clauses = [p.using, p.check].filter((c) => c !== null && c !== undefined);
      const anyUnconditional = clauses.some(isUnconditional);
      const allUnconditional = clauses.length > 0 && clauses.every(isUnconditional);
      const expression = clauses.join(' and ');

      // (1) the anonymous role, with no condition at all
      if (anonymous && anyUnconditional) {
        found.push(F('POLICY_ANON_UNRESTRICTED', 'blocking',
          `Anyone at all can ${write ? 'change' : 'read'} every row of ${t.full}`,
          `Policy "${p.name}" applies to the ${p.roles.join(' and ')} role and its condition is always true. That role is the key shipped inside every copy of the app, so this row set is public: readable, and ${write ? 'writable, ' : ''}by anyone who installs it.`,
          write
            ? `Name the signed-in role instead (to authenticated) and add the condition the data needs.`
            : `If this table is genuinely public, say so in the specification as well. Otherwise scope the policy, for example to authenticated, or to published rows only.`,
          [at]));
      }

      // (2) a write policy for the anonymous role, even when it is conditional
      if (write && anonymous && !anyUnconditional) {
        found.push(F('POLICY_WRITE_ANON', 'blocking', `Anyone can ${p.command === 'all' ? 'read and write' : p.command} rows in ${t.full}`,
          `Policy "${p.name}" lets the ${p.roles.join(' and ')} role ${p.command === 'all' ? 'read and write' : p.command} rows in ${t.full}. The anonymous role is the key shipped inside the app, so this is public access — the condition decides which rows, not who may ask.`,
          `Name the signed-in role instead (to authenticated), and make the policy depend on auth.uid().`,
          [at]));
      }

      // (3) a write policy that permits everything, whatever role it names
      if (write && anyUnconditional && !anonymous) {
        found.push(F('POLICY_UNCONDITIONAL_WRITE', 'blocking', `The policy on ${t.full} permits everything`,
          `Policy "${p.name}" contains a condition that is always true, so it allows every ${p.command === 'all' ? 'write' : p.command} from every role it names. A policy in this form is not a restriction; it is a declaration that there is none.`,
          `Write the condition the data actually requires, for example using (owner = auth.uid()).`,
          [at]));
      }

      // (4) reading everything, for everyone who is signed in
      if (!write && !anonymous && p.command === 'select' && allUnconditional) {
        found.push(F('POLICY_UNCONDITIONAL_READ', 'warning', `Every signed-in user can read every row of ${t.full}`,
          `Policy "${p.name}" applies to the authenticated role with no condition, so every account can read the whole table. That is right for a shared catalogue and wrong for anything belonging to a person.`,
          `Scope it to the rows the reader should see, or confirm the table is meant to be shared.`,
          [at]));
      }

      // (5) a write policy that does not say what the row must look like afterwards
      if ((p.command === 'insert' || p.command === 'update') && p.check === null && !anyUnconditional) {
        found.push(F('POLICY_WRITE_NO_CHECK', 'blocking', `The ${p.command} policy on ${t.full} does not check the new row`,
          `Policy "${p.name}" decides which rows can be ${p.command}ed with USING, and says nothing about what the row must look like afterwards. A client can take a row it is allowed to touch and rewrite the column the policy trusts — its own owner column — handing the row to somebody else or taking one over.`,
          `Add WITH CHECK with the same condition as USING.`,
          [at]));
      }

      // (6) a policy with no connection to the person asking, or to the row
      const ownerCols = t.columns.map((c) => c.name).filter((n) => OWNER_COLUMNS.includes(n.toLowerCase()));
      if (p.permissive && !anyUnconditional && !mentionsUserScope(expression) && !mentionsAny(expression, ownerCols)) {
        found.push(F('POLICY_NO_ROW_SCOPE', 'warning', `The policy on ${t.full} does not decide by the row or by the reader`,
          `Policy "${p.name}" depends on something other than who is asking (it does not use auth.uid()) and other than the row itself (it names no owner column). Every caller it applies to sees the same rows — which is exactly right for an admin or public table, and a leak for anything belonging to a person.`,
          `Confirm it is meant to be shared. If rows belong to users, scope it to auth.uid().`,
          [at]));
      }

      // (7) identity taken from a value the caller can set
      const setting = /current_setting\s*\(\s*'([^']+)'/i.exec(expression || '');
      if (setting && !/^request\.jwt\b/i.test(setting[1]) && !/^request\.headers\b/i.test(setting[1])) {
        found.push(F('POLICY_TRUSTS_CLIENT_SETTING', 'blocking', `The policy on ${t.full} trusts a value the caller can set`,
          `Policy "${p.name}" reads current_setting('${setting[1]}'). The request.jwt settings are written by the server from the signed-in token, but a settings key like this one can be set by the client on its own connection — so this policy can be made to say whatever the caller wants.`,
          `Use auth.uid() (or request.jwt.claims), which the server derives from the token and the caller cannot rewrite.`,
          [at]));
      }
    }
  }

  /* ── the money rule ─────────────────────────────────────────────────────── */
  /*
   * The most valuable single check here, and the one that was wrong first.
   *
   * The question is not "does a client-write policy exist on a table with a
   * status column" — the first version asked that and flagged a correct schema,
   * because a person is allowed to *create* an order and a policy that says the
   * order must start in the state the app is allowed to ask for is exactly
   * right. The question is whether a client can put the column into a state of
   * its own choosing. So the check reads what the policy pins:
   *
   *   pinned      `with check (status = 'awaiting_payment')` — the app may create
   *               rows only in that state. Nothing is exposed.
   *   unpinned    no condition on the column at all, or a condition against a
   *               value the caller supplies. The client decides, and anything
   *               reading that column as proof of payment can be fooled.
   */
  const moneyExposure = paymentExposure(schema);
  for (const m of moneyExposure.open) {
    found.push(F('CLIENT_CAN_WRITE_PAYMENT_STATE', 'blocking', `The app can set ${m.columns.map((c) => `"${c}"`).join(' or ')} on ${m.table} to whatever it likes`,
      `${m.table} records whether something has been paid, and policy "${m.policy.name}" lets the app ${m.policy.command === 'insert' ? 'create rows' : 'change rows'} without saying what the value must be afterwards. A client that can run that statement can write any value into that column, so anything treated as proof of payment can be faked without going near the store.`,
      `Pin the column in the policy for creation — with check (status = 'awaiting_payment') — and take updates to it away from the app entirely. The status belongs to a function that verifies the receipt with the server's own rights.`,
      [`${m.policy.file}${m.policy.line ? `:${m.policy.line}` : ''}`]));
  }
  for (const m of moneyExposure.pinned) {
    found.push(F('PAYMENT_STATE_PINNED', 'info', `The app may ${m.policy.command} ${m.table} only in ${m.values.map((v) => `'${v}'`).join(', ')}`,
      `Policy "${m.policy.name}" pins ${m.columns.map((c) => `"${c}"`).join(', ')} to a fixed value, so a client cannot choose it. This is what a correct creation policy looks like.`,
      `Nothing to do.`,
      [`${m.policy.file}${m.policy.line ? `:${m.policy.line}` : ''}`]));
  }

  /* ── functions ──────────────────────────────────────────────────────────── */
  for (const fn of schema.functions) {
    const at = `${fn.file}${fn.line ? `:${fn.line}` : ''}`;
    if (fn.securityDefiner && !fn.setsSearchPath) {
      found.push(F('DEFINER_WITHOUT_SEARCH_PATH', 'blocking', `${fn.full} runs as its owner without a fixed search path`,
        `A SECURITY DEFINER function runs with the rights of the user who created it, and this one does not pin search_path. A caller who can create a table earlier on the search path can change which table the function believes it is writing to.`,
        `Add SET search_path = '' (or the exact schemas it needs) to the function definition.`,
        [at]));
    }
    if (fn.securityDefiner && fn.writesStatus) {
      const takesStatusArgument = /\b(status|paid|state)\s*=\s*(?:p_|v_|new\.|in_)?\w*(status|paid|state)\w*/i.test(fn.body)
        || /\bupdate\b[\s\S]{0,80}\bset\b[\s\S]{0,80}\bstatus\s*=\s*\$\$/i.test(fn.body);
      if (takesStatusArgument) {
        found.push(F('SERVER_WRITES_CALLER_STATUS', 'warning', `${fn.full} writes the status it is given`,
          `This function sets a payment status from a value handed to it by the caller. If the caller is the app, the app is still deciding whether something is paid — the function only moved the decision, it did not verify anything.`,
          `Have the function verify the receipt with the store, or call a server-only function, before writing the status.`,
          [at]));
      } else {
        found.push(F('SERVER_WRITES_STATUS', 'info', `${fn.full} writes a payment status`,
          `Something server-side writes the status column. Confirm it checks the payment before it does.`,
          `Nothing to do if it verifies with the store first.`,
          [at]));
      }
    }
  }

  /* ── grants ─────────────────────────────────────────────────────────────── */
  for (const g of schema.other.filter((o) => o.kind === 'grant')) {
    const at = `${g.file}${g.line ? `:${g.line}` : ''}`;
    const toAnon = /\b(anon|public)\b/i.test(g.to || '');
    if (toAnon && /all/i.test(g.what)) {
      found.push(F('GRANT_ALL_TO_ANON', 'blocking', `All privileges on ${g.on} are granted to ${g.to}`,
        `GRANT ALL to the anonymous role gives every operation the database has on that object, whatever the policies say about the rows.`,
        `Grant only the operations the app performs, and only to authenticated.`,
        [at]));
    }
    if (toAnon && /^(public|anon)$/i.test((g.to || '').trim()) && /update|delete/i.test(g.what)) {
      found.push(F('GRANT_WRITE_TO_ANON', 'blocking', `${g.what} on ${g.on} is granted to ${g.to}`,
        `A write privilege on this object is granted to the anonymous role, which every installation of the app carries.`,
        `Grant it to authenticated instead, and let the policies decide which rows.`,
        [at]));
    }
  }

  /* ── storage buckets ────────────────────────────────────────────────────── */
  for (const st of schema.statements) {
    const code = st.code.replace(/\s+/g, ' ');
    if (/insert\s+into\s+storage\.buckets/i.test(code) && /\bpublic\b[\s\S]{0,40}\btrue\b/i.test(code)) {
      found.push(F('PUBLIC_STORAGE_BUCKET', 'warning', 'A public storage bucket is created',
        `A bucket marked public serves every file in it to anyone who knows the URL, with no policy involved. If any of those files are private — invoices, identity documents, recordings — the policy you write will not protect them.`,
        `Keep the bucket private and serve files through signed URLs.`,
        [`${st.file}${st.line ? `:${st.line}` : ''}`]));
    }
  }

  /* ── and the schema against what the app says it needs ──────────────────── */
  if (spec && spec.backend && spec.backend.kind && spec.backend.kind !== 'none') {
    const declared = Array.isArray(spec.backend.tablesRequiringRls) ? spec.backend.tablesRequiringRls : [];
    const byName = new Map(schema.tables.map((t) => [t.full, t]));
    for (const raw of declared) {
      const { full } = normaliseTable(raw);
      const t = byName.get(full);
      if (!t) {
        found.push(F('SPEC_TABLE_MISSING', 'blocking', `The app expects protection on a table that is not in the schema`,
          `The specification lists ${raw} among the tables that must be protected, and no migration creates ${full}. Either the name is wrong — a typo here means the protection being relied on is not the protection being checked — or the migration is missing.`,
          `Correct the name, or add the table and its policies.`,
          [raw]));
        continue;
      }
      if (!t.rls) {
        found.push(F('SPEC_TABLE_UNPROTECTED', 'blocking', `${t.full} is listed as protected and is not`,
          `The specification says ${t.full} needs row level security; the schema never switches it on.`,
          `Add: alter table ${t.full} enable row level security;`,
          [raw]));
      }
    }

    const caps = Array.isArray(spec.capabilities) ? spec.capabilities : [];
    if (caps.includes('payments')) {
      const anyStatusWriter = schema.functions.some((f) => f.securityDefiner && f.writesStatus);
      if (!anyStatusWriter && moneyExposure.open.length) {
        found.push(F('PAYMENTS_WITHOUT_SERVER_WRITE', 'blocking', 'Purchases are enabled and nothing server-side writes the payment state',
          `The app takes payments, no function running with the server's own rights records the outcome, and the app itself can write the column that would. Whatever marks an order as paid is reachable from the app.`,
          `Add a SQL function that verifies the receipt and writes the status, and take that column out of the app's reach.`));
      }
    }
  }

  return found.sort((a, b) => levelRank(a.level) - levelRank(b.level) || a.code.localeCompare(b.code));
}

/**
 * Read migrations, run the rules, and summarise.
 *
 * `blocking` is the number that matters: a schema with blocking findings should
 * not be shipped, and the CLI exits non-zero so a pipeline stops on it.
 */
export function gate(files, { spec = null } = {}) {
  const schema = readSchema(files);
  const findings = rulesFor(schema, { spec });
  const byLevel = { blocking: 0, warning: 0, info: 0 };
  for (const f of findings) byLevel[f.level] = (byLevel[f.level] || 0) + 1;
  return {
    schema,
    findings,
    counts: byLevel,
    /** What was actually examined, so a green result means something specific. */
    examined: {
      files: files.map((f) => f.path),
      tables: schema.tables.map((t) => t.full),
      withRls: schema.tables.filter((t) => t.rls).map((t) => t.full),
      policies: schema.tables.reduce((n, t) => n + t.policies.length, 0),
      functions: schema.functions.map((f) => f.full),
      statements: schema.statements.length,
    },
  };
}
