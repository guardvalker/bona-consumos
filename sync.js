// Motor de sync con Supabase para bona-consumos. Capa de servicio pura (sin
// tocar el DOM) — index.html la consume vía window.Sync. Mismo patrón que
// lista-super/sync.js, adaptado a grupos múltiples por usuario (acá cada
// usuario puede pertenecer a varios grupos, a diferencia de lista-super que
// tenía una sola lista activa por dispositivo).
window.Sync = (function () {
  const GRUPO_ID_KEY = 'bona_consumos_grupo_id';
  const ALIAS_KEY = 'bona_consumos_alias';
  const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

  let sb = null;
  let cb = {};
  let currentUser = null;
  let grupoId = null;
  let grupoInfo = null; // { id, nombre, monedaBase, creadoPor }
  let channel = null;
  let refetchTimer = null;

  function isConfigured() {
    const c = window.SUPABASE_CONFIG;
    return !!(c && c.url && c.anonKey && !c.url.includes('TU-PROYECTO'));
  }

  function fail(err) {
    console.error('[Sync]', err);
    cb.onSyncError && cb.onSyncError(err && err.message ? err.message : String(err));
  }

  function getStoredGrupoId() {
    try { return localStorage.getItem(GRUPO_ID_KEY); } catch (e) { return null; }
  }
  function setStoredGrupoId(id) {
    try { localStorage.setItem(GRUPO_ID_KEY, id); } catch (e) {}
  }
  function clearStoredGrupoId() {
    try { localStorage.removeItem(GRUPO_ID_KEY); } catch (e) {}
  }

  function extractGrupoId(input) {
    const m = String(input || '').match(UUID_RE);
    return m ? m[0] : null;
  }

  function pendingJoinCodeFromUrl() {
    try {
      const url = new URL(window.location.href);
      return extractGrupoId(url.searchParams.get('grupo'));
    } catch (e) { return null; }
  }

  // ---- Auth ----

  async function sendOtp(email) {
    if (!sb) throw new Error('Supabase no está configurado');
    const { error } = await sb.auth.signInWithOtp({ email });
    if (error) throw error;
  }

  async function verifyOtp(email, token) {
    if (!sb) throw new Error('Supabase no está configurado');
    const { data, error } = await sb.auth.verifyOtp({ email, token, type: 'email' });
    if (error) throw error;
    currentUser = data.user;
    cb.onAuthChange && cb.onAuthChange(currentUser);
    const stored = getStoredGrupoId();
    if (stored) await selectGrupo(stored).catch(() => {});
  }

  async function signOut() {
    if (!sb) return;
    unsubscribeRealtime();
    await sb.auth.signOut();
    currentUser = null;
    grupoId = null;
    grupoInfo = null;
    cb.onGrupoChange && cb.onGrupoChange(null);
  }

  function getUser() { return currentUser; }

  // ---- Alias (nombre para mostrar, global — no por grupo) ----

  function getMyAlias() {
    try { return localStorage.getItem(ALIAS_KEY) || ''; } catch (e) { return ''; }
  }

  // Usado como display_name al insertar una fila nueva en gc_miembros
  // (crear/unirse a un grupo): si ya seteaste un alias antes de sumarte a
  // ese grupo, arranca mostrando eso en vez del email.
  function myDisplayNameDefault() {
    return getMyAlias() || (currentUser ? currentUser.email : '');
  }

  // Actualiza el alias en TODAS las filas de gc_miembros del usuario actual
  // (todos los grupos a la vez, no solo el activo) — el alias es un dato de
  // cuenta, no de un grupo en particular, aunque técnicamente esté
  // desnormalizado por fila de membresía (mismo esquema que ls_miembros en
  // lista-super, no hay tabla de perfil global).
  async function updateMyDisplayName(alias) {
    if (!sb || !currentUser) throw new Error('Iniciá sesión primero');
    const limpio = (alias || '').trim();
    const valor = limpio || currentUser.email;
    try { localStorage.setItem(ALIAS_KEY, limpio); } catch (e) {}
    const { error } = await sb.from('gc_miembros').update({ display_name: valor }).eq('usuario_id', currentUser.id);
    if (error) throw error;
    if (grupoId) await pullNow();
  }

  // ---- Mis grupos (lista + balance neto de cada uno) ----

  // Trae los grupos de los que soy miembro, junto con mi balance neto en
  // cada uno. Hace 3 queries livianas (agregados, no el detalle completo de
  // cada grupo) en vez de un fetchGrupoState() por grupo — evita traer todos
  // los gastos de todos los grupos solo para mostrar la lista.
  async function listMyGrupos() {
    if (!sb || !currentUser) return [];
    const uid = currentUser.id;

    const [miembrosRes, grupos, pagados, shares, settlementsDe, settlementsA] = await Promise.all([
      sb.from('gc_miembros').select('grupo_id').eq('usuario_id', uid),
      sb.from('gc_grupos').select('id, nombre, moneda_base, creado_por'),
      sb.from('gc_gastos').select('grupo_id, monto_base').eq('pagado_por', uid),
      sb.from('gc_gasto_shares').select('monto_base, gasto:gc_gastos(grupo_id)').eq('usuario_id', uid),
      sb.from('gc_settlements').select('grupo_id, monto').eq('de_usuario_id', uid),
      sb.from('gc_settlements').select('grupo_id, monto').eq('a_usuario_id', uid),
    ]);
    if (miembrosRes.error) throw miembrosRes.error;
    if (grupos.error) throw grupos.error;
    if (pagados.error) throw pagados.error;
    if (shares.error) throw shares.error;
    if (settlementsDe.error) throw settlementsDe.error;
    if (settlementsA.error) throw settlementsA.error;

    const misGrupoIds = new Set(miembrosRes.data.map((m) => m.grupo_id));
    const balancePorGrupo = {};
    const add = (grupoId, delta) => {
      balancePorGrupo[grupoId] = window.Logic.round2((balancePorGrupo[grupoId] || 0) + delta);
    };
    pagados.data.forEach((g) => add(g.grupo_id, Number(g.monto_base)));
    shares.data.forEach((s) => { if (s.gasto) add(s.gasto.grupo_id, -Number(s.monto_base)); });
    settlementsDe.data.forEach((s) => add(s.grupo_id, Number(s.monto)));
    settlementsA.data.forEach((s) => add(s.grupo_id, -Number(s.monto)));

    return grupos.data
      .filter((g) => misGrupoIds.has(g.id))
      .map((g) => ({
        id: g.id,
        nombre: g.nombre,
        monedaBase: g.moneda_base,
        creadoPor: g.creado_por,
        balance: balancePorGrupo[g.id] || 0,
      }));
  }

  // ---- Grupo activo ----

  function getGrupoId() { return grupoId; }
  function getGrupoInfo() { return grupoInfo; }
  function getShareLink() {
    if (!grupoId) return null;
    return `${window.location.origin}${window.location.pathname}?grupo=${grupoId}`;
  }

  async function refreshGrupoInfo() {
    if (!sb || !grupoId) return;
    const { data, error } = await sb
      .from('gc_grupos')
      .select('id, nombre, moneda_base, creado_por')
      .eq('id', grupoId)
      .single();
    if (error) {
      // No pudimos leer el grupo bajo RLS (ya no somos miembro, o quedó un
      // id viejo guardado localmente) — desvinculamos en vez de quedar en
      // un estado a medias. Mismo criterio que refreshListaInfo() en
      // lista-super.
      unsubscribeRealtime();
      grupoId = null;
      grupoInfo = null;
      clearStoredGrupoId();
      cb.onGrupoChange && cb.onGrupoChange(null);
      return;
    }
    grupoInfo = { id: data.id, nombre: data.nombre, monedaBase: data.moneda_base, creadoPor: data.creado_por };
  }

  async function createGrupo(nombre, monedaBase) {
    if (!sb || !currentUser) throw new Error('Iniciá sesión primero');
    const id = crypto.randomUUID();
    const { error } = await sb.from('gc_grupos').insert({
      id, nombre, moneda_base: monedaBase, creado_por: currentUser.id,
    });
    if (error) throw error;
    const { error: memErr } = await sb.from('gc_miembros').insert({
      grupo_id: id, usuario_id: currentUser.id, display_name: myDisplayNameDefault(),
    });
    if (memErr) throw memErr;
    await selectGrupo(id);
    return id;
  }

  async function joinGrupo(rawInput) {
    if (!sb || !currentUser) throw new Error('Iniciá sesión primero');
    const id = extractGrupoId(rawInput);
    if (!id) throw new Error('No reconocí un código/link de grupo válido ahí');
    const { error } = await sb.from('gc_miembros').insert({
      grupo_id: id, usuario_id: currentUser.id, display_name: myDisplayNameDefault(),
    });
    if (error) throw error;
    await selectGrupo(id);
    return id;
  }

  async function leaveGrupo() {
    if (!sb || !currentUser || !grupoId) return;
    await sb.from('gc_miembros').delete().eq('grupo_id', grupoId).eq('usuario_id', currentUser.id);
    unsubscribeRealtime();
    grupoId = null;
    grupoInfo = null;
    clearStoredGrupoId();
    cb.onGrupoChange && cb.onGrupoChange(null);
  }

  // .select().single() encadenado: si el día de mañana la policy de UPDATE
  // cambia y deja de permitir esto, un update bloqueado por RLS afecta 0
  // filas sin devolver error por sí solo — el .single() sí truena en ese
  // caso (mismo motivo que renameLista() en lista-super).
  async function renameGrupo(nombre) {
    if (!sb || !grupoId) throw new Error('No hay grupo activo');
    const { data, error } = await sb
      .from('gc_grupos')
      .update({ nombre })
      .eq('id', grupoId)
      .select('id, nombre, moneda_base, creado_por')
      .single();
    if (error) {
      if (error.code === 'PGRST116') throw new Error('No tenés permiso para renombrar este grupo');
      throw error;
    }
    grupoInfo = { id: data.id, nombre: data.nombre, monedaBase: data.moneda_base, creadoPor: data.creado_por };
    cb.onGrupoChange && cb.onGrupoChange(grupoInfo);
  }

  async function deleteGrupo() {
    if (!sb || !grupoId) return;
    const { error } = await sb.from('gc_grupos').delete().eq('id', grupoId);
    if (error) throw error;
    unsubscribeRealtime();
    grupoId = null;
    grupoInfo = null;
    clearStoredGrupoId();
    cb.onGrupoChange && cb.onGrupoChange(null);
  }

  async function getMembers() {
    if (!sb || !grupoId) return [];
    const { data, error } = await sb.from('gc_miembros').select('*').eq('grupo_id', grupoId);
    if (error) { fail(error); return []; }
    return data || [];
  }

  async function selectGrupo(id) {
    grupoId = id;
    setStoredGrupoId(id);
    await refreshGrupoInfo();
    if (!grupoId) return; // refreshGrupoInfo desvinculó: no somos miembro real
    subscribeRealtime();
    cb.onGrupoChange && cb.onGrupoChange(grupoInfo);
    await pullNow();
  }

  // ---- Pull remoto (detalle completo del grupo activo) ----

  async function fetchGrupoState() {
    const [gastosRes, settlementsRes, categoriasRes, miembrosRes] = await Promise.all([
      sb.from('gc_gastos').select('*').eq('grupo_id', grupoId).order('fecha', { ascending: false }),
      sb.from('gc_settlements').select('*').eq('grupo_id', grupoId),
      sb.from('gc_categorias').select('*').eq('grupo_id', grupoId),
      sb.from('gc_miembros').select('*').eq('grupo_id', grupoId),
    ]);
    if (gastosRes.error) throw gastosRes.error;
    if (settlementsRes.error) throw settlementsRes.error;
    if (categoriasRes.error) throw categoriasRes.error;
    if (miembrosRes.error) throw miembrosRes.error;

    const gastoIds = gastosRes.data.map((g) => g.id);
    const sharesRes = gastoIds.length
      ? await sb.from('gc_gasto_shares').select('*').in('gasto_id', gastoIds)
      : { data: [] };
    if (sharesRes.error) throw sharesRes.error;

    const gastos = gastosRes.data.map((g) => ({
      id: g.id,
      descripcion: g.descripcion,
      monto: Number(g.monto),
      moneda: g.moneda,
      tasaCambio: g.tasa_cambio == null ? null : Number(g.tasa_cambio),
      montoBase: Number(g.monto_base),
      categoria: g.categoria,
      pagadoPor: g.pagado_por,
      fecha: g.fecha,
      notas: g.notas,
      creadoPor: g.creado_por,
      shares: sharesRes.data
        .filter((s) => s.gasto_id === g.id)
        .map((s) => ({
          usuarioId: s.usuario_id,
          tipoSplit: s.tipo_split,
          valor: s.valor == null ? null : Number(s.valor),
          montoBase: Number(s.monto_base),
        })),
    }));

    const settlements = settlementsRes.data.map((s) => ({
      id: s.id,
      deUsuarioId: s.de_usuario_id,
      aUsuarioId: s.a_usuario_id,
      monto: Number(s.monto),
      moneda: s.moneda,
      fecha: s.fecha,
      nota: s.nota,
    }));

    const categoriasCustom = categoriasRes.data.map((c) => ({ nombre: c.nombre, icono: c.icono }));
    const miembros = miembrosRes.data.map((m) => ({
      usuarioId: m.usuario_id, displayName: m.display_name,
    }));

    return { gastos, settlements, categoriasCustom, miembros };
  }

  async function pullNow() {
    if (!sb || !grupoId) return;
    try {
      const state = await fetchGrupoState();
      cb.onRemoteData && cb.onRemoteData(state);
    } catch (err) {
      fail(err);
    }
  }

  function debouncedRefetch() {
    clearTimeout(refetchTimer);
    refetchTimer = setTimeout(pullNow, 300);
  }

  function subscribeRealtime() {
    unsubscribeRealtime();
    const filter = `grupo_id=eq.${grupoId}`;
    channel = sb.channel(`grupo-${grupoId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'gc_gastos', filter }, debouncedRefetch)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'gc_settlements', filter }, debouncedRefetch)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'gc_categorias', filter }, debouncedRefetch)
      // gc_gasto_shares no tiene grupo_id propio (cuelga de gc_gastos) — sin
      // filter, cualquier cambio en cualquier grupo dispara un refetch acá,
      // aceptable a esta escala (mismo trade-off que ls_receta_ingredientes
      // en lista-super).
      .on('postgres_changes', { event: '*', schema: 'public', table: 'gc_gasto_shares' }, debouncedRefetch)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'gc_miembros', filter }, () => {
        refreshGrupoInfo();
        cb.onMembersChange && getMembers().then(cb.onMembersChange);
      })
      .subscribe();
  }

  function unsubscribeRealtime() {
    if (channel) { sb.removeChannel(channel); channel = null; }
    clearTimeout(refetchTimer);
  }

  // ---- Push local -> remoto ----

  // gasto: { id, descripcion, monto, moneda, tasaCambio, montoBase,
  //          categoria, pagadoPor, fecha, notas, shares: [...] }
  // creado_por siempre queda como quien guardó por última vez (no se
  // preserva el creador original en ediciones) — coherente con que el spec
  // no define roles/admin dentro del grupo, todos los miembros son iguales.
  async function saveGasto(gasto) {
    if (!sb || !grupoId || !currentUser) throw new Error('No hay grupo activo');
    const { error: gErr } = await sb.from('gc_gastos').upsert({
      id: gasto.id,
      grupo_id: grupoId,
      descripcion: gasto.descripcion,
      monto: gasto.monto,
      moneda: gasto.moneda,
      tasa_cambio: gasto.tasaCambio,
      monto_base: gasto.montoBase,
      categoria: gasto.categoria,
      pagado_por: gasto.pagadoPor,
      fecha: gasto.fecha,
      notas: gasto.notas || null,
      creado_por: currentUser.id,
      updated_at: new Date().toISOString(),
    });
    if (gErr) throw gErr;

    const { error: delErr } = await sb.from('gc_gasto_shares').delete().eq('gasto_id', gasto.id);
    if (delErr) throw delErr;

    const rows = gasto.shares.map((s) => ({
      gasto_id: gasto.id,
      usuario_id: s.usuarioId,
      tipo_split: s.tipoSplit,
      valor: s.valor,
      monto_base: s.montoBase,
    }));
    const { error: sErr } = await sb.from('gc_gasto_shares').insert(rows);
    if (sErr) throw sErr;

    await pullNow();
  }

  async function deleteGasto(id) {
    if (!sb) return;
    const { error } = await sb.from('gc_gastos').delete().eq('id', id);
    if (error) throw error;
    await pullNow();
  }

  async function saveSettlement(settlement) {
    if (!sb || !grupoId || !currentUser) throw new Error('No hay grupo activo');
    const { error } = await sb.from('gc_settlements').insert({
      id: settlement.id || crypto.randomUUID(),
      grupo_id: grupoId,
      de_usuario_id: settlement.deUsuarioId,
      a_usuario_id: settlement.aUsuarioId,
      monto: settlement.monto,
      moneda: settlement.moneda,
      fecha: settlement.fecha,
      nota: settlement.nota || null,
      creado_por: currentUser.id,
    });
    if (error) throw error;
    await pullNow();
  }

  async function deleteSettlement(id) {
    if (!sb) return;
    const { error } = await sb.from('gc_settlements').delete().eq('id', id);
    if (error) throw error;
    await pullNow();
  }

  async function addCategoriaCustom(nombre, icono) {
    if (!sb || !grupoId) throw new Error('No hay grupo activo');
    const { error } = await sb.from('gc_categorias').insert({
      id: crypto.randomUUID(), grupo_id: grupoId, nombre, icono: icono || null,
    });
    if (error) {
      if (error.code === '23505') throw new Error('Esa categoría ya existe en este grupo');
      throw error;
    }
    await pullNow();
  }

  // ---- Init ----

  function init(callbacks) {
    cb = callbacks || {};
    if (!isConfigured()) return;
    sb = window.supabase.createClient(window.SUPABASE_CONFIG.url, window.SUPABASE_CONFIG.anonKey);

    const handleSession = (session) => {
      currentUser = session ? session.user : null;
      cb.onAuthChange && cb.onAuthChange(currentUser);
      if (currentUser && !grupoId) {
        const stored = getStoredGrupoId();
        if (stored) selectGrupo(stored).catch(fail);
      }
    };

    sb.auth.onAuthStateChange((_event, session) => handleSession(session));
    sb.auth.getSession().then(({ data }) => handleSession(data.session));
  }

  return {
    isConfigured,
    init,
    sendOtp,
    verifyOtp,
    signOut,
    getUser,
    getMyAlias,
    updateMyDisplayName,
    listMyGrupos,
    getGrupoId,
    getGrupoInfo,
    getShareLink,
    getMembers,
    createGrupo,
    joinGrupo,
    leaveGrupo,
    renameGrupo,
    deleteGrupo,
    selectGrupo,
    pendingJoinCodeFromUrl,
    pullNow,
    saveGasto,
    deleteGasto,
    saveSettlement,
    deleteSettlement,
    addCategoriaCustom,
  };
})();
