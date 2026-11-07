// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// What the chosen day holds, under the calendar: the calendar's events and João's own tasks.
// Today also brings the tasks left undone on earlier days, on top and in red. "+ Añadir" opens a
// field right here: Enter keeps the task, Esc closes it.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {dayKey, sameDay, shortDay} from './calendarGrid.js';
import {parseTask} from './taskStore.js';

const ENTER_SHIFT = 6;
const ENTER = 300;
const STAGGER = 40;

const scaleFactor = () => St.ThemeContext.get_for_stage(global.stage).scale_factor;
const clock = date => GLib.DateTime.new_from_unix_local(Math.floor(date.getTime() / 1000)).format('%-H:%M');
const plainTime = time => time.replace(/^0(\d)/, '$1');

// Starts and ends at midnight: a whole day (or several).
const allDay = event => event.date.getHours() === 0 && event.date.getMinutes() === 0 &&
    event.end.getHours() === 0 && event.end.getMinutes() === 0 && event.end > event.date;

function label(style, text, wrap = false) {
    const l = new St.Label({style_class: style, text, x_expand: true});
    if (wrap) {
        l.clutter_text.line_wrap = true;
        l.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        l.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    } else {
        l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    }
    return l;
}

// A box with a dashed outline (St does not draw dashed borders).
const DashedBox = GObject.registerClass(
class JoaoDashedBox extends St.Widget {
    _init(text) {
        // y_expand set by hand: the outline's own does not reach the panel and stretch the box.
        super._init({style_class: 'joao-agenda-empty-box', layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: false});
        const area = new St.DrawingArea({x_expand: true, y_expand: true});
        area.connect('repaint', () => {
            const cr = area.get_context();
            const [w, h] = area.get_surface_size();
            const scale = scaleFactor();
            const line = scale;
            const r = 12 * scale;
            const m = line / 2;
            cr.setSourceRGBA(1, 1, 1, 0.2);
            cr.setLineWidth(line);
            cr.setDash([4 * scale, 3 * scale], 0);
            cr.newSubPath();
            cr.arc(w - r - m, r + m, r - m, -Math.PI / 2, 0);
            cr.arc(w - r - m, h - r - m, r - m, 0, Math.PI / 2);
            cr.arc(r + m, h - r - m, r - m, Math.PI / 2, Math.PI);
            cr.arc(r + m, r + m, r - m, Math.PI, 1.5 * Math.PI);
            cr.closePath();
            cr.stroke();
            cr.$dispose();
        });
        this.add_child(area);
        this.add_child(new St.Label({style_class: 'joao-agenda-empty', text, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER}));
    }
});

export const Agenda = GObject.registerClass(
class JoaoAgenda extends St.BoxLayout {
    // store: TaskStore. events(day): the calendar's events that day. openDay(day): the calendar app.
    _init({store, events, openDay}) {
        super._init({style_class: 'joao-agenda', orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this._store = store;
        this._events = events;
        this._openDay = openDay;

        const head = new St.BoxLayout({x_expand: true});
        this._title = new St.Label({style_class: 'joao-agenda-title', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        head.add_child(this._title);
        // Filled, in the accent colour: Frank found the plain link too easy to miss.
        this.addButton = new St.Button({style_class: 'joao-agenda-addbtn', can_focus: true,
            accessible_name: 'Añadir una tarea a este día', y_align: Clutter.ActorAlign.CENTER});
        const addBox = new St.BoxLayout({style_class: 'joao-agenda-addbtn-box'});
        addBox.add_child(new St.Icon({icon_name: 'list-add-symbolic', style_class: 'joao-agenda-addbtn-icon', y_align: Clutter.ActorAlign.CENTER}));
        addBox.add_child(new St.Label({text: 'Añadir tarea', y_align: Clutter.ActorAlign.CENTER}));
        this.addButton.set_child(addBox);
        this.addButton.connect('clicked', () => this._toggleAdd());
        head.add_child(this.addButton);
        this.add_child(head);

        this._addBox = new St.BoxLayout({style_class: 'joao-agenda-add', x_expand: true, visible: false});
        this.entry = new St.Entry({style_class: 'joao-agenda-entry', hint_text: 'Nueva tarea · ej. Llamar a las 9',
            can_focus: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this.entry.clutter_text.connect('activate', () => this._addTask());
        this.entry.clutter_text.connect('key-press-event', (actor, event) => {
            if (event.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;
            this.closeAdd();
            this.addButton.grab_key_focus();
            return Clutter.EVENT_STOP;
        });
        this._addBox.add_child(this.entry);
        const ok = new St.Button({style_class: 'joao-agenda-ok', label: 'Añadir', can_focus: true, y_align: Clutter.ActorAlign.CENTER});
        ok.connect('clicked', () => this._addTask());
        this._addBox.add_child(ok);
        this.add_child(this._addBox);

        this._items = new St.BoxLayout({style_class: 'joao-agenda-items', orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this.add_child(this._items);
        this._day = null;
        this._today = null;
        this._animateNext = false;
    }

    get items() {
        return this._items.get_children();
    }

    // animate: the rows come in one after another (a new day was chosen).
    show(day, today, animate = false) {
        this._day = day;
        this._today = today;
        this._title.text = this._dayTitle(day, today);
        const focusedId = this.items.find(row => row.check?.has_key_focus())?.taskId ?? null;
        this._items.destroy_all_children();
        const rows = this._rows(day, today);
        if (!rows.length)
            this._items.add_child(new DashedBox('Día libre. Usa «Añadir tarea» para agendar algo.'));
        rows.forEach((row, i) => {
            this._items.add_child(row);
            if (row.taskId && row.taskId === focusedId)
                row.check.grab_key_focus();
            if (!animate)
                return;
            row.set({opacity: 0, translation_y: -ENTER_SHIFT * scaleFactor()});
            row.ease({opacity: 255, translation_y: 0, delay: i * STAGGER, duration: ENTER, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        });
    }

    // Something changed: the same day again (the rows come in only after adding one).
    refresh() {
        const animate = this._animateNext;
        this._animateNext = false;
        if (this._day)
            this.show(this._day, this._today, animate);
    }

    _dayTitle(day, today) {
        if (sameDay(day, today))
            return `Hoy · ${shortDay(day)}`;
        if (sameDay(day, today.add_days(1)))
            return `Mañana · ${shortDay(day)}`;
        return `${shortDay(day)} de ${day.format('%B')}`;
    }

    _rows(day, today) {
        const key = dayKey(day);
        const late = sameDay(day, today) ? this._store.getOverdue(dayKey(today)) : [];
        const timed = [];
        for (const event of this._events(day))
            timed.push({at: allDay(event) ? '' : clock(event.date), row: () => this._eventRow(event)});
        const tasks = this._store.getForDay(key);
        for (const task of tasks.filter(t => !t.done))
            timed.push({at: task.time ?? '99:99', row: () => this._taskRow(task, key < dayKey(today))});
        // Events and tasks by time (whole-day events first, tasks without a time last), done ones at the end.
        timed.sort((a, b) => a.at.padStart(5, '0').localeCompare(b.at.padStart(5, '0')));
        return [
            ...late.map(task => this._taskRow(task, true)),
            ...timed.map(t => t.row()),
            ...tasks.filter(t => t.done).map(task => this._taskRow(task, false)),
        ];
    }

    _eventRow(event) {
        const row = new St.Button({style_class: 'joao-agenda-item event', can_focus: true, x_expand: true,
            accessible_name: `Evento: ${event.summary}. Abrir en Calendario`});
        const box = new St.BoxLayout({style_class: 'joao-agenda-item-box', x_expand: true});
        box.add_child(new St.Widget({style_class: 'joao-agenda-bar'}));
        const words = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        words.add_child(label('joao-agenda-item-title', event.summary ?? ''));
        const when = allDay(event) ? 'Todo el día' : `${clock(event.date)} – ${clock(event.end)}`;
        words.add_child(label('joao-agenda-item-sub', `${when} · evento`));
        box.add_child(words);
        row.set_child(box);
        row.connect('clicked', () => this._openDay(this._day));
        return row;
    }

    // late: undone from an earlier day.
    _taskRow(task, late) {
        const row = new St.BoxLayout({style_class: 'joao-agenda-item task', x_expand: true, reactive: true, track_hover: true});
        row.taskId = task.id;
        const check = new St.Button({style_class: 'joao-agenda-check', can_focus: true, y_align: Clutter.ActorAlign.START,
            accessible_name: task.done ? 'Marcar como pendiente' : 'Marcar como hecha'});
        if (task.done) {
            check.add_style_class_name('done');
            check.set_child(new St.Icon({style_class: 'joao-agenda-check-icon', icon_name: 'object-select-symbolic'}));
        }
        if (late)
            check.add_style_class_name('late');
        check.connect('clicked', () => this._store.toggle(task.id));
        row.check = check;
        row.add_child(check);

        const words = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const title = label('joao-agenda-item-title', task.title, true);
        if (task.done)
            title.add_style_class_name('done');
        words.add_child(title);
        let sub = null;
        if (late && task.date !== dayKey(this._day))
            sub = label('joao-agenda-item-sub late', `Vencida · ${shortDay(GLib.DateTime.new_from_iso8601(`${task.date}T00:00:00`, GLib.TimeZone.new_local()))}`);
        else if (task.time)
            sub = label('joao-agenda-item-sub', `vence ${plainTime(task.time)}`);
        if (sub)
            words.add_child(sub);
        row.add_child(words);

        const remove = new St.Button({style_class: 'joao-agenda-remove', can_focus: true, opacity: 0, y_align: Clutter.ActorAlign.START,
            accessible_name: `Borrar la tarea ${task.title}`, child: new St.Icon({icon_name: 'window-close-symbolic'})});
        remove.connect('clicked', () => this._store.remove(task.id));
        const syncRemove = () => {
            remove.opacity = row.hover || remove.has_key_focus() ? 255 : 0;
        };
        row.connect('notify::hover', syncRemove);
        remove.connect('key-focus-in', syncRemove);
        remove.connect('key-focus-out', syncRemove);
        row.remove = remove;
        row.add_child(remove);
        row.accessible_name = task.title;
        return row;
    }

    _toggleAdd() {
        if (this._addBox.visible) {
            this.closeAdd();
            return;
        }
        this._addBox.show();
        this.entry.grab_key_focus();
    }

    closeAdd() {
        this.entry.text = '';
        this._addBox.hide();
    }

    _addTask() {
        const {title, time} = parseTask(this.entry.text);
        if (!title)
            return;
        this.closeAdd();
        this.addButton.grab_key_focus();
        this._animateNext = true;
        this._store.add({title, time, date: dayKey(this._day)});
    }
});
