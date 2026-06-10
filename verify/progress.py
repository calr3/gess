"""Verify (1) the AI 'thinking…' progress bar fills smoothly toward the search
budget and disappears when the move lands, and (2) the new 'AI · Ultra (60s)'
dropdown option exists and drives a 60s budget."""
import sys, time
from playwright.sync_api import sync_playwright

URL = "http://localhost:4201"

def fill_pct(page):
    return page.evaluate("""() => {
        const f = document.querySelector('.ai-progress-fill');
        if (!f) return null;
        const p = f.parentElement;
        return Math.round(f.offsetWidth / p.offsetWidth * 1000) / 10;
    }""")

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    logs = []
    page.on("console", lambda m: logs.append(m.text))
    page.on("pageerror", lambda e: logs.append("PAGEERROR: " + str(e)))

    page.goto(URL, wait_until="networkidle")
    page.wait_for_selector("app-board", timeout=15000)

    # --- Check dropdown options ---
    opts = page.eval_on_selector_all(
        "select.controller-select >> nth=0 >> option",
        "els => els.map(e => [e.value, e.textContent.trim()])")
    print("White dropdown options:")
    for v, t in opts:
        print(f"   {v!r:10} {t!r}")
    has_ultra = any(v == "ultra" and "60s" in t for v, t in opts)
    print("ultra option present:", has_ultra)

    # --- Test A: progress bar with Black=normal (2s) ---
    selects = page.query_selector_all("select.controller-select")
    # Black is the second select and moves first.
    selects[1].select_option("normal")
    print("\n[A] Black set to Normal (2s); watching progress bar...")

    # Wait for the bar to appear (after the 400ms schedule delay + thinking).
    page.wait_for_selector(".ai-progress-fill", timeout=4000)
    samples = []
    t0 = time.time()
    while time.time() - t0 < 2.4:
        pct = fill_pct(page)
        if pct is not None:
            samples.append((round(time.time() - t0, 2), pct))
        if pct is None and samples:
            break  # bar disappeared (move landed)
        page.wait_for_timeout(200)
    print("   width samples (t_s, pct):", samples)
    mono = all(b[1] >= a[1] - 0.5 for a, b in zip(samples, samples[1:]))
    print("   monotonically increasing:", mono)
    print("   max width reached:", max((s[1] for s in samples), default=None))

    # Screenshot mid-think on the next search if we missed it; capture now.
    page.screenshot(path="verify/progress.png")

    # Wait for the move to land and the bar to clear.
    page.wait_for_function("() => !document.querySelector('.ai-progress-fill')", timeout=6000)
    print("   bar cleared after move:", page.query_selector(".ai-progress-fill") is None)
    normal_log = [l for l in logs if "[Gess AI]" in l and "2000ms" in l]
    print("   AI log shows 2000ms budget:", len(normal_log) > 0)

    # --- Test B: Ultra plumbing (60s) — sample slow fill, don't wait full 60s ---
    page.reload(wait_until="networkidle")
    page.wait_for_selector("app-board", timeout=15000)
    selects = page.query_selector_all("select.controller-select")
    selects[1].select_option("ultra")
    print("\n[B] Black set to Ultra (60s); sampling fill rate over 3s...")
    page.wait_for_selector(".ai-progress-fill", timeout=4000)
    t0 = time.time()
    page.wait_for_timeout(3000)
    pct = fill_pct(page)
    elapsed = time.time() - t0
    print(f"   after ~{elapsed:.1f}s, fill = {pct}% (expect ~{elapsed/60*100:.0f}% for a 60s budget)")
    ultra_ok = pct is not None and 2 <= pct <= 12  # ~5% expected, generous band

    errors = [l for l in logs if "PAGEERROR" in l]
    if errors:
        print("\nERRORS:")
        for e in errors[:10]:
            print("  ", e[:200])

    ok = (has_ultra and len(samples) >= 3 and mono
          and max((s[1] for s in samples), default=0) > 20
          and page.query_selector(".ai-progress-fill") is None
          and ultra_ok and not errors)
    print("\nRESULT:", "PASS" if ok else "FAIL")
    browser.close()
    sys.exit(0 if ok else 1)
