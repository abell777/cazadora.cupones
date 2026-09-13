// onboarding.js — se abre una sola vez, al instalar la extensión

function localizeDocument() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const msg = chrome.i18n.getMessage(el.getAttribute("data-i18n"));
    if (msg) el.textContent = msg;
  });
}

document.addEventListener("DOMContentLoaded", () => {
  localizeDocument();

  document.getElementById("cz-cta").addEventListener("click", () => {
    window.close();
  });

  document.getElementById("cz-open-settings").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });
});
