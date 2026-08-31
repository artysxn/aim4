-- ---------------------------------------------------------------------------
-- 0019_affiliate_cap.sql
-- Commission runs for a year of a customer's life, not forever.
--
-- Uncapped, the top rung is a permanent 20% cut of every renewal for as long
-- as that customer stays. That is a share of the business rather than a cost
-- of winning it, and it is the one number that made the programme look
-- expensive: 20% of everything, forever, against a discount the buyer only
-- ever got once.
--
-- Capped at twelve months it costs about 10% of a two year customer and 7% of
-- a three year one, which is what an UNCAPPED 10% would have cost, while the
-- affiliate still earns the full rate on everything they are paid for. The
-- headline stays worth recruiting on and the tail stops being expensive.
--
-- The window is calendar months from attribution, not twelve payments, so a
-- plan change mid-year cannot turn it into fourteen (see commissionEligibility).
--
-- Rows with a cap already set were set deliberately and are left alone. Rows
-- with none were never given one; they get the new default.
--
-- Nothing already earned changes. Every affiliate_commissions row is a
-- historical fact and this touches none of them.
-- ---------------------------------------------------------------------------

alter table public.affiliates
  alter column max_months set default 12;

update public.affiliates
   set max_months = 12,
       updated_at = now()
 where max_months is null;
