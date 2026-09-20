/** Output formatting. Dense and unambiguous — a model reads this, not a human. */
export function relativeTime(epochMs, now = Date.now()) {
    const seconds = Math.max(0, Math.round((now - epochMs) / 1000));
    if (seconds < 60)
        return `${seconds}s ago`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60)
        return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 48)
        return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
}
/** A compact budget bar, so the model can see pressure at a glance. */
export function budgetBar(used, total, width = 20) {
    if (total <= 0)
        return '';
    const ratio = Math.min(1, used / total);
    const filled = Math.round(ratio * width);
    return `[${'#'.repeat(filled)}${'.'.repeat(width - filled)}] ${used}/${total} tokens (${Math.round(ratio * 100)}%)`;
}
export function pluralize(n, singular, plural = `${singular}s`) {
    return `${n} ${n === 1 ? singular : plural}`;
}
/** Text result in the shape the MCP SDK expects. */
export function text(body) {
    return { content: [{ type: 'text', text: body }] };
}
//# sourceMappingURL=format.js.map