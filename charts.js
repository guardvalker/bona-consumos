// Gráficos SVG para la pantalla de Estadísticas — funciones puras que
// devuelven markup, sin librerías externas (mismo criterio "sin frameworks
// pesados" del resto de la app). index.html las consume vía window.Charts.
window.Charts = (function () {
  function polarToCartesian(cx, cy, r, angleDeg) {
    const rad = ((angleDeg - 90) * Math.PI) / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  }

  function arcPath(cx, cy, r, startAngle, endAngle) {
    const start = polarToCartesian(cx, cy, r, endAngle);
    const end = polarToCartesian(cx, cy, r, startAngle);
    const largeArc = endAngle - startAngle > 180 ? 1 : 0;
    return `M ${cx} ${cy} L ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 0 ${end.x} ${end.y} Z`;
  }

  // data: [{ value, colorVar }] — colorVar ej. '--ctp-peach' (variable CSS,
  // no un hex fijo, así el gráfico respeta el tema claro/oscuro solo).
  function pieChart(data, { size = 220 } = {}) {
    const total = data.reduce((a, d) => a + d.value, 0);
    if (total <= 0) return '';
    const cx = size / 2, cy = size / 2, r = size / 2 - 4;
    let angle = 0;
    const slices = data.map((d) => {
      const portion = d.value / total;
      const startAngle = angle;
      const endAngle = angle + portion * 360;
      angle = endAngle;
      // Una sola categoría con el 100% degenera el arco (start === end) —
      // dibujar un círculo completo en su lugar.
      if (portion >= 0.9995) {
        return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="var(${d.colorVar})"/>`;
      }
      return `<path d="${arcPath(cx, cy, r, startAngle, endAngle)}" fill="var(${d.colorVar})"/>`;
    }).join('');
    return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${slices}</svg>`;
  }

  // Barras horizontales (más legibles que verticales con nombres largos de
  // categoría). rowHeight fijo, alto total proporcional a la cantidad de filas.
  function barChart(data, { width = 280, rowHeight = 32 } = {}) {
    const max = Math.max(...data.map((d) => d.value), 0.0001);
    const height = data.length * rowHeight;
    const bars = data.map((d, i) => {
      const y = i * rowHeight + rowHeight * 0.22;
      const barH = rowHeight * 0.56;
      const w = Math.max(3, (d.value / max) * width);
      return `<rect x="0" y="${y}" width="${w}" height="${barH}" rx="6" fill="var(${d.colorVar})"/>`;
    }).join('');
    return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" preserveAspectRatio="none">${bars}</svg>`;
  }

  return { pieChart, barChart };
})();
