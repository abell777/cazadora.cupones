// popup.js

const ERROR_MESSAGE_KEYS = {
  invalid_code: "popupErrorInvalidCode",
  invalid_desc: "popupErrorInvalidDesc",
  rate_limited: "popupErrorRateLimited",
  unknown: "popupErrorGeneric"
};

function localizeDocument() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const msg = chrome.i18n.getMessage(el.getAttribute("data-i18n"));
    if (msg) el.textContent = msg;
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    const msg = chrome.i18n.getMessage(el.getAttribute("data-i18n-placeholder"));
    if (msg) el.placeholder = msg;
  });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    const msg = chrome.i18n.getMessage(el.getAttribute("data-i18n-title"));
    if (msg) {
      el.title = msg;
      el.setAttribute("aria-label", msg);
    }
  });
}

// Misma lógica que normalizeDomain() en background/background.js — duplicada
// aquí porque el popup no comparte módulos con el service worker. Si se
// cambia una, cambiar la otra.
const SECOND_LEVEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "net.uk", "co.jp", "co.kr", "co.in", "co.nz", "co.za",
  "com.br", "com.mx", "com.ar", "com.co", "com.au", "com.tr", "com.pe",
  "com.ec", "com.uy", "com.sg", "com.hk", "com.tw"
]);

function normalizeDomain(hostname) {
  const clean = (hostname || "").toLowerCase().replace(/^www\./, "");
  const labels = clean.split(".").filter(Boolean);
  if (labels.length <= 2) return clean;

  const lastTwo = labels.slice(-2).join(".");
  const lastThree = labels.slice(-3).join(".");
  if (SECOND_LEVEL_SUFFIXES.has(lastTwo)) return lastThree;
  return lastTwo;
}

function renderCoupons(coupons) {
  const list = document.getElementById("cz-coupon-list");
  list.innerHTML = "";

  if (!coupons || coupons.length === 0) {
    const li = document.createElement("li");
    li.className = "cz-empty";
    li.textContent = chrome.i18n.getMessage("popupEmptyCoupons");
    list.appendChild(li);
    return;
  }

  coupons.forEach((c) => {
    const li = document.createElement("li");
    const codeSpan = document.createElement("span");
    codeSpan.className = "cz-code";
    codeSpan.textContent = c.code;
    const descSpan = document.createElement("span");
    descSpan.className = "cz-desc";
    descSpan.textContent = c.desc || "";
    li.appendChild(codeSpan);
    li.appendChild(descSpan);
    list.appendChild(li);
  });
}

let currentDomain = null;

function updateHint(sharedBackend) {
  const hint = document.getElementById("cz-hint");
  if (!hint) return;
  hint.textContent = chrome.i18n.getMessage(sharedBackend ? "popupHintShared" : "popupHintLocal");
}

function showError(errorCode) {
  const errorEl = document.getElementById("cz-error");
  if (!errorEl) return;
  if (!errorCode) {
    errorEl.hidden = true;
    errorEl.textContent = "";
    return;
  }
  const key = ERROR_MESSAGE_KEYS[errorCode] || ERROR_MESSAGE_KEYS.unknown;
  errorEl.textContent = chrome.i18n.getMessage(key);
  errorEl.hidden = false;
}

function loadCouponsForDomain(domain) {
  chrome.runtime.sendMessage({ type: "GET_COUPONS_FOR_DOMAIN", domain }, (response) => {
    renderCoupons(response ? response.coupons : []);
    updateHint(response ? response.sharedBackend : false);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  localizeDocument();

  document.getElementById("cz-settings-btn").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  const affiliateInfoBtn = document.getElementById("cz-affiliate-info-btn");
  if (affiliateInfoBtn) {
    affiliateInfoBtn.addEventListener("click", () => {
      chrome.tabs.create({ url: chrome.runtime.getURL("legal/privacy-policy.html") });
    });
  }

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab || !tab.url) {
      document.getElementById("cz-domain").textContent = chrome.i18n.getMessage("popupNoStoreDetected");
      return;
    }
    try {
      const url = new URL(tab.url);
      currentDomain = normalizeDomain(url.hostname);
      document.getElementById("cz-domain").textContent = chrome.i18n
        .getMessage("popupCurrentStore")
        .replace("%DOMAIN%", currentDomain);
      loadCouponsForDomain(currentDomain);
    } catch (e) {
      document.getElementById("cz-domain").textContent = chrome.i18n.getMessage("popupNoStoreDetected");
    }
  });

  document.getElementById("cz-add-form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (!currentDomain) return;

    const code = document.getElementById("cz-code-input").value.trim();
    const desc = document.getElementById("cz-desc-input").value.trim();
    if (!code) return;

    showError(null);

    chrome.runtime.sendMessage(
      { type: "ADD_USER_COUPON", domain: currentDomain, code, desc },
      (response) => {
        renderCoupons(response ? response.coupons : []);
        updateHint(response ? response.sharedBackend : false);
        showError(response ? response.error : "unknown");
        if (!response || !response.error) {
          document.getElementById("cz-code-input").value = "";
          document.getElementById("cz-desc-input").value = "";
        }
      }
    );
  });
});
