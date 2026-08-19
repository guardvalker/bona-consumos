// Lógica pura de cálculo para bona-consumos: splits de gastos, conversión de
// moneda y simplificación de deudas. Sin DOM, sin Supabase — index.html y
// sync.js consumen esto vía window.Logic.
window.Logic = (function () {

  const CATEGORIAS_DEFAULT = [
    'Comida', 'Transporte', 'Alojamiento', 'Entretenimiento', 'Servicios', 'Otros',
  ];

  function round2(n) {
    return Math.round((n + Number.EPSILON) * 100) / 100;
  }

  // Reparte `total` entre n partes iguales, en centavos exactos: reparte el
  // resto de redondeo (si total no es múltiplo exacto de 0.01*n) sobre las
  // primeras `resto` personas en vez de perderlo/duplicarlo — así la suma de
  // las partes siempre da exactamente `total`.
  function splitEqual(total, n) {
    const centavosTotal = Math.round(total * 100);
    const base = Math.floor(centavosTotal / n);
    const resto = centavosTotal - base * n;
    const partes = [];
    for (let i = 0; i < n; i++) {
      partes.push((base + (i < resto ? 1 : 0)) / 100);
    }
    return partes;
  }

  // Reparte `total` en proporción a `pesos` (porcentajes o shares numéricos,
  // no hace falta que sumen 100 en el caso de shares). Mismo criterio de
  // ajuste de redondeo que splitEqual, pero el remanente se lo lleva quien
  // tiene la parte más grande (menos distorsivo que dárselo siempre al
  // primero de la lista).
  function splitByWeights(total, pesos) {
    const sumaPesos = pesos.reduce((a, b) => a + b, 0);
    if (sumaPesos <= 0) throw new Error('Los pesos/porcentajes deben sumar más que cero');
    const centavosTotal = Math.round(total * 100);
    const crudo = pesos.map((p) => (centavosTotal * p) / sumaPesos);
    const partes = crudo.map(Math.floor);
    let asignado = partes.reduce((a, b) => a + b, 0);
    let restante = centavosTotal - asignado;
    // Reparte los centavos que quedaron sin asignar por el floor, empezando
    // por las partes con mayor resto fraccionario (método de Hamilton).
    const orden = crudo
      .map((v, i) => ({ i, resto: v - Math.floor(v) }))
      .sort((a, b) => b.resto - a.resto);
    for (let k = 0; k < orden.length && restante > 0; k++) {
      partes[orden[k].i] += 1;
      restante--;
    }
    return partes.map((c) => c / 100);
  }

  // Calcula los shares (una fila por participante) de un gasto. `montoBase`
  // es el monto ya convertido a la moneda base del grupo. Devuelve
  // [{ usuarioId, tipoSplit, valor, montoBase }], con suma de montoBase
  // exactamente igual a `montoBase` recibido (salvo 'monto_fijo', que se
  // valida aparte porque el usuario carga los montos a mano).
  function calcularShares(montoBase, tipoSplit, participantes) {
    // participantes: [{ usuarioId, valor }] — valor es porcentaje/shares
    // según tipoSplit, o el monto fijo ya en moneda base, o ignorado si 'igual'.
    const ids = participantes.map((p) => p.usuarioId);

    if (tipoSplit === 'igual') {
      const partes = splitEqual(montoBase, ids.length);
      return ids.map((usuarioId, i) => ({
        usuarioId, tipoSplit, valor: null, montoBase: partes[i],
      }));
    }

    if (tipoSplit === 'porcentaje' || tipoSplit === 'shares') {
      const pesos = participantes.map((p) => Number(p.valor) || 0);
      if (tipoSplit === 'porcentaje') {
        const suma = round2(pesos.reduce((a, b) => a + b, 0));
        if (suma !== 100) {
          throw new Error(`Los porcentajes suman ${suma}%, tienen que sumar 100%`);
        }
      }
      const partes = splitByWeights(montoBase, pesos);
      return ids.map((usuarioId, i) => ({
        usuarioId, tipoSplit, valor: pesos[i], montoBase: partes[i],
      }));
    }

    if (tipoSplit === 'monto_fijo') {
      const partes = participantes.map((p) => round2(Number(p.valor) || 0));
      const suma = round2(partes.reduce((a, b) => a + b, 0));
      if (suma !== round2(montoBase)) {
        throw new Error(`Los montos suman ${suma}, tienen que sumar ${round2(montoBase)}`);
      }
      return ids.map((usuarioId, i) => ({
        usuarioId, tipoSplit, valor: partes[i], montoBase: partes[i],
      }));
    }

    throw new Error(`tipoSplit desconocido: ${tipoSplit}`);
  }

  // Balance neto por usuario a partir de gastos + shares + settlements, todo
  // ya en moneda base del grupo. Positivo = le deben (a favor). Negativo =
  // debe (en contra).
  function calcularBalances({ gastos, shares, settlements }) {
    const balance = {};
    const add = (id, delta) => { balance[id] = round2((balance[id] || 0) + delta); };

    gastos.forEach((g) => add(g.pagadoPor, g.montoBase));
    shares.forEach((s) => add(s.usuarioId, -s.montoBase));
    settlements.forEach((s) => {
      add(s.deUsuarioId, s.monto);   // pagó → su deuda baja → balance sube
      add(s.aUsuarioId, -s.monto);   // cobró → lo que le debían baja → balance baja
    });

    return balance;
  }

  // Simplifica saldos cruzados a la menor cantidad de transacciones posible
  // (algoritmo goloso: en cada paso salda al mayor deudor contra el mayor
  // acreedor). No es matemáticamente óptimo en todos los casos límite, pero
  // es el mismo criterio que usan Tricount/Splitwise y da resultados muy
  // buenos en la práctica para grupos chicos.
  function simplificarDeudas(balance) {
    const EPS = 0.005;
    const deudores = [];
    const acreedores = [];
    Object.entries(balance).forEach(([id, monto]) => {
      if (monto < -EPS) deudores.push({ id, monto: -monto });
      else if (monto > EPS) acreedores.push({ id, monto });
    });
    deudores.sort((a, b) => b.monto - a.monto);
    acreedores.sort((a, b) => b.monto - a.monto);

    const transacciones = [];
    let i = 0, j = 0;
    while (i < deudores.length && j < acreedores.length) {
      const d = deudores[i];
      const a = acreedores[j];
      const monto = round2(Math.min(d.monto, a.monto));
      if (monto > EPS) {
        transacciones.push({ deUsuarioId: d.id, aUsuarioId: a.id, monto });
      }
      d.monto = round2(d.monto - monto);
      a.monto = round2(a.monto - monto);
      if (d.monto <= EPS) i++;
      if (a.monto <= EPS) j++;
    }
    return transacciones;
  }

  return {
    CATEGORIAS_DEFAULT,
    round2,
    splitEqual,
    splitByWeights,
    calcularShares,
    calcularBalances,
    simplificarDeudas,
  };
})();
