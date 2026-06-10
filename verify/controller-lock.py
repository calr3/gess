"""Verify the current player's controller dropdown is locked while the AI is
thinking for them, and the other player's stays editable. White=Hard (15s) AI,
Black=Human; Black plays, then White's long search starts → check lock state."""
import sys, time
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
    white_sel, black_sel = selects[0], selects[1]  # row order: White, Black

    # Baseline (Black's turn, nobody thinking) — both editable.
    base_white = white_sel.is_disabled()
    base_black = black_sel.is_disabled()
    print("baseline disabled  white:", base_white, "black:", base_black)

    # White → Hard so its search runs long enough to observe the lock.
    white_sel.select_option("hard")  # editable now: not White's turn

    # Black (human) plays a legal opening move → turn passes to White (AI).
    inp = page.query_selector(".move-entry-input")
    inp.fill("h6 i7")
    inp.press("Enter")

    # Wait for White's search to actually be in flight (~400ms delay + CD).
    deadline = time.time() + 4
    while time.time() < deadline and not white_sel.is_disabled():
        page.wait_for_timeout(100)

    think_white = white_sel.is_disabled()
    think_black = black_sel.is_disabled()
    msg = page.query_selector(".game-message span").inner_text()
    print("while thinking     white:", think_white, "black:", think_black, "| msg:", repr(msg))

    # The other player's (Black's) dropdown must still be editable — change it.
    black_changed = True
    try:
        black_sel.select_option("easy", timeout=2000)
    except Exception as e:
        black_changed = False
        print("  black change failed:", e)
    print("black editable during White's think:", black_changed, "-> value", black_sel.input_value())

    page.screenshot(path="verify/controller-lock.png")

    ok = (
        base_white is False and base_black is False and
        think_white is True and think_black is False and
        "thinking" in msg.lower() and
        black_changed and black_sel.input_value() == "easy" and
        not errs
    )
    print("errors:", errs[:5])
    print("RESULT:", "PASS" if ok else "FAIL")
    browser.close()
    sys.exit(0 if ok else 1)
