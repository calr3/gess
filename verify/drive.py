"""Drive the running Gess app and verify the WASM AI engine actually plays.

Black is the AI by default (moves first). We also switch White to AI so the two
sides play each other, then confirm: moves get recorded, and each search emits
the WASM engine's "[Gess AI] …" console diagnostics (proving gess-wasm ran).
"""
import sys, time
from playwright.sync_api import sync_playwright

URL = "http://localhost:4201"

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    logs = []
    page.on("console", lambda m: logs.append(m.text))
    page.on("pageerror", lambda e: logs.append("PAGEERROR: " + str(e)))

    page.goto(URL, wait_until="networkidle")
    page.wait_for_selector("app-board", timeout=15000)

    # Make both sides AI so the game self-plays.
    selects = page.query_selector_all("select.controller-select")
    print(f"controller selects found: {len(selects)}")
    for s in selects:
        s.select_option("ai")

    # Read the move-record count helper.
    def move_rows():
        return page.query_selector_all(".moves-list .move-row, .moves-list li, .move-row")

    def status_msg():
        el = page.query_selector(".status-message, .message, .turn-message")
        return el.inner_text() if el else "(no status el)"

    start = time.time()
    last_count = 0
    deadline = start + 60  # allow a few 10s searches
    while time.time() < deadline:
        rows = move_rows()
        if len(rows) != last_count:
            last_count = len(rows)
            print(f"[{time.time()-start:5.1f}s] moves recorded: {last_count}  status: {status_msg()!r}")
        if last_count >= 4:
            break
        page.wait_for_timeout(500)

    rows = move_rows()
    print(f"\nTotal moves recorded: {len(rows)}")
    texts = [r.inner_text().replace('\n', ' ') for r in rows[:8]]
    for t in texts:
        print("  move:", t)

    ai_logs = [l for l in logs if "[Gess AI]" in l]
    print(f"\n[Gess AI] console logs: {len(ai_logs)}")
    if ai_logs:
        # Print the first diagnostic block as evidence the WASM engine ran.
        print("---- first AI diagnostic ----")
        print(ai_logs[0][:900])
        print("---- end ----")

    errors = [l for l in logs if "PAGEERROR" in l or "Error" in l]
    if errors:
        print("\nERRORS:")
        for e in errors[:10]:
            print("  ", e[:200])

    page.screenshot(path="verify/app.png", full_page=True)
    print("\nscreenshot: verify/app.png")

    ok = len(rows) >= 2 and len(ai_logs) >= 2 and not errors
    print("\nRESULT:", "PASS" if ok else "FAIL")
    browser.close()
    sys.exit(0 if ok else 1)
