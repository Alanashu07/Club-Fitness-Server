const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const startOfToday = function () {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
}

const startOfMonth = function (date = new Date()) {
    return new Date(date.getFullYear(), date.getMonth(), 1);
}

const endOfMonth = function (date = new Date()) {
    return new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999);
}

const subMonths = function(date, n) {
    return new Date(date.getFullYear(), date.getMonth() - n, date.getDate());
}

const subDays = function(date, n) {
    const d = new Date(date);
    d.setDate(d.getDate() - n);
    return d;
}

const monthLabel = function(date) {
    return date.toLocaleString('en-US', { month: 'short' });
}

const timeAgo = function(date) {
    if (!date) return '';
    const diffMs = Date.now() - new Date(date).getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);
    if (diffMins < 60) return `${Math.max(diffMins, 1)}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays === 1) return 'Yesterday';
    return `${diffDays} days ago`;
}

const startOfWeek = function(date = new Date()) {
    // Monday-based week start
    const d = new Date(date);
    const day = d.getDay(); // 0 = Sun
    const diff = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + diff);
    d.setHours(0, 0, 0, 0);
    return d;
}

const parseHHmmToMinutes = function(hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + (m || 0);
}

export default { startOfToday, startOfMonth, endOfMonth, subMonths, subDays, monthLabel, timeAgo, DAY_LABELS, startOfWeek, parseHHmmToMinutes };