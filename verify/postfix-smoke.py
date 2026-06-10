"""Post-fix browser smoke: the rebuilt/re-embedded WASM engine must still load
and play in the real app. Set both sides to AI, New Game, and confirm moves get
made with no console/page errors."""
import sys
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    errs = []
    page.on("pageerror", lambda e: errs.append("PAGEERROR: " + str(e)))
    page.on("console", lambda m: errs.append("CONSOLE-ERR: " + m.text) if m.type == "error" else None)
    page.goto("http://localhost:4201", wait_until="networkidle")
    page.wait_for_selector("app-board", timeout=15000)

    selects = page.query_selector_all("select.controller-select")
    selects[0].select_option("easy")  # White AI
    selects[1].select_option("easy")  # Black AI
    page.query_selector(".btn-new-game").click()

    # Wait for a few plies to be played by the engine.
    deadline, waited = 60000, 0
    while waited < deadline:
        n = len(page.query_selector_all(".moves-list .move-ply:not(.move-ply-empty)"))
        if n >= 4 or page.query_selector(".winner-banner"):
            break
        page.wait_for_timeout(1000); waited += 1000

    plies = [pl.inner_text().replace("\n", " ").strip()
             for pl in page.query_selector_all(".moves-list .move-ply")
             if "move-ply-empty" not in (pl.get_attribute("class") or "")]
    print("plies played by the engine:", plies)
    page.screenshot(path="verify/postfix-smoke.png")

    ok = len(plies) >= 4 and not errs
    print("errors:", errs[:5])
    print("RESULT:", "PASS" if ok else "FAIL")
    browser.close()
    sys.exit(0 if ok else 1)
