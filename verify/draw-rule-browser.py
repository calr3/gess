"""Drive the live UI to an actual no-capture draw.

Sets both players to Human, then replays a pre-generated sequence of 20 legal,
captureless moves (no stone removed on any move, both rings kept). The draw
should be declared on the 20th move — not before — with the draw banner shown
and further input refused.

The 20-move sequence was generated offline against the shared engine
(getValidMoves / countCaptures / wasCapture), so every move is legal and
removes no stone.
"""
import sys
from playwright.sync_api import sync_playwright

MOVES = ["b8 c7", "c18 c17", "e8 f7", "f19 e19", "h8 i7", "e19 f19", "k8 l7",
         "f19 e19", "n8 o7", "e19 f19", "q8 r7", "f19 e19", "c7 d6", "e19 f19",
         "f7 g6", "f19 e19", "i7 j6", "e19 f19", "l7 m6", "f19 e19"]

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

    fail = False

    # "How to play" mentions the draw rule.
    page.query_selector(".rules-summary summary").click()
    rules = page.query_selector(".rules-summary").inner_text()
    if "Draw:" in rules and "20 turns" in rules and "resets the count" in rules:
        print("  ok   How-to-play describes the draw rule")
    else:
        print(f"  FAIL How-to-play missing/incomplete draw rule: {rules!r}"); fail = True

    def banner():
        b = page.query_selector(".winner-banner")
        return b.inner_text() if b else None

    def warning():
        w = page.query_selector(".draw-warning")
        return w.inner_text().strip() if w else None

    # Countdown should appear only once 5 or fewer turns remain (after move 15),
    # decrementing each move, with correct singular/plural.
    EXPECT_WARN = {15: "5 turns", 16: "4 turns", 17: "3 turns",
                   18: "2 turns", 19: "1 turn"}

    def play(mv):
        inp = page.query_selector(".move-entry-input")
        inp.fill(mv); inp.press("Enter"); page.wait_for_timeout(120)
        e = page.query_selector(".move-entry-error")
        return e.inner_text() if e else None

    for i, mv in enumerate(MOVES, start=1):
        err = play(mv)
        b = banner()
        if i < 20:
            if err:
                print(f"  FAIL move {i} ({mv}) rejected: {err}"); fail = True; break
            if b is not None:
                print(f"  FAIL game ended early on move {i}: banner={b!r}"); fail = True; break
            w = warning()
            exp = EXPECT_WARN.get(i)
            if exp is None:
                if w is not None:
                    print(f"  FAIL countdown shown too early on move {i}: {w!r}"); fail = True; break
                print(f"  ok   move {i:2d} {mv} — game continues, no countdown")
            elif w is None or exp not in w:
                print(f"  FAIL move {i} countdown wrong: got {w!r}, expected to contain {exp!r}"); fail = True; break
            else:
                print(f"  ok   move {i:2d} {mv} — countdown: {w!r}")
        else:
            # The 20th captureless move should trigger the draw.
            if b is None:
                print(f"  FAIL no banner after the 20th captureless move (expected a draw)"); fail = True; break
            is_draw = page.query_selector(".winner-banner.draw") is not None
            print(f"  move 20 {mv} — banner shown: {b!r}")
            if not is_draw or "Draw" not in b:
                print("  FAIL banner is not the draw banner"); fail = True
            else:
                print("  ok   draw declared on move 20 with the draw banner")
            if warning() is not None:
                print(f"  FAIL countdown still shown after the draw: {warning()!r}"); fail = True
            else:
                print("  ok   countdown hidden once the game is over")

    # A move after the draw must be refused (game over).
    if not fail:
        err = play("b16 c15")
        if err != "The game is over.":
            print(f"  FAIL post-draw move not refused as game-over: {err!r}"); fail = True
        else:
            print("  ok   input refused after the draw ('The game is over.')")

    page.screenshot(path="verify/draw-rule-browser.png")
    if errs:
        print("PAGE ERRORS:", errs); fail = True

    print("\nRESULT:", "FAIL" if fail else "PASS")
    browser.close()
    sys.exit(1 if fail else 0)
