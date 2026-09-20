// privacy-policy.js

function localizeDocument() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const msg = chrome.i18n.getMessage(el.getAttribute("data-i18n"));
    if (msg) el.textContent = msg;
  });
}

document.addEventListener("DOMContentLoaded", () => {
  localizeDocument();

  const backLink = document.getElementById("cz-back-link");
  if (backLink) {
    backLink.addEventListener("click", (e) => {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    });
  }
});
