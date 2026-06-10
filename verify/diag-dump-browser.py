"""Dump the full negamax diagnostic block so the new columns can be eyeballed:
per-depth 'best move'/'score', and the top-20 'prev' (previous-depth) tie-break."""
import sys, time
from playwright.sync_api import sync_playwright

URL = "http://localhost:4201"
with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    logs, errors = [], []
    page.on("console", lambda m: logs.append(m.text))
    page.on("pageerror", lambda e: errors.append("PAGEERROR: " + str(e)))
    page.goto(URL, wait_until="networkidle")
    page.wait_for_selector("app-board", timeout=15000)

    # Black moves first → AI Normal (2s): a low depth completes fast, leaving the
    # next depth partially searched (the case the 'next' column is meant to show).
    page.query_selector_all("select.controller-select")[1].select_option("normal")
    print("Black set to AI · Normal (2s); waiting for the diagnostic...")

    deadline = time.time() + 30
    block = None
    while time.time() < deadline:
        for l in logs:
            if l.startswith("[Gess AI] black:"):
                block = l
        if block and len(page.query_selector_all(".moves-list .move-row")) >= 1:
            break
        page.wait_for_timeout(400)

    print("=" * 70)
    print(block if block else "(no diagnostic captured)")
    print("=" * 70)
    if errors:
        print("ERRORS:", errors[:5])
    print("RESULT:", "PASS" if block and not errors else "FAIL")
    browser.close()
    sys.exit(0 if (block and not errors) else 1)
