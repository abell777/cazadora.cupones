// price-radar.js
// Orquesta el radar de precios: si la página actual es una ficha de
// producto, registra el precio (local + backend compartido opcional, igual
// que los cupones) y avisa si ha subido antes de una rebaja, o si es el
// precio más bajo visto en el histórico reciente.
// Independiente del flujo de cupones (content.js): puede activarse en
// páginas de producto donde todavía no hay carrito ni campo de cupón.

(function () {
  const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000; // 30 días
  const UP_THRESHOLD_PERCENT = 5;

  function getDomain() {
    return window.location.hostname.replace(/^www\./, "");
  }

  function getProductKey() {
    // Dominio + ruta (sin query ni hash) como identificador estable del
    // producto. No es perfecto (algunas tiendas cambian la URL sin cambiar
    // de producto, o al revés), pero es un punto de partida razonable sin
    // depender de nada específico de cada tienda.
    return window.location.pathname.replace(/\/+$/, "") || "/";
  }

  function formatMoney(value, currencyToken) {
    return currencyToken ? `${value.toFixed(2)} ${currencyToken}` : value.toFixed(2);
  }

  // history: [{ date: "YYYY-MM-DD", value, currencyToken }], puede venir sin ordenar.
  function analyze(history, currentValue, todayIso) {
    const cutoffTime = Date.now() - LOOKBACK_MS;
    const past = (history || []).filter((h) => {
      if (!h || h.value == null || h.date === todayIso) return false;
      const t = new Date(h.date).getTime();
      return !Number.isNaN(t) && t >= cutoffTime;
    });
    if (past.length === 0) return null; // sin datos previos suficientes, no decimos nada todavía

    const minPast = Math.min(...past.map((h) => h.value));

    if (currentValue < minPast) {
      return { kind: "low" };
    }

    const pctUp = ((currentValue - minPast) / minPast) * 100;
    if (pctUp >= UP_THRESHOLD_PERCENT) {
      return { kind: "up", pctUp, minPast };
    }

    return null;
  }

  async function isPriceRadarEnabled() {
    const settings = await chrome.storage.sync.get({ priceRadarEnabled: true });
    return settings.priceRadarEnabled;
  }

  async function init() {
    if (!window.CazadoraDetector || !window.CazadoraPriceRadarWidget) return;
    if (!(await isPriceRadarEnabled())) return;

    const product = window.CazadoraDetector.detectProduct();
    if (!product.isProductPage || product.value == null) return;

    const domain = getDomain();
    const productKey = getProductKey();
    const todayIso = new Date().toISOString().slice(0, 10);

    chrome.runtime.sendMessage(
      {
        type: "RECORD_PRICE",
        domain,
        productKey,
        value: product.value,
        currencyToken: product.currencyToken || null,
        url: window.location.href,
        gtin: product.gtin || null,
        brand: product.brand || null,
        mpn: product.mpn || null
      },
      (response) => {
        if (!response || response.error) return;

        // Prioridad: si hay un mismo producto más barato en otra tienda, ese
        // aviso es más accionable que el histórico de la propia tienda, así
        // que se muestra ese y no los dos a la vez (el widget solo puede
        // mostrar un aviso cada vez).
        if (response.crossStoreDeal) {
          const deal = response.crossStoreDeal;
          const message = chrome.i18n
            .getMessage("priceRadarCheaperElsewhereMessage")
            .replace("%PERCENT%", Math.round(deal.pctCheaper))
            .replace("%STORE%", deal.domain);
          window.CazadoraPriceRadarWidget.show({ kind: "cheaper-elsewhere", message });
          return;
        }

        if (!response.history) return;
        const outcome = analyze(response.history, product.value, todayIso);
        if (!outcome) return;

        if (outcome.kind === "up") {
          const message = chrome.i18n
            .getMessage("priceRadarUpMessage")
            .replace("%PERCENT%", Math.round(outcome.pctUp))
            .replace("%PRICE%", formatMoney(outcome.minPast, product.currencyToken));
          window.CazadoraPriceRadarWidget.show({ kind: "up", message });
        } else if (outcome.kind === "low") {
          window.CazadoraPriceRadarWidget.show({
            kind: "low",
            message: chrome.i18n.getMessage("priceRadarLowMessage")
          });
        }
      }
    );
  }

  // Igual que content.js: espera a que la página esté asentada (SPA-friendly).
  if (document.readyState === "complete") {
    setTimeout(init, 900);
  } else {
    window.addEventListener("load", () => setTimeout(init, 900));
  }
})();
