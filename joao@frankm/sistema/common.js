// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Small pieces shared by the system panel's blocks.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const TIP_GAP = 8;

// One label that follows whichever attached button the pointer is over.
export class Tooltip {
    constructor() {
        this._label = new St.Label({style_class: 'escenas-full-tooltip', visible: false});
        Main.uiGroup.add_child(this._label);
    }

    attach(button, text) {
        button.track_hover = true;
        button.connect('notify::hover', () => {
            if (button.hover)
                this._show(button, text);
            else
                this.hide();
        });
    }

    _show(button, text) {
        const label = this._label;
        label.text = text;
        Main.uiGroup.set_child_above_sibling(label, null);
        label.show();
        const [x, y] = button.get_transformed_position();
        const [width] = button.get_transformed_size();
        const [, tipWidth] = label.get_preferred_width(-1);
        const [, tipHeight] = label.get_preferred_height(-1);
        const over = y - tipHeight - TIP_GAP;
        const [, buttonHeight] = button.get_preferred_height(-1);
        const monitor = Main.layoutManager.findMonitorForActor(button);
        const left = Math.max(monitor.x, Math.min(x + (width - tipWidth) / 2, monitor.x + monitor.width - tipWidth));
        label.set_position(Math.round(left), Math.round(over >= monitor.y ? over : y + buttonHeight + TIP_GAP));
    }

    hide() {
        this._label.hide();
    }

    destroy() {
        this._label.destroy();
    }
}

export function launchSettings(panel = null) {
    try {
        Gio.Subprocess.new(panel ? ['gnome-control-center', panel] : ['gnome-control-center'], Gio.SubprocessFlags.NONE);
    } catch (e) {
        logError(e, 'João: gnome-control-center');
    }
}

// The calendar app GNOME would open; GNOME's own one can also be told which day to show.
export function launchCalendar(date = null) {
    try {
        if (date && GLib.find_program_in_path('gnome-calendar')) {
            // It reads the date in the system's own format.
            Gio.Subprocess.new(['gnome-calendar', '--date', date.format('%x')], Gio.SubprocessFlags.NONE);
            return;
        }
        const app = Gio.AppInfo.get_default_for_type('text/calendar', false);
        app?.launch([], global.create_app_launch_context(0, -1));
    } catch (e) {
        logError(e, 'João: calendario');
    }
}

