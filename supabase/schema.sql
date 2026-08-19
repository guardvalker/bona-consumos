-- ============================================================================
-- bona-consumos — schema Supabase para gastos compartidos (grupos, gastos,
-- splits, settlements). Ejecutar completo en el SQL Editor del dashboard del
-- proyecto (Database > SQL Editor > New query > pegar todo > Run), o con
-- `supabase db push` si se prefiere versionado vía CLI.
--
-- Vive en el mismo proyecto Supabase compartido `bonapps` que el resto del
-- ecosistema (ver lista-super/supabase/schema.sql para el patrón de
-- referencia) — prefijo `gc_` para no colisionar con las tablas `ls_` de
-- lista-super ni futuras tablas de otras apps.
--
-- No requiere PostGIS ni ninguna extensión más allá de pgcrypto (para
-- gen_random_uuid()), que Supabase trae habilitada por defecto.
--
-- Invitación a un grupo: estilo lista-super, por link compartido (el UUID
-- del grupo), no por email automático — cualquiera que lo conozca y haga
-- login con su propio OTP puede insertarse en gc_miembros. No hay tabla de
-- invitaciones pendientes ni Edge Function de envío de mail custom.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ----------------------------------------------------------------------------
-- Tablas
-- ----------------------------------------------------------------------------

-- IMPORTANTE (validado con test real de RLS, no solo por analogía con
-- lista-super): ni el insert en gc_grupos ni el insert en gc_miembros deben
-- encadenar `.select()`/RETURNING desde el cliente. Ambas tablas tienen una
-- política de SELECT basada en gc_is_member(), que exige que ya exista la
-- fila de membresía — y esa fila todavía no existe (o, en el caso de
-- gc_miembros, la policy no la ve como propia) dentro del mismo statement
-- que la está creando. Postgres aborta todo el INSERT con "new row violates
-- row-level security policy" en vez de devolver 0 filas silenciosamente.
-- Patrón correcto (igual que ls_listas/ls_miembros en lista-super): generar
-- el id client-side con crypto.randomUUID(), insertar sin .select(), y si
-- se necesita confirmar los datos insertados, hacer un SELECT aparte
-- después de que la membresía ya quedó creada.
create table if not exists gc_grupos (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  moneda_base text not null default 'ARS',
  creado_por uuid not null references auth.users(id),
  creado_en timestamptz not null default now()
);

create table if not exists gc_miembros (
  grupo_id uuid not null references gc_grupos(id) on delete cascade,
  usuario_id uuid not null references auth.users(id) on delete cascade,
  display_name text,
  agregado_en timestamptz not null default now(),
  primary key (grupo_id, usuario_id)
);

-- Solo categorías custom agregadas por un grupo más allá del set predefinido
-- (Salidas, Super, Servicios, Transporte), que vive como constante en el
-- cliente, no acá. `icono` guarda una clave del ICON_LIBRARY del cliente
-- (ej. 'cart', 'home', 'gift'), no un SVG — el picker de íconos al crear una
-- categoría custom ofrece un set fijo predefinido, ver ICON_LIBRARY en
-- index.html.
create table if not exists gc_categorias (
  id uuid primary key default gen_random_uuid(),
  grupo_id uuid not null references gc_grupos(id) on delete cascade,
  nombre text not null,
  icono text,
  creado_en timestamptz not null default now(),
  unique (grupo_id, nombre)
);

create table if not exists gc_gastos (
  id uuid primary key default gen_random_uuid(),
  grupo_id uuid not null references gc_grupos(id) on delete cascade,
  descripcion text not null,
  monto numeric not null,
  moneda text not null,
  tasa_cambio numeric,
  monto_base numeric not null,
  categoria text not null,
  pagado_por uuid not null references auth.users(id),
  fecha date not null default current_date,
  notas text,
  creado_por uuid not null references auth.users(id),
  creado_en timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists gc_gasto_shares (
  gasto_id uuid not null references gc_gastos(id) on delete cascade,
  usuario_id uuid not null references auth.users(id),
  tipo_split text not null check (tipo_split in ('igual', 'porcentaje', 'monto_fijo', 'shares')),
  valor numeric,
  monto_base numeric not null,
  primary key (gasto_id, usuario_id)
);

create table if not exists gc_settlements (
  id uuid primary key default gen_random_uuid(),
  grupo_id uuid not null references gc_grupos(id) on delete cascade,
  de_usuario_id uuid not null references auth.users(id),
  a_usuario_id uuid not null references auth.users(id),
  monto numeric not null,
  moneda text not null,
  fecha date not null default current_date,
  nota text,
  creado_por uuid not null references auth.users(id),
  creado_en timestamptz not null default now()
);

create index if not exists gc_gastos_grupo_id_idx on gc_gastos (grupo_id);
create index if not exists gc_settlements_grupo_id_idx on gc_settlements (grupo_id);
create index if not exists gc_categorias_grupo_id_idx on gc_categorias (grupo_id);

-- ----------------------------------------------------------------------------
-- Helper: ¿el usuario autenticado actual es miembro de este grupo?
-- security definer para poder usarse dentro de las políticas RLS de
-- gc_miembros sin caer en recursión (la función esquiva el RLS de la propia
-- tabla que consulta).
-- ----------------------------------------------------------------------------

create or replace function gc_is_member(p_grupo_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from gc_miembros m
    where m.grupo_id = p_grupo_id and m.usuario_id = auth.uid()
  );
$$;

grant execute on function gc_is_member(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- RLS
-- ----------------------------------------------------------------------------

alter table gc_grupos enable row level security;
alter table gc_miembros enable row level security;
alter table gc_categorias enable row level security;
alter table gc_gastos enable row level security;
alter table gc_gasto_shares enable row level security;
alter table gc_settlements enable row level security;

-- Grants explícitos de nivel tabla, para no depender de que el proyecto
-- Supabase tenga configurados los default privileges esperados — RLS por sí
-- sola no alcanza si el rol `authenticated` no tiene ni el permiso base.
grant select, insert, update, delete on
  gc_grupos, gc_miembros, gc_categorias, gc_gastos, gc_gasto_shares, gc_settlements
to authenticated;

-- gc_grupos: ver los que integrás; crear libre (te agregás como miembro
-- después, desde el cliente, en la misma operación de "crear grupo");
-- cualquier miembro puede editarlo (renombrar, cambiar moneda base); solo
-- quien lo creó puede borrarlo.
create policy "gc_grupos_select" on gc_grupos
  for select using (gc_is_member(id));

create policy "gc_grupos_insert" on gc_grupos
  for insert with check (creado_por = auth.uid());

create policy "gc_grupos_update" on gc_grupos
  for update using (gc_is_member(id));

create policy "gc_grupos_delete" on gc_grupos
  for delete using (creado_por = auth.uid());

-- gc_miembros: ver miembros de tus propios grupos; unirte a un grupo
-- (insertar tu propia fila — "unirse" = conocer el grupo_id compartido por
-- link); salir vos mismo; editar tu propia fila (alias/display_name) en
-- cualquier grupo del que seas miembro, nunca la de otro.
create policy "gc_miembros_select" on gc_miembros
  for select using (gc_is_member(grupo_id));

create policy "gc_miembros_insert" on gc_miembros
  for insert with check (usuario_id = auth.uid());

create policy "gc_miembros_update" on gc_miembros
  for update using (usuario_id = auth.uid()) with check (usuario_id = auth.uid());

create policy "gc_miembros_delete" on gc_miembros
  for delete using (usuario_id = auth.uid());

-- gc_categorias / gc_gastos / gc_settlements: acceso completo si sos
-- miembro del grupo.
create policy "gc_categorias_all" on gc_categorias
  for all using (gc_is_member(grupo_id)) with check (gc_is_member(grupo_id));

create policy "gc_gastos_all" on gc_gastos
  for all using (gc_is_member(grupo_id)) with check (gc_is_member(grupo_id));

create policy "gc_settlements_all" on gc_settlements
  for all using (gc_is_member(grupo_id)) with check (gc_is_member(grupo_id));

-- gc_gasto_shares: tabla hija de gc_gastos, la membresía se resuelve
-- subiendo hasta el gasto padre (y de ahí al grupo).
create policy "gc_gasto_shares_all" on gc_gasto_shares
  for all using (
    exists (select 1 from gc_gastos g where g.id = gasto_id and gc_is_member(g.grupo_id))
  ) with check (
    exists (select 1 from gc_gastos g where g.id = gasto_id and gc_is_member(g.grupo_id))
  );

-- ----------------------------------------------------------------------------
-- Realtime: exponer las tablas para que supabase-js pueda suscribirse a
-- postgres_changes filtrado por grupo_id.
-- ----------------------------------------------------------------------------

alter publication supabase_realtime add table
  gc_gastos, gc_gasto_shares, gc_settlements, gc_miembros, gc_categorias;

-- ----------------------------------------------------------------------------
-- MIGRACIÓN 2026-08-19: alias de miembro + íconos de categoría custom.
--
-- Todo lo de arriba ya corrió en el proyecto `bonapps` en vivo (2026-08-19) —
-- volver a pegar el archivo completo desde el principio fallaría en los
-- `create policy` ya existentes (Postgres no tiene `create policy if not
-- exists`). Este bloque sí es seguro de pegar y correr solo, tanto en el
-- proyecto ya existente como en un setup nuevo desde cero (por eso también
-- queda acá aunque las tablas de arriba ya lo tengan incorporado). También
-- vive como archivo standalone en migracion-2026-08-19.sql, para copiar
-- entero sin tener que ubicar este comentario dentro de un archivo grande.
-- ----------------------------------------------------------------------------

alter table gc_categorias add column if not exists icono text;

drop policy if exists "gc_miembros_update" on gc_miembros;
create policy "gc_miembros_update" on gc_miembros
  for update using (usuario_id = auth.uid()) with check (usuario_id = auth.uid());
