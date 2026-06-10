"""Verify the live (purple) preview of a move typed into the move-entry input.

  - first valid square  → source footprint highlighted (.typed-fp / .typed-from),
                          no arrow yet;
  - second valid square → destination footprint added (.typed-to) and the purple
                          arrow (.typed-arrow) drawn;
  - it uses the same footprint/arrow visualisation as a real move, just purple
    (a distinct stroke colour and footprint tint);
  - an illegal partial entry shows nothing / collapses back to the source;
  - submitting or clearing the input removes the preview.

Black is Human (default) and to move first, so typed previews apply.
"""
import sys
from playwright.sync_api import sync_playwright

def count(page, sel):
    return len(page.query_selector_all(sel))

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    errs = []
    page.on("pageerror", lambda e: errs.append("PAGEERROR: " + str(e)))
    page.on("console", lambda m: errs.append("CONSOLE-ERR: " + m.text) if m.type == "error" else None)
    page.goto("http://localhost:4201", wait_until="networkidle")
    page.wait_for_selector("app-board", timeout=15000)
    page.query_selector(".btn-new-game").click()  # fresh game, Black (human) to move
    page.wait_for_timeout(150)

    inp = page.query_selector(".move-entry-input")
    fail = False

    def stroke(sel):
        el = page.query_selector(sel)
        return page.evaluate("e => getComputedStyle(e).stroke", el) if el else None

    def check(name, cond, detail=""):
        global fail
        if cond:
            print(f"  ok   {name}")
        else:
            print(f"  FAIL {name}{' — ' + detail if detail else ''}"); fail = True

    # A legal opening move for Black: i8 (a piece) → h7.  (Black's forward row.)
    # Pick one the engine accepts; "e8 f7" was used in the draw test and is legal.
    FROM, TO = "e8", "f7"

    # ── 1. Empty input → no preview ──────────────────────────────────────────
    inp.fill(""); page.wait_for_timeout(80)
    check("empty input: no footprint/arrow",
          count(page, ".typed-fp") == 0 and count(page, ".typed-arrow") == 0)

    # ── 2. First valid square → source footprint, no arrow ───────────────────
    inp.fill(FROM); page.wait_for_timeout(80)
    fp1 = count(page, ".typed-fp")
    check("first square: source footprint shown (≈9 cells)", 7 <= fp1 <= 9, f"got {fp1}")
    check("first square: a typed-from centre marked", count(page, ".typed-from") == 1)
    check("first square: no arrow yet", count(page, ".typed-arrow") == 0)
    check("first square: no typed-to yet", count(page, ".typed-to") == 0)

    # ── 3. Second valid square → full move + purple arrow ─────────────────────
    inp.fill(f"{FROM} {TO}"); page.wait_for_timeout(80)
    fp2 = count(page, ".typed-fp")
    check("full move: both footprints shown (more cells than one)", fp2 > fp1, f"{fp1}→{fp2}")
    check("full move: typed-from + typed-to both marked",
          count(page, ".typed-from") == 1 and count(page, ".typed-to") == 1)
    check("full move: purple arrow drawn", count(page, ".typed-arrow") == 1)

    # ── 4. Same visualisation as the real move, but purple ────────────────────
    s = stroke(".typed-arrow line")
    # #b06cf0 → rgb(176, 108, 240)
    check("arrow stroke is purple", s is not None and "176" in s and "108" in s and "240" in s, f"stroke={s!r}")
    page.screenshot(path="verify/typed-move-preview.png")  # full purple preview on screen

    # ── 5. Illegal destination collapses back to just the source ──────────────
    inp.fill(f"{FROM} a1"); page.wait_for_timeout(80)
    check("illegal destination: arrow removed", count(page, ".typed-arrow") == 0)
    check("illegal destination: source footprint still shown", count(page, ".typed-fp") >= 7)

    # ── 6. Non-piece first square shows nothing ───────────────────────────────
    inp.fill("a1"); page.wait_for_timeout(80)  # border / empty — not a footprint
    check("non-piece first square: nothing shown", count(page, ".typed-fp") == 0)

    # ── 7. Submitting a valid move applies it and clears the preview ──────────
    inp.fill(f"{FROM} {TO}"); page.wait_for_timeout(80)
    inp.press("Enter"); page.wait_for_timeout(200)
    err = page.query_selector(".move-entry-error")
    check("valid move accepted (no error)", err is None, err.inner_text() if err else "")
    check("preview cleared after submit",
          count(page, ".typed-fp") == 0 and count(page, ".typed-arrow") == 0)
    # The move now appears in the record.
    check("move recorded", page.query_selector(".move-ply") is not None)

    if errs:
        print("PAGE ERRORS:", errs); fail = True
    print("\nRESULT:", "FAIL" if fail else "PASS")
    browser.close()
    sys.exit(1 if fail else 0)
