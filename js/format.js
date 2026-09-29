const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ESC[c]);

const nf = new Intl.NumberFormat('he-IL', { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Plain minus sign in LTR-isolated text keeps negative numbers readable inside RTL.
export function money(v, compact = false) {
  const n = Math.round(v || 0);
  if (compact && Math.abs(n) >= 1000) {
    return `⁦${n < 0 ? '-' : ''}₪${nf.format(Math.abs(n) / 1000)}K⁩`;
  }
  return `⁦${n < 0 ? '-' : ''}₪${nf.format(Math.abs(n))}⁩`;
}

export const moneyExact = v => `⁦${v < 0 ? '-' : ''}₪${nf2.format(Math.abs(v))}⁩`;

const MONTHS = ['ינו', 'פבר', 'מרץ', 'אפר', 'מאי', 'יוני', 'יולי', 'אוג', 'ספט', 'אוק', 'נוב', 'דצמ'];
export const monthLabel = ym => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(2, 4)}`;

export const dateLabel = d => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(2, 4)}`;
