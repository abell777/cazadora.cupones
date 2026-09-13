// widget.js
// Construye y controla el widget flotante que se inyecta en la página.
// Los textos salen de _locales/*/messages.json (chrome.i18n), según el
// idioma del navegador del usuario, no están fijados en español.
// Se expone en window.CazadoraWidget

(function () {
  let container = null;

  function remove() {
    if (container) {
      container.remove();
      container = null;
    }
  }

  function setStatus(text) {
    if (!container) return;
    const statusEl = container.querySelector(".cz-status");
    if (statusEl) statusEl.textContent = text;
  }

  function couponsLabel(count) {
    return count === 1
      ? chrome.i18n.getMessage("couponCountSingular")
      : chrome.i18n.getMessage("couponCountPlural").replace("%COUNT%", count);
  }

  function show({ count, onApply, onClose }) {
    remove();

    container = document.createElement("div");
    container.id = "cazadora-widget";

    const message = chrome.i18n
      .getMessage("widgetMessage")
      .replace("%COUPONS%", couponsLabel(count));

    container.innerHTML = `
      <div class="cz-header">
        <span class="cz-brand">${chrome.i18n.getMessage("widgetBrand")}</span>
        <span class="cz-close" title="${chrome.i18n.getMessage("widgetCloseTitle")}">✕</span>
      </div>
      <div class="cz-perforation"></div>
      <div class="cz-body">
        <div class="cz-message">${message}</div>
        <div class="cz-actions">
          <button class="cz-btn primary" id="cz-apply">${chrome.i18n.getMessage("widgetApplyButton")}</button>
          <button class="cz-btn secondary" id="cz-dismiss">${chrome.i18n.getMessage("widgetDismissButton")}</button>
        </div>
        <div class="cz-status"></div>
      </div>
    `;

    document.documentElement.appendChild(container);

    container.querySelector(".cz-close").addEventListener("click", () => {
      remove();
      if (onClose) onClose();
    });
    container.querySelector("#cz-dismiss").addEventListener("click", () => {
      remove();
      if (onClose) onClose();
    });
    container.querySelector("#cz-apply").addEventListener("click", (e) => {
      e.target.disabled = true;
      if (onApply) onApply();
    });
  }

  window.CazadoraWidget = { show, remove, setStatus };
})();
