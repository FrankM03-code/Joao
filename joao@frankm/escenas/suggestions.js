// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// "A esta hora sueles abrir…". Everything here is local; nothing leaves the computer.
const WINDOW_MINUTES = 60;
const DAYS = 30;
const MIN_HITS = 3;
const MIN_LEAD = 1;
const DAY_MINUTES = 24 * 60;

const isWeekend = weekday => weekday === 0 || weekday === 6;

const minuteOf = date => date.getHours() * 60 + date.getMinutes();

// Works across midnight: 23:30 and 00:15 are 45 minutes apart.
function closeInTime(a, b) {
    const d = Math.abs(a - b);
    return Math.min(d, DAY_MINUTES - d) <= WINDOW_MINUTES;
}

const sameMoment = (entry, now) =>
    isWeekend(entry.weekday) === isWeekend(now.getDay()) && closeInTime(entry.minuteOfDay, minuteOf(now));

export const usageEntry = (id, now) => ({
    id,
    weekday: now.getDay(),
    minuteOfDay: minuteOf(now),
    at: now.toISOString(),
});

// The scene to suggest now, or null when no suggestion is reliable.
export function suggest(data, usage, now = new Date()) {
    const {scenes, suggestions: {disabled, pinned}} = data;
    const usable = id => scenes.some(s => s.id === id) && !disabled.includes(id);
    const pin = pinned.find(p => usable(p.id) && sameMoment(p, now));
    if (pin)
        return scenes.find(s => s.id === pin.id);

    const since = now.getTime() - DAYS * 24 * 3600 * 1000;
    const hits = new Map();
    for (const entry of usage) {
        if (usable(entry.id) && Date.parse(entry.at) >= since && sameMoment(entry, now))
            hits.set(entry.id, (hits.get(entry.id) ?? 0) + 1);
    }
    const [first, second] = [...hits].sort((a, b) => b[1] - a[1]);
    if (!first || first[1] < MIN_HITS || (second && first[1] - second[1] < MIN_LEAD))
        return null;
    return scenes.find(s => s.id === first[0]);
}
