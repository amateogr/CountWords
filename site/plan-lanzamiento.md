# Plan de lanzamiento — Contador de palabras multiidioma

> Estado actual: MVP funcional (HTML único, Web Worker, import `.txt`/`.docx`/`.pdf`, `_headers` listos). Este documento cubre lo que falta para pasar de *artifact* a *producto en línea*.

## Fase 0 — Ya hecho
- [x] Motor `Intl.Segmenter` + detección de escritura (13 sistemas, RTL incluido)
- [x] Web Worker — el conteo no bloquea la UI
- [x] Import `.docx` (mammoth.js) / `.pdf` (pdf.js), lazy-load, sin sandbox de JS embebido
- [x] Anti-XSS: `textContent`/`createElement` en todo lo derivado del usuario, cero `innerHTML`
- [x] Cotas anti-DoS: tamaño de texto, tamaño de archivo, páginas de PDF
- [x] `_headers` (CSP, HSTS, Permissions-Policy) — construido, pendiente de aplicar al desplegar

---

## Fase 1 — Infraestructura y despliegue *(bloqueante)*

| Tarea | Detalle | Esfuerzo |
|---|---|---|
| Elegir hosting estático | ver comparativa abajo | 30 min |
| Dominio propio | registrar + DNS | 1h + propagación |
| Aplicar `_headers` | formato varía por plataforma | 15 min |
| CI/CD | deploy automático en cada push a `main` | 30 min |
| MFA en cuentas de infra | hosting, registrador DNS, GitHub | 15 min — **el eslabón más débil de un sitio estático es la cuenta que lo despliega, no el código** |

Para un sitio 100% estático, lo que H1.md pedía como "arquitectura de escalado" (auto-scaling, balanceo, CDN, DDoS) viene incluido gratis en cualquiera de estos — no hay que construirlo:

| | Cloudflare Pages | Netlify | Vercel |
|---|---|---|---|
| CDN + DDoS incluido | ✅ | ✅ | ✅ |
| WAF gratis | ✅ (managed rules) | ❌ (de pago) | ❌ (de pago) |
| Soporta `_headers` tal cual | ✅ | ✅ | ⚠️ usa `vercel.json` |
| Analítica sin cookies incluida | ✅ Web Analytics | ❌ | ❌ |
| Build minutes gratis/mes | 500 | 300 | 100 |

Recomendación técnica: **Cloudflare Pages** — WAF + analítica sin cookies + `_headers` nativo, sin coste añadido.

---

## Fase 2 — Ciberseguridad de producción *(bloqueante antes de tráfico real)*

- [ ] Externalizar `<script>`/`<style>` inline a ficheros `.js`/`.css` propios
- [ ] CSP sin `unsafe-inline` — hash (`sha256-...`) o nonce por request
- [ ] SRI real (`integrity=`) en mammoth.js y pdf.js — hash calculado sobre el fichero servido, no inventado
- [ ] `security.txt` (RFC 9116) — divulgación responsable de vulnerabilidades
- [ ] Escaneo de cabeceras: securityheaders.com + Mozilla Observatory (objetivo A/A+)
- [ ] Pentest manual ligero: XSS vía textarea/import, manipulación del `postMessage` del Worker, fuzz de `.docx`/`.pdf` malformados

```
# /.well-known/security.txt
Contact: mailto:security@tudominio.com
Expires: 2027-08-01T00:00:00.000Z
Preferred-Languages: es, en
Canonical: https://tudominio.com/.well-known/security.txt
```

**Reencuadre de H1.md §3 (HA/DR) para un sitio estático y sin estado:**
- RPO = 0 — no hay datos de usuario que perder, el texto nunca sale del navegador
- RTO ≈ minutos — el "backup" es tu historial de git; recuperación = redeploy del último commit
- Multi-zona ya la da gratis el CDN del hosting elegido

---

## Fase 3 — Analítica y observabilidad

- [ ] Analítica sin cookies: Cloudflare Web Analytics o Plausible — mide tráfico agregado sin tocar el textarea ni exigir banner de cookies
- [ ] Monitor de uptime gratuito: UptimeRobot / Better Stack
- ❌ Evita Google Analytics: usa cookies, obliga a banner RGPD, y no aporta nada que Cloudflare/Plausible no den ya

---

## Fase 4 — Legal mínimo *(bloqueante solo si activas Fase 5 con ads/analítica con cookies)*

*No soy abogado — esto es información de a qué obliga cada elección técnica, no asesoría legal.*

- [ ] Aviso legal / Términos de uso — herramienta "as-is", sin garantías
- [ ] Política de privacidad, honesta y verificable:
  - "El texto que analizas nunca sale de tu navegador" → sigue siendo cierto hoy, mantenlo
  - "Este sitio usa cookies de analítica/publicidad de terceros" → añádelo solo si activas Fase 5; ahí sí hace falta banner de consentimiento (RGPD/ePrivacy) con tráfico UE

---

## Fase 5 — Monetización *(opcional — evalúa la tensión con tu propuesta de valor)*

Tu diferenciador hoy es "100% local, nada sale del dispositivo". Un ad network de terceros carga scripts que sí hacen tracking de la página (no del texto analizado, pero rompe la percepción de "cero terceros").

| Opción | Tracking de terceros | Encaje con audiencia técnica | Fricción de implementación |
|---|---|---|---|
| Google AdSense | Alto (doubleclick.net, googlesyndication.com) | Bajo — tu público suele usar ad-blockers | CSP se abre mucho, `ads.txt` obligatorio, banner de cookies obligatorio en UE |
| Carbon Ads | Bajo, sin tracking cruzado | Alto — red pensada para audiencia dev | CSP se abre a un único dominio |
| Patrocinio directo / donaciones | Ninguno | Alto | Cero cambios de CSP, cero banner |

```
# ads.txt — solo si usas AdSense u otra red que lo exija
google.com, pub-XXXXXXXXXXXXXXXX, DIRECT, f08c47fec0942fa0
```

Dato factual (no es recomendación de inversión): el CPM de display suele rondar 1–3 USD; con tráfico de nicho como este necesitarías del orden de decenas de miles de visitas/mes para un ingreso relevante. Con audiencias pequeñas y técnicas, patrocinio directo o donaciones suele rendir más que ads.

---

## Fase 6 — Promoción

**SEO técnico**, añadir al `<head>`:
```html
<meta name="description" content="Contador de palabras multiidioma: chino, japonés, árabe, tailandés y más. 100% local, sin servidor.">
<meta property="og:title" content="Contador de palabras — multiidioma">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<link rel="canonical" href="https://tudominio.com/">
```

```
# robots.txt
User-agent: *
Allow: /
Sitemap: https://tudominio.com/sitemap.xml
```

**Canales de lanzamiento**, por esfuerzo/retorno:
1. Show HN — el ángulo técnico (Intl.Segmenter, cero backend) encaja bien ahí
2. r/SideProject, r/webdev
3. Comunidades de traductores/escritores (r/translator, foros de traducción) — tu audiencia real de uso diario
4. Post técnico "cómo lo construí" en dev.to/Hashnode — backlinks + credibilidad
5. Product Hunt — mejor con tracción previa, no como primer canal

---

## Fase 7 — Recomendaciones de uso *(para una sección de ayuda del propio sitio)*

- Navegadores soportados: Chrome/Edge 130+, Firefox 125+, Safari 17+ (`Intl.Segmenter`, Baseline 2024). Navegadores más antiguos caen a un modo de aproximación menos preciso, ya avisado en la UI.
- Límites: 500.000 car. en pegado directo · 5MB en `.txt` · 20MB en `.docx`/`.pdf` (500 páginas máx.)
- El texto nunca sale del dispositivo, pero evita pegar información sensible en equipos compartidos o públicos — el riesgo ahí no es el sitio, es quien más tenga acceso al navegador.

---

## Orden de ejecución
**Fase 1 → Fase 2 → (Fase 3 en paralelo) → [si hay ads: Fase 4 antes de Fase 5] → Fase 5 (opcional) → Fase 6**
