// background.js (service worker, Manifest V3)
// Responde a peticiones de cupones por dominio, combinando:
//   1) la base de datos semilla incluida en la extensión,
//   2) el backend compartido (Supabase) si rellenas las claves de aquí abajo,
//   3) como último recurso, cupones guardados solo en este navegador.
//
// También aplica una validación básica anti-spam antes de aceptar un cupón
// aportado por un usuario (ver schema-moderation.sql para las mismas reglas
// aplicadas también en la base de datos, por si alguien se salta la extensión).

// ============================================================
// EDITA AQUÍ tus claves de Supabase (ver backend/schema.sql y el README
// para cómo obtenerlas). Mientras estén vacías, la extensión funciona
// igual que antes, guardando los cupones aportados solo en este navegador.
// ============================================================
const SUPABASE_URL = "https://uxpbubaewotvhjghsqyq.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_AaLdTDAEqFd3u7wLABt3JQ_5bbbfJfQ";

const supabaseConfigured = !!SUPABASE_URL && !!SUPABASE_ANON_KEY;

let seedCoupons = null;
let affiliateConfig = null;

async function loadSeedCoupons() {
  if (seedCoupons) return seedCoupons;
  const url = chrome.runtime.getURL("data/coupons.json");
  const res = await fetch(url);
  seedCoupons = await res.json();
  return seedCoupons;
}

async function loadAffiliateConfig() {
  if (affiliateConfig) return affiliateConfig;
  const url = chrome.runtime.getURL("data/affiliates.json");
  const res = await fetch(url);
  affiliateConfig = await res.json();
  return affiliateConfig;
}

// Lista corta de sufijos de segundo nivel habituales (ccTLD tipo .co.uk,
// .com.br...) para no confundir "co" o "com" con el nombre real de la
// tienda al calcular el dominio base. No es exhaustiva (no existe una lista
// corta que lo sea de verdad sin tirar de la Public Suffix List completa),
// pero cubre los mercados que le importan a este proyecto.
const SECOND_LEVEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "net.uk", "co.jp", "co.kr", "co.in", "co.nz", "co.za",
  "com.br", "com.mx", "com.ar", "com.co", "com.au", "com.tr", "com.pe",
  "com.ec", "com.uy", "com.sg", "com.hk", "com.tw"
]);

// Normaliza un hostname (p. ej. "secure.booking.com" o
// "www.checkout.tienda.co.uk") al dominio "base" bajo el que este proyecto
// guarda sus cupones ("booking.com", "tienda.co.uk") — así un checkout en un
// subdominio (secure., checkout., pay...) encuentra los mismos cupones que
// el dominio principal, sin tener que duplicar cada tienda por subdominio.
function normalizeDomain(domain) {
  const hostname = (domain || "").toLowerCase().replace(/^www\./, "");
  const labels = hostname.split(".").filter(Boolean);
  if (labels.length <= 2) return hostname;

  const lastTwo = labels.slice(-2).join(".");
  const lastThree = labels.slice(-3).join(".");
  if (SECOND_LEVEL_SUFFIXES.has(lastTwo)) return lastThree;
  return lastTwo;
}

// --- Validación anti-spam (misma forma que los CHECK de schema-moderation.sql) ---
// Mantener en sync manualmente con schema-moderation.sql si se cambia una de las dos.

const CODE_FORMAT_RE = /^[A-Za-z0-9][A-Za-z0-9 _-]{1,39}$/;
const LINK_RE = /https?:\/\/|www\./i;
const DESC_MAX_LENGTH = 140;

function validateSubmission(code, desc) {
  if (!code || !CODE_FORMAT_RE.test(code)) return "invalid_code";
  if (desc && (desc.length > DESC_MAX_LENGTH || LINK_RE.test(desc))) return "invalid_desc";
  return null;
}

// --- Identificador anónimo del dispositivo (solo informativo desde la
//     migración a auth anónima de Supabase, ver más abajo; se sigue
//     guardando por compatibilidad con filas antiguas, pero ya NO es lo que
//     protege el límite de frecuencia, porque cualquiera puede inventarse
//     uno nuevo en cada petición si llama a la API directamente). ---

async function getOrCreateClientId() {
  const key = "cazadora_client_id";
  const result = await chrome.storage.local.get(key);
  if (result[key]) return result[key];
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ [key]: id });
  return id;
}

// --- Sesión anónima de Supabase Auth (endurecimiento anti-bot) ---
// En vez de confiar en un client_id que el propio navegador se inventa (y que
// un atacante que llame a la API directamente puede cambiar en cada petición
// para saltarse el límite de frecuencia), la extensión inicia sesión como
// "usuario anónimo" real de Supabase Auth. Ese inicio de sesión lo emite el
// servidor y trae su propio límite (30/hora por IP por defecto en Supabase),
// así que generar identidades nuevas deja de ser gratis. Requiere haber
// activado "Allow anonymous sign-ins" en el proyecto de Supabase — ver
// schema-anon-auth.sql. Si no está activado, esto falla en silencio y los
// envíos a la comunidad devuelven error genérico (los cupones locales y la
// lectura de la comunidad siguen funcionando igual).

const ANON_SESSION_KEY = "cazadora_anon_session";
const ANON_SESSION_REFRESH_MARGIN_MS = 60 * 1000; // renovar 1 min antes de que caduque

async function getStoredAnonSession() {
  const result = await chrome.storage.local.get(ANON_SESSION_KEY);
  return result[ANON_SESSION_KEY] || null;
}

async function storeAnonSession(session) {
  await chrome.storage.local.set({ [ANON_SESSION_KEY]: session });
}

async function signInAnonymously() {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ data: {}, gotrue_meta_security: {} })
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.access_token) return null;
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in || 3600) * 1000,
    user_id: data.user?.id || null
  };
}

async function refreshAnonSession(refreshToken) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken })
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.access_token) return null;
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || refreshToken,
    expires_at: Date.now() + (data.expires_in || 3600) * 1000,
    user_id: data.user?.id || null
  };
}

// Devuelve un access_token de usuario anónimo válido, o null si no se pudo
// conseguir (proyecto sin auth anónima activada, sin red, etc.). Reutiliza la
// sesión guardada mientras no esté a punto de caducar, para no hacer un
// inicio de sesión nuevo en cada cupón/precio enviado.
async function getAnonAccessToken() {
  if (!supabaseConfigured) return null;
  try {
    const stored = await getStoredAnonSession();
    if (stored && stored.expires_at > Date.now() + ANON_SESSION_REFRESH_MARGIN_MS) {
      return stored.access_token;
    }
    if (stored && stored.refresh_token) {
      const refreshed = await refreshAnonSession(stored.refresh_token);
      if (refreshed) {
        await storeAnonSession(refreshed);
        return refreshed.access_token;
      }
    }
    const created = await signInAnonymously();
    if (created) {
      await storeAnonSession(created);
      return created.access_token;
    }
    return null;
  } catch (e) {
    console.warn("Cazadora: no se pudo iniciar sesión anónima en Supabase", e);
    return null;
  }
}

// --- Límite de frecuencia local (para el modo sin backend compartido) ---

async function isLocalRateLimited() {
  const key = `local_submissions:${todayKey()}`;
  const result = await chrome.storage.local.get(key);
  return (result[key] || 0) >= 20; // igual que el límite diario del backend
}

async function bumpLocalRateLimit() {
  const key = `local_submissions:${todayKey()}`;
  const result = await chrome.storage.local.get(key);
  await chrome.storage.local.set({ [key]: (result[key] || 0) + 1 });
}

// --- Backend compartido (Supabase) ---

async function fetchCommunityCoupons(domain) {
  if (!supabaseConfigured) return [];
  try {
    const url = `${SUPABASE_URL}/rest/v1/coupons?domain=eq.${encodeURIComponent(
      domain
    )}&status=eq.approved&select=code,desc:description,source`;
    const res = await fetch(url, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`
      }
    });
    if (!res.ok) return [];
    return await res.json();
  } catch (e) {
    console.warn("Cazadora: no se pudo contactar con el backend compartido", e);
    return [];
  }
}

async function postCommunityCoupon(domain, code, desc) {
  if (!supabaseConfigured) return { ok: false, reason: "unknown" };
  try {
    const clientId = await getOrCreateClientId();
    const accessToken = await getAnonAccessToken();
    if (!accessToken) return { ok: false, reason: "unknown" };
    const res = await fetch(`${SUPABASE_URL}/rest/v1/coupons`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify({
        domain,
        code,
        description: desc || "Aportado por la comunidad",
        source: "community",
        status: "approved",
        client_id: clientId
      })
    });
    if (res.ok) return { ok: true };

    // La base de datos rechaza formato inválido o exceso de envíos con un
    // error (constraint / trigger). No distinguimos el motivo exacto aquí
    // porque ya validamos el formato antes de llegar a este punto: si falla
    // en este paso, lo más probable es el límite de frecuencia.
    if (res.status === 429 || res.status === 400 || res.status === 409) {
      return { ok: false, reason: "rate_limited" };
    }
    return { ok: false, reason: "unknown" };
  } catch (e) {
    console.warn("Cazadora: no se pudo guardar el cupón en el backend compartido", e);
    return { ok: false, reason: "unknown" };
  }
}

// --- Inyección del enlace de afiliado (monetización) ---

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

async function alreadyTaggedToday(domain) {
  const key = `affiliate_tagged:${domain}`;
  const result = await chrome.storage.local.get(key);
  return result[key] === todayKey();
}

async function markTaggedToday(domain) {
  const key = `affiliate_tagged:${domain}`;
  await chrome.storage.local.set({ [key]: todayKey() });
}

async function isAffiliateTaggingEnabled() {
  const result = await chrome.storage.sync.get({ affiliateTaggingEnabled: true });
  return result.affiliateTaggingEnabled;
}

async function maybeTagAffiliate(domainRaw, pageUrl) {
  const domain = normalizeDomain(domainRaw);
  const config = await loadAffiliateConfig();
  const entry = config[domain];
  if (!entry || !entry.trackingUrlTemplate) return; // sin programa de afiliados configurado para esta tienda

  if (!(await isAffiliateTaggingEnabled())) return; // el usuario lo ha desactivado en Ajustes

  if (await alreadyTaggedToday(domain)) return; // ya se selló hoy, no repetir en cada página

  const trackingUrl = entry.trackingUrlTemplate.replace(
    "{TARGET_URL}",
    encodeURIComponent(pageUrl)
  );

  try {
    // Petición "silenciosa": no navega al usuario a ningún sitio, solo deja que la
    // red de afiliación registre la visita y ponga su cookie de seguimiento.
    await fetch(trackingUrl, { method: "GET", mode: "no-cors", credentials: "include" });
    await markTaggedToday(domain);
  } catch (e) {
    console.warn("Cazadora: no se pudo sellar el enlace de afiliado", e);
  }
}

// --- Almacenamiento local (fallback cuando no hay backend configurado) ---

async function getLocalUserCoupons(domain) {
  const key = `user_coupons:${domain}`;
  const result = await chrome.storage.local.get(key);
  return result[key] || [];
}

async function addLocalUserCoupon(domain, code, desc) {
  const key = `user_coupons:${domain}`;
  const existing = await getLocalUserCoupons(domain);
  const alreadyExists = existing.some((c) => c.code.toLowerCase() === code.toLowerCase());
  if (!alreadyExists) {
    existing.push({ code, desc: desc || "Aportado por la comunidad", source: "local" });
    await chrome.storage.local.set({ [key]: existing });
  }
}

// --- Radar de precios: histórico local + backend compartido opcional ---
// Mismo patrón que los cupones: funciona solo-local si no hay Supabase
// configurado, y se enriquece con el histórico de la comunidad si lo hay.

const PRODUCT_KEY_RE = /^[\w\-./%]{1,200}$/;
const PRICE_HISTORY_DAYS_KEPT = 40;
const PRICE_SHARED_DAILY_LIMIT = 200; // envíos automáticos, no manuales: límite más alto que el de cupones

function priceHistoryStorageKey(domain, productKey) {
  return `price_history:${domain}:${productKey}`;
}

async function loadLocalPriceHistory(domain, productKey) {
  const key = priceHistoryStorageKey(domain, productKey);
  const result = await chrome.storage.local.get(key);
  return result[key] || [];
}

async function recordLocalPrice(domain, productKey, value, currencyToken) {
  const key = priceHistoryStorageKey(domain, productKey);
  const history = await loadLocalPriceHistory(domain, productKey);
  const today = todayKey();
  const idx = history.findIndex((h) => h.date === today);
  const entry = { date: today, value, currencyToken: currencyToken || null };
  if (idx >= 0) {
    history[idx] = entry;
  } else {
    history.push(entry);
  }
  const trimmed = history.slice(-PRICE_HISTORY_DAYS_KEPT);
  await chrome.storage.local.set({ [key]: trimmed });
  return trimmed;
}

function validatePriceSubmission(domain, productKey, value) {
  if (!domain) return "invalid_product";
  if (!PRODUCT_KEY_RE.test(productKey || "")) return "invalid_product";
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1000000) {
    return "invalid_price";
  }
  return null;
}

// Limpia el identificador de producto entre tiendas que llega del content
// script. gtin solo se acepta si tiene pinta real de código de barras
// (8-14 dígitos); si no, se descarta en vez de fallar toda la petición —
// la extensión simplemente no podrá comparar ese producto entre tiendas.
function sanitizeIdentity(gtinRaw, brandRaw, mpnRaw) {
  const gtin = typeof gtinRaw === "string" && /^[0-9]{8,14}$/.test(gtinRaw) ? gtinRaw : null;
  const brand = typeof brandRaw === "string" && brandRaw.trim() ? brandRaw.trim().slice(0, 80) : null;
  const mpn = typeof mpnRaw === "string" && mpnRaw.trim() ? mpnRaw.trim().slice(0, 80) : null;
  return { gtin, brand, mpn };
}

async function isPriceRateLimited() {
  const key = `local_price_submissions:${todayKey()}`;
  const result = await chrome.storage.local.get(key);
  return (result[key] || 0) >= PRICE_SHARED_DAILY_LIMIT;
}

async function bumpPriceRateLimit() {
  const key = `local_price_submissions:${todayKey()}`;
  const result = await chrome.storage.local.get(key);
  await chrome.storage.local.set({ [key]: (result[key] || 0) + 1 });
}

async function fetchCommunityPriceHistory(domain, productKey) {
  if (!supabaseConfigured) return [];
  try {
    const url =
      `${SUPABASE_URL}/rest/v1/price_history?domain=eq.${encodeURIComponent(domain)}` +
      `&product_key=eq.${encodeURIComponent(productKey)}` +
      `&select=price,currency,created_at&order=created_at.asc&limit=60`;
    const res = await fetch(url, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
    });
    if (!res.ok) return [];
    const rows = await res.json();
    return rows.map((r) => ({
      date: (r.created_at || "").slice(0, 10),
      value: r.price,
      currencyToken: r.currency
    }));
  } catch (e) {
    console.warn("Cazadora: no se pudo leer el histórico de precios compartido", e);
    return [];
  }
}

async function postCommunityPrice(domain, productKey, value, currencyToken, url, gtin, brand, mpn) {
  if (!supabaseConfigured) return { ok: false };
  try {
    const clientId = await getOrCreateClientId();
    const accessToken = await getAnonAccessToken();
    if (!accessToken) return { ok: false };
    const res = await fetch(`${SUPABASE_URL}/rest/v1/price_history`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify({
        domain,
        product_key: productKey,
        price: value,
        currency: currencyToken || null,
        url: url || null,
        client_id: clientId,
        gtin: gtin || null,
        brand: brand || null,
        mpn: mpn || null
      })
    });
    return { ok: res.ok };
  } catch (e) {
    console.warn("Cazadora: no se pudo guardar el precio en el histórico compartido", e);
    return { ok: false };
  }
}

// Comprueba si el mismo producto (por gtin, o si no hay, por marca+mpn) se ha
// visto más barato en otra tienda en los últimos 30 días. Requiere backend
// compartido (necesita datos de otras visitas de la comunidad) y una moneda
// conocida (nunca comparamos precios en monedas distintas). Solo avisa si la
// diferencia es lo bastante grande como para no ser ruido de envío/IVA.
const CROSS_STORE_MIN_DISCOUNT_PERCENT = 10;

async function fetchCrossStoreDeal(domain, gtin, brand, mpn, currencyToken, currentValue) {
  if (!supabaseConfigured) return null;
  if (!currencyToken) return null;
  if (!gtin && !(brand && mpn)) return null;

  try {
    const cutoffIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const identityFilter = gtin
      ? `gtin=eq.${encodeURIComponent(gtin)}`
      : `brand=eq.${encodeURIComponent(brand)}&mpn=eq.${encodeURIComponent(mpn)}`;
    const url =
      `${SUPABASE_URL}/rest/v1/price_history?${identityFilter}` +
      `&domain=neq.${encodeURIComponent(domain)}` +
      `&currency=eq.${encodeURIComponent(currencyToken)}` +
      `&created_at=gte.${encodeURIComponent(cutoffIso)}` +
      `&select=domain,price&order=price.asc&limit=20`;
    const res = await fetch(url, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` }
    });
    if (!res.ok) return null;
    const rows = await res.json();
    if (!rows.length) return null;

    const best = rows[0]; // ya viene ordenado por precio ascendente
    const pctCheaper = ((currentValue - best.price) / currentValue) * 100;
    if (pctCheaper < CROSS_STORE_MIN_DISCOUNT_PERCENT) return null;

    return { domain: best.domain, price: best.price, pctCheaper };
  } catch (e) {
    console.warn("Cazadora: no se pudo comprobar precios en otras tiendas", e);
    return null;
  }
}

// Combina el histórico local con el compartido, quedándose con un único
// valor por día (el compartido "gana" si hay dos para el mismo día, porque
// suele reflejar más observaciones que la propia).
function mergeHistoryByDate(entries) {
  const byDate = new Map();
  for (const entry of entries) {
    if (!entry || entry.value == null || !entry.date) continue;
    byDate.set(entry.date, entry);
  }
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

async function recordAndGetPriceHistory(domainRaw, productKeyRaw, value, currencyToken, url, gtinRaw, brandRaw, mpnRaw) {
  const domain = normalizeDomain(domainRaw);
  const productKey = (productKeyRaw || "").slice(0, 200);
  const { gtin, brand, mpn } = sanitizeIdentity(gtinRaw, brandRaw, mpnRaw);

  const validationError = validatePriceSubmission(domain, productKey, value);
  if (validationError) return { history: [], error: validationError };

  const localHistory = await recordLocalPrice(domain, productKey, value, currencyToken);

  if (!supabaseConfigured) {
    return { history: localHistory, crossStoreDeal: null, error: null };
  }

  if (!(await isPriceRateLimited())) {
    const result = await postCommunityPrice(domain, productKey, value, currencyToken, url, gtin, brand, mpn);
    if (result.ok) await bumpPriceRateLimit();
  }

  const communityHistory = await fetchCommunityPriceHistory(domain, productKey);
  const crossStoreDeal = await fetchCrossStoreDeal(domain, gtin, brand, mpn, currencyToken, value);

  return {
    history: mergeHistoryByDate([...communityHistory, ...localHistory]),
    crossStoreDeal,
    error: null
  };
}

// --- Estado para la página de opciones ---

function countConfiguredAffiliateStores(config) {
  return Object.entries(config).filter(
    ([key, entry]) => !key.startsWith("_") && entry && entry.trackingUrlTemplate
  ).length;
}

async function getStatus() {
  const config = await loadAffiliateConfig();
  return {
    sharedBackend: supabaseConfigured,
    affiliateStoreCount: countConfiguredAffiliateStores(config)
  };
}

async function clearLocalCoupons() {
  const all = await chrome.storage.local.get(null);
  const keysToRemove = Object.keys(all).filter(
    (k) => k.startsWith("user_coupons:") || k.startsWith("price_history:")
  );
  if (keysToRemove.length) await chrome.storage.local.remove(keysToRemove);
}

// --- Primera instalación: onboarding ---

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("onboarding/onboarding.html") });
  }
});

// --- API combinada ---

function dedupeByCode(coupons) {
  const seen = new Set();
  return coupons.filter((c) => {
    const key = c.code.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function getCouponsForDomain(domainRaw) {
  const domain = normalizeDomain(domainRaw);
  const seeds = await loadSeedCoupons();
  const seedList = seeds[domain] || [];
  const communityList = await fetchCommunityCoupons(domain);
  const localList = supabaseConfigured ? [] : await getLocalUserCoupons(domain);
  return dedupeByCode([...seedList, ...communityList, ...localList]);
}

async function addUserCoupon(domainRaw, codeRaw, descRaw) {
  const domain = normalizeDomain(domainRaw);
  const code = (codeRaw || "").trim();
  const desc = (descRaw || "").trim();

  const validationError = validateSubmission(code, desc);
  if (validationError) {
    return { coupons: await getCouponsForDomain(domain), error: validationError };
  }

  if (supabaseConfigured) {
    const result = await postCommunityCoupon(domain, code, desc);
    if (!result.ok) {
      return { coupons: await getCouponsForDomain(domain), error: result.reason };
    }
  } else {
    if (await isLocalRateLimited()) {
      return { coupons: await getCouponsForDomain(domain), error: "rate_limited" };
    }
    await addLocalUserCoupon(domain, code, desc);
    await bumpLocalRateLimit();
  }

  return { coupons: await getCouponsForDomain(domain), error: null };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_COUPONS_FOR_DOMAIN") {
    getCouponsForDomain(message.domain).then((coupons) => {
      sendResponse({ coupons, sharedBackend: supabaseConfigured });
    });
    return true; // respuesta asíncrona
  }

  if (message.type === "ADD_USER_COUPON") {
    addUserCoupon(message.domain, message.code, message.desc).then(({ coupons, error }) => {
      sendResponse({ coupons, sharedBackend: supabaseConfigured, error });
    });
    return true;
  }

  if (message.type === "MAYBE_TAG_AFFILIATE") {
    maybeTagAffiliate(message.domain, message.pageUrl);
    // No hace falta respuesta: es una acción "dispara y olvida".
  }

  if (message.type === "GET_STATUS") {
    getStatus().then(sendResponse);
    return true;
  }

  if (message.type === "CLEAR_LOCAL_COUPONS") {
    clearLocalCoupons().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === "RECORD_PRICE") {
    recordAndGetPriceHistory(
      message.domain,
      message.productKey,
      message.value,
      message.currencyToken,
      message.url,
      message.gtin,
      message.brand,
      message.mpn
    ).then(sendResponse);
    return true;
  }
});
