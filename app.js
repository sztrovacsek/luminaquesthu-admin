const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---------------------------------------------------------------- helpers --

function escapeHtml(s) {
  return (s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function statusLabel(s) {
  return { draft: 'Vázlat', in_review: 'Ellenőrzésre vár', published: 'Publikált', archived: 'Archivált' }[s] || s;
}

function roleLabel(r) {
  return { student: 'diák', teacher: 'tanár', quest_manager: 'quest manager', admin: 'admin' }[r] || r;
}

// A task is editable if the current user authored it, or holds a role that
// can review any task (quest_manager, admin) — mirrors the task_update RLS
// policy exactly, so the UI never offers an action the database will reject.
function canEditTask(t) {
  return currentRole === 'admin' || currentRole === 'quest_manager' || t.author_id === currentUser.id;
}

function typeLabel(t) {
  return {
    numeric_input: 'Numerikus válasz',
    multiple_choice: 'Feleletválasztós',
    true_false: 'Igaz/Hamis',
    ordering: 'Sorba rendezés',
    free_text: 'Szöveges válasz (kézi javítás)'
  }[t] || t;
}

function blankAnswerAndContent(type) {
  switch (type) {
    case 'numeric_input':
      return { content: { stem: '', fields: [{ name: 'x', label: 'x =' }], hints: [] }, answer_key: { values: { x: 0 } } };
    case 'multiple_choice':
      return { content: { stem: '', choices: ['', '', '', ''], hints: [] }, answer_key: { correct_index: 0 } };
    case 'true_false':
      return { content: { stem: '', hints: [] }, answer_key: { correct: true } };
    case 'ordering':
      return { content: { stem: '', items: [{ id: 'a', text: '' }, { id: 'b', text: '' }] }, answer_key: { correct_order: ['a', 'b'] } };
    case 'free_text':
      return { content: { stem: '', hints: [] }, answer_key: { grading: 'manual', sample_solution: '' } };
  }
}

// ------------------------------------------------------------------ auth --

const loginView = document.getElementById('login-view');
const deniedView = document.getElementById('denied-view');
const appView = document.getElementById('app-view');

function showView(view) {
  loginView.style.display = view === 'login' ? 'flex' : 'none';
  deniedView.style.display = view === 'denied' ? 'flex' : 'none';
  appView.style.display = view === 'app' ? 'block' : 'none';
}

document.getElementById('login-btn').onclick = async () => {
  const email = document.getElementById('login-email').value.trim();
  const msg = document.getElementById('login-msg');
  if (!email) return;
  const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.href } });
  msg.textContent = error ? error.message : 'Link elküldve, nézd meg az e-mailjeidet.';
  msg.className = 'msg ' + (error ? 'err' : 'ok');
};

document.getElementById('signout-btn').onclick = () => sb.auth.signOut();
document.getElementById('denied-signout').onclick = () => sb.auth.signOut();

let currentUser = null;
let currentRole = null;

async function handleSession(session) {
  if (!session) {
    currentUser = null;
    currentRole = null;
    showView('login');
    return;
  }
  currentUser = session.user;
  const { data: profile, error } = await sb
    .from('profiles').select('role, full_name').eq('id', currentUser.id).single();

  if (error || !profile || profile.role === 'student') {
    currentRole = profile ? profile.role : null;
    showView('denied');
    return;
  }
  currentRole = profile.role;
  document.getElementById('user-badge').textContent = `${profile.full_name || currentUser.email} · ${roleLabel(profile.role)}`;
  showView('app');
  await loadWorlds();
}

sb.auth.onAuthStateChange((_event, session) => handleSession(session));
sb.auth.getSession().then(({ data }) => handleSession(data.session));

// -------------------------------------------------------------- data load --

const worldSelect = document.getElementById('world-select');
const questSelect = document.getElementById('quest-select');
const taskTbody = document.getElementById('task-tbody');
const questStats = document.getElementById('quest-stats');

async function loadWorlds() {
  const { data, error } = await sb.from('world').select('id, name').order('name');
  if (error) return console.error(error);
  worldSelect.innerHTML = data.map(w => `<option value="${w.id}">${escapeHtml(w.name)}</option>`).join('');
  await loadQuests();
}
worldSelect.onchange = loadQuests;

async function loadQuests() {
  const worldId = worldSelect.value;
  const { data, error } = await sb.from('quest')
    .select('id, title, grade_band, order_index')
    .eq('world_id', worldId).order('grade_band').order('order_index');
  if (error) return console.error(error);
  questSelect.innerHTML = data.map(q => `<option value="${q.id}">[${q.grade_band}] ${escapeHtml(q.title)}</option>`).join('');
  await loadTasks();
}
questSelect.onchange = loadTasks;

let tasksCache = [];

async function loadTasks() {
  const questId = questSelect.value;
  if (!questId) { taskTbody.innerHTML = ''; questStats.textContent = ''; return; }
  const { data, error } = await sb.from('task').select('*').eq('quest_id', questId).order('difficulty');
  if (error) { console.error(error); return; }
  tasksCache = data;
  renderTaskTable();
  const counts = {};
  data.forEach(t => { counts[t.difficulty] = (counts[t.difficulty] || 0) + 1; });
  questStats.textContent = `${data.length} feladat · nehézség szerint: ` +
    Object.entries(counts).map(([d, c]) => `${d}:${c}`).join(', ');
}

function renderTaskTable() {
  taskTbody.innerHTML = tasksCache.map(t => `
    <tr>
      <td><span class="diff-dots">${'\u25cf'.repeat(t.difficulty)}${'\u25cb'.repeat(5 - t.difficulty)}</span></td>
      <td>${typeLabel(t.type)}</td>
      <td class="stem">${escapeHtml((t.content.stem || '').slice(0, 90))}</td>
      <td><span class="badge ${t.status}">${statusLabel(t.status)}</span></td>
      <td>${t.xp_value}</td>
      <td>
        ${canEditTask(t)
          ? `<button class="btn small" onclick="openEditor('${t.id}')">Szerkeszt</button>`
          : `<button class="btn small" onclick="viewTask('${t.id}')">Megtekint</button>`}
        <button class="btn small" onclick="duplicateTask('${t.id}')">Másol</button>
        ${canEditTask(t) ? `<button class="btn small danger" onclick="archiveTask('${t.id}')">Archivál</button>` : ''}
      </td>
    </tr>
  `).join('');
}

// --------------------------------------------------------------- editor ---

const editorPanel = document.getElementById('editor-panel');
const editorBody = document.getElementById('editor-body');
const editorTitle = document.getElementById('editor-title');
const editorMsg = document.getElementById('editor-msg');

let editingTask = null;
let isNewTask = false;
let isReadOnly = false;

document.getElementById('editor-close').onclick = () => { editorPanel.style.display = 'none'; };

document.getElementById('new-task-btn').onclick = () => {
  if (!questSelect.value) { alert('Előbb válassz egy quest-et.'); return; }
  const base = blankAnswerAndContent('numeric_input');
  const blank = {
    id: null, quest_id: questSelect.value, type: 'numeric_input', difficulty: 1,
    content: base.content, answer_key: base.answer_key,
    xp_value: 10, status: 'draft', source: 'teacher_upload', locale: 'hu'
  };
  openEditorWithTask(blank, true);
};

window.openEditor = function (taskId) {
  const task = JSON.parse(JSON.stringify(tasksCache.find(t => t.id === taskId)));
  openEditorWithTask(task, false, false);
};

window.viewTask = function (taskId) {
  // Reachable when the task is visible (published, or the viewer is a
  // reviewer) but not editable by this user — read-only by construction,
  // not just by UI convention: the Save button is hidden entirely below.
  const task = JSON.parse(JSON.stringify(tasksCache.find(t => t.id === taskId)));
  openEditorWithTask(task, false, true);
};

window.duplicateTask = function (taskId) {
  const task = JSON.parse(JSON.stringify(tasksCache.find(t => t.id === taskId)));
  task.id = null;
  task.status = 'draft';
  task.source = 'teacher_upload';
  openEditorWithTask(task, true, false);
};

window.archiveTask = async function (taskId) {
  if (!confirm('Biztosan archiválod ezt a feladatot?')) return;
  const { error } = await sb.from('task').update({ status: 'archived' }).eq('id', taskId);
  if (error) return alert(error.message);
  await loadTasks();
};

window.moveOrderRow = function (btn, dir) {
  const row = btn.closest('[data-order-row]');
  const sibling = dir < 0 ? row.previousElementSibling : row.nextElementSibling;
  if (!sibling) return;
  if (dir < 0) row.parentElement.insertBefore(row, sibling);
  else row.parentElement.insertBefore(sibling, row);
};

function openEditorWithTask(task, isNew, readOnly) {
  editingTask = task;
  isNewTask = isNew;
  isReadOnly = !!readOnly;
  editorTitle.textContent = isReadOnly
    ? 'Feladat megtekintése (csak olvasható)'
    : (isNew ? (task.id ? 'Feladat másolása' : 'Új feladat') : 'Feladat szerkesztése');
  editorMsg.textContent = isReadOnly
    ? 'Ezt a feladatot nem te írtad, ezért csak megtekintheted. Másolással készíthetsz belőle saját, szerkeszthető verziót.'
    : '';
  editorMsg.className = 'msg';
  editorBody.innerHTML = renderEditorForm(task, isNew);
  bindCommonEditorEvents();
  bindTypeSpecificEvents(task.type);
  if (isReadOnly) {
    editorBody.querySelectorAll('input, textarea, select, button').forEach(el => { el.disabled = true; });
  }
  document.getElementById('editor-save').style.display = isReadOnly ? 'none' : 'inline-block';
  if (isNew) {
    const typeSelect = document.getElementById('f-type');
    if (typeSelect) {
      typeSelect.onchange = (e) => {
        const newType = e.target.value;
        const stem = document.getElementById('f-stem').value;
        const blank = blankAnswerAndContent(newType);
        blank.content.stem = stem;
        editingTask.type = newType;
        editingTask.content = blank.content;
        editingTask.answer_key = blank.answer_key;
        document.getElementById('type-specific-legend').textContent = typeLabel(newType);
        document.getElementById('type-specific').innerHTML = renderTypeSpecific(editingTask);
        bindTypeSpecificEvents(newType);
      };
    }
  }
  editorPanel.style.display = 'block';
}

function hintRow(h) {
  return `<div class="list-row" data-hint-row>
    <input type="text" value="${escapeHtml(h)}" style="flex:1">
    <button type="button" class="btn small danger" onclick="this.parentElement.remove()">&times;</button>
  </div>`;
}

function fieldRow(f, value) {
  return `<div class="list-row" data-field-row>
    <input type="text" class="fname" placeholder="név (pl. x)" value="${escapeHtml(f.name)}" style="width:90px">
    <input type="text" class="flabel" placeholder="címke (pl. x =)" value="${escapeHtml(f.label)}" style="flex:1">
    <input type="number" class="fvalue" placeholder="helyes érték" value="${value ?? ''}" step="any">
    <button type="button" class="btn small danger" onclick="this.parentElement.remove()">&times;</button>
  </div>`;
}

function choiceRow(text, checked) {
  return `<div class="list-row" data-choice-row>
    <input type="radio" name="correct-choice" ${checked ? 'checked' : ''}>
    <input type="text" class="cchoice" value="${escapeHtml(text)}" style="flex:1">
    <button type="button" class="btn small danger" onclick="this.parentElement.remove()">&times;</button>
  </div>`;
}

function orderRow(text) {
  return `<div class="list-row" data-order-row>
    <input type="text" value="${escapeHtml(text)}" style="flex:1">
    <button type="button" class="btn small" onclick="moveOrderRow(this,-1)">&uarr;</button>
    <button type="button" class="btn small" onclick="moveOrderRow(this,1)">&darr;</button>
    <button type="button" class="btn small danger" onclick="this.parentElement.remove()">&times;</button>
  </div>`;
}

function renderEditorForm(task, isNew) {
  return `
    <label class="field-label">Szöveg (stem)</label>
    <textarea id="f-stem" rows="3">${escapeHtml(task.content.stem || '')}</textarea>

    <div style="display:flex; gap:12px;">
      <div style="flex:1">
        <label class="field-label">Nehézség</label>
        <select id="f-difficulty" style="width:100%">
          ${[1, 2, 3, 4, 5].map(d => `<option value="${d}" ${d === task.difficulty ? 'selected' : ''}>${d}</option>`).join('')}
        </select>
      </div>
      <div style="flex:1">
        <label class="field-label">XP</label>
        <input type="number" id="f-xp" value="${task.xp_value}" style="width:100%">
      </div>
    </div>

    <label class="field-label">Állapot</label>
    <select id="f-status" style="width:100%">
      ${['draft', 'in_review', 'published', 'archived'].map(s => `<option value="${s}" ${s === task.status ? 'selected' : ''}>${statusLabel(s)}</option>`).join('')}
    </select>

    <label class="field-label">Típus</label>
    ${isNew
      ? `<select id="f-type" style="width:100%">
          ${['numeric_input', 'multiple_choice', 'true_false', 'ordering', 'free_text'].map(t => `<option value="${t}" ${t === task.type ? 'selected' : ''}>${typeLabel(t)}</option>`).join('')}
        </select>`
      : `<div class="muted">${typeLabel(task.type)} (típus mentés után nem módosítható)</div>`}

    <fieldset>
      <legend>Segítségek (hints)</legend>
      <div id="hints-list">${(task.content.hints || []).map(h => hintRow(h)).join('')}</div>
      <button type="button" class="btn small" id="add-hint">+ Segítség</button>
    </fieldset>

    <fieldset>
      <legend id="type-specific-legend">${typeLabel(task.type)}</legend>
      <div id="type-specific">${renderTypeSpecific(task)}</div>
    </fieldset>
  `;
}

function renderTypeSpecific(task) {
  const c = task.content;
  const a = task.answer_key;
  if (task.type === 'numeric_input') {
    return `
      <div id="fields-list">
        ${c.fields.map(f => fieldRow(f, a.values ? a.values[f.name] : '')).join('')}
      </div>
      <button type="button" class="btn small" id="add-field">+ Mező</button>
      <p class="muted" style="font-size:12px; margin-top:8px">A mező neve (pl. "x", "y") kell hogy megegyezzen a helyes értékkel párosítva.</p>
    `;
  }
  if (task.type === 'multiple_choice') {
    return `
      <div id="choices-list">
        ${c.choices.map((choice, i) => choiceRow(choice, i === a.correct_index)).join('')}
      </div>
      <button type="button" class="btn small" id="add-choice">+ Válasz</button>
      <p class="muted" style="font-size:12px; margin-top:8px">Jelöld be a rádiógombbal a helyes választ.</p>
    `;
  }
  if (task.type === 'true_false') {
    return `
      <select id="tf-correct" style="width:100%">
        <option value="true" ${a.correct === true ? 'selected' : ''}>Igaz</option>
        <option value="false" ${a.correct === false ? 'selected' : ''}>Hamis</option>
      </select>
    `;
  }
  if (task.type === 'ordering') {
    const itemsById = {};
    (c.items || []).forEach(it => { itemsById[it.id] = it.text; });
    const orderedTexts = (a.correct_order && a.correct_order.length ? a.correct_order : Object.keys(itemsById))
      .map(id => itemsById[id] ?? '');
    return `
      <p class="muted" style="font-size:12px; margin-bottom:8px">Add meg a lépéseket helyes sorrendben — a diákoknak a rendszer összekeverve fogja mutatni.</p>
      <div id="order-list">${orderedTexts.map(t => orderRow(t)).join('')}</div>
      <button type="button" class="btn small" id="add-order-row">+ Lépés</button>
    `;
  }
  if (task.type === 'free_text') {
    return `
      <label class="field-label">Minta megoldás (csak tanárnak látható)</label>
      <textarea id="ft-sample" rows="4">${escapeHtml(a.sample_solution || '')}</textarea>
      <p class="muted" style="font-size:12px; margin-top:8px">Ez a feladattípus manuális javítást igényel, nem értékelődik ki automatikusan.</p>
    `;
  }
  return '';
}

function bindCommonEditorEvents() {
  document.getElementById('add-hint').onclick = () => {
    document.getElementById('hints-list').insertAdjacentHTML('beforeend', hintRow(''));
  };
}

function bindTypeSpecificEvents(type) {
  if (type === 'numeric_input') {
    const btn = document.getElementById('add-field');
    if (btn) btn.onclick = () => {
      document.getElementById('fields-list').insertAdjacentHTML('beforeend', fieldRow({ name: '', label: '' }, ''));
    };
  } else if (type === 'multiple_choice') {
    const btn = document.getElementById('add-choice');
    if (btn) btn.onclick = () => {
      document.getElementById('choices-list').insertAdjacentHTML('beforeend', choiceRow('', false));
    };
  } else if (type === 'ordering') {
    const btn = document.getElementById('add-order-row');
    if (btn) btn.onclick = () => {
      document.getElementById('order-list').insertAdjacentHTML('beforeend', orderRow(''));
    };
  }
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

document.getElementById('editor-save').onclick = async () => {
  if (isReadOnly) return;
  const t = editingTask;
  const stem = document.getElementById('f-stem').value.trim();
  const difficulty = parseInt(document.getElementById('f-difficulty').value, 10);
  const xp_value = parseInt(document.getElementById('f-xp').value, 10);
  const status = document.getElementById('f-status').value;
  const hints = [...document.querySelectorAll('#hints-list [data-hint-row] input')]
    .map(i => i.value.trim()).filter(Boolean);

  const content = { stem, hints };
  const answer_key = {};

  if (t.type === 'numeric_input') {
    const rows = [...document.querySelectorAll('#fields-list [data-field-row]')];
    content.fields = rows.map(r => ({
      name: r.querySelector('.fname').value.trim(),
      label: r.querySelector('.flabel').value.trim()
    }));
    answer_key.values = {};
    rows.forEach(r => {
      const name = r.querySelector('.fname').value.trim();
      answer_key.values[name] = parseFloat(r.querySelector('.fvalue').value);
    });
  } else if (t.type === 'multiple_choice') {
    const rows = [...document.querySelectorAll('#choices-list [data-choice-row]')];
    content.choices = rows.map(r => r.querySelector('.cchoice').value.trim());
    answer_key.correct_index = rows.findIndex(r => r.querySelector('input[type=radio]').checked);
  } else if (t.type === 'true_false') {
    answer_key.correct = document.getElementById('tf-correct').value === 'true';
  } else if (t.type === 'ordering') {
    const rows = [...document.querySelectorAll('#order-list [data-order-row]')];
    const steps = rows.map(r => r.querySelector('input[type=text]').value.trim());
    const ids = steps.map((_, i) => String.fromCharCode(97 + i));
    const correct_order = ids.slice();
    const shuffled = shuffle(ids.map((id, i) => ({ id, text: steps[i] })));
    content.items = shuffled;
    answer_key.correct_order = correct_order;
  } else if (t.type === 'free_text') {
    answer_key.grading = 'manual';
    answer_key.sample_solution = document.getElementById('ft-sample').value.trim();
  }

  const payload = {
    quest_id: t.quest_id, type: t.type, difficulty, content, answer_key,
    xp_value, status, source: t.source, locale: t.locale || 'hu', author_id: currentUser.id
  };

  editorMsg.textContent = 'Mentés...';
  editorMsg.className = 'msg';

  const { error } = isNewTask
    ? await sb.from('task').insert(payload)
    : await sb.from('task').update(payload).eq('id', t.id);

  if (error) {
    editorMsg.textContent = error.message;
    editorMsg.className = 'msg err';
    return;
  }
  editorMsg.textContent = 'Mentve.';
  editorMsg.className = 'msg ok';
  await loadTasks();
  setTimeout(() => { editorPanel.style.display = 'none'; }, 600);
};
