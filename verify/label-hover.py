"""Verify edge-label highlighting: hovering a board square subtly highlights the
matching file (column) and rank (row) labels, and the highlight clears when the
cursor leaves the board. Default orientation → cell DOM index = r*20 + c."""
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

    def active_labels():
        return sorted(el.inner_text() for el in page.query_selector_all(".label-active"))

    # Before hover: nothing highlighted.
    before = active_labels()
    print("before hover:", before)

    # Hover square h6 → row index 14, col index 7 → DOM cell 14*20+7 = 287.
    cells = page.query_selector_all(".board-grid .cell")
    cells[14 * 20 + 7].hover()
    page.wait_for_timeout(150)
    during = active_labels()
    print("hovering h6 ->", during)

    # Hover a different square: e10 → col 4 ('e'), row 10 → label 10. cell 10*20+4.
    cells[10 * 20 + 4].hover()
    page.wait_for_timeout(150)
    during2 = active_labels()
    print("hovering e10 ->", during2)

    # Leave the board (hover the side panel) → highlight clears.
    page.query_selector(".panel-title").hover()
    page.wait_for_timeout(150)
    after = active_labels()
    print("after leave:", after)

    page.screenshot(path="verify/label-hover.png")
    # Re-hover h6 for the screenshot to actually show the effect.
    cells[14 * 20 + 7].hover()
    page.wait_for_timeout(150)
    page.screenshot(path="verify/label-hover.png")

    ok = (
        before == [] and
        during == ["6", "6", "h", "h"] and   # top+bottom 'h', left+right '6'
        during2 == ["10", "10", "e", "e"] and
        after == [] and
        not errs
    )
    print("errors:", errs[:5])
    print("RESULT:", "PASS" if ok else "FAIL")
    browser.close()
    sys.exit(0 if ok else 1)
