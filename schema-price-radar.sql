-- Tabla para el radar de precios. Ejecuta esto UNA VEZ en el "SQL Editor" de
-- tu proyecto de Supabase (después de schema.sql y schema-moderation.sql;
-- es independiente de la tabla `coupons`, no la toca).
--
-- Qué guarda: una fila por cada vez que la extensión de algún usuario "ve"
-- el precio de un producto (nunca datos personales, solo dominio + ruta del
-- producto + precio + fecha). Se usa para poder avisar si un precio ha
-- subido antes de una rebaja, o si es el más bajo visto recientemente.

create table if not exists price_history (
  id bigint generated always as identity primary key,
  domain text not null,
  product_key text not null,
  price numeric not null,
  currency text,
  url text,
  client_id text not null,
  created_at timestamptz default now()
);

create index if not exists price_history_domain_product_idx
  on price_history (domain, product_key, created_at);

alter table price_history enable row level security;

-- Cualquiera puede leer el histórico (para que la extensión compare precios).
create policy "Histórico de precios visible para todos"
  on price_history for select
  using (true);

-- La extensión inserta una fila automáticamente al visitar una ficha de
-- producto (si el usuario tiene el radar de precios activado en Ajustes).
create policy "Cualquiera puede registrar una observación de precio"
  on price_history for insert
  with check (true);

-- Validaciones básicas de formato, mismo espíritu que schema-moderation.sql.
alter table price_history add constraint price_history_domain_format
  check (domain ~ '^[a-z0-9.-]+\.[a-z]{2,}$') not valid;

alter table price_history add constraint price_history_price_range
  check (price > 0 and price <= 1000000) not valid;

alter table price_history add constraint price_history_product_key_length
  check (char_length(product_key) between 1 and 200) not valid;

-- Límite de frecuencia por dispositivo: 60/hora y 300/día. Es más alto que
-- el de cupones porque este envío es automático (una vez por página de
-- producto visitada), no una acción manual del usuario.
create or replace function enforce_price_history_rate_limit()
returns trigger as $$
declare
  recent_hour int;
  recent_day int;
begin
  select count(*) into recent_hour from price_history
    where client_id = new.client_id and created_at > now() - interval '1 hour';
  if recent_hour >= 60 then
    raise exception 'rate_limit_hour';
  end if;

  select count(*) into recent_day from price_history
    where client_id = new.client_id and created_at > now() - interval '1 day';
  if recent_day >= 300 then
    raise exception 'rate_limit_day';
  end if;

  return new;
end;
$$ language plpgsql;

drop trigger if exists price_history_rate_limit on price_history;
create trigger price_history_rate_limit
  before insert on price_history
  for each row execute function enforce_price_history_rate_limit();

-- Opcional, más adelante, una vez compruebes que las filas nuevas cumplen el
-- formato: alter table price_history validate constraint price_history_domain_format;
--          alter table price_history validate constraint price_history_price_range;
--          alter table price_history validate constraint price_history_product_key_length;

-- Mantenimiento recomendado (no automático): el histórico crece con cada
-- visita a una ficha de producto. Si quieres limitarlo con el tiempo, puedes
-- programar en Supabase (pg_cron, si lo tienes disponible en tu plan) algo
-- como borrar filas de más de 90 días:
--   delete from price_history where created_at < now() - interval '90 days';
