(() => {
  'use strict';

  const STORAGE_EMPLOYEES = 'belegsplit_employees_v1';
  const STORAGE_RECEIPTS = 'belegsplit_receipts_v1';
  const TESSERACT_SRC = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
  // Pinned to the last pdfjs-dist release with a classic (non-module) UMD
  // build (window.pdfjsLib via a plain <script> tag) — v4+ ships ES modules
  // only, and loading those via dynamic import() of a cross-origin URL runs
  // into MIME-type/CORS module-loading quirks that plain <script> tags (the
  // same approach already used for Tesseract) don't have.
  const PDFJS_SRC = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js';
  const PDFJS_WORKER_SRC = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
  const COLORS = ['#fbbf24', '#38bdf8', '#f472b6', '#4ade80', '#a78bfa', '#fb923c', '#22d3ee', '#f87171'];

  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // ---------- Storage ----------
  function loadEmployees() {
    try {
      const raw = localStorage.getItem(STORAGE_EMPLOYEES);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  }
  function saveEmployees() { localStorage.setItem(STORAGE_EMPLOYEES, JSON.stringify(employees)); }

  function loadReceipts() {
    try {
      const raw = localStorage.getItem(STORAGE_RECEIPTS);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  }
  function saveReceipts() { localStorage.setItem(STORAGE_RECEIPTS, JSON.stringify(receipts)); }

  let employees = loadEmployees();
  let receipts = loadReceipts();

  const state = {
    view: 'start',
    filterReceiptId: null,
    assignStatusFilter: 'offen',
    selection: new Set()
  };

  // Transient review session (not persisted until "Übernehmen")
  let reviewRows = null;
  let reviewPhotoUrl = null;
  let editingItemId = null;

  // ---------- Formatting ----------
  const currencyFmt = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
  const dateFmt = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  function fmtMoney(n) { return currencyFmt.format(n || 0); }

  // ---------- Helpers ----------
  function employeeById(id) { return employees.find(e => e.id === id) || null; }
  function receiptById(id) { return receipts.find(r => r.id === id) || null; }
  function nextColor() { return COLORS[employees.length % COLORS.length]; }

  function allItemsFlat() {
    const out = [];
    for (const r of receipts) {
      for (const it of r.items) out.push({ item: it, receiptId: r.id, receiptDate: r.createdAt });
    }
    out.sort((a, b) => b.receiptDate - a.receiptDate);
    return out;
  }

  function receiptTotal(r) { return r.items.reduce((s, i) => s + i.price, 0); }
  function receiptOpenCount(r) { return r.items.filter(i => !i.assignedTo).length; }

  function initials(name) {
    return name.trim().slice(0, 2).toUpperCase();
  }

  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), 2200);
  }

  // ---------- View switching ----------
  function switchView(view) {
    state.view = view;
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-' + view).classList.add('active');
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    const titles = { start: 'Belege', assign: 'Zuordnen', summary: 'Übersicht', settings: 'Einstellungen' };
    document.getElementById('topbar-title').textContent = titles[view] || 'Belege';
    if (view !== 'assign') {
      state.selection.clear();
      updateSelectBar();
    }
    renderAll();
  }

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  // ---------- RENDER: Start (receipt list) ----------
  function renderStart() {
    const list = document.getElementById('receipt-list');
    const sorted = [...receipts].sort((a, b) => {
      if (!!a.paid !== !!b.paid) return a.paid ? 1 : -1;
      return b.createdAt - a.createdAt;
    });
    if (sorted.length === 0) {
      list.innerHTML = '<div class="empty-hint">Noch keine Belege erfasst</div>';
      return;
    }
    list.innerHTML = '';
    for (const r of sorted) {
      const row = document.createElement('div');
      row.className = 'entry-row clickable' + (r.paid ? ' paid' : '');
      const open = receiptOpenCount(r);
      row.innerHTML = `
        <button class="receipt-paid-check ${r.paid ? 'checked' : ''}" type="button" aria-label="Beleg als bezahlt markieren">✓</button>
        <div class="entry-main">
          <div class="entry-date">${dateFmt.format(new Date(r.createdAt))}</div>
          <div class="entry-time">${r.items.length} Artikel</div>
          <span class="badge ${open > 0 ? 'open' : 'done'}">${open > 0 ? open + ' offen' : 'fertig zugeordnet'}</span>
          ${r.paid ? '<span class="badge paid">bezahlt</span>' : ''}
        </div>
        <div class="entry-total-wrap">
          <div class="entry-total">${fmtMoney(receiptTotal(r))}</div>
        </div>
        <div class="entry-chevron">›</div>
      `;
      row.querySelector('.receipt-paid-check').addEventListener('click', (e) => {
        e.stopPropagation();
        r.paid = !r.paid;
        saveReceipts();
        renderStart();
      });
      row.addEventListener('click', () => {
        state.filterReceiptId = r.id;
        switchView('assign');
      });
      list.appendChild(row);
    }
  }

  // ---------- RENDER: Assign (Zuordnen) ----------
  function renderAssign() {
    const filterRow = document.getElementById('assign-filter-receipt');
    if (state.filterReceiptId) {
      const r = receiptById(state.filterReceiptId);
      if (r) {
        filterRow.hidden = false;
        document.getElementById('assign-filter-label').textContent = 'Beleg vom ' + dateFmt.format(new Date(r.createdAt));
      } else {
        state.filterReceiptId = null;
        filterRow.hidden = true;
      }
    } else {
      filterRow.hidden = true;
    }

    document.querySelectorAll('#assign-status-switch .segmented-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.status === state.assignStatusFilter);
    });

    let items = allItemsFlat();
    if (state.filterReceiptId) items = items.filter(x => x.receiptId === state.filterReceiptId);
    if (state.assignStatusFilter === 'offen') items = items.filter(x => !x.item.assignedTo);
    else if (state.assignStatusFilter === 'zugeordnet') items = items.filter(x => x.item.assignedTo);

    const list = document.getElementById('assign-list');
    if (items.length === 0) {
      list.innerHTML = '<div class="empty-hint">Keine Artikel vorhanden</div>';
      updateSelectBar();
      return;
    }
    list.innerHTML = '';
    for (const { item, receiptId } of items) {
      const row = document.createElement('div');
      row.className = 'item-row' + (state.selection.has(item.id) ? ' selected' : '');
      const emp = item.assignedTo ? employeeById(item.assignedTo) : null;
      row.innerHTML = `
        <div class="item-check">✓</div>
        <div class="item-main">
          <div class="item-name"></div>
        </div>
        <div class="item-right">
          <div class="item-price">${fmtMoney(item.price)}</div>
          <div class="assign-badge ${emp ? '' : 'unassigned'}">
            ${emp ? `<span class="avatar-dot" style="background:${emp.color}">${initials(emp.name)}</span><span>${emp.name}</span>` : '<span>nicht zugeordnet</span>'}
          </div>
        </div>
        <button class="item-edit-btn" type="button" aria-label="Bearbeiten">✎</button>
      `;
      row.querySelector('.item-name').textContent = item.name;
      row.addEventListener('click', () => {
        if (state.selection.has(item.id)) state.selection.delete(item.id);
        else state.selection.add(item.id);
        renderAssign();
      });
      row.querySelector('.item-edit-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        openItemEditSheet(item.id);
      });
      row.dataset.itemId = item.id;
      row.dataset.receiptId = receiptId;
      list.appendChild(row);
    }
    updateSelectBar();
  }

  function updateSelectBar() {
    const bar = document.getElementById('select-bar');
    const n = state.selection.size;
    if (n > 0 && state.view === 'assign') {
      bar.classList.add('active');
      document.getElementById('select-count').textContent = n + (n === 1 ? ' ausgewählt' : ' ausgewählt');
    } else {
      bar.classList.remove('active');
    }
  }

  document.getElementById('assign-filter-clear').addEventListener('click', () => {
    state.filterReceiptId = null;
    renderAssign();
  });

  document.querySelectorAll('#assign-status-switch .segmented-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.assignStatusFilter = btn.dataset.status;
      renderAssign();
    });
  });

  document.getElementById('btn-clear-selection').addEventListener('click', () => {
    state.selection.clear();
    renderAssign();
  });

  // ---------- Assign sheet ----------
  function findItemById(itemId) {
    for (const r of receipts) {
      const it = r.items.find(i => i.id === itemId);
      if (it) return { item: it, receipt: r };
    }
    return null;
  }

  function openAssignSheet() {
    if (state.selection.size === 0) return;
    const grid = document.getElementById('assign-sheet-employees');
    document.getElementById('assign-sheet-title').textContent =
      state.selection.size === 1 ? 'Artikel zuweisen' : state.selection.size + ' Artikel zuweisen';
    grid.innerHTML = '';
    if (employees.length === 0) {
      const hint = document.createElement('div');
      hint.className = 'empty-hint';
      hint.style.padding = '10px 0';
      hint.textContent = 'Noch keine Personen angelegt. Lege sie zuerst in den Einstellungen an.';
      grid.appendChild(hint);
    }
    for (const emp of employees) {
      const chip = document.createElement('button');
      chip.className = 'employee-chip';
      chip.innerHTML = `<span class="avatar-dot" style="background:${emp.color}">${initials(emp.name)}</span><span>${emp.name}</span>`;
      chip.addEventListener('click', () => {
        for (const id of state.selection) {
          const found = findItemById(id);
          if (found) found.item.assignedTo = emp.id;
        }
        saveReceipts();
        state.selection.clear();
        closeAssignSheet();
        renderAll();
        toast('Zugeordnet zu ' + emp.name);
      });
      grid.appendChild(chip);
    }
    document.getElementById('assign-sheet-backdrop').classList.add('active');
  }
  function closeAssignSheet() {
    document.getElementById('assign-sheet-backdrop').classList.remove('active');
  }

  document.getElementById('btn-open-assign-sheet').addEventListener('click', openAssignSheet);
  document.getElementById('assign-sheet-cancel').addEventListener('click', closeAssignSheet);
  document.getElementById('assign-sheet-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'assign-sheet-backdrop') closeAssignSheet();
  });
  document.getElementById('assign-sheet-unassign').addEventListener('click', () => {
    for (const id of state.selection) {
      const found = findItemById(id);
      if (found) found.item.assignedTo = null;
    }
    saveReceipts();
    state.selection.clear();
    closeAssignSheet();
    renderAll();
    toast('Zuordnung entfernt');
  });

  // ---------- RENDER: Summary ----------
  function renderSummary() {
    const list = document.getElementById('summary-list');
    if (employees.length === 0) {
      list.innerHTML = '<div class="empty-hint">Noch keine Personen angelegt. Lege sie in den Einstellungen an.</div>';
    } else {
      list.innerHTML = '';
      const flat = allItemsFlat();
      for (const emp of employees) {
        const own = flat.filter(x => x.item.assignedTo === emp.id);
        const total = own.reduce((s, x) => s + x.item.price, 0);
        const paidTotal = own.filter(x => x.item.paid).reduce((s, x) => s + x.item.price, 0);
        const card = document.createElement('div');
        card.className = 'summary-card';
        card.innerHTML = `
          <div class="summary-card-header">
            <span class="avatar-dot" style="background:${emp.color}">${initials(emp.name)}</span>
            <span class="name"></span>
            <span class="count">${own.length} Artikel</span>
            <span class="total">${fmtMoney(total)}</span>
          </div>
          ${paidTotal > 0 ? `<div class="summary-paid-note">davon bezahlt: ${fmtMoney(paidTotal)}</div>` : ''}
          ${own.length ? `<div class="summary-card-items">${own.map(x => `
            <div class="summary-item-line${x.item.paid ? ' paid' : ''}" data-item-id="${x.item.id}">
              <button class="summary-item-check${x.item.paid ? ' checked' : ''}" type="button" aria-label="Artikel als bezahlt markieren">✓</button>
              <span class="summary-item-name"></span>
              <span class="summary-item-price">${fmtMoney(x.item.price)}</span>
            </div>`).join('')}</div>` : ''}
        `;
        card.querySelector('.name').textContent = emp.name;
        if (own.length) {
          card.querySelectorAll('.summary-item-name').forEach((el, idx) => { el.textContent = own[idx].item.name; });
          card.querySelectorAll('.summary-item-line').forEach((lineEl) => {
            const itemId = lineEl.dataset.itemId;
            lineEl.querySelector('.summary-item-check').addEventListener('click', () => {
              const found = findItemById(itemId);
              if (found) {
                found.item.paid = !found.item.paid;
                saveReceipts();
                renderAll();
              }
            });
          });
        }
        list.appendChild(card);
      }
    }

    const flat = allItemsFlat();
    const unassigned = flat.filter(x => !x.item.assignedTo);
    const unassignedTotal = unassigned.reduce((s, x) => s + x.item.price, 0);
    const box = document.getElementById('summary-unassigned');
    if (unassigned.length > 0) {
      box.hidden = false;
      document.getElementById('summary-unassigned-value').textContent =
        unassigned.length + (unassigned.length === 1 ? ' Artikel, ' : ' Artikel, ') + fmtMoney(unassignedTotal);
    } else {
      box.hidden = true;
    }
  }

  document.getElementById('btn-share-summary').addEventListener('click', async () => {
    const flat = allItemsFlat();
    let text = 'Kassenzettel-Abrechnung\n\n';
    let grandTotal = 0;
    for (const emp of employees) {
      const own = flat.filter(x => x.item.assignedTo === emp.id);
      if (own.length === 0) continue;
      const total = own.reduce((s, x) => s + x.item.price, 0);
      grandTotal += total;
      text += `${emp.name}: ${fmtMoney(total)}\n`;
      for (const x of own) text += `  - ${x.item.name} ${fmtMoney(x.item.price)}\n`;
      text += '\n';
    }
    const unassigned = flat.filter(x => !x.item.assignedTo);
    if (unassigned.length > 0) {
      const uTotal = unassigned.reduce((s, x) => s + x.item.price, 0);
      text += `Nicht zugeordnet: ${fmtMoney(uTotal)} (${unassigned.length} Artikel)\n\n`;
    }
    text += `Gesamt: ${fmtMoney(grandTotal + unassigned.reduce((s, x) => s + x.item.price, 0))}`;

    if (navigator.share) {
      try { await navigator.share({ text }); return; } catch (e) { /* user cancelled or unsupported, fall through */ }
    }
    try {
      await navigator.clipboard.writeText(text);
      toast('In Zwischenablage kopiert');
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); toast('In Zwischenablage kopiert'); } catch (e2) { toast('Teilen nicht möglich'); }
      document.body.removeChild(ta);
    }
  });

  // ---------- RENDER: Settings ----------
  function renderSettings() {
    const list = document.getElementById('employee-manage-list');
    list.innerHTML = '';
    if (employees.length === 0) {
      list.innerHTML = '<div class="empty-hint" style="padding:14px 0;">Noch keine Personen</div>';
    }
    for (const emp of employees) {
      const row = document.createElement('div');
      row.className = 'employee-row';
      row.innerHTML = `
        <span class="avatar-dot" style="background:${emp.color}">${initials(emp.name)}</span>
        <input type="text" value="${escapeAttr(emp.name)}">
        <button class="employee-delete">×</button>
      `;
      const input = row.querySelector('input');
      input.addEventListener('change', () => {
        emp.name = input.value.trim() || emp.name;
        saveEmployees();
        renderAll();
      });
      row.querySelector('.employee-delete').addEventListener('click', () => {
        if (!confirm(`${emp.name} wirklich entfernen? Bereits zugeordnete Artikel werden wieder als "nicht zugeordnet" markiert.`)) return;
        employees = employees.filter(e => e.id !== emp.id);
        for (const r of receipts) {
          for (const it of r.items) {
            if (it.assignedTo === emp.id) it.assignedTo = null;
          }
        }
        saveEmployees();
        saveReceipts();
        renderAll();
      });
      list.appendChild(row);
    }
  }

  function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  document.getElementById('btn-add-employee').addEventListener('click', addEmployeeFromInput);
  document.getElementById('new-employee-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addEmployeeFromInput();
  });
  function addEmployeeFromInput() {
    const input = document.getElementById('new-employee-name');
    const name = input.value.trim();
    if (!name) return;
    employees.push({ id: generateId(), name, color: nextColor() });
    saveEmployees();
    input.value = '';
    renderAll();
  }

  document.getElementById('btn-clear-receipts').addEventListener('click', () => {
    if (!confirm('Alle Belege und Artikel wirklich löschen?')) return;
    receipts = [];
    saveReceipts();
    renderAll();
  });
  document.getElementById('btn-clear-all').addEventListener('click', () => {
    if (!confirm('Wirklich ALLE Daten (Belege, Artikel und Personen) löschen?')) return;
    receipts = [];
    employees = [];
    saveReceipts();
    saveEmployees();
    renderAll();
  });

  function renderAll() {
    renderStart();
    renderAssign();
    renderSummary();
    renderSettings();
  }

  // ================== SCAN + OCR + REVIEW ==================

  let tesseractLoadPromise = null;
  function loadTesseract() {
    if (window.Tesseract) return Promise.resolve();
    if (tesseractLoadPromise) return tesseractLoadPromise;
    tesseractLoadPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = TESSERACT_SRC;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('OCR-Bibliothek konnte nicht geladen werden. Internetverbindung erforderlich (einmalig).'));
      document.head.appendChild(s);
    });
    return tesseractLoadPromise;
  }

  function downscaleImage(file, maxDim) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width > height) { height = Math.round(height * maxDim / width); width = maxDim; }
          else { width = Math.round(width * maxDim / height); height = maxDim; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve({ canvas, url: img.src });
      };
      img.onerror = () => reject(new Error('Bild konnte nicht gelesen werden.'));
      img.src = URL.createObjectURL(file);
    });
  }

  // Grayscale + robust contrast stretch (ignores the top/bottom 1% of pixel
  // values as outliers, e.g. glare or a dark shadow corner) — this alone
  // makes a big difference for thermal-paper receipt OCR accuracy.
  function preprocessForOcr(sourceCanvas) {
    const w = sourceCanvas.width, h = sourceCanvas.height;
    const imgData = sourceCanvas.getContext('2d').getImageData(0, 0, w, h);
    const d = imgData.data;
    const n = w * h;
    const gray = new Uint8ClampedArray(n);
    const hist = new Uint32Array(256);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      const g = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0;
      gray[p] = g;
      hist[g]++;
    }
    const clip = Math.floor(n * 0.01);
    let lo = 0, acc = 0;
    while (lo < 255 && acc < clip) { acc += hist[lo]; lo++; }
    let hi = 255; acc = 0;
    while (hi > 0 && acc < clip) { acc += hist[hi]; hi--; }
    if (hi <= lo) { lo = 0; hi = 255; }
    const range = hi - lo || 1;

    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      let v = Math.round((gray[p] - lo) * 255 / range);
      if (v < 0) v = 0; else if (v > 255) v = 255;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    out.getContext('2d').putImageData(imgData, 0, 0);
    return out;
  }

  // ---------- Receipt text parsing ----------
  const SKIP_LINE_RE = /(summe|gesamt(?!\s*\d)|zu\s*zahlen|z\.?\s*zahlen|gegeben|zur[uü]ck|r[uü]ckgeld|ec[- ]?cash|kartenzahlung|girocard|bar\s*zahlung|mwst|ust\b|steuer|netto|brutto|^datum|uhrzeit|bon[- ]?nr|trace|terminal|beleg[- ]?nr|kassenbon|vielen\s*dank|wiedersehen|kunden\s*karte|payback|punkte\s*gesammelt|rabatt|abzug|gutschein|tse\b|signatur|seriennummer|kassierer|kasse\s*\d|steuernummer|ust-?idnr|www\.|http)/i;

  function parsePriceToken(token) {
    // token like "1,19" or "12,50" or "1.19"
    const normalized = token.replace(',', '.');
    const n = parseFloat(normalized);
    return isNaN(n) ? null : n;
  }

  function parseReceiptText(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const rows = [];
    // Trailing part after the price is typically a tax-rate letter (A/B) and/or
    // a "*" marker (scanner-till receipts flag every non-plain-VAT line with
    // one) — both are optional and must be tolerated or the whole line is
    // dropped.
    const priceAtEndRe = /(-?\d{1,4}[.,]\d{2})\s*(?:€|EUR)?\s*[A-Za-z]{0,2}\s*[*#]?\s*$/;
    // A trailing "X01"-style piece-count code some tills print glued to the
    // item name (e.g. self-scan registers) — not meaningful, strip it.
    const trailingQtyCodeRe = /\s+[Xx]\d{2,3}$/;
    // Some tills print the item name + line total on one line, then the
    // quantity breakdown on its own indented line below with no name at
    // all (e.g. "2 Stk x    3,00"). That's not a separate item — it
    // belongs to the item line right above it and must update it in place,
    // or it gets counted twice.
    const qtyContinuationRe = /^(\d{1,3})\s*(?:stk|stück|stueck)\.?\s*[x×X]\s*$/i;

    for (const rawLine of lines) {
      if (SKIP_LINE_RE.test(rawLine)) continue;
      const m = rawLine.match(priceAtEndRe);
      if (!m) continue;
      const trailingPrice = parsePriceToken(m[1]);
      if (trailingPrice === null || trailingPrice <= 0 || trailingPrice > 500) continue;
      let rest = rawLine.slice(0, m.index).trim().replace(trailingQtyCodeRe, '').trim();
      if (!rest) continue;

      const cm = rest.match(qtyContinuationRe);
      if (cm && rows.length > 0) {
        const qty = parseInt(cm[1], 10);
        if (qty >= 1 && qty <= 50) {
          const prev = rows[rows.length - 1];
          prev.qty = qty;
          prev.unitPrice = Math.round(trailingPrice * 100) / 100;
        }
        continue;
      }

      let qty = 1;
      let unitPrice = trailingPrice;

      // "Name  3 x 0,49" (name, then qty x unitprice; trailingPrice is the line total)
      const qtyUnitRe = /^(.*?)\s+(\d{1,3})\s*[x×X]\s*(\d{1,4}[.,]\d{2})\s*$/;
      // "3 Name  x 0,49" (leading qty, then name, then x unitprice; trailingPrice is the line total)
      const leadQtyTrailUnitRe = /^(\d{1,3})\s+(.+?)\s+[x×X]\s*(\d{1,4}[.,]\d{2})\s*$/;
      // "3x Name" / "3 x Name" (leading qty x name, trailingPrice is the line total, no explicit unit price)
      const leadQtyRe = /^(\d{1,3})\s*[x×X]\s*(.+)$/;

      const qm = rest.match(qtyUnitRe);
      const lqm = rest.match(leadQtyTrailUnitRe);
      if (qm && qm[1].trim().length >= 2) {
        qty = parseInt(qm[2], 10);
        const explicitUnit = parsePriceToken(qm[3]);
        if (explicitUnit !== null) unitPrice = explicitUnit;
        rest = qm[1].trim();
      } else if (lqm && lqm[2].trim().length >= 2) {
        qty = parseInt(lqm[1], 10);
        const explicitUnit = parsePriceToken(lqm[3]);
        if (explicitUnit !== null) unitPrice = explicitUnit;
        rest = lqm[2].trim();
      } else {
        const lm = rest.match(leadQtyRe);
        if (lm && lm[2].trim().length >= 2) {
          qty = parseInt(lm[1], 10);
          rest = lm[2].trim();
          unitPrice = qty > 0 ? Math.round((trailingPrice / qty) * 100) / 100 : trailingPrice;
        }
      }

      if (!qty || qty < 1 || qty > 50) qty = 1;
      rest = rest.replace(/^[-*•.\s]+/, '').replace(/\s{2,}/g, ' ').trim();
      if (rest.length < 2) continue;

      rows.push({ id: generateId(), name: rest, unitPrice: Math.round(unitPrice * 100) / 100, qty });
    }
    return rows;
  }

  // ---------- Single item edit sheet ----------
  function openItemEditSheet(itemId) {
    const found = findItemById(itemId);
    if (!found) return;
    editingItemId = itemId;
    document.getElementById('item-edit-name').value = found.item.name;
    document.getElementById('item-edit-price').value = found.item.price.toFixed(2);
    document.getElementById('item-edit-backdrop').classList.add('active');
  }
  function closeItemEditSheet() {
    document.getElementById('item-edit-backdrop').classList.remove('active');
    editingItemId = null;
  }
  document.getElementById('item-edit-cancel').addEventListener('click', closeItemEditSheet);
  document.getElementById('item-edit-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'item-edit-backdrop') closeItemEditSheet();
  });
  document.getElementById('item-edit-save').addEventListener('click', () => {
    const found = findItemById(editingItemId);
    if (!found) return closeItemEditSheet();
    const name = document.getElementById('item-edit-name').value.trim();
    const price = parseFloat(document.getElementById('item-edit-price').value);
    if (!name || !(price > 0)) { toast('Bitte Name und Preis angeben'); return; }
    found.item.name = name;
    found.item.price = Math.round(price * 100) / 100;
    saveReceipts();
    closeItemEditSheet();
    renderAll();
  });
  document.getElementById('item-edit-delete').addEventListener('click', () => {
    const found = findItemById(editingItemId);
    if (!found) return closeItemEditSheet();
    found.receipt.items = found.receipt.items.filter(i => i.id !== editingItemId);
    saveReceipts();
    closeItemEditSheet();
    renderAll();
  });

  // ---------- Review overlay ----------
  function openReviewOverlay({ initialRows, photoUrl }) {
    reviewRows = initialRows || [];
    reviewPhotoUrl = photoUrl || null;

    document.getElementById('review-title').textContent = 'Neuer Beleg';
    const photoWrap = document.getElementById('review-photo-wrap');
    const retakeBtn = document.getElementById('btn-review-retake');
    if (reviewPhotoUrl) {
      photoWrap.hidden = false;
      document.getElementById('review-photo').src = reviewPhotoUrl;
      retakeBtn.hidden = false;
    } else {
      photoWrap.hidden = true;
      retakeBtn.hidden = true;
    }
    document.getElementById('ocr-status').hidden = true;
    document.getElementById('ocr-raw-wrap').hidden = true;
    renderReviewRows();
    document.getElementById('review-overlay').classList.add('active');
  }

  function closeReviewOverlay() {
    document.getElementById('review-overlay').classList.remove('active');
    reviewRows = null;
    reviewPhotoUrl = null;
  }

  function renderReviewRows() {
    const container = document.getElementById('review-rows');
    container.innerHTML = '';
    let total = 0;
    for (const row of reviewRows) {
      total += row.unitPrice * row.qty;
      const el = document.createElement('div');
      el.className = 'review-row';
      el.innerHTML = `
        <div class="review-row-top">
          <input type="text" class="row-name" placeholder="Artikelname" value="${escapeAttr(row.name)}">
          <button class="review-row-delete">×</button>
        </div>
        <div class="review-row-bottom">
          <div class="review-price-wrap">
            <span>je</span>
            <input type="number" class="row-price" inputmode="decimal" step="0.01" min="0" value="${row.unitPrice.toFixed(2)}">
            <span>€</span>
          </div>
          <div class="stepper">
            <button class="step-minus" type="button">−</button>
            <span class="stepper-value">${row.qty}</span>
            <button class="step-plus" type="button">+</button>
            <span class="stepper-label">Stk</span>
          </div>
        </div>
      `;
      el.querySelector('.row-name').addEventListener('input', (e) => { row.name = e.target.value; updateReviewSaveState(); });
      el.querySelector('.row-price').addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        row.unitPrice = isNaN(v) ? 0 : v;
        renderReviewRows();
      });
      el.querySelector('.step-minus').addEventListener('click', () => {
        if (row.qty > 1) { row.qty--; renderReviewRows(); }
      });
      el.querySelector('.step-plus').addEventListener('click', () => {
        if (row.qty < 50) { row.qty++; renderReviewRows(); }
      });
      el.querySelector('.review-row-delete').addEventListener('click', () => {
        reviewRows = reviewRows.filter(r => r.id !== row.id);
        renderReviewRows();
      });
      container.appendChild(el);
    }
    document.getElementById('review-count').textContent = reviewRows.reduce((s, r) => s + r.qty, 0);
    document.getElementById('review-total').textContent = fmtMoney(total);
    updateReviewSaveState();
  }

  function updateReviewSaveState() {
    const valid = reviewRows.length > 0 && reviewRows.every(r => r.name.trim().length > 0 && r.unitPrice > 0);
    document.getElementById('btn-review-save').disabled = !valid;
  }

  document.getElementById('btn-review-add-row').addEventListener('click', () => {
    reviewRows.push({ id: generateId(), name: '', unitPrice: 0, qty: 1 });
    renderReviewRows();
    const inputs = document.querySelectorAll('#review-rows .row-name');
    if (inputs.length) inputs[inputs.length - 1].focus();
  });

  document.getElementById('btn-review-cancel').addEventListener('click', () => {
    closeReviewOverlay();
  });

  document.getElementById('btn-review-save').addEventListener('click', () => {
    const expanded = [];
    for (const row of reviewRows) {
      const name = row.name.trim();
      if (!name || !(row.unitPrice > 0)) continue;
      for (let i = 0; i < row.qty; i++) {
        expanded.push({ id: generateId(), name, price: Math.round(row.unitPrice * 100) / 100, assignedTo: null, paid: false });
      }
    }
    if (expanded.length === 0) return;

    receipts.push({ id: generateId(), createdAt: Date.now(), items: expanded, paid: false });
    saveReceipts();
    closeReviewOverlay();
    switchView('start');
    toast('Beleg gespeichert');
  });

  document.getElementById('btn-review-retake').addEventListener('click', () => {
    document.getElementById('file-input').click();
  });

  // ---------- Start actions ----------
  document.getElementById('btn-manual-receipt').addEventListener('click', () => {
    openReviewOverlay({ initialRows: [{ id: generateId(), name: '', unitPrice: 0, qty: 1 }] });
  });

  document.getElementById('btn-scan-receipt').addEventListener('click', () => {
    document.getElementById('file-input').click();
  });

  // ---------- Paste-text sheet ----------
  document.getElementById('btn-paste-text').addEventListener('click', () => {
    document.getElementById('paste-text-input').value = '';
    document.getElementById('paste-text-backdrop').classList.add('active');
  });
  document.getElementById('paste-text-cancel').addEventListener('click', () => {
    document.getElementById('paste-text-backdrop').classList.remove('active');
  });
  document.getElementById('paste-text-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'paste-text-backdrop') document.getElementById('paste-text-backdrop').classList.remove('active');
  });
  document.getElementById('paste-text-submit').addEventListener('click', () => {
    const text = document.getElementById('paste-text-input').value;
    document.getElementById('paste-text-backdrop').classList.remove('active');
    const parsed = parseReceiptText(text);
    openReviewOverlay({
      initialRows: parsed.length ? parsed : [{ id: generateId(), name: '', unitPrice: 0, qty: 1 }]
    });
    if (parsed.length === 0) toast('Keine Artikel erkannt – bitte manuell eintragen');
  });

  function setOcrStatus(msg) {
    const ocrStatus = document.getElementById('ocr-status');
    const ocrText = document.getElementById('ocr-status-text');
    ocrStatus.hidden = false;
    ocrText.textContent = msg;
  }

  async function runOcrOnCanvas(canvas) {
    setOcrStatus('Texterkennung wird geladen …');
    await loadTesseract();
    setOcrStatus('Text wird erkannt … (kann beim ersten Mal etwas dauern)');
    const ocrCanvas = preprocessForOcr(canvas);
    const progressLogger = (m) => {
      if (m.status === 'recognizing text' && typeof m.progress === 'number') {
        setOcrStatus(`Text wird erkannt … ${Math.round(m.progress * 100)}%`);
      }
    };

    let worker = null;
    try {
      // Manual worker so we can set a page-segmentation mode tuned for
      // receipts (a single uniform block of short lines) instead of
      // Tesseract's fully-automatic layout detection, which tends to
      // struggle with logos/barcodes on receipts.
      worker = await window.Tesseract.createWorker('deu', 1, { logger: progressLogger });
      await worker.setParameters({ tessedit_pageseg_mode: '6' });
      const result = await worker.recognize(ocrCanvas);
      return result.data.text;
    } catch (workerErr) {
      // Fall back to the simple convenience API if the worker/PSM setup
      // above fails for any reason, so a scan never comes up completely empty.
      const result = await window.Tesseract.recognize(ocrCanvas, 'deu', { logger: progressLogger });
      return result.data.text;
    } finally {
      if (worker) worker.terminate().catch(() => {});
    }
  }

  // Applies recognized/extracted text to the currently open review overlay:
  // parses it into rows, or — if nothing could be matched — shows the raw
  // text so the source of the problem (bad recognition vs. unusual layout)
  // is visible instead of just an empty row.
  function applyRecognizedText(text, { sourceLabel }) {
    const parsed = parseReceiptText(text || '');
    document.getElementById('ocr-status').hidden = true;
    if (!reviewRows) return;
    reviewRows = parsed.length ? parsed : [{ id: generateId(), name: '', unitPrice: 0, qty: 1 }];
    if (parsed.length === 0) {
      const rawWrap = document.getElementById('ocr-raw-wrap');
      const rawText = (text || '').trim();
      if (rawText) {
        document.getElementById('ocr-raw-text').value = rawText;
        rawWrap.hidden = false;
        toast('Erkannter Text konnte keinem Artikel zugeordnet werden');
      } else {
        toast(`Aus ${sourceLabel} konnte kein Text gelesen werden`);
      }
    }
    renderReviewRows();
  }

  // ---------- PDF handling ----------
  let pdfjsLoadPromise = null;
  function loadPdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (pdfjsLoadPromise) return pdfjsLoadPromise;
    pdfjsLoadPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = PDFJS_SRC;
      s.onload = () => {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_SRC;
        resolve(window.pdfjsLib);
      };
      s.onerror = () => {
        pdfjsLoadPromise = null;
        reject(new Error('PDF-Bibliothek konnte nicht geladen werden. Internetverbindung erforderlich (einmalig).'));
      };
      document.head.appendChild(s);
    });
    return pdfjsLoadPromise;
  }

  // Groups pdf.js's flat per-glyph-run text items back into lines by their
  // vertical position — getTextContent() has no notion of "line" on its own.
  function linesFromPdfTextItems(items) {
    const rows = [];
    let currentY = null;
    let currentLine = [];
    for (const item of items) {
      if (!item.str) continue;
      const y = item.transform ? item.transform[5] : 0;
      if (currentY === null || Math.abs(y - currentY) > 2) {
        if (currentLine.length) rows.push(currentLine.join(' ').replace(/\s+/g, ' ').trim());
        currentLine = [];
        currentY = y;
      }
      currentLine.push(item.str);
    }
    if (currentLine.length) rows.push(currentLine.join(' ').replace(/\s+/g, ' ').trim());
    return rows.filter(Boolean);
  }

  async function extractPdfText(pdf) {
    const allLines = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      allLines.push(...linesFromPdfTextItems(content.items));
    }
    return allLines.join('\n');
  }

  async function renderPdfPageToCanvas(pdf, pageNum, scale) {
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    return canvas;
  }

  async function handlePdfFile(file) {
    openReviewOverlay({ initialRows: [] });
    setOcrStatus('PDF wird gelesen …');
    try {
      await loadPdfJs();
      const data = await file.arrayBuffer();
      const pdf = await window.pdfjsLib.getDocument({ data }).promise;

      const extractedText = (await extractPdfText(pdf)).trim();
      // A PDF with a real text layer (an emailed/app receipt, not a scan)
      // gives exact text — far more reliable than OCR, so prefer it and
      // skip OCR entirely whenever there's enough of it to be the receipt
      // content rather than just a stray header/watermark.
      if (extractedText.length > 30) {
        applyRecognizedText(extractedText, { sourceLabel: 'dem PDF' });
        return;
      }

      // No usable text layer — it's a scanned/photographed PDF. Render the
      // first page to an image and run it through the same OCR path as a photo.
      setOcrStatus('Kein Text im PDF gefunden – Seite wird als Bild erkannt …');
      const pageCanvas = await renderPdfPageToCanvas(pdf, 1, 2.5);
      const photoWrap = document.getElementById('review-photo-wrap');
      document.getElementById('review-photo').src = pageCanvas.toDataURL('image/jpeg', 0.85);
      photoWrap.hidden = false;
      const text = await runOcrOnCanvas(pageCanvas);
      applyRecognizedText(text, { sourceLabel: 'der PDF-Seite' });
    } catch (err) {
      document.getElementById('ocr-status').hidden = true;
      toast(err && err.message ? err.message : 'PDF konnte nicht gelesen werden');
      if (reviewRows && reviewRows.length === 0) {
        reviewRows = [{ id: generateId(), name: '', unitPrice: 0, qty: 1 }];
        renderReviewRows();
      }
    }
  }

  document.getElementById('file-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;

    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');
    if (isPdf) {
      await handlePdfFile(file);
      return;
    }

    let photoUrl, canvas;
    try {
      const res = await downscaleImage(file, 1800);
      canvas = res.canvas;
      photoUrl = canvas.toDataURL('image/jpeg', 0.85);
    } catch (err) {
      toast('Foto konnte nicht gelesen werden');
      return;
    }

    openReviewOverlay({ initialRows: [], photoUrl });
    try {
      const text = await runOcrOnCanvas(canvas);
      applyRecognizedText(text, { sourceLabel: 'dem Foto' });
    } catch (err) {
      document.getElementById('ocr-status').hidden = true;
      toast(err && err.message ? err.message : 'Texterkennung fehlgeschlagen');
      if (reviewRows && reviewRows.length === 0) {
        reviewRows = [{ id: generateId(), name: '', unitPrice: 0, qty: 1 }];
        renderReviewRows();
      }
    }
  });

  // ---------- Init ----------
  renderAll();
})();
