(function () {
  const state = {
    tasks: [],
    labels: [],
    view: 'year',
    anchors: { year: new Date(), quarter: new Date(), month: new Date() },
    editingId: null,
    filterText: '',
    draftGoals: [],
    gcal: { connected: false, monthKey: '', events: [], loading: false, error: '' },
  };

  const LABEL_PALETTE = ['#4f7cff', '#22a55a', '#e5484d', '#f5a623', '#8b5cf6', '#06b6d4', '#ec4899'];

  function currentAnchor() {
    return state.anchors[state.view];
  }
  // ---------- Undo / redo ----------
  const UNDO_LIMIT = 50;
  const undoStack = [];
  const redoStack = [];

  function snapshotData() {
    return JSON.parse(JSON.stringify({ tasks: state.tasks, labels: state.labels }));
  }

  function pushUndo() {
    undoStack.push(snapshotData());
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    redoStack.length = 0;
  }

  async function undo() {
    if (undoStack.length === 0) return;
    const prev = undoStack.pop();
    redoStack.push(snapshotData());
    state.tasks = prev.tasks;
    state.labels = prev.labels;
    await persist();
    renderAll();
  }

  async function redo() {
    if (redoStack.length === 0) return;
    const next = redoStack.pop();
    undoStack.push(snapshotData());
    state.tasks = next.tasks;
    state.labels = next.labels;
    await persist();
    renderAll();
  }

  const WEEKDAYS_JA = ['日', '月', '火', '水', '木', '金', '土'];

  // ---------- Date utils ----------
  function toDateOnly(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }
  function parseDate(str) {
    const [y, m, d] = str.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  function formatDate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  function addMonths(date, n) {
    return new Date(date.getFullYear(), date.getMonth() + n, date.getDate());
  }
  function startOfMonth(date) {
    return new Date(date.getFullYear(), date.getMonth(), 1);
  }
  function endOfMonth(date) {
    return new Date(date.getFullYear(), date.getMonth() + 1, 0);
  }
  function daysBetween(a, b) {
    return Math.round((toDateOnly(b) - toDateOnly(a)) / 86400000);
  }
  function clampDate(date, min, max) {
    if (date < min) return min;
    if (date > max) return max;
    return date;
  }
  function isSameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }
  function isDelayed(t) {
    return (t.delay || 0) > 0;
  }
  function monthLabel(d) {
    return `${d.getFullYear()}年${d.getMonth() + 1}月`;
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  }

  function hexToRgba(hex, alpha) {
    const h = (hex || '#4f7cff').replace('#', '');
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const bigint = parseInt(full, 16) || 0x4f7cff;
    const r = (bigint >> 16) & 255, g = (bigint >> 8) & 255, b = bigint & 255;
    return `rgba(${r},${g},${b},${alpha})`;
  }

  // ---------- Persistence ----------
  async function loadData() {
    const data = await window.scheduleAPI.loadData();
    state.tasks = (data.tasks || []).map((t) => {
      const { category, ...rest } = t;
      return {
        ...rest,
        label: t.label !== undefined ? t.label : (category || ''),
        delay: t.delay || 0,
        scope: t.scope === 'month' ? 'month' : 'main',
        goals: t.goals || [],
      };
    });
    if (Array.isArray(data.labels) && data.labels.length) {
      state.labels = data.labels.map((l) => ({ ...l, hideInMonth: !!l.hideInMonth }));
    } else {
      const names = Array.from(new Set([
        ...(data.categories || []),
        ...state.tasks.map((t) => t.label).filter(Boolean),
      ]));
      state.labels = names.map((name, i) => ({
        id: crypto.randomUUID(), name, color: LABEL_PALETTE[i % LABEL_PALETTE.length],
      }));
    }
  }
  async function persist() {
    await window.scheduleAPI.saveData({ tasks: state.tasks, labels: state.labels });
  }

  // ---------- Label queries / mutations ----------
  function addLabel(name, color, hideInMonth) {
    name = name.trim();
    if (!name || state.labels.some((l) => l.name === name)) return false;
    state.labels.push({ id: crypto.randomUUID(), name, color, hideInMonth: !!hideInMonth });
    return true;
  }

  function updateLabel(id, name, color, hideInMonth) {
    const l = state.labels.find((x) => x.id === id);
    if (!l) return;
    name = name.trim();
    if (!name) return;
    const oldName = l.name;
    l.name = name;
    l.color = color;
    l.hideInMonth = !!hideInMonth;
    if (oldName !== name) {
      state.tasks.forEach((t) => { if (t.label === oldName) t.label = name; });
    }
  }

  function isLabelHiddenInMonth(labelName) {
    if (!labelName) return false;
    const l = state.labels.find((x) => x.name === labelName);
    return !!(l && l.hideInMonth);
  }

  function deleteLabel(id) {
    const l = state.labels.find((x) => x.id === id);
    if (!l) return;
    state.labels = state.labels.filter((x) => x.id !== id);
    state.tasks.forEach((t) => { if (t.label === l.name) t.label = ''; });
  }

  // ---------- Task queries ----------
  function getFilteredTasks() {
    const q = state.filterText.trim().toLowerCase();
    let list = state.tasks.slice().sort((a, b) => a.start.localeCompare(b.start));
    if (q) {
      list = list.filter((t) => t.title.toLowerCase().includes(q) || (t.label || '').toLowerCase().includes(q));
    }
    return list;
  }

  function tasksIntersecting(rangeStart, rangeEnd) {
    return state.tasks.filter((t) => {
      if (t.scope === 'month') return false;
      const s = parseDate(t.start), e = parseDate(t.end);
      return e >= rangeStart && s <= rangeEnd;
    });
  }

  function packLanes(tasks, rangeStart, rangeEnd) {
    const sorted = tasks.slice().sort((a, b) => a.start.localeCompare(b.start));
    const laneEnds = [];
    const rows = [];
    for (const t of sorted) {
      const s = clampDate(parseDate(t.start), rangeStart, rangeEnd);
      const e = clampDate(parseDate(t.end), rangeStart, rangeEnd);
      let lane = laneEnds.findIndex((end) => end < s);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(e);
      } else {
        laneEnds[lane] = e;
      }
      rows.push({ task: t, lane, start: s, end: e });
    }
    return { rows, laneCount: laneEnds.length };
  }

  // ---------- Rendering: sidebar ----------
  function renderSidebar() {
    const list = getFilteredTasks();
    const container = document.getElementById('task-list');
    container.innerHTML = '';
    if (list.length === 0) {
      container.innerHTML = '<div class="empty-msg">予定がありません</div>';
      return;
    }
    const groups = [
      { title: '年間・3ヶ月', items: list.filter((t) => t.scope !== 'month') },
      { title: '月間', items: list.filter((t) => t.scope === 'month') },
    ];
    for (const g of groups) {
      if (g.items.length === 0) continue;
      const header = document.createElement('div');
      header.className = 'task-list-section';
      header.textContent = g.title;
      container.appendChild(header);
      for (const t of g.items) {
        const delayed = isDelayed(t);
        const goals = t.goals || [];
        const doneGoals = goals.filter((g2) => g2.done).length;
        const card = document.createElement('div');
        card.className = 'task-card' + (delayed ? ' delayed' : '');
        card.innerHTML = `
          <div class="task-card-title"><span class="color-dot" style="background:${t.color}"></span>${escapeHtml(t.title)}${delayed ? '<span class="delay-badge">遅延</span>' : ''}</div>
          <div class="task-card-dates">${t.start} 〜 ${t.end}${t.label ? ' ・ ' + escapeHtml(t.label) : ''}</div>
          ${goals.length ? `<div class="task-card-goals">スモールゴール: ${doneGoals}/${goals.length}</div>` : ''}
        `;
        card.addEventListener('click', () => openModal(t.id));
        container.appendChild(card);
      }
    }
  }

  function renderLabelSelectOptions() {
    const sel = document.getElementById('field-label');
    const current = sel.value;
    sel.innerHTML = '<option value="">(なし)</option>' +
      state.labels.map((l) => `<option value="${escapeHtml(l.name)}">${escapeHtml(l.name)}</option>`).join('');
    if (state.labels.some((l) => l.name === current)) sel.value = current;
  }

  function renderLabelList() {
    const container = document.getElementById('label-list');
    if (state.labels.length === 0) {
      container.innerHTML = '<div class="empty-msg">カレンダーがありません</div>';
      return;
    }
    container.innerHTML = state.labels.map((l) => `
      <div class="label-row" data-id="${l.id}">
        <span class="color-dot" style="background:${l.color}"></span>
        <span class="label-name">${escapeHtml(l.name)}</span>
        ${l.hideInMonth ? '<span class="label-hide-month-badge" title="月表示には含まれません">年間のみ</span>' : ''}
        <div class="label-row-actions">
          <button type="button" class="icon-btn edit-label-btn" title="編集">✎</button>
          <button type="button" class="icon-btn delete-label-btn" title="削除">🗑</button>
        </div>
      </div>
    `).join('');

    container.querySelectorAll('.label-row').forEach((row) => {
      const id = row.dataset.id;
      row.querySelector('.edit-label-btn').addEventListener('click', () => enterLabelEditMode(row, id));
      row.querySelector('.delete-label-btn').addEventListener('click', async () => {
        if (!confirm('このカレンダーを削除しますか？関連する予定からカレンダーが外れます。')) return;
        pushUndo();
        deleteLabel(id);
        await persist();
        renderLabelList();
        renderLabelSelectOptions();
        renderAll();
      });
    });
  }

  function enterLabelEditMode(row, id) {
    const l = state.labels.find((x) => x.id === id);
    row.innerHTML = `
      <input type="text" class="label-edit-name" value="${escapeHtml(l.name)}" maxlength="40" />
      <input type="color" class="label-edit-color" value="${l.color}" />
      <label class="label-hide-month-field">
        <input type="checkbox" class="label-edit-hide-month" ${l.hideInMonth ? 'checked' : ''} />
        月表示に含めない
      </label>
      <div class="label-row-actions">
        <button type="button" class="icon-btn save-label-btn" title="保存">✔</button>
        <button type="button" class="icon-btn cancel-label-btn" title="キャンセル">✕</button>
      </div>
    `;
    row.querySelector('.save-label-btn').addEventListener('click', async () => {
      const name = row.querySelector('.label-edit-name').value;
      const color = row.querySelector('.label-edit-color').value;
      const hideInMonth = row.querySelector('.label-edit-hide-month').checked;
      if (!name.trim()) return;
      pushUndo();
      updateLabel(id, name, color, hideInMonth);
      await persist();
      renderLabelList();
      renderLabelSelectOptions();
      renderAll();
    });
    row.querySelector('.cancel-label-btn').addEventListener('click', () => renderLabelList());
  }

  // ---------- Small goals (modal draft state) ----------
  function renderGoalsList() {
    const container = document.getElementById('goals-list');
    if (state.draftGoals.length === 0) {
      container.innerHTML = '<div class="empty-msg">スモールゴールはまだありません</div>';
      return;
    }
    container.innerHTML = state.draftGoals.map((g) => `
      <div class="goal-row${g.done ? ' done' : ''}" data-id="${g.id}">
        <input type="checkbox" class="goal-check" ${g.done ? 'checked' : ''} />
        <span class="goal-text">${escapeHtml(g.text)}</span>
        ${g.date ? `<span class="goal-date">${g.date}</span>` : ''}
        <div class="goal-row-actions">
          <button type="button" class="icon-btn edit-goal-btn" title="編集">✎</button>
          <button type="button" class="icon-btn delete-goal-btn" title="削除">✕</button>
        </div>
      </div>
    `).join('');

    container.querySelectorAll('.goal-row').forEach((row) => {
      const id = row.dataset.id;
      row.querySelector('.goal-check').addEventListener('change', (e) => {
        const g = state.draftGoals.find((x) => x.id === id);
        g.done = e.target.checked;
        row.classList.toggle('done', g.done);
      });
      row.querySelector('.delete-goal-btn').addEventListener('click', () => {
        state.draftGoals = state.draftGoals.filter((x) => x.id !== id);
        renderGoalsList();
      });
      row.querySelector('.edit-goal-btn').addEventListener('click', () => enterGoalEditMode(row, id));
    });
  }

  function enterGoalEditMode(row, id) {
    const g = state.draftGoals.find((x) => x.id === id);
    row.innerHTML = `
      <input type="text" class="goal-edit-text" value="${escapeHtml(g.text)}" maxlength="100" />
      <input type="date" class="goal-edit-date" value="${g.date || ''}" />
      <div class="goal-row-actions">
        <button type="button" class="icon-btn save-goal-btn" title="保存">✔</button>
        <button type="button" class="icon-btn cancel-goal-btn" title="キャンセル">✕</button>
      </div>
    `;
    row.querySelector('.save-goal-btn').addEventListener('click', () => {
      const text = row.querySelector('.goal-edit-text').value.trim();
      const date = row.querySelector('.goal-edit-date').value;
      if (!text) return;
      g.text = text;
      g.date = date;
      renderGoalsList();
    });
    row.querySelector('.cancel-goal-btn').addEventListener('click', () => renderGoalsList());
  }

  // ---------- Goal queries (for quarter / month views) ----------
  function goalsIntersecting(rangeStart, rangeEnd) {
    const items = [];
    for (const t of state.tasks) {
      for (const g of t.goals || []) {
        if (!g.date) continue;
        const d = parseDate(g.date);
        if (d >= rangeStart && d <= rangeEnd) {
          items.push({ id: `goal:${t.id}:${g.id}`, taskId: t.id, title: g.text, start: g.date, end: g.date, color: t.color, done: g.done });
        }
      }
    }
    return items;
  }

  // ---------- Rendering: gantt (year / quarter) ----------
  function renderGantt(containerEl, rangeStart, rangeEnd, monthUnits, goalItems) {
    const totalDays = daysBetween(rangeStart, rangeEnd) + 1;
    const tasks = tasksIntersecting(rangeStart, rangeEnd)
      .slice()
      .sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
    const rows = tasks.map((t, i) => ({
      task: t,
      lane: i,
      start: clampDate(parseDate(t.start), rangeStart, rangeEnd),
      end: clampDate(parseDate(t.end), rangeStart, rangeEnd),
    }));
    const laneCount = rows.length;
    const { rows: goalRows, laneCount: goalLaneCount } = goalItems && goalItems.length
      ? packLanes(goalItems, rangeStart, rangeEnd)
      : { rows: [], laneCount: 0 };

    const headerCells = monthUnits.map((u) => {
      const days = daysBetween(u.start, u.end) + 1;
      const widthPct = (days / totalDays) * 100;
      return `<div class="gantt-header-cell${u.monthStart ? ' gantt-month-start' : ''}" style="width:${widthPct}%">${escapeHtml(u.label)}</div>`;
    }).join('');

    const gridlines = monthUnits.map((u) => {
      const days = daysBetween(u.start, u.end) + 1;
      const widthPct = (days / totalDays) * 100;
      return `<div class="gantt-gridline${u.monthStart ? ' gantt-month-start' : ''}" style="width:${widthPct}%"></div>`;
    }).join('');

    const today = toDateOnly(new Date());
    let todayLine = '';
    if (today >= rangeStart && today <= rangeEnd) {
      const leftPct = (daysBetween(rangeStart, today) / totalDays) * 100;
      todayLine = `<div class="gantt-today-line" style="left:${leftPct}%"></div>`;
    }

    const nameRowsHtml = rows.map((r) => {
      const t = r.task;
      const delayed = isDelayed(t);
      return `
        <div class="gantt-name-row${delayed ? ' delayed' : ''}" data-id="${t.id}" title="${escapeHtml(t.title)}">
          <span class="color-dot" style="background:${t.color}"></span>
          <span class="gantt-name-text">${delayed ? '⚠ ' : ''}${escapeHtml(t.title)}</span>
        </div>`;
    }).join('');

    const rowsHtml = rows.map((r) => {
      const leftPct = (daysBetween(rangeStart, r.start) / totalDays) * 100;
      const widthPct = ((daysBetween(r.start, r.end) + 1) / totalDays) * 100;
      const t = r.task;
      const delayed = isDelayed(t);
      const delayDegree = t.delay || 0;
      const overdueOverlay = delayed
        ? `<div class="gantt-bar-overdue" style="left:0%; width:${delayDegree}%"></div>`
        : '';
      return `
        <div class="gantt-bar${delayed ? ' delayed' : ''}" data-id="${t.id}" style="left:${leftPct}%; width:${widthPct}%; top:${r.lane * 34 + 4}px; border-color:${t.color}; background:${hexToRgba(t.color, 0.15)}" title="${escapeHtml(t.title)}（進捗 ${t.progress}%）${delayed ? ` - 遅延度 ${delayDegree}%` : ''}">
          <div class="gantt-bar-fill" style="width:${t.progress}%; background:${hexToRgba(t.color, 0.45)}"></div>
          ${overdueOverlay}
        </div>`;
    }).join('');

    const taskAreaHeight = Math.max(laneCount, 1) * 34 + 16;
    const goalAreaHeight = goalRows.length ? goalLaneCount * 24 + 20 : 0;
    const bodyHeight = taskAreaHeight + goalAreaHeight;

    const goalSectionLabel = goalRows.length
      ? `<div class="gantt-goal-section-label" style="top:${taskAreaHeight}px">◆ スモールゴール</div>`
      : '';

    const goalRowsHtml = goalRows.map((r) => {
      const leftPct = (daysBetween(rangeStart, r.start) / totalDays) * 100;
      const g = r.task;
      return `
        <div class="gantt-goal-marker${g.done ? ' done' : ''}" data-task-id="${g.taskId}" style="left:${leftPct}%; top:${taskAreaHeight + 16 + r.lane * 24}px; background:${hexToRgba(g.color, g.done ? 0.9 : 0.55)}; border-color:${g.color}" title="${escapeHtml(g.title)}${g.done ? ' - 完了' : ''}">
          <span class="gantt-goal-label">${escapeHtml(g.title)}</span>
        </div>`;
    }).join('');

    const namesGoalLabel = goalRows.length
      ? `<div class="gantt-names-goal-label" style="height:${goalAreaHeight}px">◆ スモールゴール</div>`
      : '';

    containerEl.innerHTML = `
      <div class="gantt">
        <div class="gantt-layout">
          <div class="gantt-names">
            <div class="gantt-names-header">予定</div>
            <div class="gantt-names-body">
              <div class="gantt-names-tasks" style="height:${taskAreaHeight}px">${nameRowsHtml}</div>
              ${namesGoalLabel}
            </div>
          </div>
          <div class="gantt-timeline">
            <div class="gantt-header">${headerCells}</div>
            <div class="gantt-body" style="height:${bodyHeight}px">
              <div class="gantt-gridlines">${gridlines}</div>
              ${todayLine}
              <div class="gantt-rows">${rowsHtml}</div>
              ${goalSectionLabel}
              ${goalRowsHtml}
              ${rows.length === 0 && goalRows.length === 0 ? '<div class="gantt-empty">この期間に予定はありません</div>' : ''}
            </div>
          </div>
        </div>
      </div>
    `;

    containerEl.querySelectorAll('.gantt-bar, .gantt-name-row').forEach((el) => {
      el.addEventListener('click', () => openModal(el.dataset.id));
    });
    containerEl.querySelectorAll('.gantt-goal-marker').forEach((el) => {
      el.addEventListener('click', () => openModal(el.dataset.taskId));
    });
  }

  function getFiscalYearStart(anchorDate) {
    const y = anchorDate.getFullYear();
    return anchorDate.getMonth() >= 3 ? y : y - 1;
  }

  function getYearMonthUnits(fiscalStartYear) {
    const units = [];
    for (let i = 0; i < 12; i++) {
      const m = (3 + i) % 12;
      const y = fiscalStartYear + (3 + i >= 12 ? 1 : 0);
      units.push({ label: `${m + 1}月`, start: new Date(y, m, 1), end: new Date(y, m + 1, 0) });
    }
    return units;
  }

  function getQuarterMonthUnits(anchorDate) {
    const units = [];
    const base = startOfMonth(anchorDate);
    for (let i = 0; i < 3; i++) {
      const start = addMonths(base, i);
      const end = endOfMonth(start);
      units.push({ label: monthLabel(start), start, end });
    }
    return units;
  }

  function getQuarterPeriodUnits(anchorDate) {
    const units = [];
    const base = startOfMonth(anchorDate);
    for (let i = 0; i < 3; i++) {
      const monthStart = addMonths(base, i);
      const y = monthStart.getFullYear(), m = monthStart.getMonth();
      const monthEnd = endOfMonth(monthStart);
      const segments = [
        { start: new Date(y, m, 1), end: new Date(y, m, 10), suffix: '上旬' },
        { start: new Date(y, m, 11), end: new Date(y, m, 20), suffix: '中旬' },
        { start: new Date(y, m, 21), end: monthEnd, suffix: '下旬' },
      ];
      segments.forEach((s, idx) => {
        units.push({ label: `${m + 1}月${s.suffix}`, start: s.start, end: s.end, monthStart: idx === 0 });
      });
    }
    return units;
  }

  function renderYearView() {
    const fiscalStartYear = getFiscalYearStart(state.anchors.year);
    const rangeStart = new Date(fiscalStartYear, 3, 1);
    const rangeEnd = new Date(fiscalStartYear + 1, 2, 31);
    renderGantt(document.getElementById('view-year'), rangeStart, rangeEnd, getYearMonthUnits(fiscalStartYear));
  }

  function renderQuarterView() {
    const monthUnits = getQuarterMonthUnits(state.anchors.quarter);
    const rangeStart = monthUnits[0].start, rangeEnd = monthUnits[monthUnits.length - 1].end;
    const periodUnits = getQuarterPeriodUnits(state.anchors.quarter);
    renderGantt(document.getElementById('view-quarter'), rangeStart, rangeEnd, periodUnits, goalsIntersecting(rangeStart, rangeEnd));
  }

  // ---------- Rendering: month calendar ----------
  // ---------- Googleカレンダー（読み取り専用） ----------
  async function fetchGcalMonth() {
    if (!state.gcal.connected || state.gcal.loading) return;
    const anchor = state.anchors.month;
    const key = `${anchor.getFullYear()}-${anchor.getMonth()}`;
    if (state.gcal.monthKey === key) return;
    state.gcal.loading = true;
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const gridStart = new Date(first.getFullYear(), first.getMonth(), 1 - first.getDay());
    const gridEnd = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + 42);
    const res = await window.scheduleAPI.gcalEvents(gridStart.toISOString(), gridEnd.toISOString());
    state.gcal.loading = false;
    state.gcal.monthKey = key;
    if (res.ok) {
      state.gcal.error = '';
      state.gcal.events = res.events.map((ev) => {
        if (ev.allDay) return ev;
        const d = new Date(ev.start);
        return {
          ...ev,
          dateKey: formatDate(d),
          timeLabel: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
        };
      });
    } else {
      state.gcal.error = res.error || '';
      state.gcal.events = [];
    }
    if (state.view === 'month') renderMonthView();
  }

  function gcalEventsOn(dateStr) {
    return state.gcal.events.filter((ev) => {
      if (ev.allDay) return ev.start <= dateStr && dateStr < ev.end;
      return ev.dateKey === dateStr;
    });
  }

  function startInlineMonthAdd(cellEl) {
    const existing = cellEl.querySelector('.month-inline-input');
    if (existing) { existing.focus(); return; }
    const date = cellEl.dataset.date;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'month-inline-input';
    input.placeholder = '予定を入力';
    input.maxLength = 80;
    let done = false;
    const commit = async () => {
      if (done) return;
      const text = input.value.trim();
      if (!text) { cancel(); return; }
      done = true;
      pushUndo();
      state.tasks.push({
        id: crypto.randomUUID(),
        title: text, description: '', start: date, end: date,
        label: '', color: '#4f7cff', progress: 0, delay: 0, scope: 'month', goals: [],
      });
      await persist();
      renderAll();
    };
    const cancel = () => {
      if (done) return;
      done = true;
      input.remove();
    };
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.stopPropagation(); cancel(); }
    });
    input.addEventListener('blur', () => commit());
    cellEl.appendChild(input);
    input.focus();
  }

  function renderMonthView() {
    const container = document.getElementById('view-month');
    const anchor = state.anchors.month;
    const year = anchor.getFullYear();
    const month = anchor.getMonth();
    const first = new Date(year, month, 1);
    const firstWeekday = first.getDay();
    const daysInMonth = endOfMonth(first).getDate();
    const totalCells = Math.ceil((firstWeekday + daysInMonth) / 7) * 7;
    const today = toDateOnly(new Date());

    const weekdaysHtml = WEEKDAYS_JA.map((w) => `<div class="month-weekday">${w}</div>`).join('');

    let cellsHtml = '';
    for (let i = 0; i < totalCells; i++) {
      const dayOffset = i - firstWeekday;
      const cellDate = new Date(year, month, 1 + dayOffset);
      const outside = cellDate.getMonth() !== month;
      const isToday = isSameDay(cellDate, today);
      const cellDateStr = formatDate(cellDate);
      const dayGoals = [];
      for (const t of state.tasks) {
        if (isLabelHiddenInMonth(t.label)) continue;
        for (const g of t.goals || []) {
          if (g.date === cellDateStr) dayGoals.push({ ...g, color: t.color, taskId: t.id, goalId: g.id });
        }
      }
      const dayTasks = state.tasks.filter((t) => t.scope === 'month' && parseDate(t.start) <= cellDate && cellDate <= parseDate(t.end));

      const taskChips = dayTasks.map((t) => `
        <div class="month-chip${isDelayed(t) ? ' delayed' : ''}" data-id="${t.id}" style="background:${t.color}" title="${escapeHtml(t.title)}（進捗 ${t.progress}%）">${escapeHtml(t.title)}</div>
      `).join('');

      const gcalChips = gcalEventsOn(cellDateStr).map((ev) => `
        <div class="month-gcal-chip" title="Googleカレンダー: ${escapeHtml(ev.title)}">${ev.timeLabel ? ev.timeLabel + ' ' : ''}${escapeHtml(ev.title)}</div>
      `).join('');

      const goalChips = dayGoals.map((g) => `
        <div class="month-goal-chip${g.done ? ' done' : ''}" data-task-id="${g.taskId}" data-goal-id="${g.goalId}" style="border-color:${g.color}" title="スモールゴール: ${escapeHtml(g.text)}${g.done ? ' - 完了' : ''}">◆ ${escapeHtml(g.text)}</div>
      `).join('');

      cellsHtml += `
        <div class="month-cell ${outside ? 'outside' : ''} ${isToday ? 'today' : ''}" data-date="${cellDateStr}">
          <div class="month-cell-date">${cellDate.getDate()}</div>
          ${gcalChips}
          ${taskChips}
          ${goalChips}
        </div>`;
    }

    container.innerHTML = `
      <div class="month-calendar">
        <div class="month-weekdays">${weekdaysHtml}</div>
        <div class="month-grid">${cellsHtml}</div>
      </div>
    `;

    container.querySelectorAll('.month-cell').forEach((el) => {
      el.addEventListener('click', () => startInlineMonthAdd(el));
    });
    container.querySelectorAll('.month-chip[data-id]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        openModal(el.dataset.id);
      });
    });
    container.querySelectorAll('.month-goal-chip[data-goal-id]').forEach((el) => {
      el.addEventListener('click', async (e) => {
        e.stopPropagation();
        const taskId = el.dataset.taskId;
        const goalId = el.dataset.goalId;
        const task = state.tasks.find((t) => t.id === taskId);
        if (!task) return;
        const goal = (task.goals || []).find((g) => g.id === goalId);
        if (!goal) return;
        goal.done = !goal.done;
        await persist();
        renderAll();
      });
    });
    container.querySelectorAll('.month-gcal-chip').forEach((el) => {
      el.addEventListener('click', (e) => e.stopPropagation());
    });

    fetchGcalMonth();
  }

  // ---------- Navigation ----------
  function updatePeriodLabel() {
    const label = document.getElementById('period-label');
    if (state.view === 'year') {
      label.textContent = `${getFiscalYearStart(state.anchors.year)}年度`;
    } else if (state.view === 'quarter') {
      const units = getQuarterMonthUnits(state.anchors.quarter);
      label.textContent = `${units[0].label} 〜 ${units[2].label}`;
    } else {
      label.textContent = monthLabel(state.anchors.month);
    }
  }

  function navigate(direction) {
    if (state.view === 'year') state.anchors.year = addMonths(state.anchors.year, 12 * direction);
    else if (state.view === 'quarter') state.anchors.quarter = addMonths(state.anchors.quarter, 3 * direction);
    else state.anchors.month = addMonths(state.anchors.month, 1 * direction);
    renderAll();
  }

  function renderAll() {
    updatePeriodLabel();
    document.querySelectorAll('.view-panel').forEach((p) => p.classList.remove('active'));
    document.getElementById('view-' + state.view).classList.add('active');
    if (state.view === 'year') renderYearView();
    else if (state.view === 'quarter') renderQuarterView();
    else renderMonthView();
    renderSidebar();
    renderLabelSelectOptions();
  }

  // ---------- Modal ----------
  function openModal(id, prefillDate) {
    state.editingId = id || null;
    const modal = document.getElementById('task-modal');
    const title = document.getElementById('modal-title');
    const deleteBtn = document.getElementById('delete-task-btn');

    renderLabelSelectOptions();

    if (id) {
      const t = state.tasks.find((x) => x.id === id);
      title.textContent = '予定を編集';
      document.getElementById('field-title').value = t.title;
      document.getElementById('field-description').value = t.description || '';
      document.getElementById('field-start').value = t.start;
      document.getElementById('field-end').value = t.end;
      document.getElementById('field-label').value = t.label || '';
      document.getElementById('field-color').value = t.color;
      document.getElementById('field-progress').value = t.progress;
      document.getElementById('progress-value-label').textContent = t.progress + '%';
      document.getElementById('field-delay').value = t.delay || 0;
      document.getElementById('delay-value-label').textContent = (t.delay || 0) + '%';
      document.getElementById('field-scope').value = t.scope === 'month' ? 'month' : 'main';
      state.draftGoals = (t.goals || []).map((g) => ({ ...g }));
      deleteBtn.classList.remove('hidden');
    } else {
      title.textContent = '新規予定';
      document.getElementById('task-form').reset();
      const d = prefillDate || formatDate(currentAnchor());
      document.getElementById('field-start').value = d;
      document.getElementById('field-end').value = d;
      document.getElementById('field-label').value = '';
      document.getElementById('field-color').value = '#4f7cff';
      document.getElementById('field-scope').value = (prefillDate || state.view === 'month') ? 'month' : 'main';
      document.getElementById('field-progress').value = 0;
      document.getElementById('progress-value-label').textContent = '0%';
      document.getElementById('field-delay').value = 0;
      document.getElementById('delay-value-label').textContent = '0%';
      state.draftGoals = [];
      deleteBtn.classList.add('hidden');
    }
    renderGoalsList();
    modal.classList.remove('hidden');
  }

  function closeModal() {
    document.getElementById('task-modal').classList.add('hidden');
    state.editingId = null;
    state.draftGoals = [];
  }

  // ---------- Events ----------
  function setupEventListeners() {
    document.querySelectorAll('.view-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.view = btn.dataset.view;
        document.querySelectorAll('.view-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        renderAll();
      });
    });
    document.querySelector('.view-btn[data-view="year"]').classList.add('active');

    document.getElementById('nav-prev').addEventListener('click', () => navigate(-1));
    document.getElementById('nav-next').addEventListener('click', () => navigate(1));
    document.getElementById('nav-today').addEventListener('click', () => {
      state.anchors[state.view] = toDateOnly(new Date());
      renderAll();
    });

    document.getElementById('add-task-btn').addEventListener('click', () => openModal(null));
    document.getElementById('modal-close').addEventListener('click', closeModal);
    document.getElementById('cancel-task-btn').addEventListener('click', closeModal);
    document.getElementById('task-modal').addEventListener('click', (e) => {
      if (e.target.id === 'task-modal') closeModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!document.getElementById('gcal-modal').classList.contains('hidden')) {
        document.getElementById('gcal-modal').classList.add('hidden');
      } else if (!document.getElementById('label-modal').classList.contains('hidden')) {
        document.getElementById('label-modal').classList.add('hidden');
      } else if (!document.getElementById('task-modal').classList.contains('hidden')) {
        closeModal();
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key.toLowerCase() !== 'z' || !(e.metaKey || e.ctrlKey)) return;
      const active = document.activeElement;
      const isEditable = active && (['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName) || active.isContentEditable);
      if (isEditable) return;
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
    });

    document.getElementById('field-progress').addEventListener('input', (e) => {
      document.getElementById('progress-value-label').textContent = e.target.value + '%';
    });

    document.getElementById('field-delay').addEventListener('input', (e) => {
      document.getElementById('delay-value-label').textContent = e.target.value + '%';
    });

    document.getElementById('task-filter').addEventListener('input', (e) => {
      state.filterText = e.target.value;
      renderSidebar();
    });

    document.getElementById('add-goal-btn').addEventListener('click', () => {
      const input = document.getElementById('new-goal-text');
      const dateInput = document.getElementById('new-goal-date');
      const text = input.value.trim();
      if (!text) return;
      state.draftGoals.push({ id: crypto.randomUUID(), text, date: dateInput.value, done: false });
      input.value = '';
      dateInput.value = '';
      renderGoalsList();
    });
    document.getElementById('new-goal-text').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        document.getElementById('add-goal-btn').click();
      }
    });

    // ---- Google連携モーダル ----
    async function refreshGcalModal() {
      const st = await window.scheduleAPI.gcalStatus();
      state.gcal.connected = st.connected;
      document.getElementById('gcal-status').textContent = st.connected
        ? '連携中: Googleカレンダーの予定を月間ビューに表示しています'
        : (st.unsupported ? 'Web版では利用できません（Electron版をご利用ください）' : '未連携');
      document.getElementById('gcal-setup').classList.toggle('hidden', st.connected || !!st.unsupported);
      document.getElementById('gcal-disconnect-btn').classList.toggle('hidden', !st.connected);
      document.getElementById('gcal-connect-btn').classList.toggle('hidden', st.connected || !!st.unsupported);
    }
    document.getElementById('gcal-btn').addEventListener('click', async () => {
      document.getElementById('gcal-error').classList.add('hidden');
      await refreshGcalModal();
      document.getElementById('gcal-modal').classList.remove('hidden');
    });
    document.getElementById('gcal-modal-close').addEventListener('click', () => {
      document.getElementById('gcal-modal').classList.add('hidden');
    });
    document.getElementById('gcal-modal').addEventListener('click', (e) => {
      if (e.target.id === 'gcal-modal') document.getElementById('gcal-modal').classList.add('hidden');
    });
    document.getElementById('gcal-console-link').addEventListener('click', (e) => {
      e.preventDefault();
      window.open('https://console.cloud.google.com/apis/credentials');
    });
    document.getElementById('gcal-connect-btn').addEventListener('click', async () => {
      const errEl = document.getElementById('gcal-error');
      errEl.classList.add('hidden');
      document.getElementById('gcal-status').textContent = 'ブラウザが開きます。Googleアカウントでログインして許可してください…';
      const res = await window.scheduleAPI.gcalConnect(
        document.getElementById('gcal-client-id').value,
        document.getElementById('gcal-client-secret').value
      );
      if (res.ok) {
        state.gcal.monthKey = '';
        await refreshGcalModal();
        renderAll();
      } else {
        await refreshGcalModal();
        errEl.textContent = res.error || '接続に失敗しました';
        errEl.classList.remove('hidden');
      }
    });
    document.getElementById('gcal-disconnect-btn').addEventListener('click', async () => {
      await window.scheduleAPI.gcalDisconnect();
      state.gcal = { connected: false, monthKey: '', events: [], loading: false, error: '' };
      await refreshGcalModal();
      renderAll();
    });

    document.getElementById('manage-labels-btn').addEventListener('click', () => {
      renderLabelList();
      document.getElementById('label-modal').classList.remove('hidden');
    });
    document.getElementById('label-modal-close').addEventListener('click', () => {
      document.getElementById('label-modal').classList.add('hidden');
    });
    document.getElementById('label-modal').addEventListener('click', (e) => {
      if (e.target.id === 'label-modal') document.getElementById('label-modal').classList.add('hidden');
    });
    document.getElementById('label-add-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const nameInput = document.getElementById('new-label-name');
      const colorInput = document.getElementById('new-label-color');
      const hideMonthInput = document.getElementById('new-label-hide-month');
      const name = nameInput.value.trim();
      if (!name) return;
      if (state.labels.some((l) => l.name === name)) {
        alert('同じ名前のカレンダーが既にあります');
        return;
      }
      pushUndo();
      addLabel(name, colorInput.value, hideMonthInput.checked);
      await persist();
      nameInput.value = '';
      hideMonthInput.checked = false;
      renderLabelList();
      renderLabelSelectOptions();
    });

    document.getElementById('task-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const titleVal = document.getElementById('field-title').value.trim();
      const description = document.getElementById('field-description').value.trim();
      let start = document.getElementById('field-start').value;
      let end = document.getElementById('field-end').value;
      const label = document.getElementById('field-label').value;
      const color = document.getElementById('field-color').value;
      const progress = Number(document.getElementById('field-progress').value);
      const delay = Number(document.getElementById('field-delay').value);
      const scope = document.getElementById('field-scope').value === 'month' ? 'month' : 'main';
      const goals = state.draftGoals.slice();

      if (!titleVal || !start || !end) return;
      if (end < start) { const tmp = start; start = end; end = tmp; }

      pushUndo();
      if (state.editingId) {
        const t = state.tasks.find((x) => x.id === state.editingId);
        Object.assign(t, { title: titleVal, description, start, end, label, color, progress, delay, scope, goals });
      } else {
        state.tasks.push({
          id: crypto.randomUUID(),
          title: titleVal, description, start, end, label, color, progress, delay, scope, goals,
        });
      }
      await persist();
      closeModal();
      renderAll();
    });

    document.getElementById('delete-task-btn').addEventListener('click', async () => {
      if (!state.editingId) return;
      if (!confirm('この予定を削除しますか？')) return;
      pushUndo();
      state.tasks = state.tasks.filter((t) => t.id !== state.editingId);
      await persist();
      closeModal();
      renderAll();
    });
  }

  async function init() {
    await loadData();
    const today = toDateOnly(new Date());
    state.anchors = { year: today, quarter: today, month: today };
    setupEventListeners();
    try {
      const st = await window.scheduleAPI.gcalStatus();
      state.gcal.connected = !!st.connected;
    } catch {}
    renderAll();
  }

  init();
})();
