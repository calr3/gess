"""End-to-end browser check of the parallel (Lazy SMP) AI in the real app.

Verifies the page is cross-origin isolated (so shared WebAssembly.Memory works),
then drives a short AI-vs-AI game. A recorded move proves the whole parallel
pipeline ran: shared memory + a pool of nested helper workers (begin_search →
helpers search_helper → main best_move → stop_search → join). If a helper failed
to instantiate over the shared memory, loadEngine() would reject and no move
would ever be recorded.
"""
import sys, time
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

    coi = page.evaluate("() => self.crossOriginIsolated === true")
    hw = page.evaluate("() => navigator.hardwareConcurrency || 1")
    sab = page.evaluate("() => typeof SharedArrayBuffer !== 'undefined'")
    print(f"crossOriginIsolated: {coi}")
    print(f"navigator.hardwareConcurrency: {hw}  (helpers used: up to min(hw,16)-1 = {min(hw,16)-1})")
    print(f"SharedArrayBuffer available: {sab}")

    # Self-play: set both sides to AI · Easy (0.5s) so moves come quickly.
    selects = page.query_selector_all("select.controller-select")
    print(f"controller selects: {len(selects)}")
    for s in selects:
        s.select_option("easy")

    def move_count():
        return len(page.query_selector_all(".moves-list .move-row"))

    start = time.time()
    last = 0
    while time.time() - start < 40:
        c = move_count()
        if c != last:
            last = c
            print(f"[{time.time()-start:5.1f}s] moves: {c}")
        if c >= 4:
            break
        page.wait_for_timeout(300)

    moves = move_count()
    ai_logs = [l for l in logs if "[Gess AI]" in l]
    print(f"\nmoves recorded: {moves}")
    print(f"[Gess AI] logs: {len(ai_logs)}")
    if ai_logs:
        print("first AI diagnostic (head):")
        print("  " + ai_logs[0].split(chr(10))[0])
    if errors:
        print("\nERRORS:")
        for e in errors[:8]:
            print("  ", e[:200])

    page.screenshot(path="verify/parallel-browser.png")
    ok = coi and sab and moves >= 3 and len(ai_logs) >= 3 and not errors
    print("\nRESULT:", "PASS" if ok else "FAIL")
    browser.close()
    sys.exit(0 if ok else 1)
