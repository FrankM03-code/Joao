// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Reads and writes ~/.local/share/escenas/escenas-guardadas.json (with a .bak of the
// previous contents) and uso.json. Writes go one at a time, in order.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {arrangeFor, LAYOUTS} from './layouts.js';
import {usageEntry} from './suggestions.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');

const MAX_USAGE = 500;
const empty = () => ({version: 1, scenes: [], suggestions: {disabled: [], pinned: []}});
const nowIso = () => GLib.DateTime.new_now_local().format_iso8601();
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const decoder = new TextDecoder();
const encoder = new TextEncoder();

function cleanWindow(w, i) {
    if (typeof w?.appId !== 'string' || !w.appId)
        return null;
    const r = w.rect ?? {};
    const rect = isNum(r.x) && isNum(r.y) && isNum(r.w) && isNum(r.h) && r.w > 0 && r.h > 0
        ? {x: r.x, y: r.y, w: r.w, h: r.h}
        : {x: 0, y: 0, w: 1, h: 1};
    return {
        appId: w.appId,
        appName: typeof w.appName === 'string' ? w.appName : '',
        titleHint: typeof w.titleHint === 'string' ? w.titleHint : '',
        rect,
        maximized: w.maximized === true,
        order: isNum(w.order) ? w.order : i,
    };
}

function clean(raw) {
    const data = empty();
    if (!Array.isArray(raw?.scenes))
        throw new Error('formato no reconocido');
    for (const s of raw.scenes) {
        if (typeof s?.id !== 'string' || typeof s.name !== 'string' || !Array.isArray(s.windows))
            continue;
        const windows = s.windows.map(cleanWindow).filter(w => w).sort((a, b) => a.order - b.order);
        data.scenes.push({
            ...s,
            layout: LAYOUTS.some(l => l.id === s.layout) ? s.layout : 'free',
            windows,
        });
    }
    const list = raw.suggestions?.disabled;
    data.suggestions.disabled = Array.isArray(list) ? list.filter(i => typeof i === 'string') : [];
    const pins = raw.suggestions?.pinned;
    data.suggestions.pinned = Array.isArray(pins)
        ? pins.filter(p => typeof p?.id === 'string' && isNum(p.minuteOfDay) && isNum(p.weekday))
        : [];
    return data;
}

const cleanUse = u => typeof u?.id === 'string' && isNum(u.weekday) && isNum(u.minuteOfDay) && typeof u.at === 'string';

const newWindow = (app, order) => ({
    appId: app.get_id(),
    appName: app.get_name(),
    titleHint: '',
    rect: {x: 0.2, y: 0.15, w: 0.6, h: 0.7},
    maximized: false,
    order,
});

export class SavedScenesStore {
    constructor() {
        const dir = GLib.build_filenamev([GLib.get_user_data_dir(), 'escenas']);
        this._dir = Gio.File.new_for_path(dir);
        this._file = this._dir.get_child('escenas-guardadas.json');
        this._bak = this._dir.get_child('escenas-guardadas.json.bak');
        this._usageFile = this._dir.get_child('uso.json');
        this._data = empty();
        this._usage = [];
        this._lastText = null;
        this._queue = Promise.resolve();
        this._cancel = new Gio.Cancellable();
        this.reload();
    }

    destroy() {
        this._cancel.cancel();
    }

    get scenes() {
        return this._data.scenes;
    }

    get data() {
        return this._data;
    }

    get usage() {
        return this._usage;
    }

    byId(id) {
        return this.scenes.find(s => s.id === id) ?? null;
    }

    byName(name) {
        const wanted = name.trim().toLocaleLowerCase();
        return this.scenes.find(s => s.name.trim().toLocaleLowerCase() === wanted) ?? null;
    }

    // Reads the files again (they may have been edited or deleted by hand). A missing file is
    // simply "no scenes"; a broken one falls back to its .bak and is kept aside, not lost.
    reload() {
        this._queue = this._queue.then(async () => {
            const text = await this._read(this._file);
            if (text === null) {
                this._data = empty();
                this._lastText = null;
            } else {
                try {
                    this._data = clean(JSON.parse(text));
                    this._lastText = text;
                } catch (e) {
                    logError(e, 'João: escenas-guardadas.json dañado');
                    await this._write(this._dir.get_child('escenas-guardadas.json.danado'), text);
                    this._lastText = null;
                    try {
                        this._data = clean(JSON.parse(await this._read(this._bak) ?? ''));
                    } catch {
                        this._data = empty();
                    }
                }
            }
            try {
                const usage = JSON.parse(await this._read(this._usageFile) ?? '[]');
                this._usage = Array.isArray(usage) ? usage.filter(cleanUse) : [];
            } catch {
                this._usage = [];
            }
        }).catch(e => logError(e, 'João: leer escenas'));
        return this._queue;
    }

    async _read(file) {
        try {
            const [bytes] = await file.load_contents_async(this._cancel);
            return decoder.decode(bytes);
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                return null;
            throw e;
        }
    }

    async _write(file, text) {
        try {
            this._dir.make_directory_with_parents(null);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                throw e;
        }
        await file.replace_contents_bytes_async(new GLib.Bytes(encoder.encode(text)), null, false,
            Gio.FileCreateFlags.NONE, null);
    }

    _save() {
        this._queue = this._queue.then(async () => {
            const text = JSON.stringify(this._data, null, 2);
            if (this._lastText !== null)
                await this._write(this._bak, this._lastText);
            await this._write(this._file, text);
            this._lastText = text;
        }).catch(e => logError(e, 'João: guardar escenas'));
        return this._queue;
    }

    _newId() {
        let id;
        do
            id = GLib.uuid_string_random().slice(0, 8);
        while (this.byId(id));
        return id;
    }

    // Saves a new scene, or replaces @replaceId (keeping its id and creation date).
    saveScene({name, layout, windows, replaceId = null}) {
        const old = replaceId ? this.byId(replaceId) : null;
        const now = nowIso();
        const scene = {
            ...old,
            id: old?.id ?? this._newId(),
            name: name.trim(),
            layout,
            createdAt: old?.createdAt ?? now,
            updatedAt: now,
            windows: arrangeFor(layout, windows),
        };
        if (old)
            this.scenes[this.scenes.indexOf(old)] = scene;
        else
            this.scenes.push(scene);
        this._save();
        return scene;
    }

    rename(id, name) {
        const scene = this.byId(id);
        if (!scene)
            return;
        scene.name = name.trim();
        scene.updatedAt = nowIso();
        this._save();
    }

    // On: a click opens the scene's apps. Off: they wait in the strip.
    setOpenApps(id, on) {
        const scene = this.byId(id);
        if (!scene)
            return;
        scene.openApps = on;
        this._save();
    }

    setLayout(id, layout) {
        const scene = this.byId(id);
        if (!scene)
            return;
        scene.layout = layout;
        scene.windows = arrangeFor(layout, scene.windows);
        scene.updatedAt = nowIso();
        this._save();
    }

    updateWindows(id, windows) {
        const scene = this.byId(id);
        if (!scene)
            return;
        scene.windows = arrangeFor(scene.layout, windows);
        scene.updatedAt = nowIso();
        this._save();
    }

    // A scene made by dragging an app onto "Nueva escena": nothing gets opened. The name can
    // be changed later; a computed layout, because these windows have no saved position.
    createFromApp(app) {
        let name = 'Nueva escena';
        for (let n = 2; this.byName(name); n++)
            name = `Nueva escena ${n}`;
        return this.saveScene({name, layout: 'main-side', windows: [newWindow(app, 0)]});
    }

    // Goes last. In a computed layout the existing main window stays the main one; with
    // saved positions it comes up centered, on top of the others.
    addApp(id, app) {
        const scene = this.byId(id);
        if (!scene)
            return;
        scene.windows = [...scene.windows, newWindow(app, scene.windows.length)];
        scene.updatedAt = nowIso();
        this._save();
    }

    removeWindow(id, window) {
        const scene = this.byId(id);
        if (!scene)
            return;
        scene.windows = scene.windows.filter(w => w !== window).map((w, order) => ({...w, order}));
        scene.updatedAt = nowIso();
        this._save();
    }

    remove(id) {
        const i = this.scenes.findIndex(s => s.id === id);
        if (i < 0)
            return;
        this.scenes.splice(i, 1);
        const sug = this._data.suggestions;
        sug.disabled = sug.disabled.filter(d => d !== id);
        sug.pinned = sug.pinned.filter(p => p.id !== id);
        this._usage = this._usage.filter(u => u.id !== id);
        this._saveUsage();
        this._save();
    }

    disableSuggestion(id) {
        const sug = this._data.suggestions;
        if (!sug.disabled.includes(id))
            sug.disabled.push(id);
        sug.pinned = sug.pinned.filter(p => p.id !== id);
        this._save();
    }

    // "Fijar como sugerencia para esta hora": it wins at this time of this kind of day.
    pinSuggestion(id, now = new Date()) {
        const sug = this._data.suggestions;
        sug.disabled = sug.disabled.filter(d => d !== id);
        const {weekday, minuteOfDay} = usageEntry(id, now);
        sug.pinned.push({id, weekday, minuteOfDay});
        this._save();
    }

    recordUse(id, now = new Date()) {
        this._usage.push(usageEntry(id, now));
        this._usage = this._usage.slice(-MAX_USAGE);
        this._saveUsage();
    }

    _saveUsage() {
        this._queue = this._queue
            .then(() => this._write(this._usageFile, JSON.stringify(this._usage)))
            .catch(e => logError(e, 'João: guardar uso'));
    }
}
