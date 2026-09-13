// price-radar-widget.js
// Aviso flotante, pequeño y discreto, para el radar de precios. Es un
// elemento distinto del widget de cupones (#cazadora-widget) porque puede
// aparecer en páginas de producto donde el widget de cupones no aparece
// (no hay carrito ni campo de cupón todavía).
// Se expone en window.CazadoraPriceRadarWidget

(function () {
  let container = null;
  let hideTimeout = null;

  function remove() {
    if (hideTimeout) {
      clearTimeout(hideTimeout);
      hideTimeout = null;
    }
    if (container) {
      container.remove();
      container = null;
    }
  }

  // kind: "up" (ha subido, cuidado) | "low" (precio bajo histórico, buena
  // señal) | "cheaper-elsewhere" (mismo producto más barato en otra tienda)
  function show({ kind, message }) {
    remove();

    const icons = { up: "📈", low: "📉", "cheaper-elsewhere": "🏷️" };

    container = document.createElement("div");
    container.id = "cazadora-price-radar";
    container.className = `cz-pr-${kind}`;

    container.innerHTML = `
      <span class="cz-pr-icon">${icons[kind] || "📊"}</span>
      <span class="cz-pr-message">${message}</span>
      <span class="cz-pr-close" title="${chrome.i18n.getMessage("widgetCloseTitle")}">✕</span>
    `;

    document.documentElement.appendChild(container);

    container.querySelector(".cz-pr-close").addEventListener("click", remove);

    // Se retira solo pasado un rato, para no quedarse pegado en pantalla.
    hideTimeout = setTimeout(remove, 12000);
  }

  window.CazadoraPriceRadarWidget = { show, remove };
})();
