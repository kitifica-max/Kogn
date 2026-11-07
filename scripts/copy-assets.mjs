import { cpSync, mkdirSync } from 'node:fs';

// Renderer es JS plano (sin bundler). Copia HTML, CSS, JS y el avatar a dist.
mkdirSync('dist/renderer/assets', { recursive: true });
mkdirSync('dist/main', { recursive: true });
cpSync('src/renderer', 'dist/renderer', { recursive: true });
for (const id of ['nino', 'nina']) {
  for (const part of ['head', 'torso']) cpSync(`assets/${id}-${part}.svg`, `dist/renderer/assets/${id}-${part}.svg`);
}
cpSync('config.json', 'dist/main/config.json');
cpSync('build/icon.png', 'dist/main/tray.png');
