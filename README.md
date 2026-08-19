# bonapp-gastos

Repo `bona-consumos`, app "bonapp-gastos" — gastos compartidos

App de gastos compartidos para grupos chicos y fijos (estilo Tricount, más simple).
Un solo `index.html` (HTML/CSS/JS vanilla, sin build), Supabase como backend,
PWA instalable. Ver spec original en `~/Downloads/gastos-compartidos-spec.md`.

Vive en el mismo proyecto Supabase compartido `bonapps` que el resto del
ecosistema BONA (lista-super, etc.) — tablas con prefijo `gc_`, mismas
credenciales ya cargadas en `config.js`.

## Deploy a GitHub Pages

1. Crear un repo vacío en GitHub: `guardvalker/bona-consumos` (público).
2. Pushear este directorio (`git push -u origin main`).
3. GitHub → Settings → Pages → Source: "Deploy from a branch" → `main` → `/ (root)`.
4. Confirmar que carga en `https://guardvalker.github.io/bona-consumos/`.

## Estado del schema en Supabase

El schema base (`supabase/schema.sql`, hasta el comentario "MIGRACIÓN
2026-08-19") **ya está corrido** en el proyecto `bonapps` (confirmado
2026-08-19, login real funcionando). Si alguna vez hay que levantar el
proyecto desde cero en otro lugar, se pega el archivo completo tal cual en
el SQL Editor.

**Pendiente en el proyecto vivo**: la migración de `supabase/migracion-2026-08-19.sql`
(columna `icono` en `gc_categorias` + política de UPDATE en `gc_miembros`
para poder guardar el alias) todavía no se corrió contra `bonapps`. Copiar
ese archivo completo (es chico, pensado para copiar entero sin buscar nada
adentro) en el SQL Editor y ejecutar — es idempotente, no rompe nada si se
corre más de una vez. **No pegar el `schema.sql` completo de nuevo**: la
mayoría de las sentencias usan `if not exists` y no pasa nada, pero los
`create policy` no tienen ese resguardo en Postgres — pegar todo el archivo
de nuevo tira error en la primera política ya existente (bien arriba del
archivo) y probablemente ni llegue a correr la parte nueva del final.

## Verificar que Brevo esté conectado como SMTP (login por OTP)

Esto ya está resuelto a nivel de proyecto (compartido con lista-super), pero
antes de dar por usable esta app conviene confirmar que sigue así:

1. Dashboard de Supabase → **Project Settings → Authentication → SMTP Settings**.
2. Confirmar que "Enable Custom SMTP" está activo y apunta a Brevo (host
   `smtp-relay.brevo.com`), con un **Sender email** que no sea un dominio
   `p=quarantine`/`p=reject` en DMARC (Gmail funciona; los dominios de
   Proton/Hotmail como remitente rompen la entrega — ver nota en la memoria
   del ecosistema si hace falta reconfirmar esto).
3. Dashboard → **Authentication → Email Templates**: tanto "Magic Link" como
   "Confirm signup" deben incluir `{{ .Token }}` en el cuerpo (no solo el
   link) — si no, un usuario que nunca inició sesión en este proyecto ve un
   link en vez del código de 6 dígitos.
4. Probar con un email real: pedir código desde la app, confirmar que llega
   en segundos y que el código funciona.

## Checklist de políticas RLS (antes de considerar esto listo para uso real)

Todas están definidas en `supabase/schema.sql` — esta lista es para verificar
que quedaron aplicadas correctamente después de correr el script:

- [ ] `gc_grupos`: SELECT solo si sos miembro; INSERT libre (con
      `creado_por = auth.uid()`); UPDATE solo si sos miembro; DELETE solo el creador.
- [ ] `gc_miembros`: SELECT solo miembros del grupo; INSERT solo tu propia fila
      (`usuario_id = auth.uid()` — así funciona "unirse por link"); DELETE solo tu
      propia fila (salir del grupo).
- [ ] `gc_gastos`, `gc_settlements`, `gc_categorias`: acceso completo (all)
      solo si sos miembro del grupo correspondiente.
- [ ] `gc_gasto_shares`: acceso completo solo si sos miembro del grupo del
      gasto padre (política via EXISTS a `gc_gastos`).
- [ ] Las 6 tablas tienen `grant select, insert, update, delete ... to authenticated`
      explícito (RLS sola no alcanza sin este grant base).
- [ ] `gc_gastos`, `gc_gasto_shares`, `gc_settlements`, `gc_miembros`,
      `gc_categorias` están agregadas a la publicación `supabase_realtime`
      (para que el sync entre dispositivos ande en vivo).

Probado con un test real de RLS en Docker (ver detalle en `supabase/schema.sql`,
comentario arriba de `gc_grupos`) — el hallazgo más importante: **ni el insert
en `gc_grupos` ni en `gc_miembros` deben encadenar `.select()`/`RETURNING`**
desde el cliente, porque la policy de SELECT todavía no ve la fila de
membresía en el mismo statement que la crea. `sync.js` ya respeta esto.

## Decisiones de v1 (por si hace falta recordarlas más adelante)

- **Invitación por link compartido**, no email automático vía Brevo. Cualquiera
  que reciba el link (`?grupo=<uuid>`) y haga login con su propio OTP se une
  solo. Evita tener que armar una Edge Function para mandar mail custom.
- **Sin tabla de perfiles global.** El nombre para mostrar vive en
  `gc_miembros.display_name` (default: el email), por grupo — igual que
  `ls_miembros` en lista-super. La "moneda preferida default" del spec quedó
  como default de UI (ARS al crear un grupo), no como dato persistido.
- **`creado_por` en `gc_gastos` no se preserva entre ediciones** — cualquier
  miembro puede editar cualquier gasto (no hay roles/admin dentro del grupo,
  por diseño explícito del spec), y `creado_por` simplemente refleja quién lo
  guardó por última vez.
- **Redondeo de splits**: partes iguales y por porcentaje/shares usan el
  método de Hamilton (el resto de centavos se lo lleva quien tiene la parte
  fraccionaria más alta). Montos manuales con conversión de moneda: el último
  participante absorbe cualquier centavo de diferencia por redondeo, para que
  la suma siempre cierre exacto contra el total. Ver `logic.js`.
- **Filtro de gastos por miembro** (mencionado como opcional en el spec): no
  implementado en v1, solo filtro por categoría. Pendiente si hace falta.
- **PWA**: `sw.js` usa estrategia network-first (no cache-first) — a
  diferencia de lista-super, acá la corrección de los datos (plata) importa
  más que funcionar offline. Recordar bumpear `CACHE_NAME` en cada deploy que
  toque archivos cacheados.
