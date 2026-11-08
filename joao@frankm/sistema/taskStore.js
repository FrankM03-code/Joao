// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The tasks of the calendar and the pinned notes, each in its own file in ~/.local/share/joao.
// Days are 'YYYY-MM-DD' (GLib's %F), so they compare and sort as text.
//
// The calendar only talks to TaskStore's methods. A later EdsTaskStore could keep them in
// Evolution Data Server instead, talking to it over D-Bus: ECal must not be loaded into the shell.
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {JsonFile} from './jsonFile.js';

const VERSION = 1;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;

const now = () => GLib.DateTime.new_now_local().format_iso8601();

const validTask = t => t && typeof t.id === 'string' && typeof t.title === 'string' && DAY.test(t.date) &&
    (t.time == null || TIME.test(t.time));

export const TaskStore = GObject.registerClass({
    Signals: {changed: {}},
}, class JoaoTaskStore extends GObject.Object {
    _init() {
        super._init();
        this._tasks = [];
        this._file = new JsonFile('tasks.json', data => {
            if (data?.version !== VERSION || !Array.isArray(data.tasks) || !data.tasks.every(validTask))
                return null;
            return data;
        });
        this.reload();
    }

    // Reads the file again (it may have been changed by hand).
    reload() {
        this._file.load(data => {
            this._tasks = (data?.tasks ?? []).map(t => ({...t, time: t.time ?? null, done: !!t.done}));
            this.emit('changed');
        });
    }

    getForDay(day) {
        return this._tasks.filter(t => t.date === day);
    }

    // Not done and from before today.
    getOverdue(today) {
        return this._tasks.filter(t => !t.done && t.date < today).sort((a, b) => a.date.localeCompare(b.date));
    }

    // day → ['task' | 'late', …] for every pending task between start and end, both included.
    getDotsForRange(start, end, today) {
        const dots = new Map();
        for (const t of this._tasks) {
            if (t.done || t.date < start || t.date > end)
                continue;
            if (!dots.has(t.date))
                dots.set(t.date, []);
            dots.get(t.date).push(t.date < today ? 'late' : 'task');
        }
        return dots;
    }

    add({title, date, time = null}) {
        const task = {id: GLib.uuid_string_random(), title, date, time, done: false, created: now()};
        this._tasks.push(task);
        this._changed();
        return task;
    }

    toggle(id) {
        const task = this._tasks.find(t => t.id === id);
        if (!task)
            return;
        task.done = !task.done;
        this._changed();
    }

    remove(id) {
        const before = this._tasks.length;
        this._tasks = this._tasks.filter(t => t.id !== id);
        if (this._tasks.length !== before)
            this._changed();
    }

    _changed() {
        this._file.save({version: VERSION, tasks: this._tasks});
        this.emit('changed');
    }

    destroy() {
        this._file.destroy();
    }
});

// The notes ("Mis notas" in the ring's quick note). One of them at most is pinned: the panel
// shows it above the notifications. One store for both, made when João starts.
// notes.json version 2: {version, notes: [{id, text, pinned, created, updated}]}. A version 1
// file (only the pinned ones) is turned into this without losing anything.
let notes = null;
export const noteStore = () => notes;

const NOTES_VERSION = 2;
const KEEP_NOTES = 50;      // not pinned; the oldest go beyond that

const validNote = n => n && typeof n.id === 'string' && typeof n.text === 'string';

export const NoteStore = GObject.registerClass({
    Signals: {changed: {}},
}, class JoaoNoteStore extends GObject.Object {
    _init() {
        super._init();
        notes = this;
        this._notes = [];
        this._file = new JsonFile('notes.json', data => {
            if (data?.version === NOTES_VERSION && Array.isArray(data.notes) && data.notes.every(validNote))
                return data;
            if (data?.version === 1 && Array.isArray(data.pinned) && data.pinned.every(validNote))
                return data;
            return null;
        });
        this.reload();
    }

    reload() {
        this._file.load(data => {
            if (data?.version === 1) {
                // The newest stays pinned; the others become plain notes.
                const old = [...data.pinned].sort((a, b) => String(b.created ?? '').localeCompare(String(a.created ?? '')));
                this._notes = old.map((n, i) => ({id: n.id, text: n.text, pinned: i === 0,
                    created: n.created ?? now(), updated: n.created ?? now()}));
                this._save();
                return;
            }
            this._notes = (data?.notes ?? []).map(n => ({...n, pinned: !!n.pinned}));
            this.emit('changed');
        });
    }

    // The pinned one first, then the most recently changed.
    get all() {
        return [...this._notes].sort((a, b) => (b.pinned - a.pinned) ||
            String(b.updated ?? '').localeCompare(String(a.updated ?? '')));
    }

    // The pinned note, or null (the panel shows it).
    get latest() {
        return this._notes.find(n => n.pinned) ?? null;
    }

    get(id) {
        return this._notes.find(n => n.id === id) ?? null;
    }

    // Kept and pinned; the one pinned before goes to the list.
    pin(text) {
        const note = {id: GLib.uuid_string_random(), text, pinned: false, created: now(), updated: now()};
        this._notes.push(note);
        this._pinOnly(note);
        this._save();
        return note;
    }

    // Edited (and, by default, pinned).
    update(id, text, {pin = true} = {}) {
        const note = this.get(id);
        if (!note)
            return;
        note.text = text;
        note.updated = now();
        if (pin)
            this._pinOnly(note);
        this._save();
    }

    setPinned(id, pinned) {
        const note = this.get(id);
        if (!note)
            return;
        if (pinned)
            this._pinOnly(note);
        else
            note.pinned = false;
        this._save();
    }

    // Off the panel; it stays in "Mis notas".
    unpin(id) {
        this.setPinned(id, false);
    }

    remove(id) {
        this._notes = this._notes.filter(n => n.id !== id);
        this._save();
    }

    _pinOnly(note) {
        this._notes.forEach(n => {
            n.pinned = n === note;
        });
    }

    _save() {
        const plain = this._notes.filter(n => !n.pinned)
            .sort((a, b) => String(b.updated ?? '').localeCompare(String(a.updated ?? '')));
        const gone = new Set(plain.slice(KEEP_NOTES));
        this._notes = this._notes.filter(n => !gone.has(n));
        this._file.save({version: NOTES_VERSION, notes: this._notes});
        this.emit('changed');
    }

    destroy() {
        if (notes === this)
            notes = null;
        this._file.destroy();
    }
});

// "○ " opens a checklist item, "● " a done one (the quick note's "Lista con casillas").
export const CHECK_OPEN = '○ ';
export const CHECK_DONE = '● ';

// The same text with line @index's box turned over.
export function toggleCheck(text, index) {
    const lines = text.split('\n');
    const line = lines[index] ?? '';
    if (line.startsWith(CHECK_OPEN))
        lines[index] = CHECK_DONE + line.slice(CHECK_OPEN.length);
    else if (line.startsWith(CHECK_DONE))
        lines[index] = CHECK_OPEN + line.slice(CHECK_DONE.length);
    return lines.join('\n');
}

// "Llamar a Juan a las 9" → {title: 'Llamar a Juan', time: '09:00'}; "a las 9:30" too. Nothing else.
export function parseTask(text) {
    const words = text.trim().replace(/\s+/g, ' ');
    const match = words.match(/^(.*?)\s*\ba las (\d{1,2})(?::(\d{2}))?$/i);
    if (match) {
        const [, title, h, m = '00'] = match;
        if (title && +h < 24 && +m < 60)
            return {title, time: `${h.padStart(2, '0')}:${m}`};
    }
    return {title: words, time: null};
}
