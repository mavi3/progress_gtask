/*
 * Google Tasks: estado "en progreso" (solo en este navegador).
 *
 * Flujo:
 *   - Primer clic sobre el círculo de una tarea incompleta: se intercepta el
 *     evento antes de que llegue a Google, la tarea queda "en progreso" en
 *     chrome.storage.local y se dibuja medio círculo relleno.
 *   - Segundo clic: el evento pasa sin tocarlo, Google completa la tarea y se
 *     borra el estado local.
 *
 * Google nunca se entera del estado intermedio: para el servidor la tarea
 * sigue incompleta.
 *
 * El DOM de Google Tasks está ofuscado y cambia sin aviso, así que la
 * detección no depende de clases. Usa el aria-label del botón ("Marcar como
 * completada", "Mark complete", ...), role="checkbox" y, como último recurso,
 * el tachado del título. La tarea se identifica por el data-task-id de su
 * tarjeta; si no lo hay, por el título.
 */
(() => {
  'use strict';

  if (window.__gtpInstalled) return;
  window.__gtpInstalled = true;

  const TASK_PREFIX = 'gtp:task:';
  const SETTINGS_KEY = 'gtp:settings';
  const LOG_TAG = '[GTP]';
  // Proporciones del círculo de Google (ícono Material, viewBox de 24): anillo
  // de 20 px con trazo de 2 px. El relleno mide 12 px.
  const RING_RATIO = 20 / 24;
  const RING_WIDTH_RATIO = 2 / 24;
  const PIE_RATIO = 12 / 24;
  // Tras completar una tarea, ignora clics extra sobre ella mientras Google
  // anima el cambio, para no volver a ponerla "en progreso" por error.
  const COMPLETE_COOLDOWN_MS = 2500;
  const KEYBOARD_GUARD_MS = 600;

  // aria-label / tooltip del botón de completar, en varios idiomas.
  const TOGGLE_LABEL_RE = new RegExp(
    [
      '\\b(mark|marcar|marquer|segna|contrassegna|markeer|oznacz)\\b.{0,40}(complet|conclu|termin|hecho|done|finaliz|voltooid|wykonan)',
      '(erledigt|abgeschlossen|fertig).{0,40}markier',
      '^\\s*(complete|completar|concluir|terminer|erledigen)\\s*$',
    ].join('|'),
    'i',
  );
  // Etiqueta del mismo botón cuando la tarea ya está completada.
  const COMPLETED_LABEL_RE =
    /(incomplet|uncomplet|not complete|no complet|sin completar|pendiente|n[aã]o conclu|non termin|non complet|nicht erledigt|unerledigt|niet voltooid|unmark|desmarcar)/i;

  const TOGGLE_QUERY = '[role="checkbox"],[aria-label],[data-tooltip]';
  const ROW_QUERY = '[role="listitem"],[role="treeitem"],[role="row"],[role="option"],li';
  const SKIP_TEXT_QUERY =
    '[aria-hidden="true"],script,style,noscript,template,textarea,[role="tooltip"],.gtp-ui';
  const ICON_FONT_RE = /material|symbol|icon/i;

  const records = new Map(); // clave normalizada del título -> { title, since }
  const recentlyCompleted = new Map(); // clave -> timestamp
  const describeCache = new WeakMap(); // toggle -> { signature, info }
  let settings = { debug: false };
  let ready = false;
  let alive = true;
  let gesture = null; // { toggle, decision, time }
  let keyboardGuard = null; // { toggle, action, until }
  let renderFrame = 0;
  let lastDebugSummary = '';

  // Atributos propios que se ponen sobre elementos de Google. El motor de
  // plantillas de Google a veces los borra al volver a dibujar un elemento
  // (pasa, por ejemplo, al mover el foco por el menú de la tarea); se guarda
  // el valor deseado para reponerlo de inmediato desde el observer.
  const OWN_ATTRS = ['data-gtp-state', 'data-gtp-rel', 'data-gtp-fresh', 'data-gtp-wrap', 'data-gtp-overlay'];
  const ownAttrs = new WeakMap(); // elemento -> Map(atributo -> valor)

  function setOwnAttr(el, name, value = '') {
    let attrs = ownAttrs.get(el);
    if (!attrs) ownAttrs.set(el, (attrs = new Map()));
    attrs.set(name, value);
    if (el.getAttribute(name) !== value) el.setAttribute(name, value);
  }

  function removeOwnAttr(el, name) {
    const attrs = ownAttrs.get(el);
    if (attrs) attrs.delete(name);
    el.removeAttribute(name);
  }

  const ownAttr = (el, name) => ownAttrs.get(el)?.get(name);

  // ---------------------------------------------------------------------------
  // Detección del botón, la fila y el título
  // ---------------------------------------------------------------------------

  const labelOf = (el) => el.getAttribute('aria-label') || el.getAttribute('data-tooltip') || '';

  // Google usa "Marcar como completada: <título>". Las expresiones regulares
  // se aplican solo a la acción, para que palabras del título (p. ej.
  // "pendientes") no cambien el resultado.
  function splitLabel(label) {
    const match = /^([^:]{1,60}):\s+([\s\S]+)$/.exec(label);
    return match ? { action: match[1], title: match[2].trim() } : { action: label.slice(0, 80), title: '' };
  }

  function isToggleCandidate(el) {
    if (!(el instanceof Element) || el.closest('.gtp-ui')) return false;
    if (el.getAttribute('role') === 'checkbox') return true;
    const label = labelOf(el);
    return label.length > 0 && TOGGLE_LABEL_RE.test(splitLabel(label).action);
  }

  // Si hay botones anidados (p. ej. wrapper con tooltip + botón con aria-label),
  // el canónico es el más externo.
  function canonicalToggle(el) {
    let toggle = el;
    let parent = el.parentElement;
    for (let i = 0; parent && i < 4; i++, parent = parent.parentElement) {
      if (isToggleCandidate(parent)) toggle = parent;
    }
    return toggle;
  }

  function togglesIn(root, limit = Infinity) {
    const found = new Set();
    for (const el of root.querySelectorAll(TOGGLE_QUERY)) {
      if (!isToggleCandidate(el)) continue;
      found.add(canonicalToggle(el));
      if (found.size >= limit) break;
    }
    return found;
  }

  function toggleFromEvent(e) {
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    for (let i = 0; i < path.length && i < 12; i++) {
      if (isToggleCandidate(path[i])) return canonicalToggle(path[i]);
    }
    return null;
  }

  function isVisibleText(node, toggle) {
    if (!node.nodeValue || !node.nodeValue.trim()) return false;
    const parent = node.parentElement;
    if (!parent || (toggle && toggle.contains(parent))) return false;
    if (parent.closest(SKIP_TEXT_QUERY)) return false;
    const style = getComputedStyle(parent);
    if (style.visibility === 'hidden' || ICON_FONT_RE.test(style.fontFamily)) return false;
    const rect = parent.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1;
  }

  function hasTextBefore(container, toggle) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (toggle.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING) return false;
      if (isVisibleText(n, toggle)) return true;
    }
    return false;
  }

  // La fila es el ancestro más alto que contiene un solo botón de completar y
  // ningún texto visible antes del botón (en Google Tasks el círculo va primero).
  function findRow(toggle) {
    const byRole = toggle.parentElement && toggle.parentElement.closest(ROW_QUERY);
    if (byRole && togglesIn(byRole, 2).size === 1) return byRole;

    let row = toggle.parentElement || toggle;
    for (
      let el = row.parentElement, depth = 0;
      el && el !== document.body && el !== document.documentElement && depth < 10;
      el = el.parentElement, depth++
    ) {
      if (togglesIn(el, 2).size !== 1) break;
      if (hasTextBefore(el, toggle)) break;
      row = el;
    }
    return row;
  }

  function isTextField(el) {
    return el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && /^(text|search|)$/i.test(el.type));
  }

  // Sube mientras el elemento sea inline, para juntar un título partido en
  // varios nodos de texto (links, emojis, resaltados).
  function blockAncestor(el, stop) {
    let cur = el;
    while (cur && cur !== stop && cur.parentElement) {
      const display = getComputedStyle(cur).display;
      if (!display.startsWith('inline') && display !== 'contents') return cur;
      cur = cur.parentElement;
    }
    return cur || stop;
  }

  // El título es el primer bloque de texto visible después del botón.
  function extractTitle(row, toggle) {
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    walker.currentNode = toggle;
    let first = null;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (toggle.contains(n)) continue;
      if (n.nodeType === Node.ELEMENT_NODE) {
        if (isTextField(n) && n.value.trim()) return { text: n.value.trim(), el: n };
        continue;
      }
      if (isVisibleText(n, toggle)) {
        first = n;
        break;
      }
    }
    if (!first) return null;

    const block = blockAncestor(first.parentElement, row);
    let text = '';
    walker.currentNode = first;
    for (let n = first; n && block.contains(n); n = walker.nextNode()) {
      if (n.nodeType === Node.TEXT_NODE && isVisibleText(n, toggle)) text += n.nodeValue;
    }
    return { text: text.replace(/\s+/g, ' ').trim(), el: block };
  }

  function keyOf(title) {
    if (!title) return '';
    return title.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 500);
  }

  function checkedStateOf(toggle) {
    const el = toggle.matches('[aria-checked],[aria-pressed]')
      ? toggle
      : toggle.querySelector('[aria-checked],[aria-pressed]');
    if (!el) return null;
    const value = el.getAttribute('aria-checked') || el.getAttribute('aria-pressed');
    if (value === 'true') return true;
    if (value === 'false') return false;
    return null;
  }

  // Google Tasks marca las completadas con aria-pressed="true" y deja la misma
  // etiqueta; las reglas por etiqueta y por tachado son para otras variantes.
  function isCompleted(toggle, row, titleEl) {
    const checked = checkedStateOf(toggle);
    if (checked !== null) return checked;
    const { action } = splitLabel(labelOf(toggle));
    if (COMPLETED_LABEL_RE.test(action)) return true;
    if (TOGGLE_LABEL_RE.test(action)) return false;
    const stop = row.parentElement;
    for (let el = titleEl; el && el !== stop; el = el.parentElement) {
      if (getComputedStyle(el).textDecorationLine.includes('line-through')) return true;
    }
    return false;
  }

  // ID de la tarea en Google (data-task-id en la tarjeta). Se acepta solo si
  // el elemento que lo tiene contiene un único botón de completar.
  const ID_ATTRS = ['data-task-id', 'data-taskid', 'data-id'];

  function taskIdOf(toggle) {
    for (let el = toggle.parentElement, depth = 0; el && depth < 12; el = el.parentElement, depth++) {
      for (const attr of ID_ATTRS) {
        const value = el.getAttribute(attr);
        if (value && /^[\w-]{6,}$/.test(value)) return togglesIn(el, 2).size === 1 ? value : '';
      }
    }
    return '';
  }

  // Clave de la tarea: su ID cuando existe; si no, el título. titleKey sirve
  // además para migrar estados guardados por título antes de usar IDs.
  function describe(toggle) {
    const row = findRow(toggle);
    const labelTitle = splitLabel(labelOf(toggle)).title;
    const domTitle = labelTitle ? null : extractTitle(row, toggle);
    const title = labelTitle || (domTitle ? domTitle.text : '');
    const id = taskIdOf(toggle);
    const titleKey = keyOf(title);
    return {
      row,
      title,
      id,
      key: id ? `id:${id}` : titleKey,
      titleKey,
      completed: isCompleted(toggle, row, domTitle ? domTitle.el : null),
    };
  }

  function signatureOf(toggle, row) {
    return [row.textContent, labelOf(toggle), checkedStateOf(toggle)].join('\u0000');
  }

  // Durante el render se reutiliza el resultado mientras la fila no cambie.
  function describeCached(toggle) {
    const cached = describeCache.get(toggle);
    if (
      cached &&
      cached.info.row.isConnected &&
      cached.info.row.contains(toggle) &&
      cached.signature === signatureOf(toggle, cached.info.row)
    ) {
      return cached.info;
    }
    const info = describe(toggle);
    if (info.key) describeCache.set(toggle, { signature: signatureOf(toggle, info.row), info });
    return info;
  }

  // ---------------------------------------------------------------------------
  // Estado persistido
  // ---------------------------------------------------------------------------

  function safeStorage(fn) {
    try {
      fn(chrome.storage.local);
    } catch (err) {
      teardown();
    }
  }

  function loadState() {
    safeStorage((storage) =>
      storage.get(null, (items) => {
        if (!alive) return;
        for (const [k, v] of Object.entries(items || {})) {
          if (k.startsWith(TASK_PREFIX)) records.set(k.slice(TASK_PREFIX.length), v);
          else if (k === SETTINGS_KEY) settings = { ...settings, ...v };
        }
        ready = true;
        scheduleRender();
      }),
    );
  }

  function onStorageChanged(changes, area) {
    if (area !== 'local' || !isAlive()) return;
    for (const [k, change] of Object.entries(changes)) {
      if (k.startsWith(TASK_PREFIX)) {
        const key = k.slice(TASK_PREFIX.length);
        if (change.newValue) records.set(key, change.newValue);
        else records.delete(key);
      } else if (k === SETTINGS_KEY) {
        settings = { debug: false, ...(change.newValue || {}) };
      }
    }
    scheduleRender();
  }

  function startProgress(key, title, id) {
    const record = id ? { title, id, since: Date.now() } : { title, since: Date.now() };
    records.set(key, record);
    safeStorage((storage) => storage.set({ [TASK_PREFIX + key]: record }));
    debugLog('en progreso:', title);
    render();
  }

  // Estados guardados por título (versiones anteriores) pasan a la clave por ID
  // la primera vez que aparece la tarea.
  function migrateLegacy(info) {
    if (!info.id || !info.titleKey || records.has(info.key) || !records.has(info.titleKey)) return;
    const record = { ...records.get(info.titleKey), title: info.title, id: info.id };
    records.delete(info.titleKey);
    records.set(info.key, record);
    safeStorage((storage) => {
      storage.set({ [TASK_PREFIX + info.key]: record });
      storage.remove(TASK_PREFIX + info.titleKey);
    });
  }

  function stopProgress(key) {
    records.delete(key);
    recentlyCompleted.set(key, Date.now());
    safeStorage((storage) => storage.remove(TASK_PREFIX + key));
    debugLog('completada, se borra el estado local:', key);
    render();
  }

  // Vuelve a incompleta sin pasar por Google (Shift + clic o ítem del menú).
  function removeProgress(key) {
    records.delete(key);
    safeStorage((storage) => storage.remove(TASK_PREFIX + key));
    debugLog('se quita en progreso:', key);
    render();
  }

  // ---------------------------------------------------------------------------
  // Intercepción de eventos
  // ---------------------------------------------------------------------------

  // Qué hará el próximo clic: 'start' (pasa a en progreso), 'complete' (Google
  // la completa) o 'pass' (no se toca: completada, sin título o recién completada).
  function actionFor(info) {
    if (!ready || info.completed || !info.key) return 'pass';
    migrateLegacy(info);
    const completedAt = recentlyCompleted.get(info.key);
    if (completedAt && Date.now() - completedAt < COMPLETE_COOLDOWN_MS) return 'pass';
    return records.has(info.key) ? 'complete' : 'start';
  }

  // Con Shift el clic nunca completa: alterna entre incompleta y en progreso
  // ('unmark' = quitar en progreso).
  const SHIFT_ACTIONS = { start: 'start', complete: 'unmark', pass: 'pass' };
  // Acciones que se quedan en el navegador: el evento no debe llegar a Google.
  const BLOCKING_ACTIONS = new Set(['start', 'unmark']);

  function decide(toggle, shift = false) {
    const info = describe(toggle);
    const base = actionFor(info);
    const action = shift ? SHIFT_ACTIONS[base] : base;
    debugLog('decisión:', action, { title: info.title, id: info.id, completed: info.completed, row: info.row, toggle });
    return { action, key: info.key, title: info.title, id: info.id };
  }

  function block(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  // Recién marcada con el mouse encima (o con foco de teclado): se mantiene el
  // ícono de en progreso hasta que el mouse o el foco salgan. Si no, se vería
  // de inmediato el check de Google y parecería que la tarea se completó.
  function markFresh(toggle) {
    const host = hostOf(toggle);
    if (!host.isConnected || !host.matches(':hover, :focus-visible')) return;
    setOwnAttr(host, 'data-gtp-fresh');
    const clear = () => {
      removeOwnAttr(host, 'data-gtp-fresh');
      host.removeEventListener('mouseleave', clear);
      host.removeEventListener('blur', clear);
    };
    host.addEventListener('mouseleave', clear);
    host.addEventListener('blur', clear);
  }

  function apply(decision, e, toggle) {
    if (decision.action === 'start') {
      block(e);
      startProgress(decision.key, decision.title, decision.id);
      markFresh(toggle);
    } else if (decision.action === 'unmark') {
      block(e);
      removeProgress(decision.key);
    } else if (decision.action === 'complete') {
      stopProgress(decision.key);
    }
  }

  const DOWN_EVENTS = new Set(['pointerdown', 'mousedown', 'touchstart']);

  // pointerdown/mousedown/pointerup/mouseup/touch*: se decide al bajar el
  // puntero y se aplica la misma decisión al resto del gesto. El cambio de
  // estado se confirma recién en el click.
  function onPointerEvent(e) {
    if (!isAlive()) return;
    if (settings.debug && e.type === 'pointerdown') logPath(e);
    if ('button' in e && e.button !== 0) return;
    const toggle = toggleFromEvent(e);
    if (!toggle) return;
    if (DOWN_EVENTS.has(e.type)) {
      const stale = !gesture || gesture.toggle !== toggle || Date.now() - gesture.time > 1000;
      if (stale) gesture = { toggle, decision: decide(toggle, e.shiftKey), time: Date.now() };
    }
    if (gesture && gesture.toggle === toggle && BLOCKING_ACTIONS.has(gesture.decision.action)) block(e);
  }

  function guardedByKeyboard(e, toggle) {
    if (!keyboardGuard || keyboardGuard.toggle !== toggle || Date.now() > keyboardGuard.until) return false;
    if (BLOCKING_ACTIONS.has(keyboardGuard.action)) block(e);
    return true;
  }

  function onClick(e) {
    if (!isAlive() || e.button !== 0) return;
    const toggle = toggleFromEvent(e);
    if (!toggle || guardedByKeyboard(e, toggle)) return;
    const fromGesture = gesture && gesture.toggle === toggle && Date.now() - gesture.time < 10000;
    const decision = fromGesture ? gesture.decision : decide(toggle, e.shiftKey);
    gesture = null;
    apply(decision, e, toggle);
  }

  function onKeyDown(e) {
    if (!isAlive() || (e.key !== 'Enter' && e.key !== ' ')) return;
    const toggle = toggleFromEvent(e);
    if (!toggle || guardedByKeyboard(e, toggle)) return;
    const decision = decide(toggle, e.shiftKey);
    keyboardGuard = { toggle, action: decision.action, until: Date.now() + KEYBOARD_GUARD_MS };
    apply(decision, e, toggle);
  }

  function onKeyUp(e) {
    if (!isAlive() || (e.key !== 'Enter' && e.key !== ' ')) return;
    const toggle = toggleFromEvent(e);
    if (toggle) guardedByKeyboard(e, toggle);
  }

  // ---------------------------------------------------------------------------
  // Ítem en el menú de la tarea
  //
  // Google abre su propio menú (fecha límite, subtarea, borrar, mover a lista)
  // con clic derecho sobre la tarea o con su botón ⋮. Tras ese clic se espera
  // a que aparezca un role="menu" nuevo y se le agrega al principio un ítem
  // "Marcar en progreso" o "Quitar en progreso". El ítem es una copia de uno
  // de Google sin sus atributos js*/data-*, para que tenga su estilo pero no
  // dispare acciones de Google. Tras usarlo se cierra el menú con Escape.
  // ---------------------------------------------------------------------------

  const MENU_WAIT_MS = 1000;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const MENU_LABELS = {
    es: { start: 'Marcar en progreso', unmark: 'Quitar en progreso' },
    en: { start: 'Mark as in progress', unmark: 'Remove in progress' },
    pt: { start: 'Marcar como em andamento', unmark: 'Remover em andamento' },
  };
  let menuWatch = 0;

  function menuLabels() {
    const lang = (document.documentElement.lang || navigator.language || 'en').slice(0, 2).toLowerCase();
    return MENU_LABELS[lang] || MENU_LABELS.en;
  }

  // Botón de completar de la tarea a la que pertenece el elemento: el primer
  // ancestro que contiene exactamente uno.
  function toggleForElement(el) {
    for (let anc = el, depth = 0; anc && anc !== document.body && depth < 15; anc = anc.parentElement, depth++) {
      const found = togglesIn(anc, 2);
      if (found.size === 1) return [...found][0];
      if (found.size > 1) return null;
    }
    return null;
  }

  function visibleMenus() {
    const menus = new Map();
    for (const menu of document.querySelectorAll('[role="menu"]')) {
      const r = menu.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && getComputedStyle(menu).visibility !== 'hidden') {
        menus.set(menu, `${Math.round(r.left)},${Math.round(r.top)}`);
      }
    }
    return menus;
  }

  // Un menú cuenta como recién abierto si antes no se veía o si cambió de
  // lugar (Google puede reutilizar el mismo elemento).
  function watchForMenu(toggle) {
    const before = visibleMenus();
    const started = Date.now();
    const token = ++menuWatch;
    const tick = () => {
      if (token !== menuWatch || !isAlive()) return;
      for (const [menu, position] of visibleMenus()) {
        if (before.get(menu) !== position) return addMenuItem(menu, toggle);
      }
      if (Date.now() - started < MENU_WAIT_MS) setTimeout(tick, 40);
    };
    setTimeout(tick, 0);
  }

  function svgElement(name, attrs) {
    const el = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  }

  // La página exige Trusted Types: el ícono se arma con createElementNS.
  function setMenuIcon(item, mode) {
    const svg = item.querySelector('svg');
    if (!svg) return;
    while (svg.firstChild) svg.firstChild.remove();
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.append(svgElement('circle', { cx: '12', cy: '12', r: '9', fill: 'none', stroke: 'currentColor', 'stroke-width': '2' }));
    if (mode === 'start') svg.append(svgElement('path', { d: 'M12 6a6 6 0 0 1 0 12z', fill: 'currentColor' }));
  }

  function closeMenu(menu) {
    const init = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true };
    menu.dispatchEvent(new KeyboardEvent('keydown', init));
  }

  function removeMenuItems() {
    for (const item of document.querySelectorAll('.gtp-menu-item')) item.remove();
  }

  function addMenuItem(menu, toggle) {
    removeMenuItems();
    if (!toggle.isConnected) return;
    const info = describe(toggle);
    const mode = { start: 'start', complete: 'unmark' }[actionFor(info)];
    if (!mode) return;
    // Se copia un ítem con ícono (algunos, como "Mover a la parte superior",
    // no tienen) y la copia va antes del primer ítem.
    const items = [...menu.querySelectorAll('[role="menuitem"]')];
    const ref = items.find((el) => el.querySelector('svg')) || items[0];
    if (!ref) {
      debugLog('menú sin ítems para copiar:', menu);
      return;
    }

    const label = menuLabels()[mode];
    const item = ref.cloneNode(true);
    for (const el of [item, ...item.querySelectorAll('*')]) {
      for (const attr of [...el.attributes]) {
        if (/^(js|data-)|^id$|^aria-(?!hidden$)/.test(attr.name)) el.removeAttribute(attr.name);
      }
    }
    item.classList.add('gtp-ui', 'gtp-menu-item');
    item.setAttribute('role', 'menuitem');
    item.setAttribute('tabindex', '-1');
    item.setAttribute('aria-label', label);
    setMenuIcon(item, mode);
    const leaf = [...item.querySelectorAll('*')]
      .reverse()
      .find((el) => !(el instanceof SVGElement) && !el.children.length && el.textContent.trim());
    if (leaf) leaf.textContent = label;
    else item.append(label);

    const activate = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (mode === 'start') startProgress(info.key, info.title, info.id);
      else removeProgress(info.key);
      closeMenu(menu);
    };
    item.addEventListener('click', activate);
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') activate(e);
    });
    // Google resalta sus ítems desde su JavaScript (clase + foco), que no
    // conoce la copia: el resaltado y el foco se manejan aquí. Con el foco,
    // Enter activa este ítem y no el último ítem de Google que lo tuvo.
    item.addEventListener('mouseenter', () => {
      item.classList.add('gtp-hover');
      item.setAttribute('tabindex', '0');
      item.focus({ preventScroll: true });
    });
    item.addEventListener('mouseleave', () => {
      item.classList.remove('gtp-hover');
      item.setAttribute('tabindex', '-1');
    });
    items[0].parentElement.insertBefore(item, items[0]);
    debugLog('ítem agregado al menú:', label, info.title);
  }

  // contextmenu (clic derecho, Ctrl + clic, tecla de menú) o clic en un botón
  // de la tarea (⋮). Los clics sobre el círculo los maneja onClick.
  function onMenuTrigger(e) {
    if (!isAlive()) return;
    const path = e.composedPath();
    if (path.some((n) => n instanceof Element && n.classList.contains('gtp-menu-item'))) return;
    removeMenuItems();
    let toggle = toggleFromEvent(e);
    if (e.type === 'click') {
      if (toggle || e.button !== 0) return;
      if (!path.some((n) => n instanceof Element && n.matches('button, [role="button"]'))) return;
    }
    const target = path.find((n) => n instanceof Element);
    if (!toggle && target) {
      toggle = toggleForElement(target);
      // En una lista con una sola tarea, el ⋮ de la lista también "contiene"
      // un único botón: se exige que el clic venga de la fila de la tarea.
      if (toggle && !findRow(toggle).contains(target)) toggle = null;
    }
    if (toggle) watchForMenu(toggle);
  }

  const LISTENERS = [
    ['pointerdown', onPointerEvent],
    ['mousedown', onPointerEvent],
    ['touchstart', onPointerEvent],
    ['pointerup', onPointerEvent],
    ['mouseup', onPointerEvent],
    ['touchend', onPointerEvent],
    ['click', onClick],
    ['click', onMenuTrigger],
    ['contextmenu', onMenuTrigger],
    ['keydown', onKeyDown],
    ['keyup', onKeyUp],
    ['keypress', onKeyUp],
  ];
  const LISTENER_OPTIONS = { capture: true, passive: false };

  // ---------------------------------------------------------------------------
  // Render del ícono
  //
  // Cada botón de una tarea no completada recibe data-gtp-state y un ícono
  // propio (anillo + mitad rellena). content.css decide qué se ve:
  //   todo:     ícono de Google; con hover, vista previa de en progreso.
  //   progress: ícono propio naranjo; con hover, el check de Google.
  //
  // Google dibuja el check del hover fuera del botón: en un elemento hermano,
  // posicionado encima, sin texto y del mismo tamaño, con un sprite de fondo.
  // Ese elemento se marca con data-gtp-overlay y su contenedor común con
  // data-gtp-wrap, para que el CSS pueda ocultarlo.
  // ---------------------------------------------------------------------------

  const STATE_BY_ACTION = { start: 'todo', complete: 'progress' };

  const hostOf = (toggle) =>
    /^(INPUT|IMG)$/.test(toggle.tagName) && toggle.parentElement ? toggle.parentElement : toggle;

  function googleIcon(toggle) {
    for (const svg of toggle.querySelectorAll('svg')) {
      const rect = svg.getBoundingClientRect();
      if (rect.width > 4 && rect.height > 4) return { svg, rect };
    }
    return null;
  }

  // Color con que Google pinta el círculo, para la vista previa en hover.
  function iconColor(svg) {
    for (const shape of svg.querySelectorAll('path,circle,ellipse,rect,polygon')) {
      const style = getComputedStyle(shape);
      if (style.fill && style.fill !== 'none' && !style.fill.startsWith('url(')) return style.fill;
      if (style.stroke && style.stroke !== 'none' && !style.stroke.startsWith('url(')) return style.stroke;
    }
    return getComputedStyle(svg).color;
  }

  function placeIcon(host, toggle, icon) {
    const hostRect = host.getBoundingClientRect();
    if (hostRect.width < 2 || hostRect.height < 2) return;
    const found = googleIcon(toggle);
    const ref = found ? found.rect : toggle.getBoundingClientRect();
    const base = Math.min(ref.width, ref.height) * (found ? 1 : 0.5);
    const size = Math.max(8, Math.round(base * RING_RATIO));
    const ring = Math.max(1, Math.round(base * RING_WIDTH_RATIO));
    const pie = Math.max(4, Math.round(base * PIE_RATIO));
    const left = Math.round(ref.left - hostRect.left - host.clientLeft + ref.width / 2 - size / 2);
    const top = Math.round(ref.top - hostRect.top - host.clientTop + ref.height / 2 - size / 2);
    const color = found ? iconColor(found.svg) : '';
    const signature = [left, top, size, ring, pie, color].join('|');
    if (icon.dataset.pos === signature) return;
    icon.dataset.pos = signature;
    icon.style.left = `${left}px`;
    icon.style.top = `${top}px`;
    icon.style.width = `${size}px`;
    icon.style.height = `${size}px`;
    icon.style.setProperty('--gtp-ring', `${ring}px`);
    icon.style.setProperty('--gtp-pie', `${pie}px`);
    if (color) icon.style.setProperty('--gtp-neutral', color);
  }

  function isOverlayOf(el, toggleRect) {
    if (el.classList.contains('gtp-ui') || el.textContent.trim()) return false;
    const position = getComputedStyle(el).position;
    if (position !== 'absolute' && position !== 'fixed') return false;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.width > toggleRect.width * 2 || r.height > toggleRect.height * 2) return false;
    const dx = r.left + r.width / 2 - (toggleRect.left + toggleRect.width / 2);
    const dy = r.top + r.height / 2 - (toggleRect.top + toggleRect.height / 2);
    return Math.abs(dx) <= 6 && Math.abs(dy) <= 6;
  }

  function markOverlays(toggle) {
    const own = toggle.closest('[data-gtp-wrap]');
    if (own && own.querySelector('[data-gtp-overlay]')) return;
    const toggleRect = toggle.getBoundingClientRect();
    if (toggleRect.width < 2) return;
    let child = toggle;
    for (let anc = toggle.parentElement, depth = 0; anc && depth < 3; child = anc, anc = anc.parentElement, depth++) {
      if (togglesIn(anc, 2).size > 1) return;
      const overlays = [...anc.children].filter((el) => el !== child && isOverlayOf(el, toggleRect));
      if (overlays.length) {
        setOwnAttr(anc, 'data-gtp-wrap');
        for (const el of overlays) setOwnAttr(el, 'data-gtp-overlay');
        return;
      }
    }
  }

  function mark(toggle, state) {
    const host = hostOf(toggle);
    setOwnAttr(host, 'data-gtp-state', state);
    if (!host.hasAttribute('data-gtp-rel') && getComputedStyle(host).position === 'static') {
      setOwnAttr(host, 'data-gtp-rel');
    }
    let icon = null;
    for (const child of host.children) if (child.classList.contains('gtp-icon')) icon = child;
    if (!icon) {
      icon = document.createElement('span');
      icon.className = 'gtp-ui gtp-icon';
      icon.setAttribute('aria-hidden', 'true');
      host.appendChild(icon);
    }
    placeIcon(host, toggle, icon);
    markOverlays(toggle);
    return host;
  }

  function unmark(host) {
    removeOwnAttr(host, 'data-gtp-state');
    removeOwnAttr(host, 'data-gtp-rel');
    removeOwnAttr(host, 'data-gtp-fresh');
    for (const child of [...host.children]) if (child.classList.contains('gtp-icon')) child.remove();
    const wrap = host.closest('[data-gtp-wrap]');
    if (wrap) {
      removeOwnAttr(wrap, 'data-gtp-wrap');
      for (const el of wrap.querySelectorAll('[data-gtp-overlay]')) removeOwnAttr(el, 'data-gtp-overlay');
    }
  }

  function render() {
    if (!isAlive()) return;
    const root = document.body || document.documentElement;
    if (!root) return;
    const keep = new Set();
    const toggles = togglesIn(root);
    let inProgress = 0;
    for (const toggle of toggles) {
      if (settings.debug) toggle.setAttribute('data-gtp-toggle', '');
      const state = STATE_BY_ACTION[actionFor(describeCached(toggle))];
      if (!state) continue;
      keep.add(mark(toggle, state));
      if (state === 'progress') inProgress++;
    }
    for (const host of document.querySelectorAll('[data-gtp-state]')) if (!keep.has(host)) unmark(host);
    if (settings.debug) {
      const summary = `${toggles.size} botones detectados, ${inProgress} en progreso visibles`;
      if (summary !== lastDebugSummary) debugLog(summary);
      lastDebugSummary = summary;
    } else {
      for (const el of document.querySelectorAll('[data-gtp-toggle]')) el.removeAttribute('data-gtp-toggle');
    }
  }

  // Un render por cuadro, justo antes de pintar: si Google reemplaza un botón,
  // el nuevo recibe su estado sin que se alcance a ver el círculo original.
  function scheduleRender() {
    if (renderFrame) return;
    renderFrame = requestAnimationFrame(() => {
      renderFrame = 0;
      render();
    });
  }

  function isOwnNode(node) {
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return !!el && !!el.closest('.gtp-ui');
  }

  // El botón del círculo lo maneja el motor de plantillas de Google
  // (incremental DOM): al volver a dibujarlo, por ejemplo cuando el foco se
  // mueve por el menú de la tarea, borra los hijos que no son suyos, incluido
  // el ícono propio. Se devuelve en este mismo callback, que corre antes de
  // que el navegador pinte; si se esperara al render, el círculo parpadearía.
  function restoreIcons(m) {
    for (const node of m.removedNodes) {
      if (node.nodeType !== Node.ELEMENT_NODE || !node.classList.contains('gtp-icon')) continue;
      const host = m.target;
      if (node.isConnected || !host.isConnected || ownAttr(host, 'data-gtp-state') === undefined) continue;
      host.appendChild(node);
    }
  }

  function restoreAttr(m) {
    const want = ownAttr(m.target, m.attributeName);
    if (want !== undefined && m.target.getAttribute(m.attributeName) !== want) {
      m.target.setAttribute(m.attributeName, want);
    }
  }

  const observer = new MutationObserver((mutations) => {
    let changed = false;
    for (const m of mutations) {
      if (m.type === 'attributes' && OWN_ATTRS.includes(m.attributeName)) {
        restoreAttr(m);
        continue;
      }
      if (m.type === 'childList') restoreIcons(m);
      if (changed || isOwnNode(m.target)) continue;
      if (m.type === 'childList' && [...m.addedNodes, ...m.removedNodes].every(isOwnNode)) continue;
      changed = true;
    }
    if (changed) scheduleRender();
  });

  // ---------------------------------------------------------------------------
  // Diagnóstico
  // ---------------------------------------------------------------------------

  function debugLog(...args) {
    if (settings.debug) console.log(LOG_TAG, ...args);
  }

  function summarizeElement(el) {
    const attrs = {};
    for (const a of el.attributes) {
      if (/^(role|aria-|data-|jsname$|jsaction$|tabindex$|type$)/.test(a.name)) attrs[a.name] = a.value.slice(0, 80);
    }
    return { tag: el.tagName.toLowerCase(), class: (el.getAttribute('class') || '').slice(0, 60), ...attrs };
  }

  function logPath(e) {
    const path = e.composedPath().filter((n) => n instanceof Element).slice(0, 8);
    console.log(LOG_TAG, 'pointerdown sobre:', path.map(summarizeElement));
  }

  // ---------------------------------------------------------------------------
  // Ciclo de vida
  // ---------------------------------------------------------------------------

  // Al recargar o actualizar la extensión, el script viejo pierde acceso a
  // chrome.*; en ese caso se desactiva para no bloquear clics.
  function isAlive() {
    if (alive && !(globalThis.chrome && chrome.runtime && chrome.runtime.id)) teardown();
    return alive;
  }

  function teardown() {
    if (!alive) return;
    alive = false;
    for (const [type, fn] of LISTENERS) window.removeEventListener(type, fn, LISTENER_OPTIONS);
    observer.disconnect();
    cancelAnimationFrame(renderFrame);
    for (const host of document.querySelectorAll('[data-gtp-state]')) unmark(host);
    removeMenuItems();
  }

  for (const [type, fn] of LISTENERS) window.addEventListener(type, fn, LISTENER_OPTIONS);
  observer.observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['aria-label', 'aria-checked', 'aria-pressed', 'data-tooltip', 'class', 'style', 'hidden', ...OWN_ATTRS],
  });
  window.addEventListener('resize', () => scheduleRender());
  try {
    chrome.storage.onChanged.addListener(onStorageChanged);
  } catch (err) {
    teardown();
  }
  loadState();
})();
