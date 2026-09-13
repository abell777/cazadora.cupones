-- Migración de moderación anti-spam para la tabla `coupons` que ya creaste
-- con schema.sql. Ejecuta esto UNA VEZ en el "SQL Editor" de tu proyecto de
-- Supabase, después de schema.sql.
--
-- Qué soluciona: ahora mismo cualquiera con la "anon key" (que es pública,
-- viene dentro de la extensión) puede insertar CUALQUIER cosa en `coupons`,
-- incluyendo enlaces de spam en la descripción que se le mostrarían a todos
-- los usuarios. Esta migración lo bloquea a nivel de base de datos, así que
-- protege incluso a quien no pase por la extensión y llame a la API directamente.
--
-- Importante: esto NO es una protección infalible contra un atacante decidido
-- (ver nota sobre client_id más abajo). Es una barrera real contra spam y
-- basura accidental, no un sistema anti-bot completo.

-- 1) Identificador anónimo del dispositivo que aporta el cupón (no es un
--    usuario real ni personal, solo sirve para aplicar límites de frecuencia).
alter table coupons add column if not exists client_id text;

-- Los cupones que ya existían (los "semilla" de ejemplo) no tienen client_id;
-- les ponemos uno de relleno para poder exigir que sea obligatorio a partir de ahora.
update coupons set client_id = 'legacy-seed' where client_id is null;
alter table coupons alter column client_id set not null;

-- 2) Formato del código: letras, números, espacios, guiones y guiones bajos,
--    entre 2 y 40 caracteres. Bloquea intentos de meter basura o HTML.
--    NOT VALID = no revisa las filas ya existentes, solo las nuevas a partir
--    de ahora (por si algún cupón viejo no encajase con el patrón).
alter table coupons add constraint coupons_code_format
  check (code ~ '^[A-Za-z0-9][A-Za-z0-9 _-]{1,39}$') not valid;

-- 3) El dominio debe tener forma de dominio real (evita vacíos o basura).
alter table coupons add constraint coupons_domain_format
  check (domain ~ '^[a-z0-9.-]+\.[a-z]{2,}$') not valid;

-- 4) Descripción: máximo 140 caracteres y SIN enlaces. La descripción se
--    muestra tal cual a todos los usuarios de la extensión, así que es el
--    campo más golpeado por spam de enlaces.
alter table coupons add constraint coupons_description_length
  check (description is null or char_length(description) <= 140) not valid;
alter table coupons add constraint coupons_description_no_links
  check (description !~* 'https?://|www\.') not valid;

-- 5) Límite de frecuencia: máximo 5 cupones nuevos por hora y 20 por día
--    para el mismo client_id. Frena el spam en bucle y los errores repetidos.
--    Nota honesta: un atacante que llame a la API directamente puede generar
--    un client_id distinto en cada petición y saltárselo. Para un límite que
--    no se pueda evitar así hace falta autenticación anónima de Supabase o
--    una función serverless con verificación (ej. Cloudflare Turnstile) —
--    queda anotado como siguiente mejora, no está hecho en este paso.
create or replace function enforce_coupon_rate_limit()
returns trigger as $$
declare
  recent_hour int;
  recent_day int;
begin
  select count(*) into recent_hour from coupons
    where client_id = new.client_id and created_at > now() - interval '1 hour';
  if recent_hour >= 5 then
    raise exception 'rate_limit_hour';
  end if;

  select count(*) into recent_day from coupons
    where client_id = new.client_id and created_at > now() - interval '1 day';
  if recent_day >= 20 then
    raise exception 'rate_limit_day';
  end if;

  return new;
end;
$$ language plpgsql;

drop trigger if exists coupons_rate_limit on coupons;
create trigger coupons_rate_limit
  before insert on coupons
  for each row execute function enforce_coupon_rate_limit();

-- Opcional, más adelante: una vez revises que los cupones existentes tienen
-- formato correcto, puedes "activar" del todo las comprobaciones de las
-- filas antiguas con:
--   alter table coupons validate constraint coupons_code_format;
--   alter table coupons validate constraint coupons_domain_format;
--   alter table coupons validate constraint coupons_description_length;
--   alter table coupons validate constraint coupons_description_no_links;
