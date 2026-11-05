// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Search in the page: apps by name, generic name, keywords, executable and id; scenes by name
// and by the apps they hold. Ignores case and accents; apps whose name starts with the text
// come first and, inside each group, the most used.
import Shell from 'gi://Shell';

export const fold = s => (s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

const termsOf = query => fold(query).trim().split(/\s+/).filter(t => t);
const startsWord = (text, term) => text.startsWith(term) || text.split(/[\s\-_.]+/).some(w => w.startsWith(term));

function fieldsOf(app) {
    const info = app.get_app_info();
    return {
        name: fold(app.get_name()),
        others: [
            info?.get_generic_name?.(),
            ...(info?.get_keywords?.() ?? []),
            (info?.get_executable?.() ?? '').split('/').pop(),
            app.get_id().replace(/\.desktop$/, ''),
        ].map(fold),
    };
}

export function searchApps(apps, query, cache) {
    const terms = termsOf(query);
    const usage = Shell.AppUsage.get_default();
    const found = [];
    for (const app of apps) {
        const id = app.get_id();
        if (!cache.has(id))
            cache.set(id, fieldsOf(app));
        const f = cache.get(id);
        let group = 0;
        const ok = terms.every(term => {
            if (startsWord(f.name, term))
                return true;
            group = 1;
            return f.name.includes(term) || f.others.some(o => o.includes(term));
        });
        if (ok)
            found.push({app, group});
    }
    found.sort((a, b) => a.group - b.group || usage.compare(a.app.get_id(), b.app.get_id()));
    return found.map(f => f.app);
}

export function searchScenes(scenes, query, appName) {
    const terms = termsOf(query);
    return scenes.filter(scene => {
        const text = fold([scene.name, ...scene.windows.map(w => appName(w))].join(' '));
        return terms.every(term => text.includes(term));
    });
}
