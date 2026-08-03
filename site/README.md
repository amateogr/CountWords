# Countswords — paquete de despliegue

## Estructura
- `es/` — versión española (la que ya está en producción en countswords.pages.dev)
- `en/` — versión en inglés británico, traducción completa de UI + mensajes + comentarios de código

Cada carpeta es **autocontenida y desplegable de forma independiente** (incluye su propio `vendor/`, `_headers`, `robots.txt`, `sitemap.xml`, `.well-known/security.txt`). Puedes:
- Desplegar `en/` como proyecto de Cloudflare Pages aparte (p. ej. `countswords-en.pages.dev` o un dominio propio), o
- Fusionar ambas bajo un único dominio con rutas `/` (es) y `/en/` (necesitarás ajustar las rutas `/vendor/...` de `en/index.html` y añadir `hreflang` cruzado entre ambos `index.html` — no lo hice porque no sé qué estructura de URL vas a usar).

## Qué cambió en esta entrega
- Fase 3 (analítica): Plausible en vez de Cloudflare Web Analytics — su beacon.min.js exige `unsafe-eval` en el CSP, lo que habría revertido el endurecimiento de la Fase 2. CSP y `<script>` ya están añadidos; solo falta que registres el dominio en plausible.io (no requiere token en el script).
- `en/`: traducción íntegra a inglés británico (UI, mensajes de error/estado, informe descargable, comentarios de código).

## Pendiente (fuera del alcance de este paquete)
- Uptime monitor (UptimeRobot / Better Stack) — alta manual, sin cambios de código.
- Verificar cabeceras reales en producción (securityheaders.com / Mozilla Observatory).
