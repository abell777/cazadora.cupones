// content.js
// Orquesta la detección de carrito, la petición de cupones al background
// y la interacción con el widget flotante.

(function () {
  function getDomain() {
    return window.location.hostname.replace(/^www\./, "");
  }

  function dispatchNativeInputEvents(el) {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function applyCode(couponInput, applyButton, code) {
    couponInput.focus();
    couponInput.value = code;
    dispatchNativeInputEvents(couponInput);
    if (applyButton) applyButton.click();
  }

  // Formatea un ahorro reutilizando el símbolo/código de moneda detectado en
  // el precio original, para no asumir siempre euros.
  function formatMoney(value, sampleRaw) {
    const token = sampleRaw && sampleRaw.match(/(€|\$|£|¥|₹|₩|₽|R\$|CHF|USD|EUR|GBP|zł|kr)/i);
    return token ? `${value.toFixed(2)} ${token[0]}` : value.toFixed(2);
  }

  async function tryCoupons(coupons, couponInput, applyButton) {
    const initial = window.CazadoraDetector.getCurrentPrice();
    let bestPrice = initial ? initial.value : null;
    let bestCode = null;

    for (let i = 0; i < coupons.length; i++) {
      const coupon = coupons[i];
      window.CazadoraWidget.setStatus(
        chrome.i18n
          .getMessage("statusTryingCode")
          .replace("%INDEX%", i + 1)
          .replace("%TOTAL%", coupons.length)
          .replace("%CODE%", coupon.code)
      );

      applyCode(couponInput, applyButton, coupon.code);

      // Pausa para dar tiempo a que la tienda recalcule el total antes de comprobarlo.
      await sleep(1400);

      const current = window.CazadoraDetector.getCurrentPrice();
      if (current && current.value != null) {
        if (bestPrice == null || current.value < bestPrice) {
          bestPrice = current.value;
          bestCode = coupon.code;
        }
      }
    }

    if (bestCode) {
      // Nos aseguramos de dejar aplicado el código que más ha bajado el precio,
      // por si no fue el último que probamos.
      applyCode(couponInput, applyButton, bestCode);
      await sleep(1000);

      // Sellado de afiliado: SOLO aquí, tras un clic del usuario en "Probar
      // cupones" y con un código que ha confirmado un precio más bajo. Nunca
      // en la carga de la página ni sin haber encontrado descuento real
      // (política de afiliados de Chrome: acción del usuario + beneficio
      // directo en ese momento, no un sellado silencioso de fondo).
      tagAffiliateForConfirmedBenefit();

      const saved = initial && initial.value != null ? initial.value - bestPrice : null;
      if (saved && saved > 0) {
        window.CazadoraWidget.setStatus(
          chrome.i18n
            .getMessage("statusBestCode")
            .replace("%CODE%", bestCode)
            .replace("%AMOUNT%", formatMoney(saved, initial && initial.raw))
        );
      } else {
        window.CazadoraWidget.setStatus(
          chrome.i18n.getMessage("statusApplied").replace("%CODE%", bestCode)
        );
      }
    } else {
      window.CazadoraWidget.setStatus(
        chrome.i18n.getMessage("statusNoConfirm").replace("%COUNT%", coupons.length)
      );
    }
  }

  // Muchos checkouts (Cecotec incluido) renderizan el campo de cupón con
  // JavaScript DESPUÉS del evento "load" (llamadas a su API interna, carrito
  // SPA, etc.), así que una única comprobación a los 800ms puede llegar
  // demasiado pronto y no encontrar nada. En vez de eso, vigilamos la página
  // de forma continua: primero por cambios reales en el DOM (MutationObserver,
  // reacciona al instante) y con un sondeo de refuerzo cada 1.5s durante un
  // rato por si el cambio no dispara el observer (por ejemplo si el campo se
  // rellena dentro de un <iframe> o un Shadow DOM cerrado que no podemos ver).
  const POLL_INTERVAL_MS = 1500;
  const POLL_TIMEOUT_MS = 30000;
  const MUTATION_DEBOUNCE_MS = 400;

  let currentUrl = window.location.href;
  let shownForUrl = null; // evita mostrar el aviso más de una vez para la misma URL
  let pollTimer = null;
  let pollDeadline = 0;
  let mutationDebounceTimer = null;

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function attemptDetect() {
    if (!window.CazadoraDetector || !window.CazadoraWidget) return;
    if (shownForUrl === window.location.href) {
      stopPolling();
      return;
    }

    const { isCartPage, couponInput, applyButton } = window.CazadoraDetector.detect();
    if (!isCartPage || !couponInput) {
      if (Date.now() > pollDeadline) stopPolling(); // nos rendimos tras 30s, no seguimos mirando para siempre
      return;
    }

    stopPolling();
    shownForUrl = window.location.href;

    const domain = getDomain();
    chrome.runtime.sendMessage(
      { type: "GET_COUPONS_FOR_DOMAIN", domain },
      (response) => {
        if (!response || !response.coupons || response.coupons.length === 0) return;

        const coupons = response.coupons;

        window.CazadoraWidget.show({
          count: coupons.length,
          onApply: () => tryCoupons(coupons, couponInput, applyButton),
          onClose: () => {}
        });
      }
    );
  }

  function startWatching() {
    pollDeadline = Date.now() + POLL_TIMEOUT_MS;
    attemptDetect();
    if (shownForUrl === window.location.href) return; // ya lo encontró al primer intento
    pollTimer = setInterval(attemptDetect, POLL_INTERVAL_MS);
  }

  function onDomMutated() {
    clearTimeout(mutationDebounceTimer);
    mutationDebounceTimer = setTimeout(attemptDetect, MUTATION_DEBOUNCE_MS);
  }

  function tagAffiliateForConfirmedBenefit() {
    // Únicamente se llama desde tryCoupons() cuando el usuario ha pulsado
    // "Probar cupones" y un código concreto ha bajado el precio de verdad.
    // No se llama nunca al cargar o navegar por la página: eso sería sellado
    // de afiliado sin acción del usuario ni beneficio confirmado, que es lo
    // que prohíbe la política de anuncios de afiliados de Chrome Web Store.
    chrome.runtime.sendMessage({
      type: "MAYBE_TAG_AFFILIATE",
      domain: getDomain(),
      pageUrl: window.location.href
    });
  }

  function handlePossibleNavigation() {
    if (window.location.href === currentUrl) return;
    currentUrl = window.location.href;
    shownForUrl = null; // nueva página: puede que ahora sí sea el carrito
    startWatching();
  }

  // Muchas tiendas (Zara, Cecotec incluidas en parte de su flujo) navegan del
  // catálogo/producto al carrito sin recargar la página entera (SPA), así que
  // "load" no vuelve a dispararse. Detectamos esos cambios de ruta enganchando
  // pushState/replaceState (los usa el router de la SPA) y "popstate" (botón
  // atrás/adelante del navegador).
  ["pushState", "replaceState"].forEach((method) => {
    const original = history[method];
    history[method] = function (...args) {
      const result = original.apply(this, args);
      handlePossibleNavigation();
      return result;
    };
  });
  window.addEventListener("popstate", handlePossibleNavigation);

  function init() {
    if (!window.CazadoraDetector || !window.CazadoraWidget) return;
    startWatching();

    new MutationObserver(onDomMutated).observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  if (document.readyState === "complete") {
    setTimeout(init, 500);
  } else {
    window.addEventListener("load", () => setTimeout(init, 500));
  }
})();
