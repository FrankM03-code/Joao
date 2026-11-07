// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// "Hoy": the calendar (a week or the month) and, under it, what the chosen day holds. Events come
// from where GNOME's own calendar gets them (the date menu's event source, fed by Evolution Data
// Server); João does not keep them. Tasks are João's own (taskStore.js).
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Agenda} from './agenda.js';
import {CalendarGrid, dayKey, today} from './calendarGrid.js';
import {launchCalendar} from './common.js';
import {TaskStore} from './taskStore.js';

const toDate = day => new Date(day.to_unix() * 1000);

// GNOME's event source. It is replaced when the session mode changes (the lock screen has none).
// It says 'changed' in the middle of a request, and often several times in a row: the calendar
// hears it once, afterwards, and never before the screen is drawn.
class EventFeed {
    constructor(onChanged) {
        this._onChanged = onChanged;
        this._source = null;
        this._idleId = 0;
    }

    _queue() {
        if (this._idleId)
            return;
        this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._idleId = 0;
            this._onChanged();
            return GLib.SOURCE_REMOVE;
        });
    }

    get source() {
        const source = Main.panel?.statusArea?.dateMenu?._eventSource ?? null;
        if (source !== this._source) {
            this._source?.disconnectObject(this);
            this._source = source;
            source?.connectObject('changed', () => this._queue(), this);
        }
        return source;
    }

    // The days in view. Their events are loaded by GNOME's own calendar (hidden with the top bar):
    // it is moved to their month and asks for it. Asking for another range from here would fight
    // with it, each one asking again when the other's events arrive.
    show(day) {
        const calendar = Main.panel?.statusArea?.dateMenu?._calendar;
        if (!calendar?.setDate || !this.source)
            return;
        const target = toDate(day);
        const current = calendar._selectedDate;
        if (current?.getFullYear() === target.getFullYear() && current?.getMonth() === target.getMonth())
            return;
        try {
            calendar.setDate(target);
        } catch (e) {
            console.warn(`João: eventos del calendario: ${e.message}`);
        }
    }

    eventsOn(day) {
        try {
            return this.source?.getEvents(toDate(day), toDate(day.add_days(1))) ?? [];
        } catch {
            return [];
        }
    }

    destroy() {
        if (this._idleId)
            GLib.source_remove(this._idleId);
        this._idleId = 0;
        this._source?.disconnectObject(this);
        this._source = null;
    }
}

export const TodayBlock = GObject.registerClass(
class JoaoTodayBlock extends St.BoxLayout {
    _init({close}) {
        super._init({style_class: 'escenas-full-block joao-today', orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this.store = new TaskStore();
        this._events = new EventFeed(() => this._sync());
        this.calendar = new CalendarGrid({dotsFor: days => this._dots(days)});
        this.agenda = new Agenda({
            store: this.store,
            events: day => this._events.eventsOn(day),
            openDay: day => {
                close();
                launchCalendar(day);
            },
        });
        this._live = false;
        this.add_child(this.calendar);
        this.add_child(this.agenda);
        this.calendar.connect('day-selected', () => this.agenda.show(this.calendar.selected, today(), true));
        this._syncId = 0;
        this.store.connectObject('changed', () => this._queueSync(), this);
        this.connect('destroy', () => {
            if (this._syncId)
                GLib.source_remove(this._syncId);
            this._syncId = 0;
            this._events.destroy();
            this.store.disconnectObject(this);
            this.store.destroy();
        });
        this._reset();
    }

    get todayButton() {
        return this.calendar.todayButton;
    }

    // Each time the page opens: this week, today chosen, the files read again (they may have been
    // edited by hand).
    refresh() {
        this._live = true;
        this._reset();
        this.store.reload();
    }

    _reset() {
        this.agenda.closeAdd();
        this.calendar.reset();
        this.agenda.show(this.calendar.selected, today());
    }

    _dots(days) {
        // Asked for only once the page has been opened: not while the shell starts.
        if (this._live)
            this._events.show(days[Math.floor(days.length / 2)]);
        const now = dayKey(today());
        const tasks = this.store.getDotsForRange(dayKey(days[0]), dayKey(days[days.length - 1]), now);
        const dots = new Map();
        for (const day of days) {
            const key = dayKey(day);
            const kinds = this._events.eventsOn(day).map(() => 'event');
            dots.set(key, [...(tasks.get(key) ?? []).filter(k => k === 'late'), ...kinds, ...(tasks.get(key) ?? []).filter(k => k === 'task')]);
        }
        return dots;
    }

    // After the click that changed a task: its button is rebuilt.
    _queueSync() {
        if (this._syncId)
            return;
        this._syncId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._syncId = 0;
            this._sync();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Tasks or events changed: the dots and the list, without moving anything.
    _sync() {
        this.calendar.render();
        this.agenda.refresh();
    }
});
