// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// What the launcher button has to say, the size of an icon: a round chip per use of the microphone,
// the camera or the screen, and a small pill when there are no notifications. Pointing at a chip
// stretches it to show the app and what a click does.
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const CLOSED_WIDTH = 32;
const OPEN_WIDTH = 150;
const SHIFT = 6;
const REVEAL = 180;
const CONCEAL = 150;
const STRETCH = 180;
const WORDS_FADE = 150;
const MODE = Clutter.AnimationMode.EASE_OUT_QUAD;

const scaleFactor = () => St.ThemeContext.get_for_stage(global.stage).scale_factor;

const Chip = GObject.registerClass(
class JoaoTrayChip extends St.Button {
    _init(device) {
        super._init({
            style_class: `joao-chip ${device}`,
            can_focus: true,
            clip_to_allocation: true,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.THREE,
            width: CLOSED_WIDTH * scaleFactor(),
        });
        // Wider than the chip at rest, which clips it: the words wait out of sight.
        const box = new St.BoxLayout({x_align: Clutter.ActorAlign.START, y_align: Clutter.ActorAlign.CENTER});
        this._icon = new St.Icon({style_class: 'joao-chip-icon', fallback_icon_name: 'video-display-symbolic'});
        this._label = new St.Label({style_class: 'joao-chip-label', opacity: 0, y_align: Clutter.ActorAlign.CENTER});
        this._label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._action = new St.Icon({style_class: 'joao-chip-action'});
        this._actionSlot = new St.Bin({style_class: 'joao-chip-slot', opacity: 0, child: this._action});
        box.add_child(new St.Bin({style_class: 'joao-chip-slot', child: this._icon}));
        box.add_child(this._label);
        box.add_child(this._actionSlot);
        this.set_child(box);

        this.connect('notify::hover', () => this._syncOpen());
        this.connect('key-focus-in', () => this._syncOpen());
        this.connect('key-focus-out', () => this._syncOpen());
        this.connect('clicked', (chip, button) => (button === Clutter.BUTTON_SECONDARY ? this._use.onSecondary : this._use.onAction)?.());
    }

    fill(use) {
        this._use = use;
        this._icon.icon_name = use.icon;
        this._label.text = use.app;
        this._actionSlot.visible = !!use.actionIcon;
        if (use.actionIcon)
            this._action.icon_name = use.actionIcon;
        this.accessible_name = use.description;
    }

    _syncOpen() {
        const open = this.hover || this.has_key_focus();
        this.ease({width: (open ? OPEN_WIDTH : CLOSED_WIDTH) * scaleFactor(), duration: STRETCH, mode: MODE});
        for (const words of [this._label, this._actionSlot])
            words.ease({opacity: open ? 255 : 0, duration: WORDS_FADE, mode: MODE});
    }
});

export const CompactTray = GObject.registerClass(
class JoaoCompactTray extends St.BoxLayout {
    _init() {
        super._init({style_class: 'joao-tray', reactive: true, track_hover: true, visible: false, opacity: 0});
        this._chips = new Map();
        this._pill = null;
        this._side = 1;
        this._closing = false;
        Main.layoutManager.addTopChrome(this);
    }

    get isShowing() {
        return this.visible && !this._closing;
    }

    get chips() {
        return [...this._chips.values()];
    }

    // Chips are kept from one update to the next: the one under the pointer stays stretched.
    // uses = [{key, device, app, icon, actionIcon, description, onAction, onSecondary}]
    update(uses, emptyPill) {
        const keys = new Set(uses.map(use => use.key));
        for (const [key, chip] of this._chips) {
            if (!keys.has(key)) {
                chip.destroy();
                this._chips.delete(key);
            }
        }
        uses.forEach((use, index) => {
            let chip = this._chips.get(use.key);
            if (!chip) {
                chip = new Chip(use.device);
                this._chips.set(use.key, chip);
                this.add_child(chip);
            }
            chip.fill(use);
            this.set_child_at_index(chip, index);
        });
        this._syncPill(emptyPill, uses.length > 0);
    }

    // Beside the chips it is only the icon, so as not to compete with them.
    _syncPill(wanted, iconOnly) {
        if (!wanted) {
            this._pill?.destroy();
            this._pill = null;
            return;
        }
        if (!this._pill) {
            this._pill = new St.BoxLayout({style_class: 'joao-empty'});
            this._pill.add_child(new St.Icon({icon_name: 'notifications-disabled-symbolic', icon_size: 14, y_align: Clutter.ActorAlign.CENTER}));
            this._pillLabel = new St.Label({text: 'Todo al día', y_align: Clutter.ActorAlign.CENTER});
            this._pill.add_child(this._pillLabel);
            this.add_child(this._pill);
        }
        this._pillLabel.visible = !iconOnly;
        if (iconOnly)
            this._pill.add_style_class_name('icon-only');
        else
            this._pill.remove_style_class_name('icon-only');
    }

    // side: 1 when it opens towards the right of what it belongs to, -1 towards the left.
    reveal(side) {
        this._side = side;
        this._closing = false;
        this.remove_all_transitions();
        if (!this.visible)
            this.set({opacity: 0, translation_x: -side * SHIFT, visible: true});
        this.ease({opacity: 255, translation_x: 0, duration: REVEAL, mode: MODE});
    }

    conceal(animate) {
        if (!this.visible)
            return;
        this.remove_all_transitions();
        if (!animate) {
            this._finishConceal();
            return;
        }
        this._closing = true;
        this.ease({opacity: 0, translation_x: -this._side * SHIFT, duration: CONCEAL, mode: MODE,
            onStopped: finished => {
                if (finished)
                    this._finishConceal();
            }});
    }

    _finishConceal() {
        this._closing = false;
        this.hide();
        this.update([], false);
    }

    destroy() {
        Main.layoutManager.removeChrome(this);
        super.destroy();
    }
});
