// Injected into a LinkedIn jobs search tab by the Discover view. Reads result cards and the detail pane, and opens
// a card the way a click on its title would. Same reading as scout.py (CARDS_JS / PANE_JS): semantic keys and the
// "About the job" heading, never LinkedIn's obfuscated class names. It never touches Apply or Easy Apply.
(() => {
  if (window.__jobLinkedIn) return;
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const label = (e) => clean((e.getAttribute("aria-label") || "") + " " + (e.innerText || ""));

  // New layout: componentkey="job-card-component-ref-<id>". Older /jobs/search/ layout: data-job-id.
  function cardEls() {
    const out = new Map();
    for (const el of document.querySelectorAll('[componentkey^="job-card-component-ref-"]')) {
      const id = el.getAttribute("componentkey").slice("job-card-component-ref-".length);
      if (/^\d+$/.test(id) && !out.has(id)) out.set(id, el);
    }
    if (!out.size) {
      for (const el of document.querySelectorAll("[data-occludable-job-id], [data-job-id]")) {
        const id = el.getAttribute("data-occludable-job-id") || el.getAttribute("data-job-id");
        if (/^\d+$/.test(id) && !out.has(id)) out.set(id, el);
      }
    }
    return out;
  }

  function cards() {
    return [...cardEls()].map(([id, el]) => ({ id, text: clean(el.innerText).slice(0, 400) }));
  }

  function noResults() {
    return /no matching jobs|no results|try (a )?different/i.test(document.body?.innerText || "");
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Scroll the card into view, then click near its top-left (title/company), away from the dismiss ✕ on the right.
  async function open(id) {
    const el = cardEls().get(id);
    if (!el) return { ok: false, error: "card gone" };
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    await sleep(500 + Math.random() * 700);
    const r = el.getBoundingClientRect();
    if (!r.width) return { ok: false, error: "card not visible" };
    const x = r.left + Math.min(20 + Math.random() * r.width * 0.3, r.width - 4);
    const y = r.top + Math.min(10 + Math.random() * 16, r.height - 4);
    const target = document.elementFromPoint(x, y) || el;
    if (!el.contains(target)) return { ok: false, error: "card covered by something else" };
    const opts = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, view: window };
    target.dispatchEvent(new PointerEvent("pointerover", opts));
    target.dispatchEvent(new MouseEvent("mouseover", opts));
    target.dispatchEvent(new PointerEvent("pointerdown", { ...opts, pointerType: "mouse", isPrimary: true }));
    target.dispatchEvent(new MouseEvent("mousedown", opts));
    await sleep(60 + Math.random() * 90);
    target.dispatchEvent(new PointerEvent("pointerup", { ...opts, pointerType: "mouse", isPrimary: true }));
    target.dispatchEvent(new MouseEvent("mouseup", opts));
    target.dispatchEvent(new MouseEvent("click", opts));
    return { ok: true };
  }

  // The detail pane: climb from the "About the job" heading to the first ancestor holding an apply control.
  function pane(id) {
    const u = new URL(location.href);
    if (u.searchParams.get("currentJobId") !== id && !location.pathname.includes(`/jobs/view/${id}`)) return null;
    const head = [...document.querySelectorAll("h1,h2,h3,h4,span,p,div")]
      .find((e) => e.childElementCount === 0 && /^about the job$/i.test((e.innerText || "").trim()));
    if (!head) return null;
    const isApply = (e) => /\bapply\b/i.test(label(e));
    let p = head;
    while (p.parentElement && ![...p.querySelectorAll("a,button")].some(isApply)) p = p.parentElement;
    const controls = [...p.querySelectorAll("a,button")].filter(isApply);
    const ext = controls.find((e) => e.tagName === "A" && (/company website/i.test(label(e)) || /\/safety\/go\//.test(e.href)));
    const easy = controls.some((e) => /easy apply/i.test(label(e)));
    const other = controls.find((e) => !/easy apply/i.test(label(e)));
    return {
      ext: ext ? ext.href : null, easy, hasApply: !!other,
      text: (p.innerText || "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 15000),
    };
  }

  window.__jobLinkedIn = { cards, noResults, open, pane };
})();
