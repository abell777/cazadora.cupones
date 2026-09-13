# Scraper de cupones (Telegram/foros)

Componente **de servidor**, separado de la extensión de Chrome (el
navegador de un usuario nunca ejecuta esto). Es el "scraping automático de
códigos por IA" que el documento original del proyecto describía como
pendiente.

## Qué hace

1. Lee mensajes recientes de canales **públicos** de Telegram (sin API_ID
   ni bot, usando la vista web de solo lectura `t.me/s/<canal>`) y de
   páginas de foros/blogs que tú le indiques.
2. Le pasa cada mensaje a Claude pidiéndole solo un JSON: si hay un cupón
   real, para qué tienda, con qué código y con qué confianza. Si no hay
   cupón, o el modelo no está seguro, lo descarta.
3. Guarda los candidatos en tu tabla `coupons` de Supabase con
   `source = "ai_scraper"` y `status = "pending"` — **no se muestran a los
   usuarios de la extensión hasta que los apruebes**, salvo que actives
   `auto_approve_confidence_threshold` en `config.json`.

## Puesta en marcha

1. En Supabase, ejecuta `../schema-ai-scraper.sql` (una vez).
2. Copia `config.example.json` a `config.json`, rellena los canales de
   Telegram (nombre de usuario público, sin `@`) y/o páginas de foros que
   quieras vigilar. **No pongas claves secretas en este archivo.**
3. Define estas variables de entorno (nunca las escribas en el código ni
   las subas al repo):
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY` — la clave *service role* de tu proyecto
     (Project Settings → API). Es distinta de la `anon key` que usa la
     extensión: esta es secreta y se salta la seguridad a nivel de fila, así
     que solo debe vivir aquí, nunca en el código de la extensión.
   - `ANTHROPIC_API_KEY`
4. Prueba en local antes de automatizar nada:
   ```bash
   pip install -r requirements.txt
   python scrape_deals.py --config config.json --dry-run
   ```
   `--dry-run` no escribe en la base de datos, solo te enseña qué
   encontraría.
5. Cuando confíes en el resultado, quita `--dry-run` o deja que lo lance
   solo el workflow de GitHub Actions (`../.github/workflows/scrape-deals.yml`),
   que ya viene programado para correr una vez al día gratis.

## Revisar lo que encuentra

Los cupones nuevos entran como `pending`. Revísalos en el **Table Editor**
de Supabase:

```sql
select id, domain, code, description, source_ref, confidence, created_at
from coupons where status = 'pending' order by created_at desc;
```

Cambia `status` a `approved` (se mostrará en la extensión) o `rejected`
(código inventado, canal poco fiable, etc.) según corresponda.

## Límites honestos de esta primera versión

- No sigue "hilos" de foro con paginación, solo la URL exacta que le des.
- No hay deduplicación semántica: si el mismo cupón se publica en dos
  canales distintos, puede entrar dos veces en `pending` (revísalo a mano
  la primera vez; es barato de arreglar más adelante con un `unique` por
  `domain, code` si ves que pasa mucho).
- Cada mensaje analizado cuesta una llamada a la API de Claude — con
  `messages_per_channel` moderado y un cron diario el gasto es pequeño,
  pero si añades muchos canales revisa el consumo en tu cuenta de
  Anthropic.
