/**
 * THE ROW LEVEL SECURITY GATE
 * ===========================
 *
 * Every rule here has a test that makes it fire, and — just as important — a
 * test that shows it staying quiet on the near-miss. A security rule that fires
 * on a correct schema is worse than no rule: people learn to skip the list, and
 * the one finding that mattered goes past with the rest.
 *
 * Two rules were written wrongly before these tests existed, and both were
 * caught by running them against a schema that was already correct:
 *
 *   - the payment rule flagged a policy that lets a person create an order, when
 *     that policy pinned the order's status to 'awaiting_payment' and so could
 *     not be used to mark anything paid;
 *   - the unconditional-policy rule matched `using (is_public or owner =
 *     auth.uid())`, which is a legitimate policy for a table with public rows.
 *
 * Neither would have been noticed by reading the rule. Both were noticed by
 * running it against real SQL.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';

import { splitStatements, stripSqlComments, readSchema, normaliseTable } from '../../engine/backend/sql.mjs';
import { gate, rulesFor } from '../../engine/backend/rls.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE = path.join(ROOT, 'apps', 'backend-demo');

/** Read the migrations of a directory in the order a migration runner would. */
function migrations(dir) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
    .map((f) => ({ path: path.join(dir, f), sql: fs.readFileSync(path.join(dir, f), 'utf8') }));
}

/** Run the gate over a single schema written inline. */
function check(sql, spec = null) {
  return gate([{ path: 'test.sql', sql }], { spec });
}

const codes = (result) => result.findings.map((f) => f.code);
const levelOf = (result, code) => (result.findings.find((f) => f.code === code) || {}).level;

/* ── reading SQL ──────────────────────────────────────────────────────────── */

test('statements are split around strings, comments and function bodies', () => {
  const sql = `
    -- a comment; with a semicolon in it
    create table public.a (id int); /* another ; here */
    create function public.f() returns void language plpgsql as $$
    begin
      -- this semicolon is inside the function, not a statement break
      perform 1; perform 2;
    end;
    $$;
    insert into public.a values (1);
  `;
  const statements = splitStatements(sql, 'x.sql');
  assert.equal(statements.length, 3, `expected 3 statements, got ${statements.length}: ${statements.map((s) => s.code.slice(0, 40))}`);

  const dollar = `create function public.g() returns void language plpgsql as $body$
    begin update t set x = ';'; end;
  $body$; select 1;`;
  assert.equal(splitStatements(dollar, 'y.sql').length, 2, 'a tagged dollar-quoted body must not be split');

  // A quoted semicolon inside a literal is not a statement break either.
  assert.equal(splitStatements("insert into t values ('a;b');", 'z.sql').length, 1);
});

test('a commented-out statement is not read as a statement', () => {
  // This is the mistake that would let a table ship unprotected with a green
  // tick beside it: the protection is there, in a comment.
  const sql = `
    create table public.secrets (id uuid primary key, owner uuid);
    -- alter table public.secrets enable row level security;
  `;
  const schema = readSchema([{ path: 'a.sql', sql }]);
  assert.equal(schema.tables[0].rls, false, 'a commented-out enable is not an enable');
  const result = check(sql);
  assert.ok(codes(result).includes('RLS_MISSING'), 'and the table is reported as unprotected');
});

test('a table is recognised under either spelling of its name', () => {
  const sql = `
    create table orders (id uuid primary key);
    alter table public.orders enable row level security;
    create policy "own" on orders for select to authenticated using (id = auth.uid());
  `;
  const result = check(sql);
  assert.equal(result.schema.tables.length, 1, `read ${result.schema.tables.length} tables, expected one`);
  assert.equal(result.schema.tables[0].rls, true, 'public.orders and orders are the same table');
  assert.equal(levelOf(result, 'RLS_MISSING'), undefined);
});

/* ── the rules, each one biting ───────────────────────────────────────────── */

const CASES = [
  {
    rule: 'RLS_MISSING',
    what: 'a table with no row level security at all',
    sql: 'create table public.notes (id uuid primary key, body text);',
    level: 'blocking',
  },
  {
    rule: 'RLS_DISABLED_AGAIN',
    what: 'protection switched on in one migration and off in a later one',
    sql: `create table public.notes (id uuid primary key);
          alter table public.notes enable row level security;
          alter table public.notes disable row level security;`,
    level: 'blocking',
  },
  {
    rule: 'RLS_NO_POLICY',
    what: 'protection switched on with nothing granted, so the app cannot read its own data',
    sql: `create table public.notes (id uuid primary key, owner uuid);
          alter table public.notes enable row level security;`,
    level: 'warning',
  },
  {
    rule: 'RLS_NOT_FORCED',
    what: 'a protected table whose owner still bypasses its policies',
    sql: `create table public.notes (id uuid primary key, owner uuid);
          alter table public.notes enable row level security;
          create policy "own" on public.notes for select to authenticated using (owner = auth.uid());`,
    level: 'info',
  },
  {
    rule: 'POLICY_ANON_UNRESTRICTED',
    what: 'the anonymous role given every row, with no condition at all',
    sql: `create table public.notes (id uuid primary key, owner uuid);
          alter table public.notes enable row level security;
          create policy "anyone can add" on public.notes for insert to anon with check (true);`,
    level: 'blocking',
  },
  {
    rule: 'POLICY_ANON_UNRESTRICTED',
    what: 'the anonymous role allowed to read every row',
    sql: `create table public.orders (id uuid primary key, user_id uuid not null);
          alter table public.orders enable row level security;
          create policy "anyone can read" on public.orders for select to anon using (true);`,
    level: 'blocking',
  },
  {
    rule: 'POLICY_WRITE_ANON',
    what: 'a write policy granted to the anonymous role, with a condition that decides rows but not callers',
    sql: `create table public.notes (id uuid primary key, owner uuid);
          alter table public.notes enable row level security;
          create policy "add a note" on public.notes for insert to anon with check (length(owner::text) > 0);`,
    level: 'blocking',
  },
  {
    rule: 'POLICY_UNCONDITIONAL_WRITE',
    what: 'a write policy whose condition is always true',
    sql: `create table public.notes (id uuid primary key, owner uuid);
          alter table public.notes enable row level security;
          create policy "signed in, anything goes" on public.notes for all to authenticated using (true) with check (true);`,
    level: 'blocking',
  },
  {
    rule: 'POLICY_WRITE_NO_CHECK',
    what: 'an update policy with no WITH CHECK, so a client can rewrite the column the policy trusts',
    sql: `create table public.notes (id uuid primary key, owner uuid not null);
          alter table public.notes enable row level security;
          create policy "own" on public.notes for update to authenticated using (owner = auth.uid());`,
    level: 'blocking',
  },
  {
    rule: 'POLICY_NO_ROW_SCOPE',
    what: 'a policy that never asks who is asking, on a table with no owner',
    sql: `create table public.notices (id uuid primary key, body text);
          alter table public.notices enable row level security;
          create policy "signed in" on public.notices for select to authenticated using (body is not null);`,
    level: 'warning',
  },
  {
    rule: 'CLIENT_CAN_WRITE_PAYMENT_STATE',
    what: 'an update policy that lets the app choose the payment status',
    sql: `create table public.orders (id uuid primary key, user_id uuid not null, status text not null);
          alter table public.orders enable row level security;
          create policy "own" on public.orders for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());`,
    level: 'blocking',
  },
  {
    rule: 'CLIENT_CAN_WRITE_PAYMENT_STATE',
    what: 'an insert policy that does not say what state a new order may be in',
    sql: `create table public.orders (id uuid primary key, user_id uuid not null, paid boolean not null default false);
          alter table public.orders enable row level security;
          create policy "own" on public.orders for insert to authenticated with check (user_id = auth.uid());`,
    level: 'blocking',
  },
  {
    rule: 'DEFINER_WITHOUT_SEARCH_PATH',
    what: 'a SECURITY DEFINER function with the search path left open',
    sql: `create function public.credit(uid uuid, amount int) returns void
          language plpgsql security definer as $$ begin update wallets set balance = balance + amount; end; $$;`,
    level: 'blocking',
  },
  {
    rule: 'SERVER_WRITES_CALLER_STATUS',
    what: 'a server function that writes the status its caller asked for',
    sql: `create function public.set_status(p_order uuid, p_status text) returns void
          language plpgsql security definer set search_path = public as $$
          begin update public.orders set status = p_status where id = p_order; end; $$;`,
    level: 'warning',
  },
  {
    rule: 'GRANT_ALL_TO_ANON',
    what: 'every privilege granted to the anonymous role',
    sql: 'grant all on public.notes to anon;',
    level: 'blocking',
  },
  {
    rule: 'GRANT_WRITE_TO_ANON',
    what: 'delete granted to the anonymous role',
    sql: 'grant delete on public.notes to anon;',
    level: 'blocking',
  },
  {
    rule: 'PUBLIC_STORAGE_BUCKET',
    what: 'a storage bucket created public',
    sql: `insert into storage.buckets (id, name, public) values ('invoices', 'invoices', true);`,
    level: 'warning',
  },
];

for (const c of CASES) {
  test(`${c.rule} fires on ${c.what}`, () => {
    const result = check(c.sql);
    assert.ok(codes(result).includes(c.rule),
      `expected ${c.rule} among ${JSON.stringify(codes(result))}`);
    assert.equal(levelOf(result, c.rule), c.level,
      `${c.rule} should be ${c.level}`);
    const finding = result.findings.find((f) => f.code === c.rule);
    assert.ok(finding.title && finding.detail, 'a finding must say what and why');
    assert.ok(finding.action && finding.action !== 'Nothing to do.', `${c.rule} must say what to do about it`);
    assert.ok(!/\s{2,}/.test(finding.detail), 'no doubled spaces in generated text');
  });
}

/* ── and each one staying quiet when it should ────────────────────────────── */

test('a legitimate policy is not called unconditional', () => {
  // `is_public or owner = auth.uid()` is a real pattern: a table with published
  // rows. The first version of the rule flagged anything containing "or true"
  // and would have caught this too if it had looked for the wrong thing.
  const result = check(`
    create table public.posts (id uuid primary key, owner uuid not null, published boolean not null default false);
    alter table public.posts enable row level security;
    create policy "own or published" on public.posts for select to authenticated
      using (published or owner = auth.uid());
  `);
  assert.equal(codes(result).includes('POLICY_UNCONDITIONAL_WRITE'), false,
    `a real condition must not be mistaken for none: ${JSON.stringify(codes(result))}`);
});

test('an admin policy that calls is_admin() is not mistaken for an open door', () => {
  const result = check(`
    create table public.tickets (id uuid primary key, owner uuid not null);
    alter table public.tickets enable row level security;
    create policy "staff" on public.tickets for select to authenticated using (public.is_admin());
  `);
  assert.equal(codes(result).includes('POLICY_UNCONDITIONAL_WRITE'), false);
  assert.equal(codes(result).includes('POLICY_NO_ROW_SCOPE'), true,
    'but it should say that this policy decides by neither the row nor the reader');
});

test('a creation policy that pins the payment state is correct, not a hole', () => {
  const result = check(`
    create table public.orders (id uuid primary key, user_id uuid not null, status text not null);
    alter table public.orders enable row level security;
    create policy "create own" on public.orders for insert to authenticated
      with check (user_id = auth.uid() and status = 'awaiting_payment');
  `);
  assert.equal(codes(result).includes('CLIENT_CAN_WRITE_PAYMENT_STATE'), false,
    `pinning the state is the fix, not the fault: ${JSON.stringify(codes(result))}`);
  assert.ok(codes(result).includes('PAYMENT_STATE_PINNED'), 'and it should be reported as what it is');
});

test('a fully scoped table produces no blocking findings at all', () => {
  const result = check(`
    create table public.notes (id uuid primary key default gen_random_uuid(), owner uuid not null references auth.users(id));
    alter table public.notes enable row level security;
    alter table public.notes force row level security;
    create policy "read own" on public.notes for select to authenticated using (owner = auth.uid());
    create policy "write own" on public.notes for update to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
    create policy "create own" on public.notes for insert to authenticated with check (owner = auth.uid());
    create policy "delete own" on public.notes for delete to authenticated using (owner = auth.uid());
  `);
  assert.deepEqual(result.findings.filter((f) => f.level === 'blocking'), [],
    `a correct table must be clean: ${JSON.stringify(result.findings)}`);
});

test('a policy that trusts a value the caller can set is reported', () => {
  // The row-level equivalent of trusting the client: the policy compares a
  // column to a value the client sent, rather than to the identity the database
  // derived from the token.
  const result = check(`
    create table public.docs (id uuid primary key, owner uuid not null);
    alter table public.docs enable row level security;
    create policy "as told" on public.docs for select to authenticated
      using (owner = current_setting('app.user_id', true)::uuid);
  `);
  assert.ok(codes(result).includes('POLICY_TRUSTS_CLIENT_SETTING'),
    `a policy that reads a caller-settable setting must be flagged: ${JSON.stringify(codes(result))}`);
});

/* ── the schema against the specification ─────────────────────────────────── */

test('the gate checks the schema against what the app claims it needs', () => {
  const spec = {
    backend: { kind: 'supabase', requiresAuth: true, tablesRequiringRls: ['public.orders', 'public.users'] },
    capabilities: ['internet'],
  };
  const result = check(`
    create table public.orders (id uuid primary key, user_id uuid not null);
    alter table public.orders enable row level security;
    create policy "own" on public.orders for select to authenticated using (user_id = auth.uid());
  `, spec);

  assert.ok(codes(result).includes('SPEC_TABLE_MISSING'),
    'a table the app says must be protected and that does not exist is a blocking problem');
  const finding = result.findings.find((f) => f.code === 'SPEC_TABLE_MISSING');
  assert.match(finding.detail, /public\.users/);
});

test('a table the app relies on being protected, and is not, is blocking', () => {
  const spec = { backend: { kind: 'supabase', tablesRequiringRls: ['public.orders'] }, capabilities: [] };
  const result = check('create table public.orders (id uuid primary key, user_id uuid not null);', spec);
  assert.ok(codes(result).includes('SPEC_TABLE_UNPROTECTED'));
  assert.equal(levelOf(result, 'SPEC_TABLE_UNPROTECTED'), 'blocking');
});

test('purchases with no server-side write of the payment state are refused', () => {
  const spec = { backend: { kind: 'supabase', tablesRequiringRls: [] }, capabilities: ['payments'] };
  const result = check(`
    create table public.orders (id uuid primary key, user_id uuid not null, status text not null);
    alter table public.orders enable row level security;
    create policy "own" on public.orders for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
  `, spec);
  assert.ok(codes(result).includes('PAYMENTS_WITHOUT_SERVER_WRITE'),
    `taking money without a server-side record of payment must be refused: ${JSON.stringify(codes(result))}`);
});

/* ── the fixture: a schema that is meant to be correct ────────────────────── */

test('the committed example schema passes the gate', () => {
  const files = migrations(path.join(FIXTURE, 'db', 'migrations'));
  assert.ok(files.length >= 4, `expected the example migrations, found ${files.length}`);
  const spec = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'spec.json'), 'utf8'));
  const result = gate(files, { spec });

  assert.deepEqual(result.findings.filter((f) => f.level === 'blocking'), [],
    `the example must be clean, or nobody can trust the gate: ${JSON.stringify(result.findings.filter((f) => f.level === 'blocking'), null, 1)}`);

  // It must also genuinely examine the interesting things, or a pass means nothing.
  assert.ok(result.examined.tables.includes('public.orders'));
  assert.ok(result.examined.tables.includes('public.order_items'));
  assert.ok(result.examined.withRls.includes('public.orders'));
  assert.ok(result.examined.functions.includes('public.mark_order_paid'));
  assert.ok(result.examined.policies >= 6, `only ${result.examined.policies} policies examined`);
});

test('the example schema really does refuse every hole the gate looks for', () => {
  // Each of these statements, if it were present, would have to be reported. The
  // point of the test is that the example's safety comes from what it says, not
  // from the gate failing to look.
  const files = migrations(path.join(FIXTURE, 'db', 'migrations'));
  const spec = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'spec.json'), 'utf8'));
  const clean = gate(files, { spec });

  const sabotage = [
    ['order status becomes writable by the app',
      'create policy "own upd" on public.orders for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());',
      'CLIENT_CAN_WRITE_PAYMENT_STATE'],
    ['the profiles table loses its protection',
      'alter table public.profiles disable row level security;',
      'RLS_DISABLED_AGAIN'],
    ['everyone may read every order',
      'create policy "anyone" on public.orders for select to anon using (true);',
      'POLICY_ANON_UNRESTRICTED'],
    ['the definer function loses its search path',
      `create or replace function public.mark_order_paid(p_order_id uuid, p_receipt text, p_amount_paise integer)
       returns public.orders language plpgsql security definer as $$ begin return null; end; $$;`,
      'DEFINER_WITHOUT_SEARCH_PATH'],
  ];

  for (const [what, statement, expected] of sabotage) {
    const broken = [...files, { path: 'sabotage.sql', sql: statement }];
    const result = gate(broken, { spec });
    assert.ok(codes(result).includes(expected),
      `if ${what}, the gate must say ${expected}: ${JSON.stringify(codes(result))}`);
  }
});

/* ── the report itself ────────────────────────────────────────────────────── */

test('the gate says what it examined, not only what it found', () => {
  const files = migrations(path.join(FIXTURE, 'db', 'migrations'));
  const result = gate(files);
  assert.equal(result.examined.files.length, files.length);
  assert.ok(result.examined.statements > 10, 'it should count the statements it walked');
  // A gate that reports "0 findings" without saying what it read is a gate that
  // passes when it finds nothing to read.
  const empty = gate([{ path: 'empty.sql', sql: '-- nothing here' }]);
  assert.equal(empty.examined.tables.length, 0);
  assert.deepEqual(empty.counts, { blocking: 0, warning: 0, info: 0 });
});

test('findings are ordered worst first, so the list can be read top down', () => {
  const result = check(`
    create table public.a (id uuid primary key);
    create table public.b (id uuid primary key, owner uuid);
    alter table public.b enable row level security;
    create policy "own" on public.b for select to authenticated using (owner = auth.uid());
    grant all on public.c to anon;
  `);
  const levels = result.findings.map((f) => f.level);
  const rank = { blocking: 0, warning: 1, info: 2 };
  const sorted = [...levels].sort((x, y) => rank[x] - rank[y]);
  assert.deepEqual(levels, sorted, `findings out of order: ${levels.join(', ')}`);
});

test('every finding names a file and a line when it can', () => {
  const result = check(`
    create table public.notes (id uuid primary key);
  `);
  const finding = result.findings.find((f) => f.code === 'RLS_MISSING');
  assert.ok(finding.evidence.length, 'the finding should point at the statement');
  assert.match(finding.evidence[0], /test\.sql:\d+/, `evidence was ${JSON.stringify(finding.evidence)}`);
});

test('table names are read the same way everywhere', () => {
  assert.deepEqual(normaliseTable('orders'), { schema: 'public', table: 'orders', full: 'public.orders' });
  assert.deepEqual(normaliseTable('public.orders'), { schema: 'public', table: 'orders', full: 'public.orders' });
  assert.deepEqual(normaliseTable('"public"."orders"'), { schema: 'public', table: 'orders', full: 'public.orders' });
});

test('a schema that only contains Supabase tables is not judged on them', () => {
  // auth.* and storage.* belong to the platform. Reporting them as unprotected
  // would fill the list with findings nobody can act on.
  const result = check('create table auth.audit_log (id uuid primary key);');
  assert.deepEqual(result.counts, { blocking: 0, warning: 0, info: 0 },
    `platform tables should not be reported: ${JSON.stringify(result.findings)}`);
});
