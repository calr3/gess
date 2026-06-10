"""Smoke test: with the choose_on_abort change live, the app still plays legal
AI moves with no console/page errors. Both sides AI · Normal (2s)."""
import sys, time
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    errs = []
    page.on("pageerror", lambda e: errs.append("PAGEERROR: " + str(e)))
    page.on("console", lambda m: errs.append("CONSOLE-ERR: " + m.text) if m.type == "error" else None)
    page.goto("http://localhost:4201", wait_until="networkidle")
    page.wait_for_selector("app-board", timeout=15000)
    for s in page.query_selector_all("select.controller-select"):
        s.select_option("normal")
    deadline = time.time() + 40
    last = 0
    while time.time() < deadline:
        n = len(page.query_selector_all(".moves-list .move-ply"))
        if n != last:
            last = n
            print(f"[{time.time():.0f}] plies: {n}")
        if n >= 4:
            break
        page.wait_for_timeout(500)
    plies = page.query_selector_all(".moves-list .move-ply")
    texts = [pl.inner_text().replace('\n', ' ') for pl in plies[:6]]
    print("moves:", texts)
    print("errors:", errs[:5])
    ok = len(plies) >= 3 and not errs
    print("RESULT:", "PASS" if ok else "FAIL")
    browser.close()
    sys.exit(0 if ok else 1)
