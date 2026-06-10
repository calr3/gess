"""Verify chess-style move numbering: one number per turn shared by both
players ('1.' = black's 1st AND white's 1st). Both sides Human; play three
disjoint legal opening moves (black, white, black) via the type box, then
inspect the move-log grid."""
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

    for s in page.query_selector_all("select.controller-select"):
        s.select_option("human")  # both Human so nothing auto-moves

    def play(move):
        inp = page.query_selector(".move-entry-input")
        inp.fill(move)
        inp.press("Enter")
        page.wait_for_timeout(250)
        err = page.query_selector(".move-entry-error")
        if err and err.inner_text().strip():
            print(f"  '{move}' rejected: {err.inner_text()!r}")

    play("h6 i7")    # black turn 1
    play("h15 i14")  # white turn 1
    play("k6 l7")    # black turn 2

    rows = page.query_selector_all(".moves-list .move-row")
    nums = [r.query_selector(".move-num").inner_text() for r in rows]
    print("row numbers:", nums)
    layout = []
    for r in rows:
        plies = r.query_selector_all(".move-ply")
        filled = [pl.inner_text().replace("\n", " ").strip() for pl in plies
                  if "move-ply-empty" not in (pl.get_attribute("class") or "")]
        empties = sum(1 for pl in plies if "move-ply-empty" in (pl.get_attribute("class") or ""))
        layout.append((filled, empties))
        print("  row:", filled, "| empty cells:", empties)

    page.screenshot(path="verify/move-numbering.png")

    ok = (
        nums == ["1.", "2."] and
        len(layout) == 2 and
        len(layout[0][0]) == 2 and layout[0][1] == 0 and          # turn 1: black + white
        len(layout[1][0]) == 1 and layout[1][1] == 1 and          # turn 2: black only + 1 placeholder
        "h6-i7" in layout[0][0][0] and "h15-i14" in layout[0][0][1] and
        "k6-l7" in layout[1][0][0] and
        not errs
    )
    print("errors:", errs[:5])
    print("RESULT:", "PASS" if ok else "FAIL")
    browser.close()
    sys.exit(0 if ok else 1)
