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

  async function init() {
    if (!window.CazadoraDetector || !window.CazadoraWidget) return;

    const domain = getDomain();

    // Sellado de afiliado: se intenta en cualquier página de la tienda, no solo
    // en el carrito, para maximizar que la cookie de la red esté puesta cuando
    // el usuario acabe comprando. No tiene ningún efecto visible.
    chrome.runtime.sendMessage({
      type: "MAYBE_TAG_AFFILIATE",
      domain,
      pageUrl: window.location.href
    });

    const { isCartPage, couponInput, applyButton } = window.CazadoraDetector.detect();
    if (!isCartPage || !couponInput) return;

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

  // Espera a que la página esté razonablemente asentada (SPA-friendly: reintento simple)
  if (document.readyState === "complete") {
    setTimeout(init, 800);
  } else {
    window.addEventListener("load", () => setTimeout(init, 800));
  }
})();
