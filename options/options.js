// options.js — página de opciones (separada del popup)

function localizeDocument() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const msg = chrome.i18n.getMessage(el.getAttribute("data-i18n"));
    if (msg) el.textContent = msg;
  });
}

function renderStatus(status) {
  const backendEl = document.getElementById("cz-status-backend");
  const affiliatesEl = document.getElementById("cz-status-affiliates");

  backendEl.textContent = chrome.i18n.getMessage(
    status.sharedBackend ? "optionsStatusBackendOn" : "optionsStatusBackendOff"
  );

  affiliatesEl.textContent = chrome.i18n
    .getMessage("optionsStatusAffiliateCount")
    .replace("%COUNT%", status.affiliateStoreCount);
}

function loadStatus() {
  chrome.runtime.sendMessage({ type: "GET_STATUS" }, (response) => {
    if (response) renderStatus(response);
  });
}

function loadAffiliateToggle() {
  chrome.storage.sync.get({ affiliateTaggingEnabled: true }, (result) => {
    document.getElementById("cz-affiliate-toggle").checked = result.affiliateTaggingEnabled;
  });
}

function loadPriceRadarToggle() {
  chrome.storage.sync.get({ priceRadarEnabled: true }, (result) => {
    document.getElementById("cz-price-radar-toggle").checked = result.priceRadarEnabled;
  });
}

document.addEventListener("DOMContentLoaded", () => {
  localizeDocument();
  loadStatus();
  loadAffiliateToggle();
  loadPriceRadarToggle();

  document.getElementById("cz-affiliate-toggle").addEventListener("change", (e) => {
    chrome.storage.sync.set({ affiliateTaggingEnabled: e.target.checked });
  });

  document.getElementById("cz-price-radar-toggle").addEventListener("change", (e) => {
    chrome.storage.sync.set({ priceRadarEnabled: e.target.checked });
  });

  document.getElementById("cz-clear-data").addEventListener("click", () => {
    const confirmed = window.confirm(chrome.i18n.getMessage("optionsClearDataConfirm"));
    if (!confirmed) return;

    chrome.runtime.sendMessage({ type: "CLEAR_LOCAL_COUPONS" }, () => {
      const doneEl = document.getElementById("cz-clear-done");
      doneEl.hidden = false;
      setTimeout(() => {
        doneEl.hidden = true;
      }, 4000);
    });
  });
});
