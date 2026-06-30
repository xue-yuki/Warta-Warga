#!/usr/bin/env python
import argparse
import json
import os
import re
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import urljoin

SB = None
By = None
Select = None
WebDriverException = Exception

ADUANKONTEN_CATEGORY_LABELS = {
    "1": "Pornografi",
    "2": "Perjudian",
    "3": "Fitnah/Pencemaran Nama Baik",
    "4": "Penipuan",
    "5": "SARA",
    "6": "Kekerasan/Kekerasan Pada Anak",
    "7": "Perdagangan Produk dengan aturan khusus",
    "8": "Terorisme/Radikalisme",
    "9": "Separatisme/Organisasi Berbahaya",
    "10": "Hak Kekayaan Intelektual",
    "11": "Pelanggaran Keamanan Informasi",
    "12": "Konten Negatif yang Direkomendasikan Instansi Sektor",
    "13": "Konten yang Melanggar Nilai Sosial dan Budaya",
    "14": "Berita Bohong/HOAKS",
    "15": "Pemerasan",
}

GAMBLING_PREVIEW_RE = re.compile(
    r"(judol|judi|perjudian|slot|togel|casino|sabung\s*ayam|sportsbook|taruhan|betting|gacor|maxwin|scatter|rtp\s*slot|"
    r"pragmatic|pgsoft|habanero|spadegaming|sbobet|poker|roulette|blackjack|jackpot|zeus|olympus|easy\s*win|pasti\s*bayar|main\s*game|"
    r"(?:qq|judi|slot|togel|casino|dewa|koko|otaku|tokyo|sultan|raja|mega|bola|mpo|idn|naga|hoki|cuan|cina|gaza)[a-z0-9-]*(?:26|66|77|88|89|99|101|123|138|365|500|666|777|888)[a-z0-9-]*|"
    r"(?:qq|mpo|idn)\d{2,}[a-z0-9-]*)",
    re.I,
)


def load_seleniumbase():
    global SB, By, Select, WebDriverException
    if SB is not None:
        return
    try:
        from seleniumbase import SB as seleniumbase_sb
        from selenium.webdriver.common.by import By as selenium_by
        from selenium.webdriver.support.ui import Select as selenium_select
        from selenium.common.exceptions import WebDriverException as selenium_webdriver_exception
    except ImportError as exc:
        raise RuntimeError(
            "SeleniumBase belum terinstall. Jalankan: python -m pip install -r requirements.txt"
        ) from exc

    SB = seleniumbase_sb
    By = selenium_by
    Select = selenium_select
    WebDriverException = selenium_webdriver_exception


def clean_text(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def normalize_url(raw_url):
    value = str(raw_url or "").strip()
    if not value:
        return ""
    if re.match(r"^https?://", value, flags=re.I):
        return value
    return "https://" + value


def log(message):
    print(f"[aduankonten-seleniumbase] {message}", file=sys.stderr, flush=True)


def base_url(payload):
    return str(payload.get("baseUrl") or "https://aduankonten.id").rstrip("/")


def debug_dir(payload):
    value = payload.get("debugDir") or ""
    if not value:
        return ""
    Path(value).mkdir(parents=True, exist_ok=True)
    return value


def challenge_wait(payload):
    try:
        return max(30000, int(payload.get("challengeWaitMs") or payload.get("waitMs") or 30000))
    except Exception:
        return 30000


def current_url(sb):
    try:
        return sb.driver.current_url or ""
    except Exception:
        return ""


def page_source(sb):
    try:
        return sb.get_page_source()
    except Exception:
        try:
            return sb.driver.page_source
        except Exception:
            return ""


def body_text(sb):
    try:
        return sb.get_text("body")
    except Exception:
        try:
            return sb.driver.find_element(By.TAG_NAME, "body").text
        except Exception:
            return ""


def save_debug_snapshot(sb, payload, stage):
    directory = debug_dir(payload)
    if not directory:
        return None

    stamp = time.strftime("%Y-%m-%dT%H-%M-%S")
    safe_stage = re.sub(r"[^a-zA-Z0-9_-]+", "-", stage or "aduankonten").strip("-") or "aduankonten"
    base = Path(directory) / f"{stamp}-{int(time.time() * 1000) % 1000:03d}-{safe_stage}"
    html_path = str(base.with_suffix(".html"))
    screenshot_path = str(base.with_suffix(".png"))
    try:
        Path(html_path).write_text(page_source(sb), encoding="utf-8")
    except Exception:
        html_path = None
    try:
        sb.driver.get_screenshot_as_file(screenshot_path)
    except Exception:
        screenshot_path = None

    return {"htmlPath": html_path, "screenshotPath": screenshot_path}


def debug_suffix(snapshot):
    if not snapshot:
        return ""
    parts = [value for value in (snapshot.get("htmlPath"), snapshot.get("screenshotPath")) if value]
    if not parts:
        return ""
    return " Debug artifacts: " + ", ".join(parts)


def has_cloudflare_text(text):
    return bool(re.search(r"Tunggu sebentar|Verifikasi keamanan|Just a moment|Checking your browser|Cloudflare|Verify you are human", text or "", re.I))


def has_rate_limit_text(text):
    return bool(re.search(r"\b429\b|Too Many Requests|rate limit|terlalu banyak permintaan", text or "", re.I))


def wait_after_rate_limit(sb, payload, stage, attempt):
    wait_seconds = min(90, 20 + max(0, attempt - 1) * 15)
    log(f"AduanKonten rate limited during {stage}; waiting {wait_seconds}s before retry.")
    time.sleep(wait_seconds)
    try:
        sb.refresh()
    except Exception:
        try:
            open_with_reconnect(sb, base_url(payload) + "/")
        except Exception:
            pass


def is_visible(sb, selector):
    try:
        return bool(sb.is_element_visible(selector))
    except Exception:
        try:
            el = sb.driver.find_element(By.CSS_SELECTOR, selector)
            return el.is_displayed()
        except Exception:
            return False


def click(sb, selector):
    for method_name in ("uc_click", "click"):
        method = getattr(sb, method_name, None)
        if not callable(method):
            continue
        try:
            if method_name == "uc_click":
                try:
                    return method(selector, reconnect_time=2)
                except TypeError:
                    return method(selector)
            return method(selector)
        except Exception:
            continue

    el = sb.driver.find_element(By.CSS_SELECTOR, selector)
    sb.driver.execute_script("arguments[0].scrollIntoView({block:'center', inline:'center'});", el)
    el.click()


def fill_value(sb, selector, value):
    text = str(value or "")
    try:
        sb.wait_for_element_visible(selector, timeout=30)
    except Exception:
        pass

    try:
        click(sb, selector)
    except Exception:
        pass

    for method_name in ("clear", "type"):
        try:
            if method_name == "clear":
                getattr(sb, method_name)(selector)
            else:
                getattr(sb, method_name)(selector, text)
            if method_name == "type":
                break
        except Exception:
            if method_name == "type":
                try:
                    sb.update_text(selector, text)
                    break
                except Exception:
                    pass

    sb.driver.execute_script(
        """
        const el = document.querySelector(arguments[0]);
        if (!el) return false;
        el.value = arguments[1];
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('keyup', { bubbles: true }));
        return true;
        """,
        selector,
        text,
    )


def submit_form_by_js(sb, form_selector):
    return sb.driver.execute_script(
        """
        const form = document.querySelector(arguments[0]);
        if (!form) return false;
        if (typeof form.requestSubmit === 'function') form.requestSubmit();
        else form.submit();
        return true;
        """,
        form_selector,
    )


def solve_challenge(sb, payload):
    deadline = time.time() + (challenge_wait(payload) / 1000.0)
    last_error = None
    while time.time() < deadline:
        text = body_text(sb)
        if not has_cloudflare_text(text):
            return True

        log("Cloudflare challenge detected; trying SeleniumBase UC helpers.")
        for method_name in ("uc_gui_click_captcha", "solve_captcha"):
            method = getattr(sb, method_name, None)
            if not callable(method):
                continue
            try:
                try:
                    method()
                except TypeError:
                    method(timeout=10)
                time.sleep(4)
                if not has_cloudflare_text(body_text(sb)):
                    return True
            except Exception as exc:
                last_error = exc

        time.sleep(2)

    message = "Cloudflare challenge belum lolos"
    if last_error:
        message += f": {last_error}"
    raise RuntimeError(message)


def open_with_reconnect(sb, url):
    method = getattr(sb, "uc_open_with_reconnect", None)
    if callable(method):
        try:
            return method(url, reconnect_time=6)
        except TypeError:
            return method(url, 6)
    return sb.open(url)


def open_home(sb, payload):
    home = base_url(payload) + "/"
    open_with_reconnect(sb, home)

    deadline = time.time() + max(90, challenge_wait(payload) / 1000.0 + 10)
    rate_limit_attempts = 0
    while time.time() < deadline:
        if is_visible(sb, "#search_url"):
            return

        text = body_text(sb)
        if has_rate_limit_text(text):
            rate_limit_attempts += 1
            wait_after_rate_limit(sb, payload, "home", rate_limit_attempts)
            continue

        if has_cloudflare_text(text):
            solve_challenge(sb, payload)
            try:
                open_with_reconnect(sb, home)
            except Exception:
                try:
                    sb.refresh()
                except Exception:
                    pass
            time.sleep(2)
            continue

        time.sleep(1)

    snapshot = save_debug_snapshot(sb, payload, "home-form-timeout")
    if has_rate_limit_text(body_text(sb)):
        raise RuntimeError("AduanKonten masih mengembalikan 429 Too Many Requests saat membuka halaman awal." + debug_suffix(snapshot))
    raise RuntimeError("Timeout menunggu form pencarian AduanKonten." + debug_suffix(snapshot))


def wait_for_search_form(sb, payload):
    deadline = time.time() + max(90, challenge_wait(payload) / 1000.0 + 10)
    rate_limit_attempts = 0
    while time.time() < deadline:
        if is_visible(sb, "#search_url") and is_visible(sb, "#btn-search-submit"):
            return
        text = body_text(sb)
        if has_rate_limit_text(text):
            rate_limit_attempts += 1
            wait_after_rate_limit(sb, payload, "search-form", rate_limit_attempts)
            continue
        if has_cloudflare_text(text):
            solve_challenge(sb, payload)
        time.sleep(1)
    snapshot = save_debug_snapshot(sb, payload, "search-form-timeout")
    if has_rate_limit_text(body_text(sb)):
        raise RuntimeError("AduanKonten masih mengembalikan 429 Too Many Requests saat menunggu form pencarian." + debug_suffix(snapshot))
    raise RuntimeError("Timeout menunggu form search AduanKonten." + debug_suffix(snapshot))


def support_outcome_from_href(payload, href, message="Konten sudah pernah dilaporkan."):
    support_url = urljoin(base_url(payload) + "/", href or "")
    match = re.search(r"/auth/redirect/([^/?#]+)", support_url)
    return {
        "success": True,
        "kind": "duplicate",
        "duplicate": True,
        "existingSubmissionId": match.group(1) if match else None,
        "supportUrl": support_url,
        "message": clean_text(message),
    }


def detect_duplicate(sb, payload):
    try:
        links = sb.driver.find_elements(By.CSS_SELECTOR, 'a[href*="/auth/redirect/"]')
    except Exception:
        links = []
    if not links:
        return None
    href = links[0].get_attribute("href")
    return support_outcome_from_href(payload, href, body_text(sb) or "Konten sudah pernah dilaporkan.")


def run_search(sb, payload, normalized_url):
    open_home(sb, payload)
    wait_for_search_form(sb, payload)
    fill_value(sb, "#search_url", normalized_url)
    time.sleep(0.5)

    for attempt in range(3):
        if attempt:
            log("Retrying AduanKonten search after challenge/timeout.")
            open_home(sb, payload)
            fill_value(sb, "#search_url", normalized_url)
            time.sleep(0.5)

        click(sb, "#btn-search-submit")
        deadline = time.time() + 100
        rate_limit_attempts = 0
        while time.time() < deadline:
            url = current_url(sb)
            if re.search(r"/submission/submit-form\b", url, flags=re.I):
                return {"success": True, "kind": "submit_form", "url": normalized_url}

            duplicate = detect_duplicate(sb, payload)
            if duplicate:
                duplicate["url"] = normalized_url
                return duplicate

            text = body_text(sb)
            if has_rate_limit_text(text):
                rate_limit_attempts += 1
                wait_after_rate_limit(sb, payload, "search-result", rate_limit_attempts)
                break

            if has_cloudflare_text(text):
                solve_challenge(sb, payload)
                break

            time.sleep(1)

    snapshot = save_debug_snapshot(sb, payload, "search-timeout")
    if has_rate_limit_text(body_text(sb)):
        raise RuntimeError("AduanKonten masih mengembalikan 429 Too Many Requests saat mencari URL." + debug_suffix(snapshot))
    raise RuntimeError("Timeout menunggu hasil pencarian URL di AduanKonten." + debug_suffix(snapshot))


def wait_for_preview(sb, payload):
    deadline = time.time() + 140
    rate_limit_attempts = 0
    while time.time() < deadline:
        if is_visible(sb, "#category_id"):
            try:
                web_preview_id = sb.driver.execute_script(
                    """
                    return document.querySelector('#webpreview_id')?.value
                      || document.querySelector('input[name="title_preview"]')?.value
                      || document.querySelector('input[name="image_preview"]')?.value
                      || '';
                    """
                )
                if web_preview_id:
                    return
            except Exception:
                return
        text = body_text(sb)
        if has_rate_limit_text(text):
            rate_limit_attempts += 1
            wait_after_rate_limit(sb, payload, "preview", rate_limit_attempts)
            continue
        if has_cloudflare_text(text):
            solve_challenge(sb, payload)
        time.sleep(1)
    snapshot = save_debug_snapshot(sb, payload, "preview-timeout")
    if has_rate_limit_text(body_text(sb)):
        raise RuntimeError("AduanKonten masih mengembalikan 429 Too Many Requests saat menunggu preview/form submit." + debug_suffix(snapshot))
    raise RuntimeError("Timeout menunggu preview/form submit AduanKonten." + debug_suffix(snapshot))


def capture_attachment(sb, payload):
    directory = tempfile.mkdtemp(prefix="warta-warga-aduankonten-")
    out = str(Path(directory) / "attachment.png")
    try:
        sb.driver.get_screenshot_as_file(out)
    except Exception:
        try:
            sb.save_screenshot(out)
        except Exception as exc:
            raise RuntimeError(f"Gagal membuat lampiran screenshot: {exc}") from exc
    return out


def preview_text(sb):
    try:
        value = sb.driver.execute_script(
            """
            const selectors = [
              '[name="title_preview"]',
              '#title_preview',
              '.form-detail-preview [name="title_preview"]',
              '.overflow-tinjauan [name="title_preview"]',
              '.overflow-tinjauan .fw-bold',
              '.content-laporan-mobile .fw-bold'
            ];
            const parts = [];
            for (const selector of selectors) {
              for (const el of document.querySelectorAll(selector)) {
                const text = (el.innerText || el.textContent || el.value || '').trim();
                if (text) parts.push(text);
              }
            }
            return [...new Set(parts)].join(' ');
            """
        )
        if value:
            return clean_text(value)
    except Exception:
        pass
    text = body_text(sb)
    match = re.search(r"(?:Tinjauan Laporan|Tinjauan)[\s\S]{0,400}", text or "", flags=re.I)
    return clean_text(match.group(0) if match else text)


def infer_category_from_preview(sb, requested_category_id):
    category_id = str(requested_category_id or "").strip()
    title = preview_text(sb)
    if category_id != "2" and GAMBLING_PREVIEW_RE.search(title or ""):
        log(f"Preview indicates gambling; overriding category {category_id or '-'} -> 2. Preview: {title[:160]}")
        category_id = "2"
    return category_id, ADUANKONTEN_CATEGORY_LABELS.get(category_id), title


def set_category(sb, category_id):
    el = sb.driver.find_element(By.CSS_SELECTOR, "#category_id")
    sb.driver.execute_script("arguments[0].scrollIntoView({block:'center', inline:'center'});", el)
    Select(el).select_by_value(str(category_id))
    sb.driver.execute_script(
        """
        arguments[0].dispatchEvent(new Event('input', { bubbles: true }));
        arguments[0].dispatchEvent(new Event('change', { bubbles: true }));
        """,
        el,
    )


def upload_attachment(sb, attachment_path):
    path_value = str(attachment_path or "").strip()
    if not path_value:
        return
    if not os.path.exists(path_value):
        raise RuntimeError(f"Lampiran tidak ditemukan: {path_value}")
    file_input = sb.driver.find_element(By.CSS_SELECTOR, "#multiplefileupload")
    file_input.send_keys(os.path.abspath(path_value))


def wait_for_success(sb, payload):
    deadline = time.time() + 120
    rate_limit_attempts = 0
    while time.time() < deadline:
        url = current_url(sb)
        text = body_text(sb)
        if re.search(r"/page/success\b", url, flags=re.I) or re.search(r"Laporan Diterima|Kode Laporan", text or "", flags=re.I):
            return
        if has_rate_limit_text(text):
            rate_limit_attempts += 1
            wait_after_rate_limit(sb, payload, "submit-success", rate_limit_attempts)
            continue
        if has_cloudflare_text(text):
            solve_challenge(sb, payload)
        time.sleep(1)
    snapshot = save_debug_snapshot(sb, payload, "submit-success-timeout")
    if has_rate_limit_text(body_text(sb)):
        raise RuntimeError(f"AduanKonten masih mengembalikan 429 Too Many Requests setelah submit. URL terakhir: {current_url(sb)}." + debug_suffix(snapshot))
    raise RuntimeError(f"AduanKonten tidak menampilkan halaman sukses. URL terakhir: {current_url(sb)}." + debug_suffix(snapshot))


def extract_ticket(sb):
    try:
        value = clean_text(sb.get_text("#kodeLaporan"))
        if value:
            return value
    except Exception:
        pass
    html = page_source(sb)
    match = re.search(r"submissionNumber\.innerText\s*=\s*['\"]([^'\"]+)['\"]", html, flags=re.I)
    if match:
        return match.group(1).strip()
    text = body_text(sb)
    match = re.search(r"\b[A-Z0-9]{6,12}\b", text or "")
    return match.group(0) if match else None


def submit_flow(sb, payload):
    normalized_url = normalize_url(payload.get("url"))
    if not normalized_url:
        raise RuntimeError("URL konten wajib diisi")
    if not payload.get("categoryId"):
        raise RuntimeError("Kategori AduanKonten wajib diisi")
    reason = clean_text(payload.get("reason"))
    if len(reason) < 20:
        raise RuntimeError("Alasan AduanKonten minimal 20 karakter")

    outcome = run_search(sb, payload, normalized_url)
    if outcome.get("kind") == "duplicate":
        return outcome

    wait_for_preview(sb, payload)
    final_category_id, final_category_label, preview_title = infer_category_from_preview(sb, payload.get("categoryId"))
    if not final_category_id:
        raise RuntimeError("Kategori AduanKonten wajib diisi")
    set_category(sb, final_category_id)
    fill_value(sb, "#reason", reason)
    attachment = payload.get("attachmentPath") or capture_attachment(sb, payload)
    upload_attachment(sb, attachment)
    click(sb, "#btn-submission")
    wait_for_success(sb, payload)

    ticket = extract_ticket(sb)
    if not ticket:
        snapshot = save_debug_snapshot(sb, payload, "ticket-not-found")
        raise RuntimeError("AduanKonten sukses tetapi kode laporan tidak ditemukan." + debug_suffix(snapshot))

    return {
        "success": True,
        "duplicate": False,
        "ticketNumber": ticket,
        "url": normalized_url,
        "categoryId": final_category_id,
        "categoryLabel": final_category_label,
        "previewTitle": preview_title,
    }


def status_flow(sb, payload):
    ticket = clean_text(payload.get("ticket"))
    if not ticket:
        raise RuntimeError("Kode laporan AduanKonten wajib diisi")

    open_home(sb, payload)
    deadline = time.time() + 90
    rate_limit_attempts = 0
    while time.time() < deadline:
        if is_visible(sb, "#submission_number"):
            break
        if is_visible(sb, "#search_tiket"):
            click(sb, "#search_tiket")
            time.sleep(1)
            continue
        text = body_text(sb)
        if has_rate_limit_text(text):
            rate_limit_attempts += 1
            wait_after_rate_limit(sb, payload, "status-form", rate_limit_attempts)
            continue
        if has_cloudflare_text(text):
            solve_challenge(sb, payload)
        time.sleep(1)

    if not is_visible(sb, "#submission_number"):
        snapshot = save_debug_snapshot(sb, payload, "status-form-timeout")
        if has_rate_limit_text(body_text(sb)):
            raise RuntimeError("AduanKonten masih mengembalikan 429 Too Many Requests saat membuka form Lacak Aduan." + debug_suffix(snapshot))
        raise RuntimeError("Timeout menunggu form Lacak Aduan AduanKonten." + debug_suffix(snapshot))

    fill_value(sb, "#submission_number", ticket)
    try:
        click(sb, "#button_submission_number")
    except Exception:
        submit_form_by_js(sb, 'form[action*="/submission/check"]')

    deadline = time.time() + 90
    rate_limit_attempts = 0
    while time.time() < deadline:
        if re.search(r"/submission/detail/", current_url(sb), flags=re.I):
            return {"success": True, "ticket": ticket, "html": page_source(sb)}
        text = body_text(sb)
        if has_rate_limit_text(text):
            rate_limit_attempts += 1
            wait_after_rate_limit(sb, payload, "status-detail", rate_limit_attempts)
            continue
        if has_cloudflare_text(text):
            solve_challenge(sb, payload)
        time.sleep(1)

    html = page_source(sb)
    if "Konten sudah pernah dilaporkan" in html or "Status Laporan" in html:
        return {"success": True, "ticket": ticket, "html": html}

    snapshot = save_debug_snapshot(sb, payload, "status-detail-timeout")
    if has_rate_limit_text(body_text(sb)):
        raise RuntimeError("AduanKonten masih mengembalikan 429 Too Many Requests saat membuka detail status." + debug_suffix(snapshot))
    raise RuntimeError("Timeout menunggu detail status AduanKonten." + debug_suffix(snapshot))


def warmup_flow(sb, payload):
    open_home(sb, payload)
    cookies = []
    try:
        cookies = sb.driver.get_cookies()
    except Exception:
        pass
    clearance = next((cookie for cookie in cookies if cookie.get("name") == "cf_clearance"), None)
    return {
        "success": True,
        "baseUrl": base_url(payload),
        "sessionPath": payload.get("sessionPath") or None,
        "userDataDir": payload.get("userDataDir") or None,
        "persistentProfile": bool(payload.get("userDataDir")),
        "hasCloudflareClearance": bool(clearance),
        "clearanceExpires": clearance.get("expiry") if clearance else None,
    }


def probe_flow(sb, payload):
    normalized_url = normalize_url(payload.get("url"))
    if not normalized_url:
        raise RuntimeError("URL konten wajib diisi")
    return run_search(sb, payload, normalized_url)


def sb_kwargs(payload):
    kwargs = {
        "uc": True,
        "locale_code": "id",
    }
    if payload.get("headless"):
        kwargs["headless2"] = True
    else:
        kwargs["headed"] = True

    user_data_dir = payload.get("userDataDir")
    if user_data_dir:
        Path(user_data_dir).mkdir(parents=True, exist_ok=True)
        kwargs["user_data_dir"] = str(user_data_dir)

    user_agent = payload.get("userAgent")
    if user_agent:
        kwargs["agent"] = str(user_agent)

    return kwargs


def run_operation(payload):
    load_seleniumbase()
    operation = str(payload.get("operation") or "").strip().lower()
    if operation not in {"warmup", "probe", "submit", "status"}:
        raise RuntimeError(f"Operasi AduanKonten tidak dikenal: {operation}")

    with SB(**sb_kwargs(payload)) as sb:
        if operation == "warmup":
            return warmup_flow(sb, payload)
        if operation == "probe":
            return probe_flow(sb, payload)
        if operation == "submit":
            return submit_flow(sb, payload)
        if operation == "status":
            return status_flow(sb, payload)

    raise RuntimeError(f"Operasi AduanKonten tidak selesai: {operation}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    try:
        payload = json.loads(Path(args.input).read_text(encoding="utf-8"))
        result = run_operation(payload)
    except Exception as exc:
        result = {
            "success": False,
            "error": str(exc),
        }
        log(f"fatal: {exc}")

    Path(args.output).write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    if result.get("success") is False:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
