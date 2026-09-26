"""Drive the live UI to the quiet-move limit (pgx gess v1 rules).

Sets both players to Human, then replays pre-generated legal sequences through
the move-entry box:

1. 20 captureless moves from the opening. Both sides keep all 43 stones, so on
   the 20th move the game is decided on stones and is level: a draw.
2. A move that takes stones off the board (black loses five), then 20 captureless
   moves. On the 20th the game is decided on stones: White wins, 43–38.

In both, the game must not end before the 20th quiet move, the countdown must
appear for the last five, and further input is refused afterwards.

The sequences were generated offline against the shared engine (getValidMoves /
wasCapture / countRings), so every move is legal, keeps both rings, and only the
first move of the second sequence removes stones.

    GESS_URL=http://localhost:4201 python verify/quiet-rule-browser.py
    # GESS_CHROMIUM=/path/to/chrome to use a particular browser binary
"""
import os
import sys
from playwright.sync_api import sync_playwright

URL = os.environ.get("GESS_URL", "http://localhost:4201")
CHROMIUM = os.environ.get("GESS_CHROMIUM")

LEVEL = ["b8 c7", "c18 c17", "e8 f7", "f19 e19", "h8 i7", "e19 f19", "k8 l7",
         "f19 e19", "n8 o7", "e19 f19", "q8 r7", "f19 e19", "c7 d6", "e19 f19",
         "f7 g6", "f19 e19", "i7 j6", "e19 f19", "l7 m6", "f19 e19"]
AHEAD = ["h2 i3", "s13 r14", "r8 r7", "p14 q15", "m6 l7", "c18 c16", "b7 c7",
         "c16 c17", "n6 o7", "m13 k15", "s7 r6", "p14 p15", "g7 f7", "g13 f14",
         "d6 d8", "b15 d13", "d10 d9", "f12 c12", "e7 e9", "d14 e15", "e9 e11"]

# Countdown once 5 or fewer quiet moves remain, keyed by the quiet-move count.
EXPECT_WARN = {15: "5 moves", 16: "4 moves", 17: "3 moves", 18: "2 moves", 19: "1 move"}

with sync_playwright() as p:
    browser = p.chromium.launch(**({"executable_path": CHROMIUM} if CHROMIUM else {}))
    page = browser.new_page()
    errs = []
    page.on("pageerror", lambda e: errs.append("PAGEERROR: " + str(e)))
    page.on("console", lambda m: errs.append("CONSOLE-ERR: " + m.text) if m.type == "error" else None)
    page.goto(URL, wait_until="networkidle")
    page.wait_for_selector("app-board", timeout=15000)

    sels = page.query_selector_all("select.controller-select")
    sels[0].select_option("human")  # White
    sels[1].select_option("human")  # Black

    fail = False

    # "How to play" describes the rule.
    page.query_selector(".rules-summary summary").click()
    rules = page.query_selector(".rules-summary").inner_text()
    if "20 moves pass with no capture" in rules and "more stones" in rules and "resets the count" in rules:
        print("  ok   How-to-play describes the quiet-move rule")
    else:
        print(f"  FAIL How-to-play missing/incomplete quiet-move rule: {rules!r}"); fail = True

    def banner():
        b = page.query_selector(".winner-banner")
        return b.inner_text() if b else None

    def warning():
        w = page.query_selector(".draw-warning")
        return w.inner_text().strip() if w else None

    def play(mv):
        inp = page.query_selector(".move-entry-input")
        inp.fill(mv); inp.press("Enter"); page.wait_for_timeout(120)
        e = page.query_selector(".move-entry-error")
        return e.inner_text() if e else None

    def run(name, moves, quiet_from, expect_draw, expect_text):
        """Play `moves`; the quiet count starts at move index `quiet_from`."""
        global fail
        print(f"\n{name}:")
        page.query_selector(".btn-new-game").click()
        page.wait_for_timeout(150)
        for i, mv in enumerate(moves, start=1):
            err = play(mv)
            b = banner()
            quiet = i - quiet_from
            if i < len(moves):
                if err:
                    print(f"  FAIL move {i} ({mv}) rejected: {err}"); fail = True; return
                if b is not None:
                    print(f"  FAIL game ended early on move {i}: banner={b!r}"); fail = True; return
                w = warning()
                exp = EXPECT_WARN.get(quiet)
                if exp is None:
                    if w is not None:
                        print(f"  FAIL countdown shown too early on move {i}: {w!r}"); fail = True; return
                elif w is None or exp not in w or "decided on stones" not in w:
                    print(f"  FAIL move {i} countdown wrong: got {w!r}, expected {exp!r}"); fail = True; return
                else:
                    print(f"  ok   move {i:2d} {mv} — countdown: {w!r}")
            else:
                if b is None:
                    print("  FAIL no banner after the 20th quiet move"); fail = True; return
                is_draw = page.query_selector(".winner-banner.draw") is not None
                print(f"  move {i} {mv} — banner: {b!r}")
                if is_draw != expect_draw or expect_text not in b:
                    print(f"  FAIL expected {'a draw' if expect_draw else 'a win'} mentioning {expect_text!r}"); fail = True
                else:
                    print("  ok   decided on stones on the 20th quiet move")
                if warning() is not None:
                    print(f"  FAIL countdown still shown after the game ended: {warning()!r}"); fail = True
                err = play("b16 c15")
                if err != "The game is over.":
                    print(f"  FAIL post-game move not refused as game-over: {err!r}"); fail = True
                else:
                    print("  ok   input refused afterwards ('The game is over.')")

    run("Level on stones", LEVEL, 0, True, "level on stones, 43–43")
    run("White ahead on stones", AHEAD, 1, False, "White wins on stones, 43–38")

    page.screenshot(path="verify/quiet-rule-browser.png")
    if errs:
        print("PAGE ERRORS:", errs); fail = True

    print("\nRESULT:", "FAIL" if fail else "PASS")
    browser.close()
    sys.exit(1 if fail else 0)
