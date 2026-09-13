-- Migración incremental para el radar de precios ENTRE TIENDAS (v0.10.0).
-- Ejecuta esto UNA VEZ en el "SQL Editor" de Supabase, después de
-- schema-price-radar.sql. Solo añade columnas e índices a la tabla
-- price_history que ya existe — no toca ni borra ninguna fila que ya tengas.
--
-- Qué añade: un identificador de producto opcional (gtin = código de barras
-- universal, o si no hay, marca + referencia del fabricante) para poder
-- saber que dos filas de tiendas distintas son "el mismo producto" y así
-- avisar si está más barato en otra tienda. Sigue sin guardar nada que
-- identifique a la persona, solo datos del producto.

alter table price_history add column if not exists gtin text;
alter table price_history add column if not exists brand text;
alter table price_history add column if not exists mpn text;

-- Formato válido: gtin son 8-14 dígitos si se manda; brand/mpn, máximo 80
-- caracteres. "not valid" para no romper filas ya insertadas antes de esta
-- migración, igual que el resto de reglas del proyecto.
alter table price_history add constraint price_history_gtin_format
  check (gtin is null or gtin ~ '^[0-9]{8,14}$') not valid;

alter table price_history add constraint price_history_brand_length
  check (brand is null or char_length(brand) <= 80) not valid;

alter table price_history add constraint price_history_mpn_length
  check (mpn is null or char_length(mpn) <= 80) not valid;

-- Índices para la consulta "mismo producto, otra tienda, últimos 30 días,
-- ordenado por precio" que hace la extensión (ver fetchCrossStoreDeal en
-- background.js).
create index if not exists price_history_gtin_idx
  on price_history (gtin, created_at) where gtin is not null;

create index if not exists price_history_brand_mpn_idx
  on price_history (brand, mpn, created_at) where brand is not null and mpn is not null;

-- Opcional, más adelante, una vez compruebes que las filas nuevas cumplen el
-- formato:
--   alter table price_history validate constraint price_history_gtin_format;
--   alter table price_history validate constraint price_history_brand_length;
--   alter table price_history validate constraint price_history_mpn_length;
