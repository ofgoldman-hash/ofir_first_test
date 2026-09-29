// Tiny SVG bar charts (no dependencies). Each month gets a full-height hit target
// carrying a tooltip, so small bars are still easy to hover.

import { esc, money, monthLabel } from './format.js';

const W = 720, H = 260, PAD = { top: 12, right: 12, bottom: 28, left: 64 };

function niceStep(range) {
  const raw = range / 4 || 1;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * pow;
}

function scale(minV, maxV) {
  const step = niceStep(maxV - minV);
  const lo = Math.floor(minV / step) * step;
  const hi = Math.ceil(maxV / step) * step || step;
  const plotH = H - PAD.top - PAD.bottom;
  const y = v => PAD.top + (hi - v) / (hi - lo || 1) * plotH;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(v);
  return { y, ticks };
}

// A bar whose data-end (away from the baseline) has 4px rounded corners.
function barPath(x, w, yBase, yEnd, round) {
  const h = Math.abs(yBase - yEnd);
  if (h < 0.5) return '';
  const r = round ? Math.min(4, w / 2, h) : 0;
  if (yEnd < yBase) { // grows upward
    return `M${x},${yBase}V${yEnd + r}Q${x},${yEnd} ${x + r},${yEnd}H${x + w - r}Q${x + w},${yEnd} ${x + w},${yEnd + r}V${yBase}Z`;
  }
  return `M${x},${yBase}V${yEnd - r}Q${x},${yEnd} ${x + r},${yEnd}H${x + w - r}Q${x + w},${yEnd} ${x + w},${yEnd - r}V${yBase}Z`;
}

function frame(ticks, y, months, slot) {
  const grid = ticks.map(v => `
    <line class="grid${v === 0 ? ' zero' : ''}" x1="${PAD.left}" x2="${W - PAD.right}" y1="${y(v)}" y2="${y(v)}"/>
    <text class="axis" x="${PAD.left - 8}" y="${y(v) + 4}" text-anchor="end">${esc(money(v, true))}</text>`).join('');
  const every = Math.ceil(months.length / 12);
  const labels = months.map((m, i) => i % every ? '' :
    `<text class="axis" x="${PAD.left + slot * i + slot / 2}" y="${H - 8}" text-anchor="middle">${esc(monthLabel(m.month))}</text>`).join('');
  return grid + labels;
}

function svg(label, body) {
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">${body}</svg>`;
}

// Net balance per month: blue above zero, red below (diverging poles).
export function netChart(months) {
  if (!months.length) return '';
  const vals = months.map(m => m.net);
  const { y, ticks } = scale(Math.min(0, ...vals), Math.max(0, ...vals));
  const slot = (W - PAD.left - PAD.right) / months.length;
  const bw = Math.max(3, Math.min(28, slot * 0.6));
  let body = frame(ticks, y, months, slot);
  months.forEach((m, i) => {
    const x = PAD.left + slot * i + (slot - bw) / 2;
    body += `<path class="${m.net >= 0 ? 'pos' : 'neg'}" d="${barPath(x, bw, y(0), y(m.net), true)}"/>`;
    const tip = `${monthLabel(m.month)}\nמאזן: ${money(m.net)} (${m.net >= 0 ? 'עודף' : 'גירעון'})`;
    body += `<rect class="hit" x="${PAD.left + slot * i}" y="${PAD.top}" width="${slot}" height="${H - PAD.top - PAD.bottom}" data-tip="${esc(tip)}"/>`;
  });
  return svg('מאזן חודשי', body);
}

// Stacked expenses per month by layer, with the month's income as a tick mark.
export const LAYERS = [
  { key: 'fixedExp', label: 'הוצאות קבועות', cls: 's1' },
  { key: 'varExp', label: 'הוצאות משתנות', cls: 's2' },
  { key: 'oneoffExp', label: 'הוצאות חד-פעמיות', cls: 's3' },
];

export function layersChart(months) {
  if (!months.length) return '';
  const income = m => m.fixedIncome + m.varIncome + m.oneoffIncome;
  const maxV = Math.max(...months.map(m => Math.max(income(m), m.fixedExp + m.varExp + m.oneoffExp)), 1);
  const { y, ticks } = scale(0, maxV);
  const slot = (W - PAD.left - PAD.right) / months.length;
  const bw = Math.max(3, Math.min(28, slot * 0.6));
  let body = frame(ticks, y, months, slot);
  months.forEach((m, i) => {
    const x = PAD.left + slot * i + (slot - bw) / 2;
    let acc = 0;
    const present = LAYERS.filter(l => m[l.key] > 0);
    present.forEach((l, j) => {
      const base = y(acc) - (j > 0 ? 1 : 0); // 2px surface gap between segments
      acc += m[l.key];
      const end = y(acc) + (j < present.length - 1 ? 1 : 0);
      if (base - end > 0.5) body += `<path class="${l.cls}" d="${barPath(x, bw, base, end, j === present.length - 1)}"/>`;
    });
    const iy = y(income(m));
    body += `<line class="income-tick" x1="${x - 4}" x2="${x + bw + 4}" y1="${iy}" y2="${iy}"/>`;
    const tip = [
      monthLabel(m.month),
      `הכנסות: ${money(income(m))}`,
      ...LAYERS.map(l => `${l.label}: ${money(m[l.key])}`),
    ].join('\n');
    body += `<rect class="hit" x="${PAD.left + slot * i}" y="${PAD.top}" width="${slot}" height="${H - PAD.top - PAD.bottom}" data-tip="${esc(tip)}"/>`;
  });
  return svg('הוצאות לפי שכבה מול הכנסות', body);
}
