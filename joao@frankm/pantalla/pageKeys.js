// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The keyboard on the page: Tab between zones, arrows inside them, Esc, and typing anywhere
// goes to the search box.
import Clutter from 'gi://Clutter';
import St from 'gi://St';

// St's contains() does not take null, and often nothing has the keyboard.
export const holds = (actor, focus) => !!focus && actor.contains(focus);

export class PageKeys {
    constructor(view) {
        this._view = view;
    }

    // Tab jumps between these; the arrows move inside them.
    get zones() {
        return [this._view._entry, this._view._settingsBlock, this._view._suggestion, this._view._scenesBlock, this._view._appsBlock, this._view._allBlock, this._view._panel];
    }

    _nextZone(step) {
        const zones = this.zones;
        const focus = global.stage.key_focus;
        const current = zones.findIndex(zone => holds(zone, focus));
        for (let i = 1; i <= zones.length; i++) {
            const zone = zones[(Math.max(current, 0) + step * i + zones.length * i) % zones.length];
            if (zone === this._view._entry) {
                zone.grab_key_focus();
                return;
            }
            if (zone.is_mapped() && zone.navigate_focus(null, St.DirectionType.TAB_FORWARD, false))
                return;
        }
    }

    _moveFocus(direction) {
        const focus = global.stage.key_focus;
        if (holds(this._view._panel, focus)) {
            this._view._panel.navigate_focus(focus, direction, false);
        } else if (holds(this._view._entry, focus)) {
            if (direction === St.DirectionType.DOWN)
                this._nextZone(1);
        } else if (!focus) {
            this._view._entry.grab_key_focus();
        } else if (!this._view._content.navigate_focus(focus, direction, false) && direction === St.DirectionType.UP) {
            this._view._entry.grab_key_focus();
        }
    }

    focusedCard() {
        const focus = global.stage.key_focus;
        return this._view._cards.find(c => c === focus) ?? null;
    }

    onKeyPress(event) {
        const key = event.get_key_symbol();
        const inEntry = global.stage.key_focus === this._view._entry.clutter_text;
        if (key === Clutter.KEY_Escape) {
            // Esc clears the search first; with nothing typed it closes.
            if (this._view._entry.text !== '') {
                this._view._entry.text = '';
                this._view._entry.grab_key_focus();
            } else {
                this._view.close();
            }
            return Clutter.EVENT_STOP;
        }
        const card = this.focusedCard();
        if (card && key === Clutter.KEY_Delete) {
            this._view._editor.delete(card.scene);
            return Clutter.EVENT_STOP;
        }
        if (card && key === Clutter.KEY_F2) {
            this._view._editor.rename(card.scene);
            return Clutter.EVENT_STOP;
        }
        if (key === Clutter.KEY_Tab || key === Clutter.KEY_ISO_Left_Tab) {
            this._nextZone(key === Clutter.KEY_Tab ? 1 : -1);
            return Clutter.EVENT_STOP;
        }
        const direction = {
            [Clutter.KEY_Up]: St.DirectionType.UP,
            [Clutter.KEY_Down]: St.DirectionType.DOWN,
            [Clutter.KEY_Left]: St.DirectionType.LEFT,
            [Clutter.KEY_Right]: St.DirectionType.RIGHT,
        }[key];
        if (direction !== undefined) {
            this._moveFocus(direction);
            return Clutter.EVENT_STOP;
        }
        // Typing anywhere goes to the search box.
        const state = event.get_state();
        const modified = state & (Clutter.ModifierType.CONTROL_MASK | Clutter.ModifierType.MOD1_MASK |
            Clutter.ModifierType.SUPER_MASK);
        const unicode = event.get_key_unicode();
        if (!inEntry && !modified && unicode && unicode.codePointAt(0) >= 32 && unicode.codePointAt(0) !== 127) {
            this._view._entry.grab_key_focus();
            this._view._entry.clutter_text.insert_text(unicode, -1);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }
}
