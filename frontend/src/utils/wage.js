export function formatWageRange(from, to, per) {
    if (from == null || from === '' || !Number.isFinite(Number(from))) return 'N/A';
    const lo = Number(from);
    const hi = to == null || to === '' ? null : Number(to);
    const range = hi !== null && Number.isFinite(hi) && hi !== lo
        ? `$${lo.toLocaleString()} – $${hi.toLocaleString()}` : `$${lo.toLocaleString()}`;
    const unit = per && !/^(?:n\/?a|unknown)$/i.test(String(per).trim()) ? per : 'pay period not reported';
    return `${range} / ${unit}`;
}
