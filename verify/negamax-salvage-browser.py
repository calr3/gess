"""Drive the real timed negamax search (Normal = 2s, which always aborts a
deeper iteration mid-flight — the new partial-iteration salvage path). Confirm
the AI still plays a legal move, completes several depths, and logs no errors."""
import sys, re, time
from playwright.sync_api import sync_playwright

URL = "http://localhost:4201"
with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    logs, errors = [], []
    page.on("console", lambda m: logs.append(m.text))
    page.on("pageerror", lambda e: errors.append("PAGEERROR: " + str(e)))
    page.goto(URL, wait_until="networkidle")
    page.wait_for_selector("app-board", timeout=15000)

    # Black moves first → make it AI Normal (2s budget, forces mid-depth abort).
    page.query_selector_all("select.controller-select")[1].select_option("normal")
    print("Black set to AI · Normal (2s); waiting for its move...")

    deadline = time.time() + 25
    ai_log, moves = None, 0
    while time.time() < deadline:
        for l in logs:
            m = re.search(r"\[Gess AI\] black: best depth (\d+), (\d+) root moves, (\d+)ms total", l)
            if m:
                ai_log = m
        moves = len(page.query_selector_all(".moves-list .move-row"))
        if ai_log and moves >= 1:
            break
        page.wait_for_timeout(300)

    if ai_log:
        print(f"diagnostic: best depth {ai_log.group(1)}, {ai_log.group(2)} root moves, {ai_log.group(3)}ms")
    # Grab the notation of the move it actually played.
    rows = page.query_selector_all(".moves-list .move-row .move-notation")
    notation = rows[0].inner_text() if rows else None
    print(f"moves recorded: {moves}  first move: {notation}")
    if errors:
        print("ERRORS:")
        for e in errors[:8]:
            print("  ", e[:200])

    depth_ok = ai_log is not None and int(ai_log.group(1)) >= 2
    ok = depth_ok and moves >= 1 and notation and not errors
    print("RESULT:", "PASS" if ok else "FAIL")
    browser.close()
    sys.exit(0 if ok else 1)
