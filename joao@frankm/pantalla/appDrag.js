// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Dragging apps onto scene cards: the app buttons are the sources, the cards the targets,
// and near an edge of the page it scrolls by itself.
import GLib from 'gi://GLib';

import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';

const DRAG_ICON = 48;
const SCROLL_ZONE = 60;     // an app dragged this close to the edge scrolls the page
const SCROLL_STEP = 14;
const SCROLL_TICK = 25;

export class AppDrag {
    constructor(view) {
        this._view = view;
        this._refreshId = 0;
    }

    makeDraggable(button, app) {
        // The cards take any drag whose source has an 'app'.
        button._delegate = {
            app,
            getDragActor: () => app.create_icon_texture(DRAG_ICON),
            getDragActorSource: () => button,
        };
        const draggable = DND.makeDraggable(button);
        draggable.connect('drag-begin', () => {
            // The press went to the drag: the button must not stay pushed in, nor click.
            button.fake_release();
            this._begin();
        });
        draggable.connect('drag-cancelled', () => this.end());
        draggable.connect('drag-end', () => this.end());
    }

    makeDropTarget(actor, onDrop) {
        actor._delegate = {
            handleDragOver: source => (source.app ? DND.DragMotionResult.COPY_DROP : DND.DragMotionResult.NO_DROP),
            acceptDrop: source => {
                if (!source.app)
                    return false;
                onDrop(source.app);
                // Not now: the drag is still using the actors of this very card.
                if (this._refreshId)
                    GLib.source_remove(this._refreshId);
                this._refreshId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    this._refreshId = 0;
                    if (this._view.isOpen)
                        this._view._refreshCards();
                    return GLib.SOURCE_REMOVE;
                });
                return true;
            },
        };
    }

    _begin() {
        if (this.monitor)
            return;
        this._scrollArmed = false;
        // The drag ends by giving the focus back: on a button far away, the page would jump there.
        this._view._entry.grab_key_focus();
        this.monitor = {dragMotion: event => this._onMotion(event)};
        DND.addDragMonitor(this.monitor);
        this.scrollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SCROLL_TICK, () => this._scroll());
    }

    end() {
        if (this.monitor)
            DND.removeDragMonitor(this.monitor);
        this.monitor = null;
        if (this.scrollId)
            GLib.source_remove(this.scrollId);
        this.scrollId = 0;
        this._setHover(null);
    }

    destroy() {
        this.end();
        if (this._refreshId)
            GLib.source_remove(this._refreshId);
        this._refreshId = 0;
    }

    _onMotion(event) {
        let actor = event.targetActor;
        while (actor && !actor._delegate?.acceptDrop)
            actor = actor.get_parent();
        this._setHover(actor ?? null);
        return DND.DragMotionResult.CONTINUE;
    }

    _setHover(actor) {
        if (actor === this.dropHover)
            return;
        // A card can be gone already: the cards are rebuilt after a drop.
        if (this.dropHover?.get_stage())
            this.dropHover.remove_style_class_name('drop-target');
        this.dropHover = actor;
        actor?.add_style_class_name('drop-target');
    }

    // The scenes are at the top and the full list far below: near an edge, the page follows.
    _scroll() {
        const [, pointerY] = global.get_pointer();
        const [, top] = this._view._scroll.get_transformed_position();
        const [, height] = this._view._scroll.get_transformed_size();
        const zone = SCROLL_ZONE * this._view._scale;
        const step = SCROLL_STEP * this._view._scale;
        const adjustment = this._view._scroll.vadjustment;
        const up = pointerY < top + zone;
        const down = pointerY > top + height - zone;
        // A drag that starts inside a zone (the apps at the bottom of the screen) must not
        // scroll the page away: the zones work once the pointer has been outside them.
        if (!up && !down)
            this._scrollArmed = true;
        else if (this._scrollArmed)
            adjustment.value += up ? -step : step;
        return GLib.SOURCE_CONTINUE;
    }
}
