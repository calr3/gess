"""While the AI is thinking: double-click revert must be BLOCKED, but hovering a
move must still preview the historical board."""
import sys
from playwright.sync_api import sync_playwright

BOARD_JS = """() => Array.from(document.querySelectorAll('.board-grid .cell')).map(c => {
  const s = c.querySelector('.stone');
  return s ? (s.classList.contains('white-stone') ? 'w' : 'b') : '.';
}).join('')"""

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    errs = []
    page.on("pageerror", lambda e: errs.append("PAGEERROR: " + str(e)))
    page.on("console", lambda m: errs.append("CONSOLE-ERR: " + m.text) if m.type == "error" else None)
    page.goto("http://localhost:4201", wait_until="networkidle")
    page.wait_for_selector("app-board", timeout=15000)

    sels = page.query_selector_all("select.controller-select")
    sels[0].select_option("human")  # White
    sels[1].select_option("human")  # Black
    page.query_selector(".btn-new-game").click()
    page.wait_for_timeout(150)

    def play(mv):
        inp = page.query_selector(".move-entry-input")
        inp.fill(mv); inp.press("Enter"); page.wait_for_timeout(200)

    board = lambda: page.evaluate(BOARD_JS)

    # Build history; snapshot the board after black's first move.
    play("h6-i7"); S1 = board()
    play("h15-i14"); play("i7-j8")     # now White to move
    moves_before = len(page.query_selector_all(".moves-list .move-ply:not(.move-ply-empty)"))

    # Hand White to a long-thinking AI (Hard, 15s) → it starts thinking.
    sels[0].select_option("hard")

    # Wait until the search is actually in flight.
    thinking = False
    for _ in range(40):
        msg = page.query_selector(".game-message span").inner_text()
        if "thinking" in msg.lower() or page.query_selector(".ai-progress"):
            thinking = True; break
        page.wait_for_timeout(100)
    print("AI thinking detected:", thinking)

    # (a) Hover a past move → preview must still show the historical board + arrow.
    page.locator(".move-ply", has_text="h6-i7").first.hover()
    page.wait_for_timeout(150)
    preview = board()
    arrow = page.query_selector(".board-grid svg.move-arrow line") is not None
    print("hover preview works during thinking (== S1):", preview == S1, "| arrow:", arrow)

    # (b) Double-click that move → revert must be BLOCKED (history unchanged).
    page.locator(".move-ply", has_text="h6-i7").first.dblclick()
    page.wait_for_timeout(300)
    moves_after = len(page.query_selector_all(".moves-list .move-ply:not(.move-ply-empty)"))
    still_thinking = "thinking" in page.query_selector(".game-message span").inner_text().lower() \
                     or page.query_selector(".ai-progress") is not None
    print(f"plies before={moves_before} after dblclick-while-thinking={moves_after} (must be equal)")
    print("still thinking after the blocked dblclick:", still_thinking)

    page.screenshot(path="verify/no-revert-while-thinking.png")
    ok = (
        thinking and
        preview == S1 and arrow and
        moves_after == moves_before == 3 and
        not errs
    )
    print("errors:", errs[:5])
    print("RESULT:", "PASS" if ok else "FAIL")
    browser.close()
    sys.exit(0 if ok else 1)
