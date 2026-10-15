# Kogn

Agente personal de escritorio para macOS. Un personaje flotante que hace tareas por ti en tu Mac (organizar archivos, ejecutar comandos), recuerda lo que apruebas y, si tú lo activas, observa en qué trabajas para ayudarte mejor.

Versión actual: **0.3.4**. Solo macOS. Las novedades de cada versión están en [Releases](https://github.com/kitifica-max/Agentik/releases). El agente puede ejecutar comandos y modificar archivos: lee [Seguridad y advertencias](#seguridad-y-advertencias) antes de usarlo.

## Qué hace

- **Ve tu pantalla y actúa en contexto** (Claude/Anthropic): con cada mensaje, Kogn toma una captura de tu pantalla principal y la usa para entender qué estás haciendo y reaccionar. Las capturas viven en RAM durante el día y se borran a medianoche; solo se guarda lo que el agente considera importante (vía Memoria). Requiere permiso de *Grabación de pantalla* — puedes activarlo desde la pestaña Ajustes.
- **Ejecuta tareas** con el modelo que elijas (Claude, una API compatible con OpenAI o un modelo local de Ollama): organiza carpetas, mueve y copia archivos, escribe archivos y corre comandos de shell. Trabaja solo, sin pedirte permiso en cada paso (ver [Seguridad y advertencias](#seguridad-y-advertencias)).
- **Comandos sin tokens:** unas palabras clave se resuelven en tu Mac, sin llamar al modelo: `resumen` (qué avanzaste hoy), `retoma` (dónde te quedaste en tus proyectos de git), `espacio` (qué ocupa tu disco y qué se puede liberar), `limpia` (borra de forma definitiva solo lo regenerable que mostró `espacio`: cachés y archivos de desarrollo, y vacía la Papelera; únicamente dentro de tu carpeta personal), `gasto` (cuánto llevas gastado) y `aprende` (propone recuerdos de tus proyectos y hábitos). También `organiza <carpeta autorizada>` (ej. `organiza Descargas`): mueve los archivos por tipo con reglas por defecto, sin modelo.
- **Observa solo si lo activas** (ver [Activar el observador](#activar-el-observador)).
- **Recuerda solo lo que apruebas** (pestaña Memoria).
- **Muestra el gasto** estimado en el pie de la burbuja (los modelos locales cuestan $0).
- **Estilo line-art:** contornos negros de 2px, sombras duras, barra de ventana retro e ilustraciones en los estados vacíos; claro y oscuro. Guía de inicio con una ilustración animada por paso. Un clic en el avatar abre el chat y otro lo cierra. Burbujas del agente en el mismo gris del avatar.
- **Menos tokens por turno:** caché de prompt en Anthropic, resultados de herramientas viejos compactados y menor presupuesto de contexto para modelos locales (Ollama).

## Descargar

Los instaladores van publicados por versión en **[Releases](https://github.com/kitifica-max/Agentik/releases)**. Descarga el `.dmg` más reciente, ábrelo y arrastra **Kogn** a Aplicaciones. Cada versión indica su suma de verificación (SHA-256).

> **La app no está notarizada por Apple** (eso requiere una cuenta de desarrollador de pago), así que macOS la bloquea la primera vez. Para abrirla, una de dos:
> 1. En Terminal: `xattr -cr /Applications/Kogn.app` y ábrela normal.
> 2. Intenta abrirla, luego **Ajustes del Sistema → Privacidad y seguridad → Abrir de todos modos**.
>
> Si dice que está "dañada", es ese mismo bloqueo (o un `.dmg` descargado a medias): usa el comando de arriba. Antes de usarla lee [Seguridad y advertencias](#seguridad-y-advertencias).

La primera vez, abre la pestaña **Modelo**, edita el modelo y pega tu API key (o agrega uno local de Ollama).

## Desarrollo

```bash
npm install
npm run dev        # desarrollo
npm test           # pruebas
npm run build      # genera .dmg en release/
```

Requisitos: macOS 13+, Node 22+.

### Publicar una versión

```bash
npm version patch                 # sube la versión en package.json (minor/major según el cambio) y crea el tag
npm run build                     # genera release/Kogn-<versión>-*.dmg
gh release create v<versión> release/Kogn-<versión>*.dmg --generate-notes
```

## Configuración de la API key

No hay archivos `.env`: la clave se configura **dentro de la app**, en la pestaña **Modelo** (Editar → API key → Guardar). Se guarda cifrada con el Llavero de macOS y nunca se escribe en el proyecto, en logs ni en la base de datos.

## Chat

Haz clic en el personaje para abrir la burbuja. Escribe un mensaje y Kogn responde usando el modelo activo (pestaña Modelo) con contexto de tu actividad reciente (apps, archivos modificados) y recuerdos aprobados.

Si le pides que recuerde algo, propone un recuerdo. Solo se guarda si lo apruebas. Datos sensibles (contraseñas, bancarios, salud, API keys) nunca se proponen como recuerdo.

- **El historial se guarda:** si cierras y vuelves a abrir la app, el chat sigue donde lo dejaste (hasta 500 mensajes en total) y el modelo retoma el hilo.
- **Adjuntar archivos:** con el clip del chat, o arrastrándolos encima (hasta 10 por mensaje, 1.5 GB cada uno). Se **copian** a una zona interna de la app (en APFS la copia es instantánea y no ocupa espacio extra), así que **tus originales no se tocan**. Kogn y los scripts trabajan sobre esas copias: «une estos pdfs», «limpia el csv», «transcribe esto», o preguntarle por un archivo. Los resultados quedan junto a las copias (botón **Mostrar en Finder**). Los archivos sensibles (`.env`, claves…) se rechazan. Se borran solos a los 14 días, al borrar la conversación o al cambiar de conversación sin enviar.
- **Varias conversaciones:** **☰ Chats** muestra tus conversaciones como tarjetas; **+ Nuevo** (o `Ctrl+Opción+N`) empieza una limpia. Guarda hasta **20**: al pasar el límite se borra la más vieja que no esté **fijada** (avisa desde la 18). Cada una tiene su propio contexto para el modelo, así que se gastan menos tokens.
- **Detener:** mientras Kogn trabaja aparece **Detener** (o pulsa **Esc**). Corta la llamada al modelo y mata el comando que esté corriendo; lo que ya se alcanzó a hacer queda hecho y te lo dice.
- **Borrar:** cada conversación se borra desde su tarjeta o con el botón del chat; en Ajustes se borran todas. Se elimina de verdad del disco, sin dejar copias en el archivo de la base de datos.

## Biblioteca de scripts

el botón **Scripts** (arriba del chat) abre tareas ya hechas, sin gastar tokens: organizar por tipo, duplicados, pesados y viejos, escáner de secretos, capturas, carpetas vacías, descomprimir zips, convertir y redimensionar imágenes, renombrar por fecha, unir y dividir PDFs, ordenar facturas, limpiar CSV, documentos a texto, Atajos de macOS, comprimir videos, extraer audio, transcribir (Whisper local) y GIFs; y para desarrollo: puertos, `node_modules` viejos, `.env.example` y estado de repos. Todas muestran una **vista previa**, **no borran nada** (lo que sobra va a «Revisar» o a la Papelera) y se pueden **deshacer** (también con el chat: «deshaz»). El modelo puede usarlas como herramientas (`list_scripts`, `run_script`) y varias se piden directo: «duplicados en Descargas».

**Módulos opcionales:** `ffmpeg` y `whisper.cpp` se instalan con Homebrew solo si tú lo pides (botón Instalar); los modelos de voz se descargan de Hugging Face y se verifican con SHA-256. Esos programas corren dentro de un sandbox de macOS: sin red y escribiendo solo en su carpeta de salida.

## Guía de inicio

La primera vez que abres Kogn aparece una guía de 4 pasos: qué es, primeros pasos (modelo, carpeta, observador, primer mensaje; se marcan solos), ejemplos para probar y cómo mantener el control. Se puede saltar. Vuelve a abrirla con el botón **?** de la burbuja o desde **Ajustes**.

## Memoria

La pestaña **Memoria** en la burbuja muestra todos los recuerdos: propuestos, aprobados y rechazados. Puedes aprobar, rechazar o eliminar desde ahí. Un recuerdo eliminado desaparece sin dejar copias.

## Sugerencias proactivas

Kogn observa patrones de actividad y sugiere ayuda cuando detecta algo relevante. El personaje cambia a estado `con-sugerencia` (sonrisa + rebote + insignia `!`).

**Niveles** (`suggestion_level` en `config.json`):

| Nivel | Comportamiento | Cooldown |
|-------|----------------|----------|
| `silencio` | Sin sugerencias | — |
| `discreto` | Solo foco prolongado y cambio rápido de apps | 15 min |
| `activo` | Todas las reglas: foco, cambio rápido, ediciones repetidas, inactividad | 5 min |

**Reglas locales** (sin llamada a la API):
- **Foco prolongado**: >30 min en la misma app → sugiere descanso.
- **Cambio rápido**: >5 apps en 5 min → sugiere concentrarse.
- **Ediciones repetidas** (solo activo): mismo archivo cambiado 3+ veces → sugiere revisar.
- **Inactividad** (solo activo): sin actividad 10-30 min tras periodo activo → ofrece resumen.

Al aceptar una sugerencia, se abre como chat con la IA. Al descartar, se suprime esa regla temporalmente.

## Herramientas de archivo

El agente organiza y modifica archivos **dentro de las carpetas autorizadas** (pestaña **Archivos**) y lo hace directamente, sin aprobación paso a paso. Herramientas: crear carpeta, mover (uno o varios), copiar, escribir archivo, listar, leer y organizar una carpeta por reglas.

- **Antes de sobrescribir** un archivo guarda una copia del original en `~/Library/Application Support/agetik/backups/`. Mover y copiar nunca pisan un destino que ya existe.
- **Archivos sensibles:** nunca toca `.env`, claves SSH, `.pem`, credenciales ni archivos ocultos de configuración.
- **Carpetas:** solo las que autorizas, y con [tope](#seguridad-y-advertencias): nunca el disco entero ni carpetas del sistema.
- **Borrar:** no tiene herramienta de borrado y por instrucción mueve a la Papelera. Ojo: con el shell libre podría hacer más (ver [Seguridad y advertencias](#seguridad-y-advertencias)). `limpia` es aparte y solo actúa tras tu `espacio`.
- **Registro:** cada operación queda en la pestaña **Archivos** y en el audit log (tabla `audit_log`).
- **Detener:** `Esc` o el botón **Detener** cortan lo que esté en curso.

## Permisos de macOS

- **Accesibilidad**: necesario para leer el título de la ventana activa. Sin él, Kogn solo ve el nombre de la app. Ajustes del Sistema → Privacidad y seguridad → Accesibilidad → activa Kogn.
- **Automatización (System Events)**: macOS puede pedirlo al primer uso.
- **Grabación de pantalla**: Kogn no la usa.
- **Acceso a carpetas**: Kogn solo vigila las carpetas que tú agregues desde la app.

La app detecta permisos faltantes y lo indica en la burbuja.

## Activar el observador

1. Haz clic en el personaje para abrir la burbuja.
2. Pulsa **Activar observador**. Hasta entonces no se registra nada.
3. Pausa en cualquier momento con el botón **Pausar** o con **Cmd+Shift+P**. La pausa es inmediata.

Mientras el observador esté activo, el personaje muestra un punto rojo pulsante.

## Animaciones del personaje

El círculo es solo el contenedor y no se mueve; lleva un contorno de 2px como el resto de la interfaz. El personaje se anima por capas (cabeza y torso, generadas con `node scripts/split-avatar.mjs`) con el motor `src/renderer/avatar-engine.js`: máquina de estados, respiración, parpadeo aleatorio cada 3 a 5 s, movimientos oculares (saccades), gestos y sincronía con audio. Siempre sonríe.

**Dos avatares**, a elegir en **Ajustes → Avatar** (cambia al instante, sin reiniciar):
- **Niño** y **Niña** (con anteojos). Sus datos (ojos, boca, cuello, parches) están en `src/renderer/avatars.js`. El dibujo de la niña no tiene cejas, así que no se dibujan: su expresión va en ojos, boca y cabeza.
- Para sumar otro: pon su SVG en `assets/`, agrégalo a `scripts/split-avatar.mjs` y copia una entrada de `avatars.js`.

| Estado de la app | Estado del avatar | Qué hace |
|---|---|---|
| reposo, observando | `idle` | sonrisa suave, respira, gestos al azar (ladea la cabeza, asiente, sube cejas, guiña) |
| esperando-aprobacion | `listening` | atento, cejas arriba, asiente seguido |
| pensando | `thinking` | mira arriba a la izquierda, ceja alzada, cabeza ladeada |
| con-sugerencia, exito | `success` | ojos felices, sonrisa abierta, rebote |
| confuso (al fallar) | `confusion` | ceja asimétrica, sonrisa ladeada, mirada inquieta |
| **pendiente** (respuesta sin leer) | `calling` | un "pop" al llegar y **salta en bucle** con insignia `1` hasta que abres el chat |
| pausado | `sleeping` | ojos cerrados, respira lento, atenuado |
| (por API) | `speaking`, `empathy` | habla con la boca, parpadea más; cejas internas arriba |

**Respuesta pendiente:** si Kogn termina una respuesta y no estás mirando la burbuja, el personaje hace un "pop" (sintetizado, sin archivos de audio) y salta hasta que abres el chat. El sonido y el salto se pueden apagar en Ajustes. Con "reducir movimiento" de macOS no salta, pero sigue la insignia.

API: `setAvatarState(state)`, `triggerGesture(name)` (`nod`, `tilt`, `frown`, `baton`, `wink`, `shrug`, `smile_pop`, `look_around`, `bounce`, `jump`, `surprise`...) y `startAudioSync(audio)`. Hay una demo con selector de avatar en `tools/avatar-demo.html` (`python3 -m http.server 8765` y abrir `/tools/avatar-demo.html`).

Respeta "reducir movimiento" de macOS.

## Avisos

Cuando termina o falla algo y **no estás mirando la burbuja** (la tarea con modelo lento, un error de la API), Kogn manda una notificación nativa de macOS. Al hacer clic abre la burbuja. Si estás viendo la burbuja no avisa. Se desactivan en **Ajustes** (o con `"notifications": false` en `config.json`). Con el sonido activado la notificación va en silencio: el "pop" del personaje es el aviso.

## Memoria de proyectos y hábitos

Kogn aprende de ti, pero **solo propone**: nada se guarda hasta que lo apruebas en la pestaña **Memoria** (hay botones de aprobar o rechazar todo y un contador de pendientes).

- **Proyectos:** detecta tus repos de git con actividad en los últimos 30 días y propone un recuerdo por proyecto (ruta, descripción y stack: Next.js, Electron, Python...). Un proyecto se propone una sola vez, aunque lo rechaces.
- **Hábitos:** las apps que más usas y tus horas de mayor actividad. Necesitan al menos 3 días con el observador activo.
- **Cuándo:** solo si el observador está activado, 30 segundos después de arrancar y cada 12 horas. También a petición: escribe `aprende` en el chat (funciona sin el observador y no gasta tokens).

## Modelos y APIs

En la pestaña **Modelo** eliges con qué modelo trabaja Kogn (el cambio aplica al siguiente mensaje) y puedes agregar más:

| Tipo | Para qué | Notas |
|---|---|---|
| Anthropic | Claude | Tu API key, que pegas en la pestaña. |
| Google Gemini, OpenAI, DeepSeek, Groq, OpenRouter, Mistral, Kimi, xAI, OpenCode Zen, Together | Presets | Rellenan la URL base. Solo pones el ID exacto del modelo (ej. `gemini-3.8-flash`) y tu key. |
| Otra compatible con OpenAI | LM Studio, vLLM... | URL base + modelo; la key y los precios son opcionales. |
| Ollama (local) | Modelos en tu Mac | URL `http://localhost:11434`; "Detectar" lista los instalados. Cuesta $0. |

- Las API keys se guardan **cifradas con el Llavero de macOS**. No van a la base de datos, al `config.json`, a los logs ni a la interfaz.
- Para Ollama: `ollama pull qwen3:8b`. El modelo debe soportar **herramientas** (qwen3, llama3.1, mistral-nemo...). Se usa la API nativa para fijar el contexto (8192 tokens por defecto, editable).
- El gasto del contador usa el precio de cada modelo; los locales suman $0.

## Privacidad

**Qué se registra**
- App en primer plano y título de la ventana activa.
- Duración de uso por app.
- Cambios de archivos dentro de las carpetas autorizadas (nombre y ruta, no contenido).
- Historial del chat: tus mensajes y las respuestas, hasta 500, solo en tu Mac y hasta que los borres. Si pegas una clave por error, no se guarda (queda `[clave oculta]`).
- Resumen de hábitos: tiempo de uso por **día, hora y app** (sin títulos de ventana), solo de lo que no está excluido. Sirve para proponerte recuerdos como "suele estar más activo de 9 a 13".

**Qué no se registra nunca**
- Pulsaciones de teclado.
- Contenido de la pantalla: no se captura.
- Contenido de archivos, fuera o dentro de las carpetas autorizadas.
- Apps y títulos excluidos. Se descartan antes de tocar la base de datos.
- Archivos sensibles: `.env`, claves SSH, `.pem`, credenciales y archivos ocultos.

**Filtros por defecto** (en `config.json` y en código, por seguridad)
- Apps: Bitwarden, 1Password, Keychain Access, Wallet.
- Títulos que contengan: banco, bancaria, contraseña, password, login, bitwarden, 1password, keychain, salud, médico, wallet.

**Dónde se guarda**
- Base de datos SQLite local: `~/Library/Application Support/agetik/agetik.db`.
- Nada sale del equipo, salvo lo que se envía al modelo que elijas (ver [Seguridad y advertencias](#seguridad-y-advertencias)). Con un modelo local no sale nada.

**Cuánto dura**
- Eventos de actividad: 24 horas por defecto (`retention_hours` en `config.json`). Una tarea horaria borra lo vencido.
- Historial del chat: hasta 20 conversaciones y 500 mensajes en total, hasta que las borres.
- Resumen de hábitos: 60 días por defecto (`habit_retention_days`, de 7 a 365).

**Cómo borrarlo**
- Desactiva el observador: deja de registrar de inmediato.
- Borra el archivo `~/Library/Application Support/agetik/agetik.db` para eliminar todo el historial.
- Los recuerdos se borran desde el panel de memoria, sin copias ni resúmenes derivados.

## Seguridad y advertencias

- **Es un agente con poder real:** a petición tuya puede mover y escribir archivos y ejecutar comandos de shell. Hay una red de seguridad (bloquea `sudo`, `rm` masivo, `mkfs`, `dd` a disco y `curl | sh`, y limita las operaciones de archivos a tus carpetas autorizadas), pero **no es un sandbox**. Úsalo bajo tu responsabilidad.
- **Carpetas autorizadas con tope:** Kogn no acepta como carpeta autorizada algo demasiado amplio: el disco entero (también como "Macintosh HD"), un disco externo completo, tu carpeta personal entera, `Library` ni carpetas del sistema. Lo rechaza al agregarlo, lo quita solo al arrancar si ya estaba guardado, y las herramientas nunca lo tratan como permiso. Elige carpetas concretas (Descargas, Documentos, un proyecto).
- **Lo que se envía fuera:** tus mensajes y el contexto (actividad reciente, listados de carpetas y el contenido de los archivos que el modelo lea) van al proveedor del modelo que elijas (Anthropic, una API compatible con OpenAI, o Ollama en la nube). Con un modelo **local** de Ollama no sale nada de tu Mac.
- **API keys:** se guardan cifradas con el Llavero de macOS, nunca en el repo, la base de datos ni los logs.
- **Sin telemetría.** Todo (observador, memoria, hábitos) queda en tu equipo.
- **App sin notarizar:** la firma es local (ad-hoc), no de un desarrollador registrado en Apple. Si macOS la bloquea o dice que está "dañada", ejecuta `xattr -cr /Applications/Kogn.app`.

## Licencia y créditos

El **código** es [MIT](LICENSE). Las **ilustraciones** de los avatares no están bajo esa licencia: son de terceros (Designed by Freepik) y siguen sus términos. Detalles en [CREDITS.md](CREDITS.md).

## Estructura

```
src/
  main/        ventanas, IPC, configuración, avisos, secretos (Llavero)
  observer/    ventana activa, filtros, retención, vigilante de archivos
  memory/      recuerdos, filtro de datos sensibles, aprendizaje de proyectos y hábitos
  suggestions/ sugerencias proactivas
  files/       herramientas de archivos
  shell/       comandos de shell con red de seguridad
  ai/          modelos (Anthropic, OpenAI-compatible, Ollama), agente con herramientas, costos
  chat/        historial persistente y cancelación
  disk/ git/ summary/   comandos locales: espacio y limpia, retoma, resumen
  db/          SQLite
  renderer/    personaje, burbuja, guía de inicio, avatares (JS plano)
  preload/     puente IPC con allowlist
  shared/      tipos, canales IPC y reglas de carpetas
tests/         pruebas (vitest)
assets/        avatares (SVG)
scripts/       iconos y capas de los avatares
tools/         demo de animaciones
```
