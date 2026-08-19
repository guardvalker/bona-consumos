-- ============================================================================
-- bona-consumos — migración 2026-08-19: alias de miembro + íconos de
-- categoría custom.
--
-- Copiar este archivo ENTERO y pegarlo en el SQL Editor del dashboard de
-- Supabase (proyecto `bonapps`) → New query → Run. Es idempotente (seguro
-- de correr más de una vez, no rompe nada si ya se corrió antes).
--
-- Este mismo bloque también está al final de schema.sql — no hace falta
-- correr los dos, con cualquiera de los dos alcanza. Este archivo separado
-- existe solo para poder copiar todo sin tener que buscar dónde empieza
-- dentro del archivo grande.
-- ============================================================================

alter table gc_categorias add column if not exists icono text;

drop policy if exists "gc_miembros_update" on gc_miembros;
create policy "gc_miembros_update" on gc_miembros
  for update using (usuario_id = auth.uid()) with check (usuario_id = auth.uid());
