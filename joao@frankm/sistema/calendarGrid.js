// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The calendar of the panel: one week, or the whole month ("Ver mes"), with up to three dots
// under each day (amber: an event, blue: a task to do, red: a task left behind). Choosing a day
// tells the list below; the left and right arrows move the chosen day.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

const DAYS = 7;
const MONTH_WEEKS = 6;
const MAX_DOTS = 3;
const GROW = 350;
const SPACING = 2;

export const dayKey = day => day.format('%F');
export const midnight = day => GLib.DateTime.new_local(day.get_year(), day.get_month(), day.get_day_of_month(), 0, 0, 0);
export const today = () => midnight(GLib.DateTime.new_now_local());
export const sameDay = (a, b) => dayKey(a) === dayKey(b);
export const shortDay = day => `${day.format('%a').replace('.', '')} ${day.format('%-d')}`;
const capital = text => text.charAt(0).toUpperCase() + text.slice(1);

// How many days back the week of `day` starts, with the locale's first day of the week.
const back = day => (day.get_day_of_week() % DAYS - Shell.util_get_week_start() + DAYS) % DAYS;

export const CalendarGrid = GObject.registerClass({
    Signals: {'day-selected': {}},
}, class JoaoCalendarGrid extends St.BoxLayout {
    // dotsFor(days): Map 'YYYY-MM-DD' → ['event' | 'task' | 'late', …]
    _init({dotsFor}) {
        // Reactive: Clutter only hands the key presses of a day to its reactive parents.
        super._init({style_class: 'joao-cal', orientation: Clutter.Orientation.VERTICAL, x_expand: true, reactive: true});
        this._dotsFor = dotsFor;
        this._month = false;

        const head = new St.BoxLayout({style_class: 'joao-cal-head', x_expand: true});
        this._title = new St.Label({style_class: 'joao-cal-title', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        head.add_child(this._title);
        this.prev = this._link('‹', () => this._go(-1));
        this.toggle = this._link('Ver mes', () => this._toggleMonth());
        this.next = this._link('›', () => this._go(1));
        for (const button of [this.prev, this.toggle, this.next])
            head.add_child(button);
        this.add_child(head);

        this._names = this._gridWidget();
        this.add_child(this._names);
        this._grid = this._gridWidget();
        this._clip = new St.Widget({layout_manager: new Clutter.BinLayout(), clip_to_allocation: true, x_expand: true});
        this._clip.add_child(this._grid);
        this.add_child(this._clip);

        this.connect('key-press-event', (actor, event) => this._onKey(event));
        this.reset();
    }

    _link(label, action) {
        const button = new St.Button({style_class: 'joao-cal-link', label, can_focus: true, y_align: Clutter.ActorAlign.CENTER});
        button.connect('clicked', action);
        return button;
    }

    _gridWidget() {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        return new St.Widget({
            x_expand: true,
            layout_manager: new Clutter.GridLayout({column_homogeneous: true, column_spacing: SPACING * scale, row_spacing: SPACING * scale}),
        });
    }

    get selected() {
        return this._selected;
    }

    get isMonth() {
        return this._month;
    }

    // Today's cell, while it is in view.
    get todayButton() {
        return this._cells?.find(cell => sameDay(cell.day, this._today))?.button ?? null;
    }

    get cells() {
        return this._cells.map(c => c.button);
    }

    // Back to this week, with today chosen.
    reset() {
        this._today = today();
        this._selected = this._today;
        this._ref = this._today;
        this._clip.remove_transition('height');
        this._clip.height = -1;
        this._month = false;
        this.render();
    }

    // The days in view.
    get days() {
        if (!this._month) {
            const start = this._ref.add_days(-back(this._ref));
            return [...Array(DAYS).keys()].map(i => start.add_days(i));
        }
        const first = GLib.DateTime.new_local(this._ref.get_year(), this._ref.get_month(), 1, 0, 0, 0);
        const start = first.add_days(-back(first));
        return [...Array(DAYS * MONTH_WEEKS).keys()].map(i => start.add_days(i));
    }

    render() {
        const focused = this._cells?.some(c => c.button.has_key_focus());
        this._today = today();
        const days = this.days;
        const title = capital(this._ref.format('%B'));
        this._title.text = this._ref.get_year() === this._today.get_year() ? title : `${title} ${this._ref.get_year()}`;
        this.toggle.label = this._month ? 'Ver semana' : 'Ver mes';
        this.toggle.accessible_name = this._month ? 'Ver la semana' : 'Ver el mes entero';
        this.prev.accessible_name = this._month ? 'Mes anterior' : 'Semana anterior';
        this.next.accessible_name = this._month ? 'Mes siguiente' : 'Semana siguiente';

        this._names.destroy_all_children();
        days.slice(0, DAYS).forEach((day, i) => this._names.layout_manager.attach(
            new St.Label({style_class: 'joao-cal-dayname', text: day.format('%a').replace('.', ''), x_align: Clutter.ActorAlign.CENTER}), i, 0, 1, 1));

        this._grid.destroy_all_children();
        const dots = this._dotsFor(days);
        this._cells = days.map((day, i) => {
            const button = this._cell(day, dots.get(dayKey(day)) ?? []);
            this._grid.layout_manager.attach(button, i % DAYS, Math.floor(i / DAYS), 1, 1);
            return {day, button};
        });
        if (focused)
            this._cells.find(c => sameDay(c.day, this._selected))?.button.grab_key_focus();
    }

    _cell(day, dots) {
        const button = new St.Button({
            style_class: 'joao-cal-day',
            can_focus: true,
            x_expand: true,
            accessible_name: capital(day.format('%A %-d de %B')),
        });
        if (sameDay(day, this._today))
            button.add_style_class_name('today');
        if (sameDay(day, this._selected))
            button.add_style_class_name('selected');
        if (this._month && day.get_month() !== this._ref.get_month())
            button.add_style_class_name('out');
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        box.add_child(new St.Label({style_class: 'joao-cal-number', text: day.format('%-d'), x_align: Clutter.ActorAlign.CENTER}));
        const row = new St.BoxLayout({style_class: 'joao-cal-dots', x_align: Clutter.ActorAlign.CENTER});
        for (const kind of dots.slice(0, MAX_DOTS))
            row.add_child(new St.Widget({style_class: `joao-cal-dot ${kind}`}));
        box.add_child(row);
        button.set_child(box);
        button.connect('clicked', () => this.select(day));
        return button;
    }

    // Chooses a day; the view follows it when it falls outside.
    select(day) {
        this._selected = midnight(day);
        const shown = this.days;
        const inView = this._month
            ? day.get_month() === this._ref.get_month() && day.get_year() === this._ref.get_year()
            : shown.some(d => sameDay(d, day));
        if (!inView)
            this._ref = this._selected;
        this.render();
        this.emit('day-selected');
    }

    _go(step) {
        this._ref = this._month
            ? GLib.DateTime.new_local(this._ref.get_year(), this._ref.get_month(), 1, 0, 0, 0).add_months(step)
            : this._ref.add_days(step * DAYS);
        this.render();
    }

    _toggleMonth() {
        const from = this._clip.has_allocation() ? this._clip.get_height() : -1;
        this._month = !this._month;
        this._ref = this._selected;
        this.render();
        this._clip.remove_transition('height');
        if (from < 0 || !this.is_mapped())
            return;
        const [, to] = this._grid.get_preferred_height(this._clip.get_width());
        this._clip.height = from;
        this._clip.ease({
            height: to,
            duration: GROW,
            mode: Clutter.AnimationMode.EASE_OUT_QUINT,
            onStopped: () => {
                this._clip.height = -1;
            },
        });
    }

    _onKey(event) {
        const step = {[Clutter.KEY_Left]: -1, [Clutter.KEY_Right]: 1}[event.get_key_symbol()];
        if (!step || !this._cells.some(c => c.button.has_key_focus()))
            return Clutter.EVENT_PROPAGATE;
        this.select(this._selected.add_days(step));
        this._cells.find(c => sameDay(c.day, this._selected))?.button.grab_key_focus();
        return Clutter.EVENT_STOP;
    }
});
