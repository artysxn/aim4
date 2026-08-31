-- ---------------------------------------------------------------------------
-- 0018_affiliate_levels.sql
-- The commission rate is a ladder now, not a fixed number.
--
-- server/affiliates/levels.js decides what an affiliate is paid, from their
-- lifetime earnings and how many customers they have brought:
--
--   Level 1   10%   the starting rate
--   Level 2   15%   200 earned, or 20 customers
--   Level 3   20%   1500 earned, or 100 customers
--
-- `affiliates.commission_pct` is no longer the rate. It is the FLOOR, kept as
-- the escape hatch for a negotiated campaign deal, and it only ever applies
-- when it is above what the ladder has awarded. So the default moves to the
-- base rate: a fresh affiliate must override nothing.
--
-- Rows already sitting on exactly 20 are moved to 10. That number was never
-- agreed with anybody, it was the old default, and leaving it in place would
-- silently grandfather every existing code onto the top rate for life. A row
-- set to anything else was set deliberately and is left alone.
--
-- Nothing already earned changes: every affiliate_commissions row froze its
-- own commission_pct when it was written, and this touches none of them.
-- ---------------------------------------------------------------------------

alter table public.affiliates
  alter column commission_pct set default 10;

update public.affiliates
   set commission_pct = 10,
       updated_at = now()
 where commission_pct = 20;
