# Cazadora de Cupones y Chollos Reales (MVP v0.13.0)

Extensión de Chrome (Manifest V3), de alcance global (no limitada a España),
que detecta cuando estás en el carrito/checkout de una tienda online y prueba
automáticamente cupones de descuento guardados, quedándose con el que de
verdad baja el precio.

## Cambios en este paso (v0.12.0 → v0.13.0): scraper automático por IA de Telegram/foros

Esta era la pieza más grande que quedaba pendiente del documento original
del proyecto ("scraping automático de códigos por IA"), y es un componente
**nuevo de servidor**, separado de la extensión — el navegador del usuario
nunca lo ejecuta ni sabe que existe.

- **`scraper/scrape_deals.py`** (nuevo): lee mensajes recientes de canales
  **públicos** de Telegram (vía `t.me/s/<canal>`, sin necesitar API_ID/bot)
  y de páginas de foros/blogs que le indiques en `scraper/config.json`. Le
  pasa cada mensaje a Claude pidiéndole solo un JSON — tienda, código,
  confianza — y descarta cualquier mensaje donde el modelo no esté seguro
  de que hay un cupón real, en vez de forzar una extracción dudosa.
- **`schema-ai-scraper.sql`** (nuevo, ejecútalo después de los demás
  `schema*.sql`): añade una cola de revisión (`status`: `pending` /
  `approved` / `rejected`) a la tabla `coupons`. Los cupones que ya tenías
  (semilla + comunidad) quedan `approved` automáticamente, nada cambia
  para ellos. Lo que aporte el scraper entra como `pending` y **no se
  muestra en la extensión hasta que lo apruebes** desde el Table Editor de
  Supabase — salvo que actives un umbral de auto-aprobación por confianza
  en `scraper/config.json`, que viene desactivado por defecto.
- **`background/background.js`**: la lectura de cupones ahora filtra
  `status=eq.approved`, así que la cola de `pending` es invisible para los
  usuarios sin tocar la política de lectura de Supabase. Los cupones que
  aporta un usuario desde la propia extensión se siguen guardando como
  `approved` al instante, igual que antes — la cola de revisión es solo
  para lo que aporta el scraper sin supervisión humana.
- **`.github/workflows/scrape-deals.yml`** (nuevo): programa el scraper
  para correr una vez al día usando GitHub Actions, que es gratis — no
  hace falta contratar ningún servidor para esto.
- **`scraper/README.md`** (nuevo): puesta en marcha paso a paso, incluida
  la consulta SQL para revisar la cola de pendientes.

Límites honestos de esta primera versión (detallados en
`scraper/README.md`): no sigue paginación de foros, no deduplica
semánticamente entre canales, y cada mensaje analizado cuesta una llamada
a la API de Claude.

## Cambios en el paso anterior (v0.11.0 → v0.12.0): auth anónima real contra el bot de client_id falso

**Requiere una acción tuya en Supabase antes de que esto funcione**: entra en
tu proyecto -> **Authentication -> Sign In / Providers -> Anonymous** y activa
**"Allow anonymous sign-ins"**. Es un interruptor gratuito, no un servicio
nuevo que dar de alta. Sin activarlo, los envíos de cupones/precios a la
comunidad fallarán con un error genérico (la lectura de cupones y del
histórico de precios no se ve afectada, sigue funcionando igual).

Qué cambia y por qué: `schema-moderation.sql` ya avisaba de que el límite de
frecuencia (5 cupones/hora) se podía saltar llamando a la API directamente
con un `client_id` nuevo en cada petición, porque ese identificador lo
inventa el propio navegador y nadie lo verifica. Ahora:

- **`background/background.js`**: antes de aportar un cupón o registrar un
  precio, la extensión inicia sesión como "usuario anónimo" real de Supabase
  Auth (`POST /auth/v1/signup` sin email ni contraseña) y reutiliza esa
  sesión — renovándola sola cuando caduca — en vez de mandar solo la anon key
  pública. Las lecturas (buscar cupones, comparar precios) no cambian, siguen
  sin necesitar sesión.
- **`schema-anon-auth.sql`** (nuevo, ejecútalo después de los demás
  `schema*.sql`): añade una columna `user_id` que Supabase rellena sola con
  el id del usuario autenticado (no se puede falsear desde el cliente), exige
  el rol `authenticated` para insertar en `coupons` y `price_history`, y
  cambia el límite de frecuencia para contar por ese `user_id` real en vez de
  por `client_id`. El propio inicio de sesión anónimo ya tiene su límite en
  Supabase (30/hora por IP por defecto), así que fabricar identidades nuevas
  para saltarse el límite deja de ser gratis.
- `client_id` se sigue guardando (ya no es obligatorio) solo a modo de dato
  histórico, no protege nada por sí mismo desde ahora.
- Mejora opcional anotada pero no aplicada: añadir captcha (Cloudflare
  Turnstile, gratis) al propio inicio de sesión anónimo, para que ni generar
  usuarios anónimos en bucle sea gratis — ver la nota al final de
  `schema-anon-auth.sql`.

## Cambios en el paso anterior (v0.10.0 → v0.11.0): idiomas de interfaz + limpieza

Dos cosas, sin tocar ninguna lógica de la extensión:

- **`_locales/fr`, `_locales/de`, `_locales/it`, `_locales/pt`** (nuevos):
  traducción completa del popup, el onboarding, la página de ajustes y los
  mensajes del widget (cupones y radar de precios). Hasta ahora la interfaz
  solo estaba en `en`/`es`, aunque `content/detector.js` ya reconocía campos
  de cupón en francés, alemán e italiano (`réduction`, `gutschein`,
  `sconto`...) y la ficha de la Chrome Web Store (`store-listing.md`) ya
  prometía soporte en esos idiomas más portugués — era un hueco real entre
  lo que la extensión detectaba y lo que podía mostrar. Cada archivo tiene
  exactamente las mismas claves que `en/messages.json` (comprobado
  automáticamente, ninguna falta ni sobra), así que Chrome elige el idioma
  solo según el navegador del usuario sin tocar ningún `.js`. El portugués
  usado es neutro; si más adelante quieres distinguir Portugal de Brasil
  bastaría con duplicar `_locales/pt` en `_locales/pt_PT`/`_locales/pt_BR`.
- **Eliminados de verdad `content.js`, `detector.js`, `popup.js` y
  `coupons.json` de la raíz del proyecto.** El README de la v0.9.1 decía que
  ya se habían quitado por ser versiones antiguas sin uso (el `manifest.json`
  apunta a `content/`, `popup/` y `data/`), pero seguían presentes en el
  proyecto y además con contenido distinto al de sus versiones organizadas
  — probablemente se coló una copia vieja al empaquetar. No los usaba nada,
  así que quitarlos no cambia el comportamiento, solo evita confusión si
  algún día alguien edita el archivo equivocado por error.

## Cambios en el paso anterior (v0.9.1 → v0.10.0): radar de precios entre tiendas

Primera versión de lo que el documento original llamaba "Radar de Precios
Omnipresente": avisar de que el mismo producto está más barato en otra
tienda, no solo si ha subido en la misma. El README de v0.9.0 ya avisaba de
que esto necesitaba primero resolver cómo saber que dos URLs de tiendas
distintas son "el mismo producto" — esta versión lo resuelve de la forma
más fiable posible sin inventar nada: usando datos que las propias tiendas
ya publican para SEO.

- **`content/detector.js`** (`getJsonLdProductIdentity()`, nueva): busca en
  el mismo bloque `application/ld+json` tipo `Product` que ya se usa para el
  precio un identificador universal del producto, en este orden: **GTIN**
  (código de barras — GTIN-8/12/13/14, el mismo aunque cambie de tienda o de
  país) y, si no hay, **marca + referencia del fabricante (MPN)**. Sin uno
  de los dos, no hay forma fiable de comparar, así que esta parte
  simplemente no se activa en esa ficha.
- **`background.js`** (`fetchCrossStoreDeal()`, nueva): con ese
  identificador, consulta el histórico compartido de `price_history` filtrando
  por **otro dominio**, **misma moneda** (nunca se compara EUR con USD) y
  **últimos 30 días**, y si el precio más bajo visto en otra tienda es un
  10% o más barato que el que estás viendo, avisa. Por debajo de ese 10% no
  dice nada, para no generar ruido por diferencias de envío o IVA.
- **`content/price-radar-widget.js`** + `widget.css`: nuevo tipo de aviso
  (🏷️, borde dorado) para este caso, independiente del de "ha subido" /
  "precio mínimo" — si coinciden los dos a la vez, se prioriza este por ser
  más accionable.
- **`schema-price-radar-crossstore.sql`** (nuevo, ejecútalo después de
  `schema-price-radar.sql`): añade las columnas `gtin`, `brand`, `mpn` a la
  tabla `price_history` que ya tienes, con sus propias reglas de formato —
  no toca ni borra los datos que ya haya en esa tabla.
- Política de privacidad y el texto del interruptor de Ajustes actualizados
  para explicar que, cuando el radar de precios está activo, también se
  envía ese identificador de producto (gtin o marca+referencia) — nunca
  nada sobre ti.

**Límite honesto de esta v1**: solo funciona en tiendas cuya ficha de
producto incluya GTIN o marca+MPN en sus datos estructurados — es habitual
en electrónica, hogar o gran distribución, pero mucho menos en moda,
artesanía o marcas pequeñas/locales, donde este aviso simplemente no
aparecerá nunca. Tampoco intenta adivinar que dos productos "parecidos" son
el mismo por el nombre o la foto (eso sería mucho menos fiable). Como el
resto de la extensión, revisado por código pero no probado todavía contra
fichas de producto reales.

## Cambios en el paso anterior (v0.9.0 → v0.9.1): limpieza y documentación al día

Sin cambios de funcionalidad, solo orden:

- Eliminados `content.js`, `detector.js`, `coupons.json` y `popup.js` de la
  raíz del proyecto: eran versiones antiguas que ya no usaba nada (el
  `manifest.json` apunta a las organizadas en `content/`, `data/` y
  `popup/`). No cambian nada, eran solo restos de pasos anteriores.
- Corregida la sección "Cómo activar el backend compartido": mencionaba un
  archivo `config.js` que ya no existe. Las claves de Supabase se editan
  directamente en `background/background.js`, y **ya vienen rellenas** con
  lo que parece un proyecto Supabase real, no con valores de ejemplo vacíos
  — revisa que sea tuyo antes de dar nada por hecho o de publicar el
  código (ver la propia sección para cómo comprobarlo).

## Cambios en el paso anterior (v0.8.0 → v0.9.0): radar de precios (v1)

Este era el pendiente más grande de la lista original ("Eliminación total
del engaño de rebajas"). Va una versión honesta de lo que se puede construir
sin depender de un scraper externo continuo ni de una IA con acceso a
Telegram (eso sigue pendiente, ver más abajo): un radar que **aprende del
propio uso de la extensión**, exactamente igual que ya hacen los cupones
con el crowdsourcing.

- **Detección de página de producto** (`content/detector.js`,
  `detectProduct()`): nueva, distinta de la detección de carrito. Busca el
  precio, en este orden: datos estructurados `application/ld+json` tipo
  `Product` (lo más fiable, lo usan la mayoría de tiendas grandes para
  SEO), metaetiquetas Open Graph de producto (`product:price:amount`), el
  atributo `itemprop="price"`, y como último recurso un elemento cuyo
  `class`/`id` contenga "price" y cuyo texto parezca dinero.
- **`content/price-radar.js`** (nuevo): si la página es de producto, registra
  el precio de hoy y compara con el histórico de los últimos 30 días. Si el
  precio ha subido un 5% o más respecto al mínimo visto en ese periodo,
  avisa (para que un cupón no disimule una subida previa). Si es el precio
  más bajo visto en ese periodo, también avisa (señal positiva, genera
  confianza). Si no hay suficiente histórico todavía, no dice nada — evita
  falsos positivos con una sola visita.
- **`content/price-radar-widget.js`** + estilos en `content/widget.css`:
  aviso flotante independiente del de cupones (aparece arriba a la derecha,
  el de cupones sigue abajo a la derecha), se cierra solo a los 12 segundos
  o al pulsar la ✕.
- **`background.js`**: histórico local (`chrome.storage.local`, uno por
  dominio+producto, máx. 40 entradas) que funciona sin nada más configurado,
  y se enriquece con el histórico de la comunidad si tienes el backend
  compartido activo — mismo patrón que los cupones, con su propio límite de
  frecuencia (más alto que el de cupones porque este envío es automático,
  no una acción manual del usuario).
- **`schema-price-radar.sql`** (nuevo): tabla `price_history` en Supabase,
  con las mismas ideas de moderación que `schema-moderation.sql` (formato,
  rango de precio válido, límite de frecuencia por dispositivo).
- **Interruptor de privacidad propio** en Ajustes ("Activar el radar de
  precios", activado por defecto): si lo desactivas, la extensión no lee ni
  envía ningún precio, en ninguna página.
- Política de privacidad y ficha de la Chrome Web Store actualizadas para
  describir esta función con precisión.

**Límite honesto de esta v1**: es un radar que depende de que la propia
comunidad visite esas páginas de producto — no hay todavía un scraper
externo rastreando precios de forma proactiva ni comparación entre tiendas
distintas para el mismo producto (eso sería la siguiente fase, y necesita
resolver primero cómo identificar que dos URLs de tiendas distintas son "el
mismo producto", que no es trivial). La detección de precio en la ficha de
producto se ha revisado por código pero, igual que el resto de la
extensión, no se ha probado todavía contra tiendas reales.

## Cambios en el paso anterior (v0.7.0 → v0.8.0): onboarding y página de opciones

De tu lista de pendientes, este es el paso que podía hacer yo entero sin
depender de nada externo (a diferencia de darte de alta en redes de
afiliación, comprar la cuenta de desarrollador de Chrome Web Store o probar
contra un checkout real — esos siguen en tu tejado, ver más abajo).

- **`onboarding/`** (nuevo): pantalla de bienvenida que se abre sola, en una
  pestaña nueva, la primera vez que se instala la extensión (usa
  `chrome.runtime.onInstalled`, `reason === "install"`, así que no se repite
  en cada actualización). Explica en 3 pasos cómo funciona, y es honesta
  sobre la monetización: una sección "Cómo se financia" explica el sellado
  de afiliado en tiendas colaboradoras *antes* de que pase, con enlace
  directo a la política de privacidad y a los ajustes para desactivarlo.
- **`options/`** (nuevo): página de opciones independiente del popup
  (`chrome.runtime.openOptionsPage()`, enlazada también desde un icono ⚙️
  nuevo en la cabecera del popup). Incluye:
  - **Estado**: si el backend compartido está activo, y cuántas tiendas
    tienen ya comisión de afiliado configurada en `data/affiliates.json`
    (cuenta real, ignora las entradas de ejemplo con `_`).
  - **Privacidad**: un interruptor real para desactivar el sellado de
    afiliado (antes solo se podía evitar editando `data/affiliates.json` a
    mano). Se guarda en `chrome.storage.sync` como `affiliateTaggingEnabled`
    y `background.js` lo respeta antes de sellar ninguna visita.
  - **Tus datos**: botón para borrar, con confirmación, los cupones que
    hayas aportado tú y que solo viven en este navegador (no toca los
    cupones compartidos por la comunidad en Supabase).
- **`background.js`**: nuevo listener de instalación, tres mensajes nuevos
  (`GET_STATUS`, `CLEAR_LOCAL_COUPONS`) y `maybeTagAffiliate` ahora comprueba
  el interruptor de privacidad antes de sellar nada.
- **`manifest.json`**: añadida `options_page`, versión a `0.8.0`.
- **Traducciones**: todas las cadenas nuevas (onboarding y opciones) están
  en `_locales/es` y `_locales/en`, mismo patrón `chrome.i18n` que el resto.

## Cambios en el paso anterior: política de privacidad y ficha de la tienda

No es un cambio de código de la extensión (por eso la versión se queda en
0.7.0), sino de los dos documentos que faltaban para poder publicar:

- **`legal/privacy-policy.html`** (nuevo): política de privacidad bilingüe
  (español/inglés con selector), lista para publicar. Describe con
  precisión lo que la extensión hace de verdad (qué se procesa en local, qué
  se envía a Supabase, cómo funciona el sellado de afiliado) — no es un
  texto legal genérico copiado de otro sitio.
- **`store-listing.md`** (nuevo): título, descripción corta (ya comprobada
  dentro del límite de 132 caracteres) y descripción detallada, en español
  e inglés, listas para pegar en el formulario de la Chrome Web Store.

**Antes de publicar** tienes que rellenar dos huecos a mano en esos
archivos: tu correo de contacto (dentro de `privacy-policy.html`) y, una vez
subas `privacy-policy.html` a algún sitio (por ejemplo GitHub Pages), esa
URL real en el propio `privacy-policy.html` y en `store-listing.md`.
Aviso honesto: he redactado esto con cuidado y cubre lo que pide la Chrome
Web Store, pero no soy abogado — si quieres blindarlo del todo de cara al
RGPD (tendrás usuarios en la UE), conviene que alguien con esa formación le
eche un vistazo antes de publicarlo a gran escala.

## Cambios en el paso anterior (v0.6.0 → v0.7.0): moderación anti-spam

Hasta ahora, cualquiera con la "anon key" de Supabase (que va dentro de la
extensión, es pública) podía insertar lo que quisiera en la base de
datos compartida — incluyendo enlaces de spam en la descripción, que se le
mostrarían a todos los usuarios. Este paso lo cierra:

- **`schema-moderation.sql`** (nuevo, ejecútalo una vez en el SQL Editor de
  Supabase después de `schema.sql`): añade reglas a nivel de base de datos —
  formato de código válido (letras/números/espacios/guiones, 2-40
  caracteres), descripción máx. 140 caracteres y sin enlaces, y un límite de
  5 cupones/hora y 20/día por dispositivo. Protege incluso si alguien se
  salta la extensión y llama a la API directamente.
- **`background.js`**: valida el código y la descripción antes de enviarlos
  (mismo formato que la base de datos), genera un identificador anónimo por
  dispositivo (`client_id`, no es una cuenta ni datos personales) para el
  límite de frecuencia, y aplica un límite equivalente también en el modo
  sin backend compartido (solo local).
- **Popup**: si un cupón se rechaza (formato inválido o demasiados envíos
  seguidos), ahora se muestra un aviso explicando por qué, en vez de fallar
  en silencio como antes.

**Límite honesto de esta protección**: el `client_id` se genera y guarda en
el propio navegador, así que alguien que ataque la API directamente (sin
pasar por la extensión) podría generar uno nuevo en cada petición y saltarse
el límite de frecuencia. Frena el spam casual y los errores en bucle, pero
no es un sistema anti-bot robusto. Para eso haría falta autenticación
anónima de Supabase o una función serverless con verificación tipo
Cloudflare Turnstile — queda anotado como posible siguiente paso, no está
hecho todavía.

## Qué incluye esta versión

- **Arreglado un bug bloqueante**: al pulsar "Probar cupones" la extensión
  llamaba a una función (`getCurrentPrice`) que en realidad no existía en el
  detector, así que la verificación de ahorro fallaba silenciosamente en
  todas las tiendas. Ahora sí está implementada.
- **Internacionalización real** (pensado para "todo el mundo", no solo
  España): interfaz (popup y aviso flotante) traducida vía `chrome.i18n`
  a español e inglés según el idioma del navegador del usuario
  (`_locales/es` y `_locales/en`), lista para añadir más idiomas sin tocar
  el resto del código.
- Detección de carrito/checkout, campo de cupón y botón de aplicar ampliada
  más allá de español/inglés: también reconoce términos en francés, alemán,
  portugués e italiano.
- Lectura del precio total ahora reconoce más monedas y formatos de número
  (€, $, £, ¥, ₹, CHF, formatos "1.234,56" y "1,234.56"), y el mensaje de
  ahorro muestra el símbolo/moneda detectado en cada tienda en vez de asumir
  siempre euros.

## Qué incluye esta versión

- Detección de página de carrito/checkout y del campo de código promocional
  (por palabras clave en la URL y en el propio `<input>`, en varios idiomas).
- Widget flotante que avisa de cuántos cupones hay disponibles.
- **Verificación real del ahorro**: detecta el precio total del carrito
  (soporta €, $, £, ¥ y distintos formatos de decimales/miles), prueba cada
  código, mide si el precio bajó, y al final deja aplicado el código que
  mejor ha funcionado, mostrando cuánto te ahorras.
- **Backend compartido opcional (Supabase)**: si lo configuras, los cupones
  que aporte cualquier usuario se guardan en una base de datos compartida y
  los ve todo el mundo, no solo quien los metió. Si no lo configuras, la
  extensión sigue funcionando igual que antes (guardado solo local).
- Base de datos semilla de ejemplo (`data/coupons.json`) con tiendas de
  varios países (Cecotec, PcComponentes, Booking, Amazon, eBay, ASOS) —
  son solo ejemplos para probar el flujo, sustitúyelos por códigos reales.
- Popup de la extensión con los cupones conocidos de la tienda actual, un
  formulario para aportar un código, y un aviso de si se está compartiendo
  con la comunidad o guardando solo en tu navegador.

## Cómo activar el backend compartido (opcional, recomendado)

**Nota (v0.9.1):** esta sección estaba desactualizada — hablaba de un archivo
`config.js` que ya no existe en el proyecto. Desde hace varios pasos las
claves se editan directamente en `background/background.js` (líneas
`SUPABASE_URL` y `SUPABASE_ANON_KEY`, justo al principio del archivo). Ahora
mismo esas dos líneas **ya tienen valores rellenos**, no están vacías —
revisa si ese proyecto de Supabase es tuyo (entra en supabase.com con tu
cuenta y comprueba si aparece en tu lista de proyectos). Si es tuyo, no
tienes que hacer nada más. Si no lo reconoces, sustitúyelo por el tuyo
siguiendo estos pasos, o déjalo en blanco (`""`) para volver al modo solo
local:

1. Crea un proyecto gratuito en [supabase.com](https://supabase.com).
2. En tu proyecto, ve a "SQL Editor" y pega y ejecuta, en este orden:
   `schema.sql` (crea la tabla `coupons` y sus permisos), `schema-moderation.sql`
   (añade las reglas anti-spam y el límite de frecuencia de los cupones — ver
   más arriba), `schema-price-radar.sql` (crea la tabla `price_history` para
   el radar de precios, con sus propias reglas y límite de frecuencia) y
   `schema-price-radar-crossstore.sql` (añade las columnas para comparar el
   mismo producto entre tiendas distintas).
3. Ve a "Project Settings" → "API" y copia la "Project URL" y la
   "anon public key".
4. Abre `background/background.js` y sustituye las dos constantes del
   principio:
   ```js
   const SUPABASE_URL = "https://tuproyecto.supabase.co";
   const SUPABASE_ANON_KEY = "tu-anon-key-aqui";
   ```
5. Recarga la extensión en `chrome://extensions`. A partir de ahora, los
   cupones que se aporten desde el popup se guardan ahí y los ve cualquier
   usuario que tenga la extensión con esas mismas claves.

Si dejas las dos constantes vacías (`""`), no pasa nada: todo sigue
funcionando como en la versión anterior (solo local). La "anon key" de
Supabase está pensada para ir en código de cliente y no es secreta — lo que
de verdad protege tus datos son las reglas de `schema.sql` y
`schema-moderation.sql` (Row Level Security), así que no hay problema en que
esta clave quede visible en el código o en un repositorio público, siempre
que esas reglas estén aplicadas.

## Cómo activar la comisión de afiliado por tienda

1. Date de alta gratis en una red de afiliación (Awin, CJ Affiliate, TradeTracker,
   Amazon Afiliados...) y solicita entrar en el programa de la tienda que te
   interese. Cada tienda te aprueba por separado.
2. Cuando te aprueben, la red te da un enlace de seguimiento (o los datos para
   construirlo: un ID de comercio y tu ID de afiliado).
3. Abre `data/affiliates.json` y añade una entrada con el dominio exacto de la
   tienda, por ejemplo:
   ```json
   "cecotec.es": {
     "network": "awin",
     "trackingUrlTemplate": "https://www.awin1.com/cread.php?awinmid=1234&awinaffid=567890&clickref=cazadora&p={TARGET_URL}"
   }
   ```
   Dejar `{TARGET_URL}` tal cual — la extensión lo sustituye automáticamente
   por la página que esté visitando el usuario.
4. Guarda, recarga la extensión, y listo: a partir de ahí, cada vez que alguien
   entre en esa tienda (una vez al día como máximo), la extensión sella la
   visita contra tu cuenta de afiliado en segundo plano, sin ninguna
   redirección ni cambio visible para el usuario. Si esa persona compra algo
   ese día, la comisión te la pagan a ti.

Mientras una tienda no tenga entrada en `affiliates.json`, la extensión no
hace nada de esto ahí — sigue funcionando solo como buscador de cupones.

## Qué NO incluye todavía (fases siguientes)

- Anti-bot: desde v0.12.0 insertar en `coupons`/`price_history` exige una
  sesión anónima real de Supabase Auth en vez de un `client_id` inventado
  (ver `schema-anon-auth.sql`). Sigue faltando el captcha opcional en el
  propio inicio de sesión anónimo (Cloudflare Turnstile) para que tampoco
  salga gratis generar usuarios anónimos en bucle — es la única capa que
  queda por añadir.
- Scraping automático por IA de Telegram/foros/redes para nutrir la base de
  cupones en cualquier idioma/región.
- Comparación de precios **entre tiendas distintas** para el mismo producto:
  desde v0.10.0 existe una versión inicial (ver más abajo), pero solo
  funciona cuando la ficha del producto expone un código de barras (GTIN) o
  marca+referencia — muchas tiendas de moda, nicho o locales no lo hacen, y
  ahí simplemente no se activa esta parte.
- Pruebas contra carritos y fichas de producto reales de tiendas grandes
  (la detección se ha revisado por código pero no verificado en producción
  contra checkouts/fichas reales de EE. UU., Francia, Alemania, etc.).

## Lo que sigue en tu tejado (yo no puedo hacerlo por ti)

- Activar "Allow anonymous sign-ins" en tu proyecto de Supabase
  (Authentication -> Sign In / Providers -> Anonymous) y ejecutar
  `schema-anon-auth.sql` en el SQL Editor — necesario desde v0.12.0 para que
  aportar cupones o precios siga funcionando.
- Probar la extensión contra checkouts reales (Zara, Amazon, Booking...):
  necesita un navegador de verdad, no puedo simularlo desde aquí.
- Darte de alta y que te aprueben en Awin/CJ/TradeTracker por tienda, para
  que `data/affiliates.json` deje de estar vacío y la monetización empiece a
  facturar.
- Cuenta de desarrollador de Chrome Web Store (pago único, ~5$) y capturas
  de pantalla reales del popup/widget/onboarding funcionando.
- Sustituir los cupones "semilla" de ejemplo por códigos reales (o dejar que
  el crowdsourcing los aporte).
- Revisión legal de la política de privacidad si quieres blindarla del todo
  para RGPD (yo no soy abogado).

## Cómo probarla en tu ordenador

1. Abre Chrome y ve a `chrome://extensions`.
2. Activa el "Modo de desarrollador" (interruptor arriba a la derecha).
3. Pulsa "Cargar descomprimida" y selecciona la carpeta `cazadora-cupones`
   (la que tiene `manifest.json` dentro, directamente, sin subcarpetas).
4. Verás el icono de la extensión en la barra. Entra en alguna tienda de
   ejemplo y ve hasta el carrito/checkout para ver el widget flotante.

## Qué hacer con este proyecto

1. **VS Code**: abre la carpeta `cazadora-cupones` con VS Code
   (`Archivo > Abrir carpeta`) para editar el código cómodamente.
2. **Chrome**: sigue los pasos de arriba ("Cómo probarla") para probarla ya.
3. **GitHub** (opcional pero recomendado):
   - Crea un repositorio nuevo (vacío, sin README) en GitHub.
   - Desde la carpeta del proyecto en una terminal:
     ```bash
     git init
     git add .
     git commit -m "MVP: cupones + verificación de precio + backend compartido opcional"
     git branch -M main
     git remote add origin <URL_DE_TU_REPO>
     git push -u origin main
     ```
   - **Importante si usas GitHub público**: `background/background.js` ya
     lleva rellenas unas claves de Supabase. La "anon key" no es secreta
     (está pensada para ir en el cliente; las políticas de `schema.sql` y
     `schema-moderation.sql` son las que de verdad protegen los datos), así
     que subirla no es un problema de seguridad en sí. Pero antes de subir
     el repo, confirma que ese proyecto de Supabase es tuyo — si no lo
     reconoces, sustitúyelo por el tuyo o vacíalo antes de hacer el primer
     commit.
   - Para las próximas actualizaciones, simplemente sustituye los archivos
     que te vaya indicando y haz `git add . && git commit -m "..." && git push`.

A partir de aquí seguimos puliendo: iré indicando exactamente qué archivos
cambian en cada paso, sin reenviar el proyecto entero salvo que lo pidas.
