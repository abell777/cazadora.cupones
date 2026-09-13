#!/usr/bin/env python3
"""
Scraper automático de cupones/chollos para "Cazadora de Cupones".

Qué hace, en 3 pasos:
  1. Lee mensajes recientes de canales públicos de Telegram (vía la vista
     web pública t.me/s/<canal>, sin necesitar API_ID/API_HASH ni bot) y,
     opcionalmente, de páginas/foros que le indiques en config.json.
  2. Le pasa cada mensaje a un modelo de Claude pidiéndole SOLO un JSON:
     tienda + código de cupón + descripción + confianza. Si el mensaje no
     tiene ningún cupón real, el modelo devuelve "sin cupón" y se descarta.
  3. Inserta lo que encuentra en la tabla `coupons` de Supabase con
     source="ai_scraper" y status="pending" (o "approved" si superas el
     umbral de confianza que configures) — ver schema-ai-scraper.sql.

No inventa nada por su cuenta: si el modelo no está razonablemente seguro,
el mensaje se descarta en vez de forzar una extracción dudosa.

Uso:
    python scrape_deals.py --config config.json

Variables de entorno requeridas (NO las metas en config.json ni en el
repo — usa secretos de GitHub Actions o variables de entorno del servidor):
    SUPABASE_URL
    SUPABASE_SERVICE_ROLE_KEY   (la "service role key", nunca la anon key)
    ANTHROPIC_API_KEY

Aviso legal/ético (léelo antes de activar esto en producción): esto lee
contenido PÚBLICO de canales de Telegram y páginas web. Revisa los
Términos de Servicio de cada fuente y su robots.txt antes de añadirla a
config.json, y respeta los límites de frecuencia de este script (ya vienen
puestos por defecto de forma conservadora). No está pensado para saltarse
ningún muro de pago ni contenido privado.
"""

import argparse
import json
import os
import re
import sys
import time
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup

ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_MODEL = "claude-sonnet-4-6"

EXTRACTION_PROMPT = """Eres un extractor de datos, no un asistente conversacional. Te paso el texto de un mensaje público de un canal de chollos/cupones en español. Tu única tarea es decidir si contiene un código de cupón REAL y utilizable, y si es así extraer sus datos.

Responde ÚNICAMENTE con un objeto JSON (nada de texto antes o después, nada de ```), con esta forma exacta:

Si el mensaje SÍ contiene un cupón concreto y aplicable en una tienda identificable:
{"has_coupon": true, "domain": "tienda.com", "code": "CODIGO123", "description": "resumen breve del descuento en menos de 15 palabras", "confidence": 0.0 a 1.0}

Si el mensaje NO contiene un cupón real (es solo una oferta sin código, un enlace de afiliado sin código visible, spam, una pregunta, o no queda claro de qué tienda es):
{"has_coupon": false}

Reglas:
- "domain" debe ser un dominio real de tienda (ej. "zara.com", "pccomponentes.com"), en minúsculas, sin "https://" ni "www.".
- "code" debe ser el código literal tal cual aparece (letras/números), nunca inventado ni completado a medias.
- Si dudas entre dos tiendas o el código está incompleto/cortado, responde has_coupon: false.
- "confidence" refleja lo segura que estás de que el código es correcto y sigue vigente a partir del texto, no una opinión sobre si el chollo es bueno.

Mensaje a analizar:
---
{message_text}
---"""


def log(msg):
    print(f"[scrape_deals] {msg}", flush=True)


def load_config(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def require_env(name):
    value = os.environ.get(name)
    if not value:
        log(f"ERROR: falta la variable de entorno {name}")
        sys.exit(1)
    return value


# --- Paso 1: recolección de mensajes ---------------------------------------

def fetch_telegram_channel(channel, limit, request_delay):
    """Lee los mensajes recientes de un canal PÚBLICO de Telegram usando su
    vista web de solo lectura (t.me/s/<canal>), sin API_ID/API_HASH ni bot.
    Devuelve una lista de {"text": str, "source_ref": str}.
    """
    url = f"https://t.me/s/{channel}"
    try:
        res = requests.get(url, timeout=15, headers={"User-Agent": "Mozilla/5.0"})
        res.raise_for_status()
    except requests.RequestException as e:
        log(f"  no se pudo leer el canal de Telegram '{channel}': {e}")
        return []

    soup = BeautifulSoup(res.text, "html.parser")
    messages = []
    for wrap in soup.select("div.tgme_widget_message")[-limit:]:
        text_el = wrap.select_one("div.tgme_widget_message_text")
        if not text_el:
            continue
        text = text_el.get_text(separator=" ", strip=True)
        if not text:
            continue
        data_post = wrap.get("data-post")  # ej. "canal/1234"
        source_ref = f"telegram:{data_post}" if data_post else f"telegram:{channel}"
        messages.append({"text": text, "source_ref": source_ref})

    time.sleep(request_delay)
    return messages


def fetch_forum_page(name, url, request_delay):
    """Lee una página de foro/blog de chollos y devuelve su texto plano
    como UN solo "mensaje". Pensado para páginas sencillas (hilos, posts);
    no pagina ni sigue enlaces internos.
    """
    try:
        res = requests.get(url, timeout=15, headers={"User-Agent": "Mozilla/5.0"})
        res.raise_for_status()
    except requests.RequestException as e:
        log(f"  no se pudo leer la página '{name}' ({url}): {e}")
        return []

    soup = BeautifulSoup(res.text, "html.parser")
    for tag in soup(["script", "style", "nav", "header", "footer"]):
        tag.decompose()
    text = soup.get_text(separator=" ", strip=True)
    # Los hilos de foro pueden ser largos; nos quedamos con un trozo
    # razonable para no gastar de más en tokens del modelo.
    text = text[:6000]

    time.sleep(request_delay)
    return [{"text": text, "source_ref": f"web:{url}"}]


# --- Paso 2: extracción con el modelo ---------------------------------------

def extract_coupon_from_text(text, api_key):
    prompt = EXTRACTION_PROMPT.replace("{message_text}", text[:3000])
    try:
        res = requests.post(
            ANTHROPIC_API_URL,
            headers={
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": ANTHROPIC_MODEL,
                "max_tokens": 300,
                "messages": [{"role": "user", "content": prompt}],
            },
            timeout=30,
        )
        res.raise_for_status()
        data = res.json()
        raw = "".join(
            block.get("text", "") for block in data.get("content", []) if block.get("type") == "text"
        ).strip()
        raw = re.sub(r"^```(json)?|```$", "", raw.strip(), flags=re.MULTILINE).strip()
        return json.loads(raw)
    except (requests.RequestException, json.JSONDecodeError, KeyError) as e:
        log(f"  fallo al extraer con el modelo: {e}")
        return {"has_coupon": False}


# --- Paso 3: guardado en Supabase --------------------------------------------

def coupon_already_seen(supabase_url, service_key, source_ref):
    url = f"{supabase_url}/rest/v1/coupons?source_ref=eq.{requests.utils.quote(source_ref)}&select=id&limit=1"
    res = requests.get(
        url,
        headers={"apikey": service_key, "Authorization": f"Bearer {service_key}"},
        timeout=15,
    )
    if not res.ok:
        return False
    return len(res.json()) > 0


def insert_coupon(supabase_url, service_key, domain, code, description, confidence,
                   source_ref, auto_approve_threshold):
    status = "approved" if (
        auto_approve_threshold is not None and confidence >= auto_approve_threshold
    ) else "pending"

    res = requests.post(
        f"{supabase_url}/rest/v1/coupons",
        headers={
            "apikey": service_key,
            "Authorization": f"Bearer {service_key}",
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
        },
        json={
            "domain": domain,
            "code": code,
            "description": description[:140] if description else None,
            "source": "ai_scraper",
            "status": status,
            "confidence": confidence,
            "source_ref": source_ref,
        },
        timeout=15,
    )
    return res.ok, status


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--config", default="config.json", help="Ruta al archivo de configuración")
    parser.add_argument("--dry-run", action="store_true", help="No inserta nada, solo muestra lo que encontraría")
    args = parser.parse_args()

    config = load_config(args.config)
    supabase_url = require_env("SUPABASE_URL")
    service_key = require_env("SUPABASE_SERVICE_ROLE_KEY")
    anthropic_key = require_env("ANTHROPIC_API_KEY")

    request_delay = config.get("request_delay_seconds", 2)
    messages_per_channel = config.get("messages_per_channel", 30)
    auto_approve_threshold = config.get("auto_approve_confidence_threshold")  # None = desactivado

    collected = []
    for channel in config.get("telegram_channels", []):
        log(f"Leyendo canal de Telegram: {channel}")
        collected += fetch_telegram_channel(channel, messages_per_channel, request_delay)

    for forum in config.get("forum_pages", []):
        log(f"Leyendo página: {forum['name']}")
        collected += fetch_forum_page(forum["name"], forum["url"], request_delay)

    log(f"Mensajes recolectados: {len(collected)}")

    found = pending_count = approved_count = skipped_dupe = 0
    for item in collected:
        if not args.dry_run and coupon_already_seen(supabase_url, service_key, item["source_ref"]):
            skipped_dupe += 1
            continue

        result = extract_coupon_from_text(item["text"], anthropic_key)
        if not result.get("has_coupon"):
            continue
        domain = (result.get("domain") or "").strip().lower()
        code = (result.get("code") or "").strip()
        confidence = float(result.get("confidence", 0) or 0)
        if not domain or not code:
            continue

        found += 1
        log(f"  cupón candidato: {domain} -> {code} (confianza {confidence:.2f}) [{item['source_ref']}]")

        if args.dry_run:
            continue

        ok, status = insert_coupon(
            supabase_url, service_key, domain, code, result.get("description"),
            confidence, item["source_ref"], auto_approve_threshold,
        )
        if ok:
            if status == "approved":
                approved_count += 1
            else:
                pending_count += 1
        else:
            log(f"  no se pudo guardar el cupón de {domain}")

    log(
        f"Resumen: {found} candidatos encontrados, {approved_count} aprobados "
        f"automáticamente, {pending_count} en cola de revisión, {skipped_dupe} "
        "ya vistos anteriormente (omitidos)."
    )


if __name__ == "__main__":
    main()
