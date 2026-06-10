"""Verify move-history navigation:
 (1) hovering a past move shows the WHOLE board as it was just after that move,
     plus the move arrow;
 (2) double-clicking a move snaps the game back to that point and continues from
     there under the current controller (AI/Human) settings."""
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
        e = page.query_selector(".move-entry-error")
        assert e is None, f"move {mv} rejected: {e.inner_text()}"

    board = lambda: page.evaluate(BOARD_JS)
    ply = lambda txt: page.locator(".move-ply", has_text=txt).first

    # Build a 3-ply history, snapshotting the board right after black's 1st move.
    play("h6-i7")
    S1 = board()                      # board after black move 1 only
    play("h15-i14")
    play("i7-j8")
    S3 = board()                      # board after all three plies
    print("board changed over the game:", S1 != S3)

    # (1) Hover the first move → board must match the after-move-1 snapshot + arrow.
    ply("h6-i7").hover()
    page.wait_for_timeout(150)
    Phover = board()
    arrow = page.query_selector(".board-grid svg.move-arrow line") is not None
    print("hover preview == historical S1:", Phover == S1, "| arrow drawn:", arrow)

    # Leaving the record returns to the live board.
    page.query_selector(".btn-new-game").hover()  # move off the move row
    page.wait_for_timeout(150)
    Pleave = board()
    print("after mouse-leave == live S3:", Pleave == S3)

    # (2) Double-click the first move → snap back to that point, white to move.
    page.locator(".move-ply", has_text="h6-i7").first.dblclick()
    page.wait_for_timeout(250)
    plies_after = [pl.inner_text().strip()
                   for pl in page.query_selector_all(".moves-list .move-ply")
                   if "move-ply-empty" not in (pl.get_attribute("class") or "")]
    Brevert = board()
    status = page.query_selector(".game-message span").inner_text()
    print("after revert: plies =", plies_after, "| board == S1:", Brevert == S1, "| status:", repr(status))

    # (3) Continue under AI control: we're at White's turn after the revert. Hand
    # White to the AI → it must auto-play (scheduleAi runs off the state change).
    page.query_selector_all("select.controller-select")[0].select_option("easy")
    deadline = 0
    while deadline < 8000:
        n = [pl.inner_text().strip() for pl in page.query_selector_all(".moves-list .move-ply")
             if "move-ply-empty" not in (pl.get_attribute("class") or "")]
        if len(n) >= 2:
            break
        page.wait_for_timeout(500); deadline += 500
    plies_ai = [pl.inner_text().strip() for pl in page.query_selector_all(".moves-list .move-ply")
                if "move-ply-empty" not in (pl.get_attribute("class") or "")]
    print("after revert with White=AI: plies =", plies_ai, "(white should have auto-moved)")

    page.screenshot(path="verify/move-history-nav.png")

    ok = (
        S1 != S3 and
        Phover == S1 and arrow and
        Pleave == S3 and
        plies_after == ["h6-i7"] and Brevert == S1 and "White" in status and
        len(plies_ai) >= 2 and  # black h6-i7 + a white AI reply
        not errs
    )
    print("errors:", errs[:5])
    print("RESULT:", "PASS" if ok else "FAIL")
    browser.close()
    sys.exit(0 if ok else 1)
