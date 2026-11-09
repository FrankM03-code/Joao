// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// What used to be GNOME's top bar, as a glass card on the right of the page: sliders,
// switches, power mode, the calendar with its tasks, notifications and, stuck to the bottom, the power buttons.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {NotificationsBlock} from './notifications.js';
import {PowerBar} from './powerBar.js';
import {PowerProfile} from './powerProfile.js';
import {SystemSliders} from './sliders.js';
import {TodayBlock} from './today.js';
import {SystemToggles} from './toggles.js';

const HIGHLIGHT = 1500;

export const SystemPanel = GObject.registerClass(
class JoaoSystemPanel extends St.BoxLayout {
    _init({tooltip, close, closeNow, settings}) {
        super._init({style_class: 'escenas-full-panel', orientation: Clutter.Orientation.VERTICAL, reactive: true});

        this._blocks = new St.BoxLayout({style_class: 'escenas-full-panel-blocks', orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this._scroll = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
            child: this._blocks,
        });
        this.add_child(this._scroll);

        this.sliders = new SystemSliders(tooltip);
        this.toggles = new SystemToggles({tooltip, close, settings});
        this.profile = new PowerProfile(tooltip);
        this.today = new TodayBlock({close});
        this.notifications = new NotificationsBlock({tooltip, close});
        this.footer = new PowerBar({tooltip, close, closeNow, settings});
        this._blocks.add_child(this.sliders);
        this._blocks.add_child(this.toggles);
        this._blocks.add_child(this.profile);
        this._blocks.add_child(new St.Widget({style_class: 'escenas-full-separator', x_expand: true}));
        this._blocks.add_child(this.today);
        this._blocks.add_child(this.notifications);
        this.add_child(this.footer);

        const t = this.toggles.toggles;
        // What the search box points at: [the actor that lights up, the actor that takes the keyboard].
        this._controls = {
            volume: [this.sliders.volume.row, this.sliders.volume.slider],
            brightness: [this.sliders.brightness.row, this.sliders.brightness.slider],
            wifi: [t.wifi, t.wifi],
            bluetooth: [t.bluetooth, t.bluetooth],
            dark: [t.dark, t.dark],
            dnd: [t.dnd, t.dnd],
            night: [t.night, t.night],
            airplane: [t.airplane, t.airplane],
            awake: [t.awake, t.awake],
            profile: [this.profile, null],
        };
        for (const [, target] of Object.values(this._controls))
            target?.connect('key-focus-in', () => this._ensureVisible(target));
        this._highlightId = 0;
        this.connect('destroy', () => this._clearHighlight());
    }

    refresh() {
        this.today.refresh();
        this.notifications.refresh();
    }

    // The blocks scroll above the power bar when the screen is short.
    place(height) {
        this.height = height;
    }

    // Is this control on this machine? (no backlight, no power-profiles-daemon...)
    has(id) {
        if (this._controls[id])
            return this._controls[id][0].visible;
        return this.footer.can(id);
    }

    // Lights up a control for a moment and gives it the keyboard.
    highlight(id) {
        const [ring, target] = this._controls[id];
        this._clearHighlight();
        this._lit = ring;
        ring.add_style_class_name('highlighted');
        this._highlightId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HIGHLIGHT, () => {
            this._highlightId = 0;
            this._clearHighlight();
            return GLib.SOURCE_REMOVE;
        });
        if (target)
            target.grab_key_focus();
        else if (!ring.navigate_focus(null, St.DirectionType.TAB_FORWARD, false))
            ring.grab_key_focus();
        this._ensureVisible(ring);
    }

    _clearHighlight() {
        if (this._highlightId)
            GLib.source_remove(this._highlightId);
        this._highlightId = 0;
        this._lit?.remove_style_class_name('highlighted');
        this._lit = null;
    }

    runAction(id) {
        this.footer.run(id);
    }

    // The clock goes to "today"; the chip to the top of the panel.
    focusSection(section) {
        if (section === 'today') {
            this.today.todayButton.grab_key_focus();
            this._ensureVisible(this.today.todayButton);
        } else if (!this.sliders.navigate_focus(null, St.DirectionType.TAB_FORWARD, false)) {
            this.toggles.toggles.wifi.grab_key_focus();
        }
    }

    _ensureVisible(actor) {
        if (!this._blocks.contains(actor))
            return;
        const adjustment = this._scroll.vadjustment;
        const top = actor.get_transformed_position()[1] - this._scroll.get_transformed_position()[1];
        const bottom = top + actor.get_transformed_size()[1];
        if (top < 0)
            adjustment.value += top;
        else if (bottom > adjustment.page_size)
            adjustment.value += bottom - adjustment.page_size;
    }

});
