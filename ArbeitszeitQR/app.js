(() => {
  'use strict';

  const STORAGE_ENTRIES = 'zeitqr_entries_v1';
  const STORAGE_CODES = 'zeitqr_codes_v2';
  const STORAGE_CODE_LEGACY = 'zeitqr_registered_code_v1';

  const CATEGORY_LABELS = { normal: 'Arbeitszeit', montage: 'Montage' };

  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // ---------- Storage helpers ----------
  function loadEntries() {
    try {
      const raw = localStorage.getItem(STORAGE_ENTRIES);
      const list = raw ? JSON.parse(raw) : [];
      let migrated = false;
      const normalized = list.map(e => {
        if (!e.id || !e.category) migrated = true;
        return { id: e.id || generateId(), ts: e.ts, type: e.type, category: e.category || 'normal' };
      });
      if (migrated) saveEntries(normalized);
      return normalized;
    } catch (e) {
      return [];
    }
  }

  function saveEntries(list) {
    localStorage.setItem(STORAGE_ENTRIES, JSON.stringify(list));
  }

  function loadCodes() {
    try {
      const raw = localStorage.getItem(STORAGE_CODES);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* fall through to legacy migration */ }

    const legacy = localStorage.getItem(STORAGE_CODE_LEGACY);
    if (legacy) {
      const migrated = { [legacy]: 'normal' };
      localStorage.setItem(STORAGE_CODES, JSON.stringify(migrated));
      localStorage.removeItem(STORAGE_CODE_LEGACY);
      return migrated;
    }
    return {};
  }

  function saveCodes() {
    localStorage.setItem(STORAGE_CODES, JSON.stringify(codes));
  }

  function getCodeCategory(code) {
    return codes[code] || null;
  }

  function registerCode(code, category) {
    codes[code] = category;
    saveCodes();
  }

  function clearAllCodes() {
    codes = {};
    saveCodes();
  }

  let entries = loadEntries();
  let codes = loadCodes();

  // ---------- Formatting helpers ----------
  const dateFmt = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
  const shortDateFmt = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit' });
  const timeFmt = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });
  const monthFmt = new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric' });

  function dayKey(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function formatHoursPrecise(minutes) {
    const h = minutes / 60;
    return h.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' h';
  }

  // ---------- Soll-Stunden (Mo–Do 8,375h, Fr 6,5h) ----------
  const DAILY_TARGET_HOURS = { 1: 8.375, 2: 8.375, 3: 8.375, 4: 8.375, 5: 6.5, 6: 0, 0: 0 };

  function getDailyTargetMinutes(ts) {
    return DAILY_TARGET_HOURS[new Date(ts).getDay()] * 60;
  }

  function formatDiffHours(diffMinutes) {
    const sign = diffMinutes < 0 ? '−' : '+';
    const abs = Math.abs(diffMinutes) / 60;
    return sign + abs.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' h';
  }

  function diffClass(diffMinutes) {
    if (Math.abs(diffMinutes) < 3) return 'even';
    return diffMinutes > 0 ? 'over' : 'under';
  }

  // Monday 00:00 of the week containing ts
  function mondayOfWeek(ts) {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    const day = d.getDay(); // 0=Sun..6=Sat
    const diff = (day === 0 ? -6 : 1) - day;
    d.setDate(d.getDate() + diff);
    return d;
  }

  // ISO 8601 week number
  function isoWeekNumber(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  }

  // ---------- Day pairing / totals ----------
  function pairDay(dayEntries, isToday) {
    const sorted = [...dayEntries].sort((a, b) => a.ts - b.ts);
    const segments = [];
    let pendingIn = null;
    for (const e of sorted) {
      if (e.type === 'in') {
        pendingIn = e.ts;
      } else if (e.type === 'out') {
        if (pendingIn !== null) {
          segments.push({ start: pendingIn, end: e.ts, open: false });
          pendingIn = null;
        }
      }
    }
    if (pendingIn !== null) {
      if (isToday) {
        segments.push({ start: pendingIn, end: Date.now(), open: true });
      } else {
        segments.push({ start: pendingIn, end: null, open: true, incomplete: true });
      }
    }
    return segments;
  }

  function segmentsTotalMinutes(segments) {
    let total = 0;
    for (const s of segments) {
      if (s.end !== null) total += (s.end - s.start) / 60000;
    }
    return total;
  }

  function groupByDay(list) {
    const map = new Map();
    for (const e of list) {
      const k = dayKey(e.ts);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(e);
    }
    return map;
  }

  // ---------- Status ----------
  function getLastEntry(category) {
    return entries
      .filter(e => e.category === category)
      .reduce((latest, e) => (!latest || e.ts > latest.ts ? e : latest), null);
  }

  function getCurrentStatus(category) {
    const last = getLastEntry(category);
    return last && last.type === 'in' ? 'in' : 'out';
  }

  function renderStatusFor(category, opts) {
    const status = getCurrentStatus(category);
    const dot = document.getElementById(opts.dotId);
    const value = document.getElementById(opts.valueId);
    const sub = document.getElementById(opts.subId);
    dot.className = 'status-dot ' + status;
    value.textContent = status === 'in' ? opts.inLabel : opts.outLabel;

    const last = getLastEntry(category);
    if (!last) {
      sub.textContent = 'Noch kein Scan';
      return;
    }
    const label = last.type === 'in' ? opts.inSubLabel : opts.outSubLabel;
    sub.textContent = `${label} ${timeFmt.format(new Date(last.ts))}`;
  }

  function renderStatus() {
    renderStatusFor('normal', {
      dotId: 'status-dot', valueId: 'status-value', subId: 'status-sub',
      inLabel: 'Eingestempelt', outLabel: 'Ausgestempelt',
      inSubLabel: 'Eingestempelt um', outSubLabel: 'Ausgestempelt um'
    });
    renderStatusFor('montage', {
      dotId: 'status-dot-montage', valueId: 'status-value-montage', subId: 'status-sub-montage',
      inLabel: 'Vor Ort beim Kunden', outLabel: 'Nicht vor Ort',
      inSubLabel: 'Angekommen um', outSubLabel: 'Verlassen um'
    });
  }

  // ---------- Render: Today ----------
  function renderTodayFor(category, listId, inLabel, outLabel) {
    const todayKey = dayKey(Date.now());
    const todaysEntries = entries.filter(e => e.category === category && dayKey(e.ts) === todayKey);
    const list = document.getElementById(listId);

    if (todaysEntries.length === 0) {
      list.innerHTML = '<div class="empty-hint">Noch keine Einträge heute</div>';
      return;
    }

    const sorted = [...todaysEntries].sort((a, b) => b.ts - a.ts);
    list.innerHTML = sorted.map(e => {
      const icon = e.type === 'in' ? '↳' : '↰';
      const label = e.type === 'in' ? inLabel : outLabel;
      return `<div class="entry-row clickable" data-daykey="${todayKey}" data-category="${category}">
        <div class="entry-icon ${e.type}">${icon}</div>
        <div class="entry-main">
          <div class="entry-date">${label}</div>
          <div class="entry-time">${timeFmt.format(new Date(e.ts))} Uhr</div>
        </div>
        <div class="entry-chevron">›</div>
      </div>`;
    }).join('');
  }

  function renderToday() {
    renderTodayFor('normal', 'today-list', 'Kommen', 'Gehen');
    renderTodayFor('montage', 'today-list-montage', 'Ankunft', 'Abfahrt');
  }

  // ---------- Render: Month ----------
  let viewMonthDate = new Date();
  viewMonthDate.setDate(1);
  let monthCategory = 'normal';

  function renderMonth() {
    document.getElementById('month-label').textContent =
      monthFmt.format(viewMonthDate).replace(/^./, c => c.toUpperCase());

    const year = viewMonthDate.getFullYear();
    const month = viewMonthDate.getMonth();
    const monthStart = new Date(year, month, 1).getTime();
    const monthEnd = new Date(year, month + 1, 1).getTime();

    const monthEntries = entries.filter(e =>
      e.category === monthCategory && e.ts >= monthStart && e.ts < monthEnd);
    const grouped = groupByDay(monthEntries);
    const todayKey = dayKey(Date.now());

    const dayKeys = [...grouped.keys()].sort((a, b) => (a < b ? 1 : -1));

    // Group days into ISO weeks (Monday start), preserving the descending order.
    const weeks = new Map(); // weekKey -> { monday, dayKeys: [] }
    for (const k of dayKeys) {
      const dayEntries = grouped.get(k);
      const monday = mondayOfWeek(dayEntries[0].ts);
      const weekKey = dayKey(monday.getTime());
      if (!weeks.has(weekKey)) weeks.set(weekKey, { monday, dayKeys: [] });
      weeks.get(weekKey).dayKeys.push(k);
    }

    const showTarget = monthCategory === 'normal';

    let monthTotalMinutes = 0;
    const weekBlocks = [];

    for (const { monday, dayKeys: weekDayKeys } of weeks.values()) {
      let weekTotalMinutes = 0;
      let weekTargetMinutes = 0;
      const rows = [];

      for (const k of weekDayKeys) {
        const dayEntries = grouped.get(k);
        const isToday = k === todayKey;
        const segments = pairDay(dayEntries, isToday);
        const totalMin = segmentsTotalMinutes(segments);
        weekTotalMinutes += totalMin;
        monthTotalMinutes += totalMin;

        const hasIncomplete = segments.some(s => s.incomplete);

        let rangeLabel;
        if (segments.length === 0) {
          rangeLabel = '–';
        } else if (segments.length === 1) {
          const s = segments[0];
          rangeLabel = s.open && !s.incomplete
            ? `${timeFmt.format(new Date(s.start))} – läuft`
            : s.incomplete
            ? `${timeFmt.format(new Date(s.start))} – ?`
            : `${timeFmt.format(new Date(s.start))} – ${timeFmt.format(new Date(s.end))}`;
        } else {
          rangeLabel = `${segments.length} Zeitabschnitte`;
        }

        const dateLabel = dateFmt.format(new Date(dayEntries[0].ts)).replace(/^./, c => c.toUpperCase());

        let diffHtml = '';
        if (showTarget) {
          const targetMin = getDailyTargetMinutes(dayEntries[0].ts);
          const diffMin = totalMin - targetMin;
          weekTargetMinutes += targetMin;
          diffHtml = `<div class="entry-diff ${diffClass(diffMin)}">${formatDiffHours(diffMin)}</div>`;
        }

        rows.push(`<div class="entry-row clickable" data-daykey="${k}" data-category="${monthCategory}">
          <div class="entry-icon ${hasIncomplete ? 'out' : 'in'}">${hasIncomplete ? '!' : '✓'}</div>
          <div class="entry-main">
            <div class="entry-date">${dateLabel}</div>
            <div class="entry-time">${rangeLabel}${hasIncomplete ? ' <span class="entry-warn">(unvollständig)</span>' : ''}</div>
          </div>
          <div class="entry-total-wrap">
            <div class="entry-total">${formatHoursPrecise(totalMin)}</div>
            ${diffHtml}
          </div>
        </div>`);
      }

      const sunday = new Date(monday);
      sunday.setDate(sunday.getDate() + 6);
      const weekLabel = `KW ${isoWeekNumber(monday)} · ${shortDateFmt.format(monday)} – ${shortDateFmt.format(sunday)}`;
      const weekDiffMin = weekTotalMinutes - weekTargetMinutes;
      const weekDiffHtml = showTarget
        ? `<span class="week-diff ${diffClass(weekDiffMin)}">${formatDiffHours(weekDiffMin)}</span>`
        : '';

      weekBlocks.push(`<div class="week-block">
        <div class="week-header">
          <span class="week-label">${weekLabel}</span>
          <span class="week-totals">
            <span class="week-total">${formatHoursPrecise(weekTotalMinutes)}</span>
            ${weekDiffHtml}
          </span>
        </div>
        <div class="entry-list">${rows.join('')}</div>
      </div>`);
    }

    const list = document.getElementById('month-list');
    list.innerHTML = weekBlocks.length ? weekBlocks.join('') : '<div class="empty-hint">Keine Einträge in diesem Monat</div>';
    document.getElementById('month-total').textContent = formatHoursPrecise(monthTotalMinutes);
  }

  // ---------- Settings ----------
  function renderSettings() {
    const desc = document.getElementById('registered-code-desc');
    const codeList = Object.entries(codes);
    if (codeList.length === 0) {
      desc.textContent = 'Noch keine Codes registriert. Der erste gescannte Code wird automatisch registriert.';
      return;
    }
    const counts = { normal: 0, montage: 0 };
    codeList.forEach(([, cat]) => { counts[cat] = (counts[cat] || 0) + 1; });
    const parts = [];
    if (counts.normal) parts.push(`${counts.normal} für Arbeitszeit`);
    if (counts.montage) parts.push(`${counts.montage} für Montage`);
    desc.textContent = `${codeList.length} Code(s) registriert: ${parts.join(', ')}.`;
  }

  function renderAll() {
    renderStatus();
    renderToday();
    renderMonth();
    renderSettings();
  }

  // ---------- Toast ----------
  let toastTimer = null;
  function showToast(msg, kind) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'toast show' + (kind ? ' ' + kind : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'toast'; }, 2600);
  }

  // ---------- Modal ----------
  function showModal(title, text, actions) {
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-text').textContent = text;
    const actionsEl = document.getElementById('modal-actions');
    actionsEl.innerHTML = '';
    actions.forEach(a => {
      const btn = document.createElement('button');
      btn.className = 'btn ' + (a.style || 'secondary');
      btn.textContent = a.label;
      btn.onclick = () => {
        closeModal();
        a.onClick && a.onClick();
      };
      actionsEl.appendChild(btn);
    });
    document.getElementById('modal-backdrop').classList.add('active');
  }
  function closeModal() {
    document.getElementById('modal-backdrop').classList.remove('active');
  }
  document.getElementById('modal-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'modal-backdrop') closeModal();
  });

  // ---------- Day editor ----------
  let editorDateKey = null;
  let editorCategory = 'normal';
  const editorTypeLabels = {
    normal: { in: 'Kommen', out: 'Gehen' },
    montage: { in: 'Ankunft', out: 'Abfahrt' }
  };

  function tsToTimeInputValue(ts) {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function openDayEditor(dateKeyStr, category) {
    editorDateKey = dateKeyStr;
    editorCategory = category;
    renderDayEditor();
    document.getElementById('day-editor-backdrop').classList.add('active');
  }

  function closeDayEditor() {
    document.getElementById('day-editor-backdrop').classList.remove('active');
  }

  function renderDayEditor() {
    const [y, m, d] = editorDateKey.split('-').map(Number);
    const labelDate = dateFmt.format(new Date(y, m - 1, d)).replace(/^./, c => c.toUpperCase());
    document.getElementById('day-editor-title').textContent =
      `${labelDate} · ${CATEGORY_LABELS[editorCategory]}`;

    const labels = editorTypeLabels[editorCategory];
    const dayEntries = entries
      .filter(e => e.category === editorCategory && dayKey(e.ts) === editorDateKey)
      .sort((a, b) => a.ts - b.ts);

    const listEl = document.getElementById('day-editor-list');
    if (dayEntries.length === 0) {
      listEl.innerHTML = '<div class="day-editor-empty">Keine Einträge an diesem Tag</div>';
    } else {
      listEl.innerHTML = dayEntries.map(e => `
        <div class="day-editor-row" data-id="${e.id}">
          <div class="type-toggle" data-role="type">
            <button type="button" data-type="in" class="${e.type === 'in' ? 'active in' : ''}">${labels.in}</button>
            <button type="button" data-type="out" class="${e.type === 'out' ? 'active out' : ''}">${labels.out}</button>
          </div>
          <input type="time" value="${tsToTimeInputValue(e.ts)}" data-role="time">
          <button type="button" class="day-editor-delete" data-role="delete" title="Löschen">🗑</button>
        </div>
      `).join('');
    }

    // wire up row interactions
    listEl.querySelectorAll('.day-editor-row').forEach(row => {
      const id = row.dataset.id;

      row.querySelectorAll('[data-role="type"] button').forEach(btn => {
        btn.addEventListener('click', () => {
          updateEntryType(id, btn.dataset.type);
          renderDayEditor();
          renderAll();
        });
      });

      row.querySelector('[data-role="time"]').addEventListener('change', (e) => {
        const [hh, mm] = e.target.value.split(':').map(Number);
        if (Number.isNaN(hh) || Number.isNaN(mm)) return;
        const [y2, m2, d2] = editorDateKey.split('-').map(Number);
        const newTs = new Date(y2, m2 - 1, d2, hh, mm, 0, 0).getTime();
        updateEntryTime(id, newTs);
        renderDayEditor();
        renderAll();
      });

      row.querySelector('[data-role="delete"]').addEventListener('click', () => {
        showModal(
          'Eintrag löschen?',
          'Dieser Eintrag wird unwiderruflich entfernt.',
          [
            {
              label: 'Löschen', style: 'danger', onClick: () => {
                deleteEntryById(id);
                renderDayEditor();
                renderAll();
              }
            },
            { label: 'Abbrechen', style: 'secondary', onClick: () => {} }
          ]
        );
      });
    });

    // add-new-entry row
    const lastType = dayEntries.length ? dayEntries[dayEntries.length - 1].type : 'out';
    const defaultType = lastType === 'in' ? 'out' : 'in';
    const now = new Date();
    const defaultTime = editorDateKey === dayKey(Date.now())
      ? `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
      : '12:00';

    const addEl = document.getElementById('day-editor-add');
    addEl.innerHTML = `
      <div class="type-toggle" data-role="add-type">
        <button type="button" data-type="in" class="${defaultType === 'in' ? 'active in' : ''}">${labels.in}</button>
        <button type="button" data-type="out" class="${defaultType === 'out' ? 'active out' : ''}">${labels.out}</button>
      </div>
      <input type="time" value="${defaultTime}" data-role="add-time">
      <button type="button" class="btn secondary" data-role="add-confirm">+ Hinzufügen</button>
    `;

    let addType = defaultType;
    addEl.querySelectorAll('[data-role="add-type"] button').forEach(btn => {
      btn.addEventListener('click', () => {
        addType = btn.dataset.type;
        addEl.querySelectorAll('[data-role="add-type"] button').forEach(b => {
          b.classList.toggle('active', b === btn);
          b.classList.toggle(b.dataset.type, b === btn);
        });
      });
    });

    addEl.querySelector('[data-role="add-confirm"]').addEventListener('click', () => {
      const timeVal = addEl.querySelector('[data-role="add-time"]').value;
      if (!timeVal) return;
      const [hh, mm] = timeVal.split(':').map(Number);
      addManualEntry(editorDateKey, editorCategory, addType, hh, mm);
      renderDayEditor();
      renderAll();
    });
  }

  document.getElementById('day-editor-close').addEventListener('click', closeDayEditor);
  document.getElementById('day-editor-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'day-editor-backdrop') closeDayEditor();
  });

  // ---------- Punch logic ----------
  function addPunch(type, category) {
    entries.push({ id: generateId(), ts: Date.now(), type, category });
    saveEntries(entries);
    renderAll();
  }

  // ---------- Manual entry editing ----------
  function updateEntryTime(id, newTs) {
    const e = entries.find(x => x.id === id);
    if (!e) return;
    e.ts = newTs;
    saveEntries(entries);
  }

  function updateEntryType(id, newType) {
    const e = entries.find(x => x.id === id);
    if (!e) return;
    e.type = newType;
    saveEntries(entries);
  }

  function deleteEntryById(id) {
    entries = entries.filter(x => x.id !== id);
    saveEntries(entries);
  }

  function addManualEntry(dateKeyStr, category, type, hh, mm) {
    const [y, m, d] = dateKeyStr.split('-').map(Number);
    const ts = new Date(y, m - 1, d, hh, mm, 0, 0).getTime();
    entries.push({ id: generateId(), ts, type, category });
    saveEntries(entries);
  }

  function punchAndNotify(category) {
    const next = getCurrentStatus(category) === 'in' ? 'out' : 'in';
    addPunch(next, category);
    const verb = category === 'montage'
      ? (next === 'in' ? 'Angekommen' : 'Abgefahren')
      : (next === 'in' ? 'Eingestempelt' : 'Ausgestempelt');
    showToast(verb, 'success');
  }

  function handleScannedCode(code) {
    const category = getCodeCategory(code);

    if (!category) {
      showModal(
        'QR-Code registrieren',
        'Dieser Code ist noch nicht registriert. Wofür soll er ab jetzt verwendet werden?',
        [
          {
            label: 'Arbeitszeit (Büro)', style: 'secondary', onClick: () => {
              registerCode(code, 'normal');
              renderSettings();
              punchAndNotify('normal');
            }
          },
          {
            label: 'Montage (beim Kunden)', style: 'secondary', onClick: () => {
              registerCode(code, 'montage');
              renderSettings();
              punchAndNotify('montage');
            }
          },
          { label: 'Abbrechen', style: 'secondary', onClick: () => {} }
        ]
      );
      return;
    }

    punchAndNotify(category);
  }

  // ---------- Navigation ----------
  const titles = { home: 'Arbeitszeit', montage: 'Montage', month: 'Monatsübersicht', settings: 'Einstellungen' };

  function switchView(name) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-' + name).classList.add('active');
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.view === name));
    document.getElementById('topbar-title').textContent = titles[name];
    if (name === 'month') renderMonth();
  }

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  document.getElementById('month-prev').addEventListener('click', () => {
    viewMonthDate.setMonth(viewMonthDate.getMonth() - 1);
    renderMonth();
  });
  document.getElementById('month-next').addEventListener('click', () => {
    viewMonthDate.setMonth(viewMonthDate.getMonth() + 1);
    renderMonth();
  });

  document.querySelectorAll('.segmented-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      monthCategory = btn.dataset.category;
      document.querySelectorAll('.segmented-btn').forEach(b => b.classList.toggle('active', b === btn));
      renderMonth();
    });
  });

  // ---------- Settings actions ----------
  document.getElementById('btn-reset-code').addEventListener('click', () => {
    showModal(
      'Alle Codes zurücksetzen?',
      'Alle registrierten QR-Codes (Arbeitszeit und Montage) werden entfernt. Beim nächsten Scan wird wieder neu registriert.',
      [
        { label: 'Zurücksetzen', style: 'danger', onClick: () => { clearAllCodes(); renderSettings(); showToast('Codes zurückgesetzt'); } },
        { label: 'Abbrechen', style: 'secondary', onClick: () => {} }
      ]
    );
  });

  document.getElementById('btn-clear-data').addEventListener('click', () => {
    showModal(
      'Alle Einträge löschen?',
      'Diese Aktion kann nicht rückgängig gemacht werden. Alle erfassten Zeiten (Arbeitszeit und Montage) werden gelöscht.',
      [
        { label: 'Löschen', style: 'danger', onClick: () => { entries = []; saveEntries(entries); renderAll(); showToast('Alle Einträge gelöscht'); } },
        { label: 'Abbrechen', style: 'secondary', onClick: () => {} }
      ]
    );
  });

  // ---------- Scanner ----------
  let stream = null;
  let scanRAF = null;
  let scanning = false;
  const video = document.getElementById('scanner-video');
  const canvas = document.getElementById('scan-canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  function qrLibSupported() {
    return typeof window.jsQR !== 'undefined';
  }

  async function openScanner() {
    if (!qrLibSupported()) {
      showModal(
        'QR-Scan nicht verfügbar',
        'Die QR-Erkennung konnte nicht geladen werden. Bitte lade die App einmal neu, während du online bist, damit alle Dateien lokal gespeichert werden können.',
        [{ label: 'OK', style: 'secondary', onClick: () => {} }]
      );
      return;
    }

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false
      });
    } catch (e) {
      showModal(
        'Kamerazugriff verweigert',
        'Ohne Kamerazugriff kann kein QR-Code gescannt werden. Bitte erlaube den Zugriff in den Einstellungen.',
        [{ label: 'OK', style: 'secondary', onClick: () => {} }]
      );
      return;
    }

    video.srcObject = stream;
    await video.play();

    document.getElementById('scanner-overlay').classList.add('active');
    scanning = true;
    scanLoop();
  }

  function closeScanner() {
    scanning = false;
    if (scanRAF) cancelAnimationFrame(scanRAF);
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      stream = null;
    }
    video.srcObject = null;
    document.getElementById('scanner-overlay').classList.remove('active');
  }

  let lastDetectTime = 0;
  function scanLoop() {
    if (!scanning) return;
    const now = performance.now();
    if (now - lastDetectTime > 150 && video.videoWidth > 0) {
      lastDetectTime = now;
      try {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const result = window.jsQR(imageData.data, imageData.width, imageData.height, {
          inversionAttempts: 'dontInvert'
        });
        if (result && result.data) {
          const value = result.data;
          closeScanner();
          handleScannedCode(value);
          return;
        }
      } catch (e) {
        // ignore transient decode errors
      }
    }
    scanRAF = requestAnimationFrame(scanLoop);
  }

  document.getElementById('btn-scan').addEventListener('click', openScanner);
  document.getElementById('btn-scan-montage').addEventListener('click', openScanner);
  document.getElementById('btn-close-scanner').addEventListener('click', closeScanner);

  // ---------- Entry row click -> day editor ----------
  ['today-list', 'today-list-montage', 'month-list'].forEach(listId => {
    document.getElementById(listId).addEventListener('click', (e) => {
      const row = e.target.closest('.entry-row.clickable');
      if (!row) return;
      openDayEditor(row.dataset.daykey, row.dataset.category);
    });
  });

  // ---------- Live update while clocked in ----------
  setInterval(() => {
    if (getCurrentStatus('normal') === 'in' || getCurrentStatus('montage') === 'in') {
      renderMonth();
    }
  }, 30000);

  // ---------- Service worker ----------
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }

  // ---------- Init ----------
  renderAll();
})();
