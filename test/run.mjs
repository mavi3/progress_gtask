// Prueba content.js contra test/fixtures/mock-tasks.html usando el Chrome
// instalado (playwright-core, channel "chrome"). chrome.storage se simula.
//
//   npm install && npm test

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contentJs = readFileSync(path.join(root, 'src/content.js'), 'utf8');
const contentCss = readFileSync(path.join(root, 'src/content.css'), 'utf8');
const fixtureUrl = pathToFileURL(path.join(root, 'test/fixtures/mock-tasks.html')).href;

const TITLES = {
  t1: 'Comparar las propuestas de extender retroactivos',
  t2: 'Ver como pasar de NE a Notas',
  t3: '📌 Definir estrategia de roll out',
};
const ORANGE = 'rgb(232, 113, 10)';
const NEUTRAL = 'rgb(196, 199, 197)';

// La variante google identifica por data-task-id; las demás, por título.
const titleKey = (id) => `gtp:task:${TITLES[id].toLowerCase()}`;
const storeKey = (variant, id) => (variant === 'google' ? `gtp:task:id:task-${id}` : titleKey(id));

// Lo que Google muestra por su cuenta con el mouse encima.
const NATIVE_HOVER = {
  google: { google: ['ring'], overlay: true },
  default: { google: ['check'], overlay: null },
};

function installChromeStub(initial) {
  const data = { ...initial };
  const listeners = [];
  const emit = (changes) => setTimeout(() => listeners.forEach((fn) => fn(changes, 'local')), 0);
  const pick = (keys) => {
    if (keys == null) return { ...data };
    const out = {};
    for (const k of [].concat(keys)) if (k in data) out[k] = data[k];
    return out;
  };
  const done = (value, cb) => (cb ? setTimeout(() => cb(value), 0) : Promise.resolve(value));
  window.__store = data;
  window.chrome = {
    runtime: { id: 'test-extension' },
    storage: {
      local: {
        get: (keys, cb) => done(pick(keys), cb),
        set: (items, cb) => {
          const changes = {};
          for (const [k, v] of Object.entries(items)) {
            changes[k] = { oldValue: data[k], newValue: v };
            data[k] = v;
          }
          emit(changes);
          return done(undefined, cb);
        },
        remove: (keys, cb) => {
          const changes = {};
          for (const k of [].concat(keys)) {
            if (k in data) {
              changes[k] = { oldValue: data[k] };
              delete data[k];
            }
          }
          emit(changes);
          return done(undefined, cb);
        },
      },
      onChanged: { addListener: (fn) => listeners.push(fn) },
    },
  };
}

async function open(browser, variant, initialStore = {}) {
  const page = await browser.newPage();
  page.on('pageerror', (err) => {
    throw err;
  });
  await page.addInitScript(installChromeStub, initialStore);
  await page.addInitScript({ content: contentJs });
  await page.goto(`${fixtureUrl}?variant=${variant}`);
  await page.addStyleTag({ content: contentCss });
  await settle(page);
  return page;
}

const settle = (page) => page.waitForTimeout(250);
const toggle = (id) => `[data-mock-id="${id}"] .cb`;
const moveAway = (page) => page.mouse.move(1, 1);

function snapshot(page) {
  return page.evaluate(() => {
    const idOf = (el) => el.closest('.task')?.dataset.mockId;
    return {
      g: { ...window.__g },
      store: { ...window.__store },
      progress: [...document.querySelectorAll('[data-gtp-state="progress"]')].map(idOf),
      todo: [...document.querySelectorAll('[data-gtp-state="todo"]')].map(idOf),
      done: [...document.querySelectorAll('#completed .task')].map((el) => el.dataset.mockId),
    };
  });
}

// Qué ve el usuario en el círculo: SVG de Google visibles, si se ve el check
// que Google dibuja aparte (variante google) y si se ve el ícono propio.
function view(page, id) {
  return page.evaluate((id) => {
    const host = document.querySelector(`[data-mock-id="${id}"] .cb`);
    const shown = (el) => {
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden';
    };
    const overlay = host.closest('.task').querySelector('.g-overlay');
    const icon = host.querySelector('.gtp-icon');
    const ours = !!icon && getComputedStyle(icon).opacity === '1';
    const geometry = () => {
      const i = icon.getBoundingClientRect();
      const r = host.querySelector('.ring').getBoundingClientRect();
      return {
        size: i.width,
        offX: i.left + i.width / 2 - (r.left + r.width / 2),
        offY: i.top + i.height / 2 - (r.top + r.height / 2),
      };
    };
    return {
      state: host.dataset.gtpState || null,
      google: [...host.querySelectorAll('svg')].filter(shown).map((s) => s.getAttribute('class')),
      overlay: overlay ? shown(overlay) && getComputedStyle(overlay).backgroundImage !== 'none' : null,
      ours,
      color: ours ? getComputedStyle(icon).color : null,
      geometry: icon ? geometry() : null,
    };
  }, id);
}

// Cuando se ve el ícono propio no debe verse nada de Google.
function assertOnlyOurs(v, color) {
  assert.deepEqual(v.google, []);
  assert.notEqual(v.overlay, true);
  assert.equal(v.ours, true);
  assert.equal(v.color, color);
}

async function runVariant(browser, variant) {
  const check = async (name, fn) => {
    await fn();
    console.log(`  ok  ${variant}: ${name}`);
  };
  const native = NATIVE_HOVER[variant] || NATIVE_HOVER.default;
  const KEY_T1 = storeKey(variant, 't1');
  const KEY_T2 = storeKey(variant, 't2');
  const KEY_T3 = storeKey(variant, 't3');

  let page = await open(browser, variant);

  await check('incompleta sin hover: se ve solo el círculo de Google', async () => {
    await moveAway(page);
    const v = await view(page, 't1');
    assert.equal(v.state, 'todo');
    assert.deepEqual(v.google, ['ring']);
    assert.notEqual(v.overlay, true);
    assert.equal(v.ours, false);
  });

  await check('incompleta con hover: medio círculo neutro, sin el check de Google', async () => {
    await page.hover(toggle('t1'));
    assertOnlyOurs(await view(page, 't1'), NEUTRAL);
  });

  await check('completada: sin ícono propio', async () => {
    const v = await view(page, 't3');
    assert.equal(v.state, null);
    assert.equal(v.ours, false);
  });

  await check('primer clic: en progreso, Google no recibe el evento', async () => {
    await page.click(toggle('t1'));
    await settle(page);
    const s = await snapshot(page);
    assert.equal(s.g.clicks, 0);
    assert.equal(s.g.mousedowns, 0);
    assert.deepEqual(s.progress, ['t1']);
    assert.equal(s.store[KEY_T1].title, TITLES.t1);
  });

  await check('recién marcada con el mouse encima: medio círculo naranjo, sin check', async () => {
    assertOnlyOurs(await view(page, 't1'), ORANGE);
  });

  await check('en progreso sin hover: medio círculo naranjo alineado con el de Google', async () => {
    await moveAway(page);
    const v = await view(page, 't1');
    assertOnlyOurs(v, ORANGE);
    assert.equal(v.geometry.size, 20);
    assert.ok(Math.abs(v.geometry.offX) <= 1 && Math.abs(v.geometry.offY) <= 1, JSON.stringify(v.geometry));
  });

  await check('si Google vuelve a dibujar el botón, estado e ícono vuelven antes de pintar', async () => {
    const frame = await page.evaluate(async () => {
      window.__idomPatch('t1');
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      const host = document.querySelector('[data-mock-id="t1"] .cb');
      const icon = host.querySelector('.gtp-icon');
      return {
        state: host.getAttribute('data-gtp-state'),
        icon: icon ? getComputedStyle(icon).opacity : null,
        ring: getComputedStyle(host.querySelector('.ring')).visibility,
      };
    });
    assert.deepEqual(frame, { state: 'progress', icon: '1', ring: 'hidden' });
  });

  await check('en progreso con hover: solo lo que Google muestra (el check)', async () => {
    await page.hover(toggle('t1'));
    const v = await view(page, 't1');
    assert.deepEqual(v.google, native.google);
    assert.equal(v.overlay, native.overlay);
    assert.equal(v.ours, false);
    await moveAway(page);
  });

  await check('el indicador sobrevive a un re-render de Google', async () => {
    await page.evaluate(() => window.__rerender());
    await settle(page);
    assert.deepEqual((await snapshot(page)).progress, ['t1']);
  });

  await check('clic en otros botones no se intercepta', async () => {
    await page.click('#completed-header');
    await page.click('#add');
    const s = await snapshot(page);
    assert.equal(s.g.headerClicks, 1);
    assert.equal(s.g.clicks, 0);
  });

  await check('segundo clic: Google completa y se borra el estado', async () => {
    await page.click(toggle('t1'));
    await settle(page);
    const s = await snapshot(page);
    assert.equal(s.g.clicks, 1);
    assert.ok(s.done.includes('t1'));
    assert.equal(s.store[KEY_T1], undefined);
    assert.deepEqual(s.progress, []);
  });

  await check('clic en una completada la desmarca sin pasar por en progreso', async () => {
    await page.click(toggle('t1'));
    await settle(page);
    const s = await snapshot(page);
    assert.equal(s.g.clicks, 2);
    assert.ok(!s.done.includes('t1'));
    assert.deepEqual(s.progress, []);
    assert.equal(s.store[KEY_T1], undefined);
  });

  await check('teclado: Enter marca en progreso y el segundo Enter completa', async () => {
    await page.focus(toggle('t2'));
    await page.keyboard.press('Enter');
    await settle(page);
    let s = await snapshot(page);
    assert.equal(s.g.keys, 0);
    assert.deepEqual(s.progress, ['t2']);
    await page.waitForTimeout(700);
    await page.focus(toggle('t2'));
    await page.keyboard.press('Enter');
    await settle(page);
    s = await snapshot(page);
    assert.equal(s.g.keys, 1);
    assert.ok(s.done.includes('t2'));
    assert.equal(s.store[KEY_T2], undefined);
  });

  await page.close();
  page = await open(browser, variant);

  await check('doble clic rápido: en progreso y luego completada', async () => {
    await page.dblclick(toggle('t1'));
    await settle(page);
    const s = await snapshot(page);
    assert.equal(s.g.clicks, 1);
    assert.ok(s.done.includes('t1'));
    assert.equal(s.store[KEY_T1], undefined);
  });

  if (variant === 'google') {
    await check('tareas con el mismo título tienen estados independientes', async () => {
      await page.click(toggle('t2'));
      await settle(page);
      const s = await snapshot(page);
      assert.deepEqual(s.progress, ['t2']);
      assert.ok(s.todo.includes('t4'));
      assert.equal(s.store[KEY_T2].id, 'task-t2');
    });

    await check('título largo y con "pendientes": se detecta como incompleta', async () => {
      const s = await snapshot(page);
      assert.ok(s.todo.includes('t5'));
    });
  }

  await check('con el contexto de la extensión invalidado los clics pasan', async () => {
    await page.evaluate(() => {
      window.chrome.runtime.id = undefined;
    });
    const before = (await snapshot(page)).g.clicks;
    await page.click(toggle('t2'));
    await settle(page);
    const s = await snapshot(page);
    assert.equal(s.g.clicks, before + 1);
    assert.ok(s.done.includes('t2'));
  });

  await page.close();
  page = await open(browser, variant, {
    [KEY_T2]: { title: TITLES.t2, since: 1 },
    [KEY_T3]: { title: TITLES.t3, since: 1 },
  });

  await check('estado guardado se aplica al cargar; una completada no se marca', async () => {
    const s = await snapshot(page);
    assert.deepEqual(s.progress, ['t2']);
    assert.ok(s.done.includes('t3'));
  });

  await page.close();

  page = await open(browser, variant);

  await check('Shift + clic: marca y quita en progreso sin completar nunca', async () => {
    await page.click(toggle('t1'), { modifiers: ['Shift'] });
    await settle(page);
    let s = await snapshot(page);
    assert.deepEqual(s.progress, ['t1']);
    assert.equal(s.g.clicks, 0);
    await page.click(toggle('t1'), { modifiers: ['Shift'] });
    await settle(page);
    s = await snapshot(page);
    assert.deepEqual(s.progress, []);
    assert.ok(s.todo.includes('t1'));
    assert.equal(s.g.clicks, 0);
    assert.equal(s.g.mousedowns, 0);
    assert.equal(s.store[KEY_T1], undefined);
  });

  if (variant === 'google') {
    const GOOGLE_ITEMS = ['Mover a la parte superior', 'Agregar fecha límite', 'Agregar subtarea', 'Borrar'];
    const openMenu = () =>
      page.evaluate(() => {
        const menu = [...document.querySelectorAll('[role=menu]')].find(
          (m) => !m.hidden && m.getBoundingClientRect().height > 0,
        );
        if (!menu) return null;
        return { id: menu.id, items: [...menu.querySelectorAll('[role=menuitem]')].map((i) => i.textContent.trim()) };
      });

    await check('menú (clic derecho): "Marcar en progreso" sin pasar por Google', async () => {
      await page.click('[data-mock-id="t2"] .title', { button: 'right' });
      await settle(page);
      assert.deepEqual((await openMenu()).items, ['Marcar en progreso', ...GOOGLE_ITEMS]);
      await page.click('.gtp-menu-item');
      await settle(page);
      const s = await snapshot(page);
      assert.deepEqual(s.progress, ['t2']);
      assert.equal(s.g.menuActions, 0);
      assert.equal(s.g.clicks, 0);
      assert.equal(await openMenu(), null);
    });

    await check('menú (⋮): "Quitar en progreso" la deja incompleta sin completarla', async () => {
      await page.click('[data-mock-id="t2"] .opts');
      await settle(page);
      assert.deepEqual((await openMenu()).items, ['Quitar en progreso', ...GOOGLE_ITEMS]);
      await page.click('.gtp-menu-item');
      await settle(page);
      const s = await snapshot(page);
      assert.deepEqual(s.progress, []);
      assert.ok(s.todo.includes('t2'));
      assert.equal(s.store[KEY_T2], undefined);
      assert.equal(s.g.clicks, 0);
      assert.equal(s.g.menuActions, 0);
    });

    await check('menú de una completada: sin ítem propio', async () => {
      await page.click('[data-mock-id="t3"] .title', { button: 'right' });
      await settle(page);
      assert.deepEqual((await openMenu()).items, GOOGLE_ITEMS);
      await page.keyboard.press('Escape');
    });

    await check('menú de la lista con una sola tarea: sin ítem propio', async () => {
      await page.click('#list2-opts');
      await settle(page);
      const menu = await openMenu();
      assert.equal(menu.id, 'list-menu');
      assert.deepEqual(menu.items, ['Cambiar nombre']);
      await page.keyboard.press('Escape');
    });

    await check('menú de la tarea única de una lista: con ítem propio', async () => {
      await page.click('[data-mock-id="t6"] .title', { button: 'right' });
      await settle(page);
      assert.equal((await openMenu()).items[0], 'Marcar en progreso');
      await page.keyboard.press('Escape');
    });

    await check('usar un ítem de Google no se ve afectado y el ítem propio se retira', async () => {
      await page.click('[data-mock-id="t1"] .title', { button: 'right' });
      await settle(page);
      await page.click('#task-menu .mi[data-action="delete"]');
      await settle(page);
      const s = await snapshot(page);
      assert.equal(s.g.menuActions, 1);
      assert.equal(await page.locator('.gtp-menu-item').count(), 0);
      assert.ok(s.todo.includes('t1'));
    });

    await check('menú: el ítem propio tiene ícono, se resalta como los de Google y responde a Enter', async () => {
      await page.click('[data-mock-id="t1"] .title', { button: 'right' });
      await settle(page);
      await page.hover('#task-menu .mi[data-action="date"]');
      await page.hover('.gtp-menu-item');
      const look = await page.evaluate(() => {
        const ours = document.querySelector('.gtp-menu-item');
        return {
          bg: getComputedStyle(ours).backgroundColor,
          focused: document.activeElement === ours,
          googleHighlighted: document.querySelectorAll('#task-menu .mi.hl').length,
          icon: !!ours.querySelector('svg circle'),
        };
      });
      assert.deepEqual(look, { bg: 'rgb(60, 64, 67)', focused: true, googleHighlighted: 0, icon: true });
      await page.keyboard.press('Enter');
      await settle(page);
      const s = await snapshot(page);
      assert.deepEqual(s.progress, ['t1']);
      assert.equal(s.g.menuActions, 1);
      assert.equal(await openMenu(), null);
    });
  }

  await page.close();

  if (variant === 'google') {
    page = await open(browser, variant, { [titleKey('t2')]: { title: TITLES.t2, since: 1 } });

    await check('estado guardado por título se migra al ID de la tarea', async () => {
      await settle(page);
      const s = await snapshot(page);
      assert.deepEqual(s.progress, ['t2']);
      assert.equal(s.store[titleKey('t2')], undefined);
      assert.equal(s.store[KEY_T2].id, 'task-t2');
    });

    await page.close();
  }
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const variant of ['es', 'en', 'strike', 'google']) await runVariant(browser, variant);
  console.log('\nTodo OK');
} finally {
  await browser.close();
}
