// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The quick note (docs/herramientas-ampliadas-spec.md): writing straight on the glass over a blue
// line, three round buttons (checklist, remind me, copy), "Fijar", and "Mis notas" below. Enter
// pins, Shift+Enter starts a new line, Esc goes back to the menu. A note from the list opens
// here to be edited. Pinned, it shows in the panel above the notifications (only one at a time).
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {noteBody} from '../sistema/notifications.js';
import {CHECK_DONE, CHECK_OPEN} from '../sistema/taskStore.js';
import {animations, ChoiceMenu, header, Popup, scaleFactor} from './popup.js';

const HINT = '¿Qué no quieres olvidar?';
const EMPTY = 'Escribe algo primero';
const STAGGER = 60;
const ENTER = 350;
const SHIFT = 6;
const COPIED = 1200;

const DAYS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

// "hoy", "Ayer", "Mié 4", "12 oct" for older ones.
function noteDate(iso) {
    const date = iso ? GLib.DateTime.new_from_iso8601(iso, null) : null;
    if (!date)
        return '';
    const local = date.to_local();
    const today = GLib.DateTime.new_now_local();
    const midnight = d => GLib.DateTime.new_local(d.get_year(), d.get_month(), d.get_day_of_month(), 0, 0, 0).to_unix();
    const days = Math.round((midnight(today) - midnight(local)) / 86400);
    if (days <= 0)
        return 'hoy';
    if (days === 1)
        return 'Ayer';
    if (days < 7)
        return `${DAYS[local.get_day_of_week() % 7]} ${local.get_day_of_month()}`;
    return local.format('%-d %b').replace('.', '');
}

function roundButton(icon, name, run) {
    const button = new St.Button({style_class: 'joao-note-tool', can_focus: true, accessible_name: name,
        child: new St.Icon({icon_name: icon})});
    button.connect('clicked', run);
    return button;
}

export const NoteWindow = GObject.registerClass(
class JoaoNoteWindow extends Popup {
    // note: the one being edited, or null for a new one. pinned(): it was kept.
    // remind(label): the timer with that label. copy(text). layer: for the right-click menu.
    _init({store, note, back, pinned, remind, copy, layer}) {
        super._init({style_class: 'joao-ring-tool joao-note-window', y_expand: true});
        this._store = store;
        this._note = note;
        this._pinned = pinned;
        this._layer = layer;
        this.back = back;
        this.add_child(header('Nota rápida', back,
            new St.Label({style_class: 'joao-ring-head-hint', text: 'Enter fija · Shift+Enter línea', y_align: Clutter.ActorAlign.CENTER})));

        this.entry = new St.Entry({style_class: 'joao-note-paper', hint_text: HINT, can_focus: true, x_expand: true});
        const text = this.entry.clutter_text;
        text.single_line_mode = false;
        text.activatable = false;
        text.line_wrap = true;
        text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        text.connect('key-press-event', (actor, event) => {
            const key = event.get_key_symbol();
            if (key !== Clutter.KEY_Return && key !== Clutter.KEY_KP_Enter)
                return Clutter.EVENT_PROPAGATE;
            if (event.get_state() & Clutter.ModifierType.SHIFT_MASK) {
                // A new line; inside a checklist it starts with a box.
                // Done here: since GNOME 51 the text no longer breaks the line by itself.
                const line = this._currentLine();
                const box = line.startsWith(CHECK_OPEN) || line.startsWith(CHECK_DONE) ? CHECK_OPEN : '';
                text.delete_selection();
                text.insert_text(`\n${box}`, text.get_cursor_position());
                return Clutter.EVENT_STOP;
            }
            this.pin();
            return Clutter.EVENT_STOP;
        });
        text.connect('text-changed', () => {
            this.entry.hint_text = HINT;
        });
        const paper = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        paper.add_child(this.entry);
        paper.add_child(new St.Widget({style_class: 'joao-note-line', x_expand: true}));
        this.add_child(paper);

        const tools = new St.BoxLayout({style_class: 'joao-note-tools', x_expand: true});
        this.checkButton = roundButton('view-list-bullet-symbolic', 'Lista con casillas', () => this.makeChecklist());
        this.remindButton = roundButton('alarm-symbolic', 'Recordarme', () => {
            const first = this.entry.text.trim().split('\n')[0].replace(/^[○●] /, '').slice(0, 40);
            remind(first);
        });
        this.copyButton = roundButton('edit-copy-symbolic', 'Copiar', () => {
            if (!this.entry.text.trim())
                return;
            copy(this.entry.text);
            this._flash('✓ Copiada');
        });
        for (const b of [this.checkButton, this.remindButton, this.copyButton])
            tools.add_child(b);
        this._said = new St.Label({style_class: 'joao-note-said', text: '', opacity: 0, y_align: Clutter.ActorAlign.CENTER});
        tools.add_child(this._said);
        tools.add_child(new St.Widget({x_expand: true}));
        this.pinButton = new St.Button({style_class: 'joao-note-pin', can_focus: true, accessible_name: 'Fijar la nota'});
        const pinBox = new St.BoxLayout({style_class: 'joao-note-pin-box'});
        pinBox.add_child(new St.Icon({icon_name: 'view-pin-symbolic', style_class: 'joao-note-pin-icon'}));
        pinBox.add_child(new St.Label({text: 'Fijar', y_align: Clutter.ActorAlign.CENTER}));
        this.pinButton.set_child(pinBox);
        this.pinButton.connect('clicked', () => this.pin());
        tools.add_child(this.pinButton);
        this.add_child(tools);

        this._section = new St.Label({style_class: 'joao-note-section', text: 'Mis notas'});
        this.add_child(this._section);
        this._list = new St.BoxLayout({style_class: 'joao-note-list', orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        this._scroll = new St.ScrollView({style_class: 'joao-note-scroll', hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC, overlay_scrollbars: true, x_expand: true, y_expand: true, child: this._list});
        this.add_child(this._scroll);

        store.connectObject('changed', () => this._fill(false), this);
        this.connect('destroy', () => {
            store.disconnectObject(this);
            if (this._saidId)
                GLib.source_remove(this._saidId);
            this._saidId = 0;
            this._menu?.destroy();
        });
        this.load(note);
    }

    get cards() {
        return this._list.get_children();
    }

    // Into the writing area (null: a new note).
    load(note) {
        this._note = note;
        this.entry.text = note?.text ?? '';
        this.entry.hint_text = HINT;
        this._fill(false);
    }

    enter(animate) {
        this.focus();
        this._fill(animate);
    }

    focus() {
        this.entry.grab_key_focus();
        this.entry.clutter_text.set_cursor_position(-1);
    }

    _currentLine() {
        const text = this.entry.text;
        const at = this.entry.clutter_text.get_cursor_position();
        const pos = at < 0 ? text.length : at;
        const start = text.lastIndexOf('\n', pos - 1) + 1;
        const end = text.indexOf('\n', pos);
        return text.slice(start, end < 0 ? text.length : end);
    }

    // The current line, or the selected ones, become checklist items.
    makeChecklist() {
        const ct = this.entry.clutter_text;
        const text = this.entry.text;
        let [a, b] = [ct.get_selection_bound(), ct.get_cursor_position()].map(p => (p < 0 ? text.length : p));
        if (a > b)
            [a, b] = [b, a];
        const start = text.lastIndexOf('\n', a - 1) + 1;
        const endAt = text.indexOf('\n', b);
        const end = endAt < 0 ? text.length : endAt;
        const lines = text.slice(start, end).split('\n').map(line =>
            (line.startsWith(CHECK_OPEN) || line.startsWith(CHECK_DONE) ? line : `${CHECK_OPEN}${line}`));
        const block = lines.join('\n');
        this.entry.text = text.slice(0, start) + block + text.slice(end);
        ct.set_cursor_position(start + block.length);
        ct.set_selection_bound(start + block.length);
        this.entry.grab_key_focus();
    }

    _flash(text) {
        this._said.text = text;
        this._said.remove_all_transitions();
        this._said.opacity = 255;
        if (this._saidId)
            GLib.source_remove(this._saidId);
        this._saidId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, COPIED, () => {
            this._saidId = 0;
            this._said.ease({opacity: 0, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            return GLib.SOURCE_REMOVE;
        });
    }

    _fill(animate) {
        this._menu?.destroy();
        this._menu = null;
        this._list.destroy_all_children();
        // The one being written is not repeated below.
        const notes = this._store.all.filter(n => n.id !== this._note?.id);
        this._section.visible = notes.length > 0;
        notes.forEach((note, i) => {
            const card = this._card(note);
            this._list.add_child(card);
            if (!animate || !animations())
                return;
            card.set({opacity: 0, translation_y: SHIFT * scaleFactor()});
            card.ease({opacity: 255, translation_y: 0, delay: i * STAGGER, duration: ENTER,
                mode: Clutter.AnimationMode.EASE_OUT_QUINT});
        });
    }

    _card(note) {
        const card = new St.Button({style_class: 'joao-note-card', can_focus: true, x_expand: true,
            accessible_name: `${note.pinned ? 'Nota fijada' : 'Nota'}: ${note.text}. Clic para editarla`});
        if (note.pinned)
            card.add_style_class_name('pinned');
        card.note = note;
        const box = new St.BoxLayout({style_class: 'joao-note-card-box', x_expand: true});
        box.add_child(new St.Icon({style_class: 'joao-note-card-icon', y_align: Clutter.ActorAlign.START,
            icon_name: note.pinned ? 'view-pin-symbolic' : 'document-edit-symbolic'}));
        const words = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        // At most four lines here; the whole note opens above.
        const short = note.text.split('\n').slice(0, 4).join('\n');
        words.add_child(noteBody(short, null, 'joao-note-card-text'));
        const when = noteDate(note.updated ?? note.created);
        words.add_child(new St.Label({style_class: 'joao-note-card-date', text: note.pinned ? `Fijada · ${when}` : when}));
        box.add_child(words);
        card.set_child(box);
        card.connect('clicked', () => {
            this.load(note);
            this.focus();
        });
        card.connect('button-press-event', (actor, event) => {
            if (event.get_button() !== Clutter.BUTTON_SECONDARY)
                return Clutter.EVENT_PROPAGATE;
            this._choices(note, event.get_coords());
            return Clutter.EVENT_STOP;
        });
        return card;
    }

    _choices(note, [x, y]) {
        this._menu?.destroy();
        this._menu = new ChoiceMenu([
            [note.pinned ? 'Desfijar' : 'Fijar', () => this._store.setPinned(note.id, !note.pinned)],
            ['Eliminar', () => this._store.remove(note.id)],
        ], () => {
            this._menu = null;
        });
        this._menu.showAt(this._layer, x, y);
    }

    pin() {
        const text = this.entry.text.replace(/\s+$/, '');
        if (!text.trim()) {
            this.entry.text = '';
            this.entry.hint_text = EMPTY;
            this.focus();
            return;
        }
        if (this._note && this._store.get(this._note.id))
            this._store.update(this._note.id, text);
        else
            this._store.pin(text);
        this._pinned();
    }
});
