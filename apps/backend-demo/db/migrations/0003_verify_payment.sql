-- The only place an order becomes paid.
--
-- This function is SECURITY DEFINER: it runs with the rights of its owner rather
-- than the caller, which is what lets it write a column the app itself cannot
-- touch. search_path is pinned, because a definer function that resolves names
-- through whatever the caller has set is a definer function an attacker can
-- redirect.
--
-- It is called by the server, after the store's receipt has been checked there.
-- It deliberately does not accept a status from its caller: the caller is not
-- asked whether the payment happened.

create or replace function public.mark_order_paid(
  p_order_id uuid,
  p_receipt text,
  p_amount_paise integer
)
returns public.orders
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  updated public.orders;
begin
  update public.orders
     set status = 'paid',
         receipt = p_receipt,
         paid_at = now()
   where id = p_order_id
     and user_id = auth.uid()
     and amount_paise = p_amount_paise
     and status = 'awaiting_payment'
  returning * into updated;

  if updated.id is null then
    raise exception 'order not found, already settled, or the amount does not match';
  end if;

  return updated;
end;
$$;

-- Only signed-in users may ask for it, and only through the API.
revoke all on function public.mark_order_paid(uuid, text, integer) from public;
grant execute on function public.mark_order_paid(uuid, text, integer) to authenticated;
