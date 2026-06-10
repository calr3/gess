"""Verify the type-to-move entry box. Black is human by default; we set White to
human too so the AI doesn't move and perturb the log. Then: (1) an illegal entry
shows an error and changes nothing; (2) the legal opening "h6 i7" plays, adding a
ply 'h6-i7' to the move log."""
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

    # White → human so only our typed black move appears.
    selects = page.query_selector_all("select.controller-select")
    selects[0].select_option("human")  # first row is White

    inp = page.query_selector(".move-entry-input")
    btn = page.query_selector(".btn-move-entry")

    def plies():
        return [pl.inner_text().replace("\n", " ").strip()
                for pl in page.query_selector_all(".moves-list .move-ply")]

    # (1) Illegal entry → error, no move logged.
    inp.fill("a1 a2")
    btn.click()
    page.wait_for_timeout(300)
    err1 = page.query_selector(".move-entry-error")
    err1_txt = err1.inner_text() if err1 else None
    after_illegal = plies()
    print("illegal -> error:", repr(err1_txt), "| plies:", after_illegal)

    # (1b) Garbage entry → format error.
    inp.fill("hello")
    btn.click()
    page.wait_for_timeout(200)
    e = page.query_selector(".move-entry-error")
    garbage_txt = e.inner_text() if e else None
    print("garbage -> error:", repr(garbage_txt))

    # (1c) Real black group but illegal destination → "isn't a legal move".
    inp.fill("h6 a1")
    btn.click()
    page.wait_for_timeout(200)
    e = page.query_selector(".move-entry-error")
    illegal_dest_txt = e.inner_text() if e else None
    print("h6 a1 -> error:", repr(illegal_dest_txt), "| plies:", plies())

    # (2) Legal "h6 i7" via Enter key.
    inp.fill("h6 i7")
    inp.press("Enter")
    page.wait_for_timeout(400)
    after_legal = plies()
    input_val = inp.input_value()
    err2 = page.query_selector(".move-entry-error")
    print("legal 'h6 i7' -> plies:", after_legal)
    print("input cleared:", repr(input_val), "| residual error:", repr(err2.inner_text() if err2 else None))

    page.screenshot(path="verify/type-move.png")

    ok = (
        err1_txt and "isn't one of your pieces" in err1_txt.lower() and len(after_illegal) == 0 and
        garbage_txt and "two squares" in garbage_txt.lower() and
        illegal_dest_txt and "legal move" in illegal_dest_txt.lower() and
        len(after_legal) == 1 and after_legal[0].startswith("1.") and "h6-i7" in after_legal[0] and
        input_val == "" and not errs
    )
    print("errors:", errs[:5])
    print("RESULT:", "PASS" if ok else "FAIL")
    browser.close()
    sys.exit(0 if ok else 1)
