-- Orders and their items. The status column is the one that says an order was
-- paid, so the app is allowed to create an order and never allowed to change
-- its status: that happens in 0003, inside a function the app cannot rewrite.

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'awaiting_payment',
  amount_paise integer not null check (amount_paise > 0),
  receipt text,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);

alter table public.orders enable row level security;

create table public.order_items (
  id bigserial primary key,
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id text not null,
  quantity integer not null default 1 check (quantity > 0),
  unit_paise integer not null check (unit_paise > 0)
);

alter table public.order_items enable row level security;

-- A person sees their own orders, and only their own.
create policy "orders are readable by their owner"
  on public.orders for select to authenticated
  using (user_id = auth.uid());

-- They may start an order. The row they create has to belong to them, and it
-- may only be created in the state the app is allowed to ask for.
create policy "orders are created by their owner"
  on public.orders for insert to authenticated
  with check (user_id = auth.uid() and status = 'awaiting_payment');

-- Deliberately no update policy on public.orders.
-- Nothing here can change status, amount or receipt after the fact.

create policy "order items are readable by the order's owner"
  on public.order_items for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id and o.user_id = auth.uid()));

create policy "order items are created by the order's owner"
  on public.order_items for insert to authenticated
  with check (exists (select 1 from public.orders o where o.id = order_id and o.user_id = auth.uid()));
