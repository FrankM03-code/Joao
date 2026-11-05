// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// "Hoy": this week in seven cells, starting on the first day of the system's locale.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {hasCalendar, launchCalendar} from './common.js';

const DAYS = 7;

export const TodayBlock = GObject.registerClass(
class JoaoTodayBlock extends St.BoxLayout {
    _init({tooltip, close}) {
        super._init({style_class: 'escenas-full-block', orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this._tooltip = tooltip;
        this._close = close;
        const head = new St.BoxLayout({x_expand: true});
        this._title = new St.Label({style_class: 'escenas-full-block-title', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        head.add_child(this._title);
        this.link = new St.Button({style_class: 'escenas-saved-link', label: 'Calendario', can_focus: true, accessible_name: 'Abrir Calendario'});
        this.link.connect('clicked', () => {
            close();
            launchCalendar();
        });
        tooltip.attach(this.link, 'Abrir Calendario');
        head.add_child(this.link);
        this.add_child(head);
        this._week = new St.BoxLayout({style_class: 'escenas-full-week', x_expand: true});
        this.add_child(this._week);
        this.todayButton = null;
        this._shown = null;
        this.refresh();
    }

    // Also called every minute by the clock: it only rebuilds when the day has changed.
    refresh() {
        const now = GLib.DateTime.new_now_local();
        const stamp = now.format('%F');
        this.link.visible = hasCalendar();
        if (stamp === this._shown)
            return;
        this._shown = stamp;
        this._title.text = `Hoy · ${now.format('%B')}`;
        this._week.destroy_all_children();
        // GLib counts Monday = 1 ... Sunday = 7; the locale's first day has Sunday = 0.
        const back = (now.get_day_of_week() % DAYS - Shell.util_get_week_start() + DAYS) % DAYS;
        for (let i = 0; i < DAYS; i++) {
            const day = now.add_days(i - back);
            const isToday = i === back;
            this._week.add_child(this._dayCell(day, isToday));
        }
    }

    _dayCell(day, isToday) {
        const name = day.format('%a').replace('.', '');
        const number = day.format('%-d');
        const cell = new St.Button({
            style_class: 'escenas-full-day',
            can_focus: true,
            x_expand: true,
            accessible_name: day.format('%A, %-d de %B'),
        });
        if (isToday) {
            cell.add_style_class_name('today');
            this.todayButton = cell;
        }
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        box.add_child(new St.Label({style_class: 'escenas-full-day-name', text: name, x_align: Clutter.ActorAlign.CENTER}));
        box.add_child(new St.Label({style_class: 'escenas-full-day-number', text: number, x_align: Clutter.ActorAlign.CENTER}));
        cell.set_child(box);
        cell.connect('clicked', () => {
            this._close();
            launchCalendar(day);
        });
        this._tooltip.attach(cell, 'Abrir Calendario en este día');
        return cell;
    }
});
