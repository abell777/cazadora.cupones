// detector.js
// Detecta si la página actual es un carrito/checkout, localiza el campo de
// cupón y sabe leer el precio total del carrito (en cualquier idioma/moneda
// razonable, no solo español/euros).
// Se expone en window.CazadoraDetector para que lo usen content.js y widget.js

(function () {
  // Palabras clave de URL de carrito/checkout en varios idiomas.
  const URL_KEYWORDS = [
    "cart", "carrito", "cesta", "checkout", "basket", "bolsa", "pago", "pedido",
    "panier", "commande", // francés
    "warenkorb", "kasse", "bestellung", // alemán
    "carrinho", "sacola", "finalizar-compra", // portugués
    "carrello", "cassa", "ordine" // italiano
  ];

  // Pistas (name/id/placeholder/aria-label) de que un input es de código promocional.
  const INPUT_KEYWORDS = [
    "cupon", "cupón", "coupon", "promo", "descuento", "discount", "code", "codigo", "código", "voucher",
    "réduction", "reduction", // francés
    "rabattcode", "gutschein", // alemán
    "cupom", // portugués
    "sconto", "codice" // italiano
  ];

  // Texto de botones que aplican el código.
  const BUTTON_KEYWORDS = [
    "aplicar", "apply", "canjear", "validar", "usar código", "usar cupon",
    "appliquer", "valider", // francés
    "anwenden", "einlösen", // alemán
    "aplicar", // portugués (coincide con español)
    "applica", "convalida" // italiano
  ];

  // Etiquetas típicas de "total" del carrito, para localizar el precio.
  const TOTAL_KEYWORDS = [
    "total", "importe total", "precio total", // español
    "grand total", "order total", "cart total", // inglés
    "montant total", // francés
    "gesamtsumme", "gesamtbetrag", "summe", // alemán
    "importo totale", // italiano
    "valor total" // portugués
  ];

  // Símbolos/códigos de moneda habituales en cualquier país.
  const CURRENCY_TOKEN_RE = /(€|\$|£|¥|₹|₩|₽|R\$|CHF|USD|EUR|GBP|zł|kr)/i;
  const MONEY_LOOKS_LIKE_RE = new RegExp(
    "(?:€|\\$|£|¥|₹|₩|₽|R\\$|CHF|USD|EUR|GBP|zł|kr)\\s?\\d|\\d[\\d.,]*\\s?(?:€|\\$|£|¥|₹|₩|₽|CHF|USD|EUR|GBP|zł|kr)",
    "i"
  );

  function textMatchesKeywords(text, keywords) {
    if (!text) return false;
    const normalized = text.toLowerCase();
    return keywords.some((k) => normalized.includes(k));
  }

  function urlLooksLikeCart() {
    return textMatchesKeywords(window.location.href, URL_KEYWORDS);
  }

  function findCouponInput() {
    const inputs = Array.from(document.querySelectorAll("input[type='text'], input:not([type]), input[type='search']"));
    for (const input of inputs) {
      const haystack = [
        input.name,
        input.id,
        input.placeholder,
        input.getAttribute("aria-label"),
        input.className
      ].join(" ");
      if (textMatchesKeywords(haystack, INPUT_KEYWORDS)) {
        return input;
      }
    }
    return null;
  }

  function findApplyButton(nearInput) {
    const scope = nearInput ? nearInput.closest("form, div, section") || document : document;
    const candidates = Array.from(scope.querySelectorAll("button, input[type='submit'], a"));
    for (const el of candidates) {
      const text = el.innerText || el.value || el.getAttribute("aria-label") || "";
      if (textMatchesKeywords(text, BUTTON_KEYWORDS)) {
        return el;
      }
    }
    return null;
  }

  // --- Lectura del precio total (nueva, antes no existía) ---

  function looksLikeMoney(text) {
    if (!text || text.length > 40) return false;
    return MONEY_LOOKS_LIKE_RE.test(text);
  }

  function parseMoney(rawText) {
    if (!rawText) return null;
    const match = rawText.match(/-?\d[\d.,]*\d|\d/);
    if (!match) return null;
    const numStr = match[0];

    const lastComma = numStr.lastIndexOf(",");
    const lastDot = numStr.lastIndexOf(".");
    let decimalSep = null;

    if (lastComma > -1 && lastDot > -1) {
      // El separador decimal es el que aparece más a la derecha (1.234,56 vs 1,234.56)
      decimalSep = lastComma > lastDot ? "," : ".";
    } else if (lastComma > -1) {
      const decimals = numStr.length - lastComma - 1;
      decimalSep = decimals <= 2 ? "," : null; // si no, es separador de miles
    } else if (lastDot > -1) {
      const decimals = numStr.length - lastDot - 1;
      decimalSep = decimals <= 2 ? "." : null;
    }

    let normalized;
    if (decimalSep) {
      const thousandSep = decimalSep === "," ? "." : ",";
      normalized = numStr.split(thousandSep).join("").replace(decimalSep, ".");
    } else {
      normalized = numStr.replace(/[.,]/g, "");
    }

    const value = parseFloat(normalized);
    return Number.isNaN(value) ? null : value;
  }

  function findTotalElement() {
    const nodes = document.querySelectorAll("span, div, td, th, strong, b, p, h1, h2, h3, dd");
    let fallback = null;

    for (const el of nodes) {
      if (el.children.length > 0) continue; // solo nodos "hoja" con texto directo
      const text = el.textContent.trim();
      if (!looksLikeMoney(text)) continue;

      const context = [
        text,
        el.className,
        el.id,
        el.getAttribute("data-testid") || "",
        el.closest("[class]") ? el.closest("[class]").className : ""
      ].join(" ");

      if (textMatchesKeywords(context, TOTAL_KEYWORDS)) {
        return el; // coincidencia fuerte: etiqueta de "total" cerca del importe
      }
      if (!fallback) fallback = el; // por si no encontramos ninguna etiquetada como total
    }
    return fallback;
  }

  function getCurrentPrice() {
    const el = findTotalElement();
    if (!el) return null;
    const raw = el.textContent.trim();
    const value = parseMoney(raw);
    if (value == null) return null;
    return { value, raw, currencyToken: (raw.match(CURRENCY_TOKEN_RE) || [""])[0] };
  }

  function detect() {
    const couponInput = findCouponInput();
    const isCartPage = urlLooksLikeCart() || !!couponInput;
    const applyButton = couponInput ? findApplyButton(couponInput) : null;
    return { isCartPage, couponInput, applyButton };
  }

  // --- Radar de precios: detección de página de producto (distinta del carrito) ---

  function getJsonLdProductPrice() {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const script of scripts) {
      let data;
      try {
        data = JSON.parse(script.textContent);
      } catch (e) {
        continue;
      }
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        const nodes = item && item["@graph"] ? item["@graph"] : [item];
        for (const node of nodes) {
          if (!node) continue;
          const type = node["@type"];
          const typeStr = (Array.isArray(type) ? type.join(",") : type || "").toLowerCase();
          if (!typeStr.includes("product")) continue;
          const offers = Array.isArray(node.offers) ? node.offers[0] : node.offers;
          if (offers && offers.price != null) {
            const value = parseFloat(String(offers.price).replace(",", "."));
            if (!Number.isNaN(value)) {
              return { value, currencyToken: offers.priceCurrency || null, source: "jsonld" };
            }
          }
        }
      }
    }
    return null;
  }

  // GTIN-8/12/13/14 son los formatos estándar (código de barras). Cualquier
  // otra longitud tras quitar espacios/guiones no es un GTIN fiable.
  function normalizeGtin(raw) {
    if (raw == null) return null;
    const digits = String(raw).replace(/[^0-9]/g, "");
    return [8, 12, 13, 14].includes(digits.length) ? digits : null;
  }

  // Busca en los mismos nodos "Product" de JSON-LD un identificador estable
  // del producto que sea el mismo sin importar en qué tienda se venda:
  // primero el GTIN (código de barras universal), y si no hay, marca +
  // referencia del fabricante (MPN). Sin uno de los dos, no hay forma
  // fiable de saber que dos tiendas distintas venden "lo mismo", así que
  // el radar de precios entre tiendas simplemente no se activa ahí.
  function getJsonLdProductIdentity() {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const script of scripts) {
      let data;
      try {
        data = JSON.parse(script.textContent);
      } catch (e) {
        continue;
      }
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        const nodes = item && item["@graph"] ? item["@graph"] : [item];
        for (const node of nodes) {
          if (!node) continue;
          const type = node["@type"];
          const typeStr = (Array.isArray(type) ? type.join(",") : type || "").toLowerCase();
          if (!typeStr.includes("product")) continue;

          const gtin =
            normalizeGtin(node.gtin13) ||
            normalizeGtin(node.gtin14) ||
            normalizeGtin(node.gtin12) ||
            normalizeGtin(node.gtin8) ||
            normalizeGtin(node.gtin);

          const brandNode = node.brand;
          const brand =
            (typeof brandNode === "string" && brandNode.trim()) ||
            (brandNode && typeof brandNode === "object" && typeof brandNode.name === "string" && brandNode.name.trim()) ||
            null;
          const mpn = typeof node.mpn === "string" && node.mpn.trim() ? node.mpn.trim() : null;

          if (gtin) return { gtin, brand: brand || null, mpn: mpn || null };
          if (brand && mpn) return { gtin: null, brand, mpn };
        }
      }
    }
    return null;
  }

  function getMetaProductPrice() {
    const amountSelectors = [
      'meta[property="product:price:amount"]',
      'meta[property="og:price:amount"]'
    ];
    for (const sel of amountSelectors) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const value = parseFloat((el.getAttribute("content") || "").replace(",", "."));
      if (Number.isNaN(value)) continue;
      const currencyEl = document.querySelector(
        'meta[property="product:price:currency"], meta[property="og:price:currency"]'
      );
      return { value, currencyToken: currencyEl ? currencyEl.getAttribute("content") : null, source: "meta" };
    }
    return null;
  }

  function getVisibleProductPrice() {
    const itemPropEl = document.querySelector('[itemprop="price"]');
    if (itemPropEl) {
      const raw = itemPropEl.getAttribute("content") || itemPropEl.textContent;
      const value = parseMoney(raw);
      if (value != null) {
        return { value, raw, currencyToken: (raw.match(CURRENCY_TOKEN_RE) || [""])[0], source: "itemprop" };
      }
    }

    // Último recurso: un elemento hoja cuyo class/id menciona "price" y cuyo
    // texto parece dinero. Es una heurística débil a propósito: si falla,
    // simplemente no se activa el radar de precios en esa página.
    const candidates = Array.from(document.querySelectorAll('[class*="price" i], [id*="price" i]')).filter(
      (el) => el.children.length === 0
    );
    for (const el of candidates) {
      const text = el.textContent.trim();
      if (!looksLikeMoney(text)) continue;
      const value = parseMoney(text);
      if (value != null) {
        return { value, raw: text, currencyToken: (text.match(CURRENCY_TOKEN_RE) || [""])[0], source: "heuristic" };
      }
    }
    return null;
  }

  function detectProduct() {
    const result = getJsonLdProductPrice() || getMetaProductPrice() || getVisibleProductPrice();
    if (!result || result.value == null) return { isProductPage: false };
    const identity = getJsonLdProductIdentity();
    return Object.assign({ isProductPage: true }, result, identity || {});
  }

  window.CazadoraDetector = { detect, getCurrentPrice, detectProduct };
})();
