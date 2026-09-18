export interface Pt { x: number; y: number }

/**
 * Where a connector's label belongs: the midpoint **by length**, not the middle
 * element of the point list. An orthogonal route is made of segments of wildly
 * different lengths, so picking the middle vertex parks the text in a corner.
 */
export function labelAnchor(points: readonly Pt[], at = 0.5): { x: number; y: number; horizontal: boolean } {
  const frac = Math.max(0.02, Math.min(0.98, at));
  if (points.length < 2) {
    const p = points[0] ?? { x: 0, y: 0 };
    return { x: p.x, y: p.y, horizontal: true };
  }
  const seg: number[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const d = Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
    seg.push(d); total += d;
  }
  let walked = 0;
  for (let i = 0; i < seg.length; i++) {
    const d = seg[i]!;
    if (walked + d >= total * frac || i === seg.length - 1) {
      const t = d === 0 ? 0 : (total * frac - walked) / d;
      const a = points[i]!, b = points[i + 1]!;
      return {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        horizontal: Math.abs(b.x - a.x) >= Math.abs(b.y - a.y),
      };
    }
    walked += d;
  }
  const p = points[0]!;
  return { x: p.x, y: p.y, horizontal: true };
}

/**
 * Box and text placement for a label of the given width at that anchor.
 * `flip` puts it on the other side of the line: below a horizontal run
 * instead of above, left of a vertical run instead of right.
 */
export function labelBox(points: readonly Pt[], width: number, at = 0.5, flip = false) {
  const a = labelAnchor(points, at);
  if (a.horizontal) return flip
    ? { rectX: a.x - width / 2, rectY: a.y + 4, textX: a.x, textY: a.y + 15, anchor: 'middle' as const }
    : { rectX: a.x - width / 2, rectY: a.y - 17, textX: a.x, textY: a.y - 6, anchor: 'middle' as const };
  return flip
    ? { rectX: a.x - 7 - width, rectY: a.y - 8, textX: a.x - 12, textY: a.y + 3.5, anchor: 'end' as const }
    : { rectX: a.x + 7, rectY: a.y - 8, textX: a.x + 12, textY: a.y + 3.5, anchor: 'start' as const };
}

/** Which side of the nearest segment a point is on: true = the flipped side (below / left). */
export function flippedSide(points: readonly Pt[], p: Pt): boolean {
  let best = { d: Infinity, flip: false };
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!;
    const dx = b.x - a.x, dy = b.y - a.y, len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0;
    const q = { x: a.x + dx * t, y: a.y + dy * t };
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    if (d < best.d) best = { d, flip: Math.abs(dx) >= Math.abs(dy) ? p.y > q.y : p.x < q.x };
  }
  return best.flip;
}

/**
 * An orthogonal polyline as an SVG path with softly rounded corners. Straight
 * runs stay straight; each bend becomes a small quadratic arc, so parallel
 * connectors stay readable where several turn together. The radius shrinks on
 * short segments so two bends never overlap.
 */
export function roundedPath(points: readonly Pt[], radius = 8): string {
  if (points.length < 2) return '';
  const p = points;
  let d = `M${p[0]!.x} ${p[0]!.y}`;
  for (let i = 1; i < p.length - 1; i++) {
    const a = p[i - 1]!, b = p[i]!, c = p[i + 1]!;
    const inLen = Math.hypot(b.x - a.x, b.y - a.y), outLen = Math.hypot(c.x - b.x, c.y - b.y);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    if (r < 1) { d += ` L${b.x} ${b.y}`; continue; }
    const ux = (b.x - a.x) / inLen, uy = (b.y - a.y) / inLen;
    const vx = (c.x - b.x) / outLen, vy = (c.y - b.y) / outLen;
    d += ` L${b.x - ux * r} ${b.y - uy * r} Q${b.x} ${b.y} ${b.x + vx * r} ${b.y + vy * r}`;
  }
  const last = p[p.length - 1]!;
  d += ` L${last.x} ${last.y}`;
  return d;
}

/** Where along the polyline (0…1 by length) a point projects: the inverse of `labelAnchor`. */
export function fractionAlong(points: readonly Pt[], p: Pt): number {
  let total = 0, best = { d: Infinity, at: 0.5 }, walked = 0;
  const seg: number[] = [];
  for (let i = 1; i < points.length; i++) { const d = Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y); seg.push(d); total += d; }
  if (!total) return 0.5;
  for (let i = 0; i < seg.length; i++) {
    const a = points[i]!, b = points[i + 1]!, d = seg[i]!;
    const t = d === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (d * d)));
    const q = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    const dist = Math.hypot(p.x - q.x, p.y - q.y);
    if (dist < best.d) best = { d: dist, at: (walked + d * t) / total };
    walked += d;
  }
  return best.at;
}
