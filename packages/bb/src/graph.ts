type Point = { x: number; y: number };

/** Every graph's Edge, the one recipe both the app's React Flow Edge and drawings outside it (the Hub's share
 * previews) draw: a slight bow between mark centers (a quadratic whose control sits off the midpoint, left of travel,
 * by 12% of the length up to 24px, so Edges sharing a mark fan apart), clipped to the marks' rims, tapering from a
 * hairline at the source into the target like a comet trail. Undefined when the marks coincide. */
export function edgeCurve(from: Point, to: Point, radius: number) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (!distance) return undefined;
  const bend = Math.min(24, distance * 0.12);
  const control = { x: (from.x + to.x) / 2 - (dy / distance) * bend, y: (from.y + to.y) / 2 + (dx / distance) * bend };
  const at = (t: number): Point => ({
    x: (1 - t) ** 2 * from.x + 2 * (1 - t) * t * control.x + t ** 2 * to.x,
    y: (1 - t) ** 2 * from.y + 2 * (1 - t) * t * control.y + t ** 2 * to.y,
  });
  const start = Math.min(0.45, radius / distance);
  return {
    control,
    at,
    /** Where the trail leaves the source's rim and meets the target's, along the curve. */
    start,
    end: 1 - start,
    /** The trail's width at \`share\` of the way from source rim to target rim: 1 to 6.5. */
    width: (share: number) => 1 + 5.5 * share,
  };
}

/** How many times its drawn width a trail holds on screen when its graph is shown at \`zoom\`: zoomed out to fit a
 * large graph, up to 2.5×, so the taper still reads as a tree's limbs. */
export function edgeHold(zoom: number): number {
  return Math.min(2.5, Math.max(1, 1 / zoom));
}

/** The Edge's trail as one filled outline, for drawings that can't stroke segment by segment. \`scale\` thins it (a
 * cross-link off the spine draws at 0.8). Empty when the marks coincide or overlap. */
export function taperPath(from: Point, to: Point, radius: number, scale = 1): string {
  const curve = edgeCurve(from, to, radius);
  if (!curve || Math.hypot(to.x - from.x, to.y - from.y) <= 2 * radius) return "";
  const steps = 16;
  const left: string[] = [];
  const right: string[] = [];
  const f = (x: number) => x.toFixed(2);
  for (let i = 0; i <= steps; i++) {
    const t = curve.start + ((curve.end - curve.start) * i) / steps;
    const p = curve.at(t);
    // The quadratic's tangent, for the normal the outline steps out along.
    const tx = 2 * (1 - t) * (curve.control.x - from.x) + 2 * t * (to.x - curve.control.x);
    const ty = 2 * (1 - t) * (curve.control.y - from.y) + 2 * t * (to.y - curve.control.y);
    const length = Math.hypot(tx, ty) || 1;
    const half = (curve.width(i / steps) * scale) / 2;
    left.push(f(p.x - (ty / length) * half) + "," + f(p.y + (tx / length) * half));
    right.push(f(p.x + (ty / length) * half) + "," + f(p.y - (tx / length) * half));
  }
  return "M" + left.join(" L") + " L" + right.reverse().join(" L") + " Z";
}
