// Injected into every frame of the application tab by the side panel (chrome.scripting, allFrames).
// Reads the form as a list of questions and fills in answers. It never submits anything.
// Elements stay in this frame: the panel only ever sees field ids ("f1", "f2", ...).
(() => {
  if (window.__jobApplier) return;

  const OPTION_SEL = "[role=option], [role=menuitem], [role=menuitemradio], [role=treeitem], li[id*=option], div[id*=-option-]";
  const TEXT_TYPES = new Set(["text", "email", "tel", "url", "number", "date", "month", "datetime-local", "time", ""]);
  const SKIP_TYPES = new Set(["hidden", "submit", "button", "reset", "image", "password", "search", "range", "color"]);
  const state = { fields: new Map(), n: 0 };

  // ---- helpers ------------------------------------------------------------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (s, max = 400) => {
    s = (s || "").replace(/\s+/g, " ").trim();
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
  };
  const norm = (s) => clean(s, 2000).toLowerCase().replace(/[\s*:?]+$/, "").replace(/^[\s*]+/, "");
  const isRequiredText = (s) => /[*✱]\s*$|[*✱]\s*\n|\(required\)|\brequired\b\s*$/i.test((s || "").trim());
  const stripMarks = (s) => clean((s || "").replace(/\s*[*✱]\s*/g, " ").replace(/\s*\(required\)\s*$/i, "")
    .replace(/\s*(select|choose)\s*(an option|one)?\s*\.\.\.?\s*$/i, ""));
  const GENERIC = /^(attach|upload|browse|choose( a)? file|select( a)? file|add( a)? file|drop .*|enter manually|or)$/i;

  const shown = (el) => {
    if (!el || !el.isConnected) return false;
    const st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden" || +st.opacity === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  const disabled = (el) => el.disabled || el.getAttribute("aria-disabled") === "true";

  // every element, including inside open shadow roots
  const allElements = (root = document) => {
    const out = [];
    const walk = (r) => {
      for (const el of r.querySelectorAll("*")) {
        out.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(root);
    return out;
  };
  const byId = (el, id) => (el.getRootNode().getElementById ? el.getRootNode().getElementById(id) : document.getElementById(id));
  const textOfIds = (el, ids) => clean((ids || "").split(/\s+/).map((id) => byId(el, id)).filter(Boolean)
    .map((e) => e.innerText || e.textContent).join(" "));
  const isControl = (el) => el.matches("input:not([type=hidden]), textarea, select, [role=combobox], [role=radio], [role=checkbox], [contenteditable=true]");
  const hasControl = (el) => isControl(el) || !!el.querySelector("input:not([type=hidden]), textarea, select, [role=combobox], [contenteditable=true]");

  // visible label text, without the text of a control it wraps (a <select>'s options, a listbox)
  const labelText = (label, el) => {
    let t = label.innerText || "";
    for (const c of label.querySelectorAll("select, [role=listbox], textarea")) {
      const inner = c.innerText || c.textContent || "";
      if (inner.trim()) t = t.replace(inner, " ");
    }
    return t;
  };

  // The text before a field in its surroundings: the question for unlabelled inputs and custom groups.
  // Climbs only while the enclosing block holds nothing but this field's own controls (`own`), so it never
  // reaches another question, page tabs or headers. Of consecutive text blocks ("Question*" then "Help
  // text"), the first is the question and the rest is help.
  const CTRL = "input:not([type=hidden]), textarea, select, [role=combobox], [role=radio], [role=checkbox], [role=switch], [contenteditable=true]";
  const nearby = (el, own = [el]) => {
    const ours = (c) => own.some((o) => o === c || o.contains(c) || c.contains(o));
    const controls = (n) => (n.matches(CTRL) ? [n] : [...n.querySelectorAll(CTRL)]);
    const onlyOurs = (n) => controls(n).every(ours);
    let node = el;
    let mixed = 0;
    for (let depth = 0; node && depth < 8; depth++) {
      const texts = [];
      for (let sib = node.previousSibling, k = 0; sib && k < 6; sib = sib.previousSibling, k++) {
        if (sib.nodeType === Node.TEXT_NODE) {
          const t = clean(sib.textContent);
          if (t) texts.unshift(t);
          continue;
        }
        if (sib.nodeType !== Node.ELEMENT_NODE || !shown(sib)) continue;
        if (!onlyOurs(sib)) break; // the previous question
        if (controls(sib).length) continue; // another option of this same field
        const t = sib.innerText || "";
        if (clean(t) && !GENERIC.test(clean(t))) texts.unshift(t);
      }
      if (texts.length) return { text: clean(texts[0], 600), help: clean(texts.slice(1).join(" "), 400) };
      const parent = node.parentElement;
      if (!parent) break;
      if (!onlyOurs(parent)) { // a row like [salary][currency]: climb only if ours comes first, and not far
        const first = parent.querySelector(CTRL);
        if (!first || !ours(first) || ++mixed > 2) break;
      }
      node = parent;
    }
    return { text: precedingText(el, own), help: "" };
  };

  // Fallback: the text between the previous control on the page and this one (usually "Question*").
  const precedingText = (el, own) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    walker.currentNode = el;
    const parts = [];
    let size = 0;
    while (walker.previousNode() && size < 600) {
      const n = walker.currentNode;
      if (n.nodeType === Node.ELEMENT_NODE) {
        if (n.matches(CTRL) && !own.some((o) => o === n || o.contains(n) || n.contains(o))) break;
        continue;
      }
      const parent = n.parentElement;
      if (!parent || parent.closest("script, style, noscript, [aria-hidden=true]") || !shown(parent)) continue;
      if (own.some((o) => o.contains(n) || (o.labels && [...o.labels].some((l) => l.contains(n))))) continue;
      const t = clean(n.textContent);
      if (t) { parts.unshift(t); size += t.length; }
    }
    return clean(parts.join(" "), 600);
  };
  const nearbyText = (el) => nearby(el).text;

  const rawLabel = (el) => {
    const lb = el.getAttribute("aria-labelledby");
    if (lb) { const t = textOfIds(el, lb); if (t) return t; }
    if (el.labels && el.labels.length) {
      const t = clean([...el.labels].map((l) => labelText(l, el)).join(" "));
      if (t) return t;
    }
    const wrap = el.closest("label");
    if (wrap) { const t = clean(labelText(wrap, el)); if (t) return t; }
    const al = el.getAttribute("aria-label");
    if (al && clean(al)) return clean(al);
    const near = nearbyText(el);
    if (near) return near;
    const group = el.closest("[role=group][aria-labelledby], fieldset");
    if (group && group !== el) { const t = groupLabel(group, [el]); if (t) return t; }
    for (const a of ["placeholder", "title", "name", "id"]) {
      const v = el.getAttribute(a);
      if (v && clean(v)) return clean(v.replace(/[_\-[\]]+/g, " "));
    }
    return "";
  };

  // the question a group of options (or an upload widget) answers; `items` are its controls
  const groupLabel = (container, items) => {
    if (container) {
      const legend = container.matches("fieldset") ? container.querySelector("legend") : null;
      if (legend && clean(legend.innerText)) return clean(legend.innerText);
      const lb = container.getAttribute("aria-labelledby");
      if (lb) { const t = textOfIds(container, lb); if (t) return t; }
      const al = container.getAttribute("aria-label");
      if (al && clean(al)) return clean(al);
    }
    return nearby(items[0], items).text;
  };

  const optionLabel = (el) => {
    if (el.tagName === "INPUT") {
      if (el.labels && el.labels.length) return clean([...el.labels].map((l) => labelText(l, el)).join(" "));
      const wrap = el.closest("label");
      if (wrap) return clean(labelText(wrap, el));
      const al = el.getAttribute("aria-label");
      if (al) return clean(al);
      for (let n = el, i = 0; n && i < 3; n = n.parentElement, i++) { // label text next to a styled box
        const next = n.nextElementSibling;
        if (next && !next.matches(CTRL) && !next.querySelector(CTRL) && clean(next.innerText)) return clean(next.innerText);
      }
      return el.value && el.value !== "on" ? clean(el.value) : "";
    }
    return clean(el.getAttribute("aria-label") || el.innerText);
  };

  // help text under a question that was labelled from its surroundings
  const helpNear = (el) => (el.labels && el.labels.length) || el.getAttribute("aria-label") ? "" : nearby(el).help;
  const describedBy = (el) => textOfIds(el, el.getAttribute("aria-describedby"));

  let headings = [];
  const sectionOf = (el) => {
    let best = "";
    for (const h of headings) {
      if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) best = h; else break;
    }
    return best ? clean(best.innerText, 120) : "";
  };

  const sensitive = (el) => /^cc-|password/i.test(el.getAttribute("autocomplete") || "")
    || /card.?num|cvv|cvc|iban|sort.?code|password/i.test(`${el.name} ${el.id}`);
  const outsideForm = (el) => !!el.closest("nav, header [role=search], [role=search], [role=navigation], [aria-hidden=true], [inert]");

  // ---- options of custom dropdowns ------------------------------------------------------
  const visibleOptions = (el) => {
    const owned = el && (el.getAttribute("aria-controls") || el.getAttribute("aria-owns"));
    const list = owned && byId(el, owned.split(/\s+/)[0]);
    const scope = list && shown(list) ? [list] : [document, ...[...allShadowRoots()]];
    const out = [];
    for (const root of scope) for (const o of root.querySelectorAll(OPTION_SEL)) if (shown(o) && clean(o.innerText)) out.push(o);
    return out;
  };
  function* allShadowRoots() {
    for (const el of document.querySelectorAll("*")) if (el.shadowRoot) yield el.shadowRoot;
  }

  const fire = (el, type, init = {}) => {
    const r = el.getBoundingClientRect();
    const xy = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true, composed: true, view: window, button: 0 };
    const C = type.startsWith("pointer") ? PointerEvent : MouseEvent;
    el.dispatchEvent(new C(type, { ...xy, ...init }));
  };
  const press = (el) => {
    el.scrollIntoView({ block: "center", inline: "nearest" });
    for (const t of ["pointerover", "pointerenter", "mouseover", "pointerdown", "mousedown"]) fire(el, t);
    if (el.focus) el.focus({ preventScroll: true });
    for (const t of ["pointerup", "mouseup", "click"]) fire(el, t);
  };
  const escape = (el) => {
    const opts = { key: "Escape", code: "Escape", keyCode: 27, bubbles: true, cancelable: true, composed: true };
    (el || document.activeElement || document.body).dispatchEvent(new KeyboardEvent("keydown", opts));
    (el || document.activeElement || document.body).dispatchEvent(new KeyboardEvent("keyup", opts));
  };

  const readComboOptions = async (el) => {
    let opts = visibleOptions(el);
    if (!opts.length) {
      press(el);
      await sleep(350);
      opts = visibleOptions(el);
      escape(el);
      if (el.blur) el.blur();
      await sleep(80);
    }
    return [...new Set(opts.map((o) => clean(o.innerText, 150)))].slice(0, 150);
  };

  // what a custom dropdown shows as selected (react-select keeps it next to the input, not in it)
  const PLACEHOLDER = /^(select|choose|start typing|search|type)\b.*$|^$/i;
  const comboValue = (el) => {
    if (el.tagName === "INPUT" && el.value) return el.value;
    let p = el.tagName === "INPUT" ? el.parentElement : el;
    for (let i = 0; p && i < 3; i++, p = p.parentElement) {
      if (p.querySelector("label, h1, h2, h3, h4") || p.querySelectorAll("input, select, textarea, button").length > 2) break;
      const t = clean(p.innerText, 200);
      if (t) return PLACEHOLDER.test(t) ? "" : t;
    }
    return "";
  };

  // ---- scan -----------------------------------------------------------------------------
  const add = (out, rec, info) => {
    const id = `f${++state.n}`;
    state.fields.set(id, rec);
    const label = stripMarks(info.label);
    const f = { id, kind: rec.kind, label, required: !!info.required || isRequiredText(info.label) };
    if (info.options && info.options.length) f.options = info.options;
    if (info.value) f.value = clean(info.value, 300);
    const anchor = rec.el || rec.options[0].el;
    const help = (rec.el ? describedBy(rec.el) : "") || info.help || "";
    if (help && help !== label) f.help = help;
    const section = sectionOf(anchor);
    if (section && section !== label) f.section = section;
    if (rec.el && rec.el.placeholder) f.placeholder = clean(rec.el.placeholder, 100);
    if (rec.el && rec.el.maxLength > 0) f.max_length = rec.el.maxLength;
    if (rec.el && rec.el.accept) f.accept = rec.el.accept;
    out.push(f);
  };

  async function scan() {
    state.fields.clear();
    state.n = 0;
    const els = allElements();
    headings = els.filter((e) => /^H[1-4]$/.test(e.tagName) && shown(e));
    const out = [];
    const done = new Set();
    const groups = new Map(); // radios/checkboxes that belong together, in page order

    const groupKey = (el) => {
      if (el.tagName === "INPUT" && el.name) return `${el.form ? "form" : "page"}:${el.type}:${el.name}`;
      return el.closest("[role=radiogroup], [role=group], fieldset") || el.parentElement?.parentElement;
    };

    for (const el of els) {
      if (done.has(el) || outsideForm(el) || sensitive(el)) continue;
      const tag = el.tagName;
      const role = el.getAttribute("role");
      const type = (el.getAttribute("type") || "").toLowerCase();

      if (tag === "INPUT" && type === "file") {
        done.add(el);
        let label = rawLabel(el);
        if (!label || GENERIC.test(label)) { // "Attach": the question is the upload widget's heading
          const box = el.closest("[role=group], fieldset") || el.parentElement?.parentElement?.parentElement;
          label = groupLabel(box, [el]) || label || "file upload";
        }
        add(out, { kind: "file", el }, { label, required: el.required || el.getAttribute("aria-required") === "true",
          value: el.files && el.files.length ? [...el.files].map((f) => f.name).join(", ") : "" });
        continue;
      }
      if (tag === "INPUT" && (type === "radio" || type === "checkbox")) {
        const vis = shown(el) || [...(el.labels || [])].some(shown) || shown(el.parentElement);
        if (!vis || disabled(el)) continue;
        const k = groupKey(el);
        if (!groups.has(k)) groups.set(k, { type, items: [] });
        groups.get(k).items.push(el);
        done.add(el);
        continue;
      }
      if ((role === "radio" || role === "checkbox" || role === "switch") && tag !== "INPUT") {
        if (!shown(el) || disabled(el)) continue;
        const k = el.closest("[role=radiogroup], [role=group]") || el.parentElement;
        const t = role === "radio" ? "radio" : "checkbox";
        if (!groups.has(k)) groups.set(k, { type: t, items: [] });
        groups.get(k).items.push(el);
        done.add(el);
        continue;
      }
      // Yes / No answered with two buttons (no radio inputs behind them)
      if (tag === "BUTTON" && /^(yes|no)$/i.test(clean(el.innerText)) && shown(el)) {
        const sibs = [...el.parentElement.querySelectorAll(":scope > button, :scope > * > button")].filter((b) => /^(yes|no)$/i.test(clean(b.innerText)));
        if (sibs.length === 2) {
          sibs.forEach((b) => done.add(b));
          const label = groupLabel(null, sibs);
          add(out, { kind: "radio", options: sibs.map((b) => ({ el: b, label: clean(b.innerText) })) },
            { label, options: sibs.map((b) => clean(b.innerText)),
              value: clean(sibs.find((b) => b.getAttribute("aria-pressed") === "true" || b.getAttribute("aria-checked") === "true")?.innerText || "") });
          continue;
        }
      }

      const comboish = role === "combobox" || (tag === "BUTTON" && el.getAttribute("aria-haspopup") === "listbox")
        || (tag === "INPUT" && (el.getAttribute("aria-autocomplete") === "list" || el.getAttribute("aria-haspopup") === "listbox"));
      if (comboish) {
        if (!shown(el) || disabled(el)) continue;
        done.add(el);
        el.querySelectorAll("input").forEach((i) => done.add(i));
        const label = rawLabel(el);
        add(out, { kind: "combobox", el }, { label, help: helpNear(el), required: el.getAttribute("aria-required") === "true" || el.required,
          options: await readComboOptions(el), value: comboValue(el) });
        continue;
      }
      if (tag === "SELECT") {
        if (!shown(el) || disabled(el)) continue;
        done.add(el);
        const opts = [...el.options].filter((o, i) => !(i === 0 && (!o.value || /^(select|choose|please|--)/i.test(o.text))))
          .map((o) => clean(o.label || o.text, 150));
        const sel = el.selectedOptions[0];
        add(out, { kind: el.multiple ? "multiselect" : "select", el }, { label: rawLabel(el), required: el.required,
          options: opts, value: sel && sel.value ? clean(sel.label || sel.text) : "" });
        continue;
      }
      if ((tag === "INPUT" && TEXT_TYPES.has(type) && !SKIP_TYPES.has(type)) || tag === "TEXTAREA") {
        if (!shown(el) || disabled(el) || el.readOnly) continue;
        done.add(el);
        const kind = tag === "TEXTAREA" ? "textarea" : type && type !== "text" ? type : "text";
        add(out, { kind, el }, { label: rawLabel(el), required: el.required || el.getAttribute("aria-required") === "true",
          value: el.value, help: helpNear(el) });
        continue;
      }
      if (el.isContentEditable && el.getAttribute("contenteditable") !== null && !el.parentElement?.isContentEditable) {
        if (!shown(el)) continue;
        done.add(el);
        add(out, { kind: "richtext", el }, { label: rawLabel(el), value: el.innerText });
      }
    }

    for (const [key, g] of groups) {
      const items = g.items;
      const container = key instanceof Element ? key : items[0].closest("fieldset, [role=radiogroup], [role=group]") || commonAncestor(items);
      const required = items.some((i) => i.required || i.getAttribute("aria-required") === "true")
        || container?.getAttribute?.("aria-required") === "true";
      if (g.type === "checkbox" && items.length === 1) { // a lone checkbox: consent, "I agree", ...
        const el = items[0];
        const own = optionLabel(el);
        const q = groupLabel(container instanceof Element && container.matches("fieldset, [role=group], [role=radiogroup]") ? container : null, [el]);
        const label = own && q && own !== q && q.length < 300 ? `${q} — ${own}` : own || q;
        add(out, { kind: "checkbox", el }, { label, required, value: checked(el) ? "checked" : "unchecked" });
        continue;
      }
      const options = items.map((el) => ({ el, label: optionLabel(el) }));
      add(out, { kind: g.type === "radio" ? "radio" : "checkboxes", options },
        { label: groupLabel(container instanceof Element && container.matches("fieldset, [role=group], [role=radiogroup]") ? container : null, items),
          help: nearby(items[0], items).help, required,
          options: options.map((o) => o.label), value: options.filter((o) => checked(o.el)).map((o) => o.label).join(" | ") });
    }
    return { fields: out, page: pageInfo() };
  }

  const commonAncestor = (els) => {
    let a = els[0].parentElement;
    while (a && !els.every((e) => a.contains(e))) a = a.parentElement;
    return a;
  };
  const checked = (el) => el.tagName === "INPUT" ? el.checked
    : el.getAttribute("aria-checked") === "true" || el.getAttribute("aria-pressed") === "true";

  function pageInfo() {
    return { url: location.href, title: document.title, top: window === window.top,
      text: clean(document.body ? document.body.innerText : "", 8000) };
  }

  // ---- fill -----------------------------------------------------------------------------
  const setNative = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  };
  const typeText = (el, value) => {
    el.scrollIntoView({ block: "center" });
    el.focus({ preventScroll: true });
    if (el.isContentEditable) {
      document.execCommand("selectAll");
      document.execCommand("insertText", false, value);
    } else {
      setNative(el, value);
    }
    el.dispatchEvent(new FocusEvent("blur", { bubbles: false }));
    el.dispatchEvent(new FocusEvent("focusout", { bubbles: true, composed: true }));
  };
  // exact, then whole-word prefix either way, then whole-word containment ("No" must not match "Not applicable")
  const best = (items, want, text = (x) => x.label) => {
    const w = norm(want);
    if (!w) return undefined;
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const word = (hay, needle) => needle && new RegExp(`(^|\\W)${esc(needle)}($|\\W)`).test(hay);
    return items.find((i) => norm(text(i)) === w)
      || items.find((i) => norm(text(i)).startsWith(w) && word(norm(text(i)), w))
      || items.find((i) => w.startsWith(norm(text(i))) && word(w, norm(text(i))))
      || items.find((i) => word(norm(text(i)), w));
  };
  const waitFor = async (fn, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(120); }
    return fn();
  };
  // styled radios/checkboxes hide the real input: click its label instead
  const clickTarget = (el) => el.tagName === "INPUT" && !shown(el) ? (el.labels?.[0] || el.closest("label") || el.parentElement) : el;
  const mark = (rec, ok) => {
    for (const el of rec.el ? [rec.el] : rec.options.map((o) => o.el)) {
      const target = el.tagName === "INPUT" && (el.type === "radio" || el.type === "checkbox" || el.type === "file") && !shown(el)
        ? (el.labels?.[0] || el.parentElement) : el;
      if (target && target.style) { target.style.outline = `2px solid ${ok ? "#40a02b" : "#df8e1d"}`; target.style.outlineOffset = "2px"; }
    }
  };

  async function chooseCombo(el, want) {
    press(el);
    await sleep(250);
    let opt = best(visibleOptions(el), want, (o) => o.innerText);
    const input = el.tagName === "INPUT" ? el : el.querySelector("input");
    if (!opt && input) {
      setNative(input, want);
      opt = await waitFor(() => best(visibleOptions(el), want, (o) => o.innerText), 4000);
    }
    if (!opt) { escape(el); return { ok: false, error: `no option matching "${want}"` }; }
    press(opt);
    await sleep(250);
    return { ok: true, value: clean(opt.innerText, 150) };
  }

  async function fill(id, answer, file) {
    const rec = state.fields.get(id);
    if (!rec) return { ok: false, error: "field is gone (page changed): rescan" };
    try {
      const r = await fillOne(rec, answer, file);
      mark(rec, r.ok);
      return r;
    } catch (e) {
      mark(rec, false);
      return { ok: false, error: String(e && e.message || e) };
    }
  }

  async function fillOne(rec, a, file) {
    const el = rec.el;
    const choice = (a.choices && a.choices[0]) || a.value || "";
    switch (rec.kind) {
      case "file": {
        if (!file) return { ok: false, error: "no file" };
        const bytes = Uint8Array.from(atob(file.b64), (c) => c.charCodeAt(0));
        const f = new File([bytes], file.name, { type: file.type || "application/pdf" });
        const dt = new DataTransfer();
        dt.items.add(f);
        el.files = dt.files;
        el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
        if (el.files.length) return { ok: true, value: file.name };
        for (let p = el.parentElement, i = 0; p && i < 4; p = p.parentElement, i++) { // dropzone-only widgets
          for (const t of ["dragenter", "dragover", "drop"]) p.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt }));
        }
        return { ok: true, value: `${file.name} (dropped; check it attached)` };
      }
      case "select": case "multiselect": {
        const want = a.choices && a.choices.length ? a.choices : [choice];
        const opts = [...el.options].map((o) => ({ o, label: o.label || o.text }));
        const hits = want.map((w) => best(opts, w)).filter(Boolean);
        if (!hits.length) return { ok: false, error: `no option matching "${want[0]}"` };
        el.scrollIntoView({ block: "center" });
        if (el.multiple) { for (const o of el.options) o.selected = hits.some((h) => h.o === o); el.dispatchEvent(new Event("change", { bubbles: true })); }
        else setNative(el, hits[0].o.value);
        return { ok: true, value: hits.map((h) => clean(h.label)).join(" | ") };
      }
      case "radio": case "checkboxes": {
        const want = a.choices && a.choices.length ? a.choices : [choice];
        const picks = want.map((w) => best(rec.options, w)).filter(Boolean);
        if (!picks.length) return { ok: false, error: `no option matching "${want[0]}"` };
        const flips = rec.kind === "radio" ? picks.slice(0, 1).filter((o) => !checked(o.el))
          : rec.options.filter((o) => picks.includes(o) !== checked(o.el));
        for (const o of flips) {
          press(clickTarget(o.el));
          await sleep(120);
        }
        const inputs = picks.filter((o) => o.el.tagName === "INPUT");
        if (inputs.some((o) => !o.el.checked)) return { ok: false, error: "the option didn't get selected" };
        return { ok: true, value: picks.map((p) => p.label).join(" | ") };
      }
      case "checkbox": {
        const want = /^(yes|true|checked|tick)$/i.test(a.value || choice);
        if (checked(el) !== want) {
          press(clickTarget(el));
          await sleep(120);
        }
        return { ok: checked(el) === want, value: checked(el) ? "checked" : "unchecked",
          error: checked(el) === want ? undefined : "checkbox didn't change" };
      }
      case "combobox":
        return chooseCombo(el, choice);
      default: { // text-like
        const value = a.value || choice;
        typeText(el, value);
        await sleep(60);
        const got = el.isContentEditable ? el.innerText : el.value;
        if (norm(got) !== norm(value) && !(el.type === "number" && +got === +value)) {
          return { ok: false, value: got, error: "the page didn't keep the value" };
        }
        return { ok: true, value: clean(got, 300) };
      }
    }
  }

  function focusField(id) {
    const rec = state.fields.get(id);
    const el = rec && (rec.el || rec.options[0].el);
    if (!el) return false;
    const target = shown(el) ? el : el.labels?.[0] || el.parentElement;
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    if (target.focus) target.focus({ preventScroll: true });
    return true;
  }

  window.__jobApplier = { scan, fill, focusField, pageInfo };
})();
