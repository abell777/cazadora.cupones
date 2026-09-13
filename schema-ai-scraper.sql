-- Migración para el scraper automático por IA (Telegram/foros) que el README
-- venía anunciando como pendiente. Ejecuta esto UNA VEZ en el "SQL Editor"
-- de tu proyecto de Supabase, después de schema.sql, schema-moderation.sql,
-- schema-price-radar(-crossstore).sql y schema-anon-auth.sql.
--
-- Qué soluciona: hasta ahora todo cupón insertado se mostraba a todo el
-- mundo al instante (fila visible con `select using (true)`). Eso es
-- razonable para lo que aporta un usuario a mano desde la extensión (ya
-- pasa por el límite de frecuencia y las validaciones de formato/spam), pero
-- NO es razonable para lo que extraiga un script de IA leyendo Telegram o
-- foros sin supervisión: un mensaje ambiguo o una alucinación del modelo
-- podría colarse como cupón "real". Esta migración añade una cola de
-- revisión: los cupones que aporte el scraper entran como `pending` y no
-- son visibles para la extensión hasta que los apruebes (o los apruebe el
-- propio script si su confianza es muy alta, eso lo decide scraper/config).

-- 1) Columna de estado. Todo lo que ya existía (semilla + comunidad) se
--    considera aprobado automáticamente, para no romper nada.
alter table coupons add column if not exists status text default 'approved';
update coupons set status = 'approved' where status is null;
alter table coupons alter column status set not null;
alter table coupons add constraint coupons_status_valid
  check (status in ('pending', 'approved', 'rejected'));

-- 2) Metadatos propios del scraper: de dónde salió el texto (para poder
--    auditarlo o borrar en bloque si un canal resulta ser poco fiable) y
--    qué confianza le dio el modelo a la extracción (0 a 1).
alter table coupons add column if not exists source_ref text;
alter table coupons add column if not exists confidence numeric;
alter table coupons add constraint coupons_confidence_range
  check (confidence is null or (confidence >= 0 and confidence <= 1));

-- 3) La tabla `source` ya admitía cualquier texto libre; documentamos aquí
--    los valores que usa el proyecto para que quede claro en el propio
--    esquema (no es una restricción dura, solo un comentario):
comment on column coupons.source is
  'Valores usados por el proyecto: seed (semilla inicial), community (aportado desde la extensión), ai_scraper (extraído por scraper/scrape_deals.py de Telegram/foros)';

-- 4) La extensión (background.js) ahora filtra `status=eq.approved` al
--    leer, así que las filas `pending`/`rejected` dejan de mostrarse solas
--    sin tener que tocar la política de lectura. Se deja la política de
--    SELECT tal cual (sigue siendo pública) porque el filtro de estado ya
--    lo aplica el cliente y no hay dato sensible en una fila `pending`.

-- 5) El scraper inserta con la "service role key" de Supabase (nunca la
--    metas en la extensión, solo en el propio script/servidor que lo
--    ejecuta), que salta la RLS por diseño de Supabase. No hace falta
--    ninguna política nueva de INSERT para él.

-- Cola de revisión manual: una vez tengas cupones `pending`, revísalos
-- desde el Table Editor de Supabase filtrando `status = pending` y cambia
-- el que sea válido a `approved` (o `rejected` si es basura/alucinación).
-- Consulta de ejemplo para revisar los más recientes:
--   select id, domain, code, description, source_ref, confidence, created_at
--   from coupons where status = 'pending' order by created_at desc;
