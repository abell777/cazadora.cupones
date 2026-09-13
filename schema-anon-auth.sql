-- Endurecimiento anti-bot para `coupons` y `price_history` usando la
-- autenticación anónima de Supabase, en vez de confiar en un client_id que
-- cualquiera puede inventarse. Ejecuta esto UNA VEZ en el "SQL Editor" de tu
-- proyecto, después de schema.sql, schema-moderation.sql y
-- schema-price-radar(-crossstore).sql.
--
-- ANTES DE EJECUTAR ESTO: entra en tu proyecto de Supabase ->
-- Authentication -> Sign In / Providers -> Anonymous, y activa "Allow
-- anonymous sign-ins". Sin ese interruptor, la extensión no podrá crear el
-- usuario anónimo y los envíos de cupones/precios empezarán a fallar (la
-- lectura de cupones y del histórico de precios no se ve afectada).
--
-- Qué soluciona: hasta ahora, cualquiera que copiara la "anon key" pública
-- de la extensión (viene incluida en el código fuente, no es secreta) podía
-- llamar a la API REST de Supabase directamente e insertar filas mandando un
-- client_id distinto en cada petición, saltándose por completo el límite de
-- 5 cupones/hora o 60 precios/hora (ver la nota ya existente en
-- schema-moderation.sql). A partir de esta migración, insertar una fila
-- exige haber iniciado sesión como usuario anónimo real de Supabase Auth
-- (la extensión lo hace sola, sin pedir nada a quien la usa) — y ese inicio
-- de sesión anónimo tiene su propio límite en el servidor (30 por hora y IP,
-- configurable desde el dashboard), así que fabricar identidades nuevas para
-- saltarse el límite deja de ser gratis para quien quiera abusar.

-- 1) Columna de usuario real. Supabase la rellena sola con el id del usuario
--    autenticado (auth.uid()) al insertar; el cliente nunca puede fijarla a
--    mano en el cuerpo de la petición, así que no se puede falsear como
--    pasaba con client_id.
alter table coupons add column if not exists user_id uuid default auth.uid();
alter table price_history add column if not exists user_id uuid default auth.uid();

-- 2) client_id deja de ser obligatorio: se sigue guardando solo a modo de
--    dato histórico/depuración, pero ya no protege nada por sí mismo.
alter table coupons alter column client_id drop not null;
alter table price_history alter column client_id drop not null;

-- 3) Las políticas de inserción pasan a exigir el rol "authenticated" (lo
--    asumen tanto los usuarios anónimos de Supabase Auth como los
--    permanentes), no basta con tener la anon key pública.
drop policy if exists "Cualquiera puede aportar un cupón" on coupons;
create policy "Usuarios autenticados (incl. anónimos) pueden aportar un cupón"
  on coupons for insert
  with check (auth.role() = 'authenticated');

drop policy if exists "Cualquiera puede registrar una observación de precio" on price_history;
create policy "Usuarios autenticados (incl. anónimos) pueden registrar un precio"
  on price_history for insert
  with check (auth.role() = 'authenticated');

-- 4) Los límites de frecuencia pasan a contar por user_id real (asignado por
--    el servidor) en vez de por client_id (que el cliente podía cambiar en
--    cada petición). Sustituye las funciones que ya usan los triggers
--    existentes `coupons_rate_limit` / `price_history_rate_limit` — no hace
--    falta recrear los triggers, solo las funciones a las que apuntan.
create or replace function enforce_coupon_rate_limit()
returns trigger as $$
declare
  recent_hour int;
  recent_day int;
begin
  select count(*) into recent_hour from coupons
    where user_id = new.user_id and created_at > now() - interval '1 hour';
  if recent_hour >= 5 then
    raise exception 'rate_limit_hour';
  end if;

  select count(*) into recent_day from coupons
    where user_id = new.user_id and created_at > now() - interval '1 day';
  if recent_day >= 20 then
    raise exception 'rate_limit_day';
  end if;

  return new;
end;
$$ language plpgsql;

create or replace function enforce_price_history_rate_limit()
returns trigger as $$
declare
  recent_hour int;
  recent_day int;
begin
  select count(*) into recent_hour from price_history
    where user_id = new.user_id and created_at > now() - interval '1 hour';
  if recent_hour >= 60 then
    raise exception 'rate_limit_hour';
  end if;

  select count(*) into recent_day from price_history
    where user_id = new.user_id and created_at > now() - interval '1 day';
  if recent_day >= 300 then
    raise exception 'rate_limit_day';
  end if;

  return new;
end;
$$ language plpgsql;

-- Recomendado (opcional, siguiente mejora): además puedes activar un
-- CAPTCHA (Cloudflare Turnstile, gratis) para el propio inicio de sesión
-- anónimo, en Authentication -> Sign In / Providers -> Anonymous -> "Enable
-- Captcha protection". Así ni siquiera generar usuarios anónimos en bucle
-- sale gratis para un atacante. Requiere una cuenta gratuita de Cloudflare
-- y cambiar el código de la extensión para mandar el token del captcha —
-- queda anotado como mejora futura, no bloquea nada de lo de arriba.
