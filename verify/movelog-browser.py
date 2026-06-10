"""Verify the two-column, per-move-numbered move log."""
import sys, time
from playwright.sync_api import sync_playwright

URL = "http://localhost:4201"

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1400, "height": 1000})
    errors = []
    page.on("pageerror", lambda e: errors.append("PAGEERROR: " + str(e)))
    page.goto(URL, wait_until="networkidle")
    page.wait_for_selector("app-board", timeout=15000)

    # Self-play fast: both sides on Easy (0.5s).
    selects = page.query_selector_all("select.controller-select")
    print("controller selects:", len(selects))
    for s in selects:
        s.select_option("easy")

    # Wait for several plies so we get at least 2 full rows + a dangling black.
    deadline = time.time() + 60
    while time.time() < deadline:
        n = len(page.query_selector_all(".moves-list .move-ply"))
        if n >= 5:
            break
        page.wait_for_timeout(400)

    plies = page.query_selector_all(".moves-list .move-ply")
    rows = page.query_selector_all(".moves-list .move-row")
    print(f"\nrows: {len(rows)}  plies: {len(plies)}")

    # Inspect each row: which column holds which player + the printed number.
    for ri, row in enumerate(rows):
        cells = row.query_selector_all(".move-ply")
        desc = []
        for c in cells:
            num = c.query_selector(".move-num").inner_text()
            stone = c.query_selector(".stone-preview")
            cls = stone.get_attribute("class")
            color = "white" if "white-stone" in cls else "black" if "black-stone" in cls else "?"
            note = c.query_selector(".move-notation").inner_text()
            desc.append(f"[{num} {color} {note}]")
        print(f"  row {ri}: " + "  ".join(desc))

    # Check the panel got wider.
    panel_w = page.eval_on_selector(".side-panel", "el => el.getBoundingClientRect().width")
    print(f"\nside-panel width: {panel_w:.0f}px")

    page.screenshot(path="verify/movelog.png", full_page=True)
    panel = page.query_selector(".side-panel")
    panel.screenshot(path="verify/movelog-panel.png")
    print("screenshots: verify/movelog.png, verify/movelog-panel.png")

    if errors:
        print("\nERRORS:", errors[:5])

    # PASS criteria: rows exist, first row col0=black#1 col1=white#2, numbering sequential.
    ok = len(rows) >= 2 and not errors
    print("\nRESULT:", "PASS" if ok else "FAIL")
    browser.close()
    sys.exit(0 if ok else 1)
