# Google Tasks: En progreso

Extensión de Chrome que agrega un tercer estado a las tareas de Google Tasks:

1. **Incompleta**: círculo vacío, como siempre.
2. **En progreso**: el primer clic en el círculo lo rellena hasta la mitad (naranjo).
3. **Completada**: el segundo clic completa la tarea en Google, como el clic normal.

El estado "en progreso" vive solo en este navegador. Google no lo recibe: para el servidor, y para Tasks en el celular u otro computador, la tarea sigue incompleta.

## Instalación

1. Abre `chrome://extensions`.
2. Activa **Modo de desarrollador** (arriba a la derecha).
3. Haz clic en **Cargar descomprimida** y elige esta carpeta (la que tiene `manifest.json`).
4. Recarga las pestañas de Google Tasks, Gmail o Calendar que tengas abiertas.

Funciona en `tasks.google.com`. También debería funcionar en el panel de Tasks de Gmail, Calendar y Docs, porque ese panel es un iframe de `tasks.google.com` y la extensión se inyecta en todos los frames. Si ahí no aparece, usa el modo diagnóstico (abajo).

## Uso

- Clic en el círculo de una tarea incompleta: queda en progreso.
- Clic en el círculo de una tarea en progreso: Google la completa y la extensión borra el estado local.
- Con el foco en el círculo, `Enter` o `Espacio` siguen el mismo ciclo.
- **Shift + clic** en el círculo alterna entre incompleta y en progreso, sin completar nunca la tarea. Sirve para quitar el estado. Con el teclado, `Shift + Enter`.
- **Menú de la tarea** (clic derecho sobre la tarea, o su botón ⋮): la extensión agrega al principio "Marcar en progreso" o "Quitar en progreso", según el estado. En las completadas no aparece.
- Desmarcar una tarea completada funciona igual que antes: vuelve a incompleta, no a en progreso.
- Al pasar el mouse sobre el círculo se ve lo que hará el siguiente clic. En una tarea incompleta aparece el medio círculo en gris. En una tarea en progreso aparece solo el check de Google. Justo después de marcarla, el medio círculo naranjo se mantiene hasta que el mouse sale del círculo.

El ícono de la extensión abre un popup con las tareas en progreso. Desde ahí puedes quitar el estado de una tarea sin completarla, o de todas.

## Dónde se guarda el estado

En `chrome.storage.local`, con una entrada por tarea (`gtp:task:id:<ID de la tarea>`). No tiene vencimiento. Se pierde solo si desinstalas la extensión; borrar historial o cookies no la afecta. Recargar o actualizar la extensión tampoco la borra.

No se sincroniza entre computadores ni perfiles de Chrome.

## Limitaciones

La extensión reconoce cada tarea por el ID que Google pone en su tarjeta (`data-task-id`). Renombrar una tarea no le quita el estado, y dos tareas con el mismo título son independientes. Si Google deja de exponer ese ID, la extensión usa el título: en ese caso renombrar una tarea le quita el estado y dos tareas con el mismo título lo comparten.

Si completas una tarea en progreso desde otro dispositivo, la entrada local queda guardada. Si después la desmarcas, vuelve a aparecer en progreso. Puedes quitarla desde el popup.

Google cambia su interfaz sin aviso. La detección del círculo no depende de clases CSS: usa el `aria-label` del botón ("Marcar como completada: <título>", "Mark complete" y equivalentes en portugués, francés, alemán, italiano, neerlandés y polaco), `role="checkbox"` y, como último recurso, el tachado del título. Que una tarea esté completada se lee de `aria-pressed`. El check que Google muestra con el mouse encima está en un elemento aparte, junto al botón; la extensión lo ubica por posición y tamaño, y lo oculta cuando muestra su propio ícono.

El ítem del menú es una copia de un ítem de Google sin sus atributos de comportamiento (`jsaction`, `jsname`, `data-*`): tiene el mismo aspecto pero no dispara acciones de Google. La extensión lo agrega cuando aparece un menú nuevo justo después de un clic derecho o de un clic en un botón de la tarea, y cierra el menú con Escape después de usarlo. Si Google cambia la estructura del menú y no hay un ítem que copiar, el ítem no aparece; Shift + clic sigue funcionando.

## Si deja de funcionar

1. En el popup, activa **Modo diagnóstico**.
2. Recarga Google Tasks. Cada círculo detectado aparece con un contorno rojo punteado.
3. Abre DevTools (`Cmd+Opt+I`) y haz clic en un círculo. En la consola, los mensajes `[GTP]` muestran los elementos bajo el puntero (tag, `role`, `aria-label`, `data-*`, `jsname`) y la decisión tomada (título detectado, si está completada).

Si los círculos no tienen contorno, Google cambió la etiqueta del botón. Con esa salida se ajustan `TOGGLE_LABEL_RE` y `COMPLETED_LABEL_RE` al inicio de `src/content.js`.

## Pruebas

`test/fixtures/mock-tasks.html` imita la estructura de Google Tasks en cuatro variantes: `google` copia la estructura real de tasks.google.com (revisada en noviembre de 2026), y las otras tres cubren etiquetas en español sin roles de fila, `role="checkbox"` con `aria-checked` en inglés, y completado marcado solo con tachado. `test/run.mjs` carga `content.js` en esa página con el Chrome instalado y simula `chrome.storage`.

```bash
npm install
npm test
```

Las pruebas no reemplazan una revisión en Google Tasks real: si Google cambia su interfaz, la variante `google` queda desactualizada.

## Estructura

```
manifest.json        Manifest V3
src/content.js       Detección, intercepción de clics, persistencia y render
src/content.css      Indicador de medio círculo y contorno de diagnóstico
src/popup.*          Lista de tareas en progreso y modo diagnóstico
icons/               Íconos de la extensión
test/                Página de prueba y runner con playwright-core
```

## Licencia

[MIT](LICENSE).
