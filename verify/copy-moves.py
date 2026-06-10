"""Verify the Copy button produces an aligned plain-text table.

Rather than hand-craft moves, let the app's own AI play both sides for a real
game of 10+ full moves (so we get 2-digit move numbers and varied notation
widths), then scrape the Moves panel, recompute the expected aligned table in
Python with the same padding rule, and assert the live clipboard matches it
EXACTLY. This both confirms the on-screen→clipboard round-trip and proves the
column padding (right-aligned number, black padded to its max width)."""
import sys
from playwright.sync_api import sync_playwright


def expected_table(rows):
    """rows = [(num:int, black:str, white:str|None)] -> the aligned table text.
    Mirrors BoardComponent.moveHistoryText()."""
    num_w = max(len(f"{n}.") for n, _, _ in rows)
    black_w = max(len(b) for _, b, _ in rows)
    lines = []
    for n, b, w in rows:
        num = f"{n}.".rjust(num_w)
        black = b.ljust(black_w) if w else b
        white = f"  {w}" if w else ""
        lines.append(f"{num}  {black}{white}")
    return "\n".join(lines)


with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(permissions=["clipboard-read", "clipboard-write"])
    page = ctx.new_page()
    errs = []
    page.on("pageerror", lambda e: errs.append("PAGEERROR: " + str(e)))
    page.on("console", lambda m: errs.append("CONSOLE-ERR: " + m.text) if m.type == "error" else None)
    page.goto("http://localhost:4201", wait_until="networkidle")
    page.wait_for_selector("app-board", timeout=15000)

    # Both sides AI Easy (0.5s) so a real game plays itself out quickly.
    selects = page.query_selector_all("select.controller-select")
    selects[0].select_option("easy")  # White
    selects[1].select_option("easy")  # Black
    page.query_selector(".btn-new-game").click()

    # Wait until at least 19 plies (=> move number reaches 10) have been recorded.
    TARGET_PLIES = 19
    deadline = 90_000
    waited = 0
    while waited < deadline:
        n = len(page.query_selector_all(".moves-list .move-ply:not(.move-ply-empty)"))
        if n >= TARGET_PLIES or page.query_selector(".winner-banner"):
            break
        page.wait_for_timeout(1000)
        waited += 1000

    # Halt self-play before scraping/copying so the DOM and the clipboard can't
    # diverge by a move landing between them. Set both controllers to Human (the
    # current thinker may be locked, so set repeatedly) and wait for the ply
    # count to go stable with no AI progress bar showing.
    for _ in range(6):
        for sel in page.query_selector_all("select.controller-select"):
            if not sel.is_disabled():
                sel.select_option("human")
        page.wait_for_timeout(600)
    prev = -1
    for _ in range(20):
        n = len(page.query_selector_all(".moves-list .move-ply:not(.move-ply-empty)"))
        thinking = page.query_selector(".ai-progress") is not None
        if n == prev and not thinking:
            break
        prev = n
        page.wait_for_timeout(800)

    # Scrape the panel into rows of (num, black, white|None).
    rows = []
    for row in page.query_selector_all(".moves-list .move-row"):
        num = int(row.query_selector(".move-num").inner_text().strip().rstrip("."))
        plies = [pl.inner_text().strip()
                 for pl in row.query_selector_all(".move-ply")
                 if "move-ply-empty" not in (pl.get_attribute("class") or "")]
        black = plies[0]
        white = plies[1] if len(plies) > 1 else None
        rows.append((num, black, white))

    print(f"scraped {len(rows)} numbered rows (last num = {rows[-1][0]})")
    widths = {len(b) for _, b, _ in rows} | {len(w) for _, _, w in rows if w}
    print("distinct notation widths seen:", sorted(widths))

    btn = page.query_selector(".btn-copy-moves")
    btn.click()
    page.wait_for_timeout(150)
    after = page.query_selector(".btn-copy-moves").inner_text().strip()
    clip = page.evaluate("navigator.clipboard.readText()")

    want = expected_table(rows)
    print("--- clipboard ---\n" + clip)
    print("--- expected ----\n" + want)

    # Sanity: confirm the table actually exercises alignment, i.e. either a
    # 2-digit move number or notations of differing widths appear.
    exercises_padding = rows[-1][0] >= 10 or len(widths) > 1

    ok = (
        clip == want and
        after == "Copied!" and
        exercises_padding and
        len(rows) >= 1 and
        not errs
    )
    page.screenshot(path="verify/copy-moves.png")
    print("exercises padding (2-digit num or mixed widths):", exercises_padding)
    print("errors:", errs[:5])
    print("RESULT:", "PASS" if ok else "FAIL")
    browser.close()
    sys.exit(0 if ok else 1)
