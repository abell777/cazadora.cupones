-- Ejecuta esto en el "SQL Editor" de tu proyecto de Supabase (una sola vez).

create table if not exists coupons (
  id bigint generated always as identity primary key,
  domain text not null,
  code text not null,
  description text,
  source text default 'community',
  created_at timestamptz default now()
);

create index if not exists coupons_domain_idx on coupons (domain);

alter table coupons enable row level security;

-- Cualquiera puede leer los cupones (para que la extensión los muestre a todos).
create policy "Cupones visibles para todos"
  on coupons for select
  using (true);

-- Cualquiera puede aportar un cupón (crowdsourcing abierto en esta fase MVP;
-- más adelante se puede añadir moderación o límites por IP/usuario).
create policy "Cualquiera puede aportar un cupón"
  on coupons for insert
  with check (true);
