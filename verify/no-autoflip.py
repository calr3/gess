"""Confirm the Auto-flip feature is gone: no toggle in the panel, and the board
still renders and plays a move with the move-arrow overlay intact."""
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

    body = page.inner_text("body")
    toggle = page.query_selector(".flip-toggle")
    has_autoflip_text = "auto-flip" in body.lower() or "auto flip" in body.lower()
    print("flip-toggle element:", toggle, "| 'auto-flip' text present:", has_autoflip_text)

    # Board still plays: black (human by default) types a move; arrow should draw.
    inp = page.query_selector(".move-entry-input")
    inp.fill("h6 i7")
    inp.press("Enter")
    page.wait_for_timeout(400)
    filled = [pl.inner_text().replace("\n", " ").strip()
              for pl in page.query_selector_all(".moves-list .move-ply")
              if "move-ply-empty" not in (pl.get_attribute("class") or "")]
    arrow = page.query_selector(".board-grid svg.move-arrow line")
    cells = len(page.query_selector_all(".board-grid .cell"))
    print("filled plies:", filled, "| arrow drawn:", arrow is not None, "| cells:", cells)

    page.screenshot(path="verify/no-autoflip.png")

    ok = (
        toggle is None and not has_autoflip_text and
        cells == 400 and filled == ["h6-i7"] and arrow is not None and
        not errs
    )
    print("errors:", errs[:5])
    print("RESULT:", "PASS" if ok else "FAIL")
    browser.close()
    sys.exit(0 if ok else 1)
