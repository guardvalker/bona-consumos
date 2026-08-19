// Config de Supabase para bona-consumos. Mismo proyecto compartido "bonapps"
// que el resto del ecosistema BONA (ver lista-super/config.js) — cada app usa
// su propio prefijo de tablas (gc_ acá), no hace falta un proyecto separado.
// Se commitea tal cual: la anon key está diseñada por Supabase para ser
// pública, la seguridad real la dan las políticas RLS en supabase/schema.sql.
window.SUPABASE_CONFIG = {
  url: 'https://iftwujsplhjbhvzibziw.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlmdHd1anNwbGhqYmh2emlieml3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcwMTY0MzEsImV4cCI6MjEwMjU5MjQzMX0.8gQRIZTly1LylR4lsL53h--T25kn5kypNjXt0J1lYeI',
};
