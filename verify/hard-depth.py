"""Confirm the depth the CURRENT build reaches in the browser at Hard (15s) for
an opening move. Playwright launches a clean browser (no cache), so this reflects
the latest built engine, not any stale tab."""
import sys, re, time
from playwright.sync_api import sync_playwright

URL = "http://localhost:4201"
with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    logs = []
    page.on("console", lambda m: logs.append(m.text))
    page.goto(URL, wait_until="networkidle")
    page.wait_for_selector("app-board", timeout=15000)

    # Black moves first; make it the 15s Hard AI.
    selects = page.query_selector_all("select.controller-select")
    selects[1].select_option("hard")
    print("Black set to Hard (15s); waiting for its opening move (~16s)...")

    deadline = time.time() + 40
    depth = None
    while time.time() < deadline:
        for l in logs:
            m = re.search(r"\[Gess AI\] black: best depth (\d+), (\d+) root moves, (\d+)ms", l)
            if m:
                depth, roots, ms = int(m.group(1)), int(m.group(2)), int(m.group(3))
                break
        if depth is not None:
            break
        page.wait_for_timeout(500)

    if depth is None:
        print("RESULT: FAIL — no AI diagnostic captured")
        browser.close(); sys.exit(1)
    print(f"opening move: best depth {depth}, {roots} root moves, {ms}ms")
    print(f"RESULT: {'PASS — reaches depth '+str(depth) if depth >= 4 else 'depth only '+str(depth)}")
    browser.close()
    sys.exit(0)
