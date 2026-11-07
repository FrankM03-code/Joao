// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// The full-screen page and the only place of the system: a header (time, search, status),
// the main column (suggestion, saved scenes, apps) and the system panel on the right.
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {AppDrag} from './appDrag.js';
import {searchApps, searchScenes} from './appSearch.js';
import {Backdrop} from './backdrop.js';
import {appsBubble, captureWindows, escenasStrip, pointerMonitor} from '../escenas/escenasLink.js';
import {connectKeyPress} from '../escritorio/keyEvents.js';
import {notificationStore} from '../notificaciones/notificationStore.js';
import {LauncherHeader} from './header.js';
import {layoutSummary} from '../escenas/layouts.js';
import {holds, PageKeys} from './pageKeys.js';
import {appNames, DottedCard, lookupApp, SavedSceneCard} from './savedSceneCard.js';
import {SceneEditor} from './sceneEditor.js';
import {Stagger} from './stagger.js';
import {WaveReveal} from './waveReveal.js';
import {searchSettings} from './settingsSearch.js';
import {suggest} from '../escenas/suggestions.js';
import {Tooltip} from '../sistema/common.js';
import {grabHoldsKeyboard, MENU_NO_ANIMATION} from '../sistema/compat.js';
import {SystemPanel} from '../sistema/systemPanel.js';

// Layout of the screen, in pixels of a monitor at scale 1.
const MARGIN = 48;
const HEADER_TOP = 26;
const CONTENT_TOP = 112;
const PANEL_WIDTH = 332;
const PANEL_GAP = 32;
const PANEL_BOTTOM = 32;
const NARROW = 1200;        // below this the panel folds away
const CARD_WIDTH = 200;
const CARD_HEIGHT = 156;
const CARD_GAP = 14;
const APPS = 9;             // columns of the apps, and how many "Frecuentes" there are
const APP_GAP = 6;
const FADE_HEIGHT = 120;
const FADE = 150;
const OPEN_BACKDROP = 180;
const OPEN_CONTENT = 220;
const OPEN_RISE = 12;
const BUBBLE_REACH = 37;     // from its center to its outer edge
const BUBBLE_GAP = 16;
const PANEL_SHIFT = 24;
const PANEL_DELAY = 300;
const PANEL_ENTER = 400;
const SCROLLBAR_ROOM = 14;  // keep in step with stylesheet.css (.escenas-saved-inset)

const byName = (a, b) => a.get_name().localeCompare(b.get_name(), 'es');

export const SavedScenesView = GObject.registerClass(
class JoaoSavedScenesView extends St.Widget {
    _init(settings, store, restorer) {
        super._init({reactive: true, visible: false});
        this._settings = settings;
        this._store = store;
        this._restorer = restorer;
        this._grab = null;
        this._cards = [];
        this._appButtons = [];
        this._settingButtons = [];
        this._searchCache = new Map();
        this._drag = new AppDrag(this);
        this._editor = new SceneEditor(this);
        this._keys = new PageKeys(this);
        this._tooltip = new Tooltip();

        // What the circle reveals. The strip's bubble goes above it, outside it, and is never masked.
        this._layers = new St.Widget();
        this.add_child(this._layers);
        this._wave = new WaveReveal(this._layers);
        this._stagger = new Stagger();

        // Two layers, because they appear at different speeds.
        this._background = new St.Widget();
        this._layers.add_child(this._background);
        this._backdrop = new Backdrop();
        this._background.add_child(this._backdrop);
        this._tint = new St.Widget({style_class: 'escenas-saved-tint'});
        this._background.add_child(this._tint);
        this._page = new St.Widget();
        this._layers.add_child(this._page);

        this._header = new LauncherHeader({
            tooltip: this._tooltip,
            onSection: section => this.showSection(section),
            onFold: () => this._setPanelShown(!this._panelShown),
        });
        this._page.add_child(this._header);
        this._entry = this._header.entry;
        this._entry.clutter_text.connect('text-changed', () => this._populate());
        this._entry.clutter_text.connect('activate', () => this._activateFirst());

        // Everything below the search box scrolls as one page.
        this._content = new St.BoxLayout({style_class: 'escenas-saved-content', orientation: Clutter.Orientation.VERTICAL});
        this._scroll = new St.ScrollView({
            style_class: 'escenas-saved-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            child: this._content,
        });
        this._page.add_child(this._scroll);
        // Says there is more below; it goes away at the end of the page.
        this._fade = new St.Widget({style_class: 'escenas-full-fade'});
        this._page.add_child(this._fade);
        const adjustment = this._scroll.vadjustment;
        for (const prop of ['value', 'upper', 'page-size'])
            adjustment.connect(`notify::${prop}`, () => this._syncFade());

        this._panel = new SystemPanel({tooltip: this._tooltip, close: () => this.close({toOrigin: false}), closeNow: () => this.close({animate: false}), settings});
        this._page.add_child(this._panel);

        // Found by the search box, on top of everything else.
        this._settingsBlock = new St.BoxLayout({style_class: 'escenas-saved-block', orientation: Clutter.Orientation.VERTICAL});
        this._content.add_child(this._settingsBlock);
        this._settingsBlock.add_child(new St.Label({style_class: 'escenas-saved-title', text: 'Ajustes'}));
        this._settingsRow = new St.BoxLayout({style_class: 'escenas-full-results'});
        this._settingsBlock.add_child(this._settingsRow);

        this._suggestion = new St.BoxLayout({style_class: 'escenas-saved-suggestion escenas-saved-inset', reactive: true, x_expand: true});
        this._suggestion.connect('button-press-event', (a, event) => {
            if (event.get_button() !== Clutter.BUTTON_SECONDARY)
                return Clutter.EVENT_PROPAGATE;
            this._editor.openSuggestionMenu();
            return Clutter.EVENT_STOP;
        });
        this._content.add_child(this._suggestion);
        this._suggestion.add_child(new St.Bin({
            style_class: 'escenas-saved-suggestion-clock',
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({icon_name: 'preferences-system-time-symbolic', icon_size: 22}),
        }));
        const words = new St.BoxLayout({
            style_class: 'escenas-saved-suggestion-text',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._suggestionTitle = new St.Label({style_class: 'escenas-saved-suggestion-title'});
        this._suggestionDetail = new St.Label({style_class: 'escenas-saved-suggestion-detail'});
        words.add_child(this._suggestionTitle);
        words.add_child(this._suggestionDetail);
        this._suggestion.add_child(words);
        // A label of its own: St.Button's built-in one stays black over this white button.
        this._suggestionOpenLabel = new St.Label({style_class: 'escenas-saved-suggestion-open-label', y_align: Clutter.ActorAlign.CENTER});
        this._suggestionOpen = new St.Button({
            style_class: 'escenas-saved-suggestion-open',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            child: this._suggestionOpenLabel,
        });
        this._suggestionOpen.connect('clicked', () => this._openScene(this._suggested));
        this._suggestion.add_child(this._suggestionOpen);
        this._suggestionHide = new St.Button({
            style_class: 'escenas-saved-suggestion-hide',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({icon_name: 'window-close-symbolic', icon_size: 14}),
        });
        this._suggestionHide.connect('clicked', () => this._editor.disableSuggestion());
        this._suggestion.add_child(this._suggestionHide);

        this._scenesBlock = new St.BoxLayout({style_class: 'escenas-saved-block', orientation: Clutter.Orientation.VERTICAL});
        this._content.add_child(this._scenesBlock);
        const head = new St.BoxLayout({style_class: 'escenas-saved-inset', x_expand: true});
        head.add_child(new St.Label({style_class: 'escenas-saved-title', text: 'Escenas guardadas', x_expand: true}));
        head.add_child(new St.Label({
            style_class: 'escenas-saved-subtitle',
            text: 'Con el interruptor encendido, un clic abre sus apps',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._scenesBlock.add_child(head);
        this._gridLayout = new Clutter.GridLayout({column_spacing: CARD_GAP, row_spacing: CARD_GAP});
        this._grid = new St.Widget({layout_manager: this._gridLayout});
        this._grid.x_align = Clutter.ActorAlign.START;
        this._scenesBlock.add_child(this._grid);

        this._appsBlock = new St.BoxLayout({style_class: 'escenas-saved-block', orientation: Clutter.Orientation.VERTICAL});
        this._content.add_child(this._appsBlock);
        const appsHead = new St.BoxLayout({style_class: 'escenas-saved-inset', x_expand: true});
        this._appsTitle = new St.Label({style_class: 'escenas-saved-title', x_expand: true});
        appsHead.add_child(this._appsTitle);
        this._seeAll = new St.Button({style_class: 'escenas-saved-link', label: 'Ver todas', can_focus: true});
        this._seeAll.connect('clicked', () => this._scrollTo(this._allBlock));
        appsHead.add_child(this._seeAll);
        this._appsBlock.add_child(appsHead);
        this._appsLayout = new Clutter.GridLayout();
        this._appsRow = new St.Widget({style_class: 'escenas-saved-inset', layout_manager: this._appsLayout});
        this._appsBlock.add_child(this._appsRow);

        this._allBlock = new St.BoxLayout({style_class: 'escenas-saved-block', orientation: Clutter.Orientation.VERTICAL});
        this._content.add_child(this._allBlock);
        this._allBlock.add_child(new St.Label({style_class: 'escenas-saved-title escenas-saved-inset', text: 'Todas las apps'}));
        this._allLayout = new Clutter.GridLayout();
        this._allGrid = new St.Widget({style_class: 'escenas-saved-inset', layout_manager: this._allLayout});
        this._allBlock.add_child(this._allGrid);
        this._allButtons = [];

        this._noResults = new St.Label({style_class: 'escenas-saved-empty', x_align: Clutter.ActorAlign.CENTER});
        this._content.add_child(this._noResults);

        this.connect('button-press-event', (a, event) => this._onPress(event));
        connectKeyPress(this, event => this._keys.onKeyPress(event));

        // Below GNOME's dialog layer, so the save dialog shows over the page.
        const group = Main.layoutManager.uiGroup;
        group.add_child(this);
        group.set_child_below_sibling(this, Main.layoutManager.modalDialogGroup);
        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => this._onMonitorsChanged());
        this._panelId = settings.connect('changed::system-panel-visible', () => this._onMonitorsChanged());
        this._blurId = settings.connect('changed::saved-scenes-blur', () => {
            if (this.visible)
                this._syncBlur();
        });
    }

    get isOpen() {
        return this.visible && !this._closing;
    }

    get _query() {
        return this._entry.text.trim();
    }

    toggle() {
        if (this.isOpen)
            this.close();
        else
            this.open();
    }

    // Opens the page if needed and goes to that part of the system panel.
    showSection(section) {
        if (!this.isOpen)
            this.open();
        if (!this.isOpen)
            return;
        if (this._folded)
            this._setPanelShown(true);
        this._panel.focusSection(section);
    }

    open() {
        if (this.isOpen)
            return;
        if (Main.overview.visible)
            Main.overview.hide();
        // Pressed again while closing: turns back from where it is, with the page as it was.
        const reversing = this._closing;
        this._closing = false;
        if (!reversing) {
            this._placeOnPointerMonitor();
            this._syncBlur();
            this._allStale = true;
            this._entry.text = '';
            this._panel.refresh();
            this._header.syncClock();
            this._populate();
            this.show();
            this._panel.place(this._panelHeight, this._scale);
            // The panel shows them: that counts as read.
            if (this._panelShown)
                notificationStore()?.markAllRead();
        }
        this._takeBubble();
        if (reversing)
            this._animateBack();
        else
            this._animateIn();
        this._grab = Main.pushModal(this, {actionMode: Shell.ActionMode.POPUP});
        if (!grabHoldsKeyboard(this._grab)) {
            // Something else holds the keyboard (another popup): do not open half-way.
            this.close({animate: false});
            return;
        }
        this._entry.grab_key_focus();
        // The files may have been edited or deleted by hand since the last time.
        this._store.reload().then(() => {
            if (this.isOpen && this.scenesChanged())
                this._populate();
        });
    }

    // The strip's bubble, when it is on this monitor: it is the × and the circle's center.
    _takeBubble() {
        this._bubble = null;
        const bubble = appsBubble();
        const center = bubble?.center();
        const {x, y, width, height} = this._monitor;
        if (!center || center.x < x || center.x >= x + width || center.y < y || center.y >= y + height)
            return;
        this._bubble = bubble;
        bubble.enterDrawer(this);
    }

    // Called by the strip when it goes away with the page open.
    forgetBubble() {
        this._bubble = null;
    }

    _effect() {
        return St.Settings.get().enable_animations ? this._settings.get_string('launcher-open-effect') : 'none';
    }

    // Where the circle starts and ends, on the page; null when there is no bubble to start from.
    _waveCenter() {
        const center = this._effect() === 'wave' ? this._bubble?.center() : null;
        return center ? {x: center.x - this._monitor.x, y: center.y - this._monitor.y} : null;
    }

    _animateIn() {
        for (const layer of [this._layers, this._background, this._page])
            layer.remove_all_transitions();
        this._wave.stop();
        this._layers.opacity = 255;
        this._background.opacity = 255;
        this._page.opacity = 255;
        this._page.translation_y = 0;
        const effect = this._effect();
        const center = this._waveCenter();
        if (center) {
            this._wave.setArea(center.x, center.y, this._monitor.width, this._monitor.height);
            this._wave.prepare();
            // Nothing shows with the circle at zero: the elements are measured after this first frame.
            this._afterFirstFrame(() => this._waveIn(center));
        } else if (effect === 'fade' || effect === 'wave') {
            this._background.opacity = 0;
            this._background.ease({opacity: 255, duration: OPEN_BACKDROP, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            this._page.opacity = 0;
            this._page.translation_y = OPEN_RISE * this._scale;
            this._page.ease({opacity: 255, translation_y: 0, duration: OPEN_CONTENT, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
    }

    _waveIn(center) {
        const origin = {x: center.x + this._monitor.x, y: center.y + this._monitor.y};
        const bottom = this._monitor.y + this._monitor.height;
        this._stagger.enter(this._staggeredActors(), origin, bottom);
        this._stagger.enterFromSide(this._panel, PANEL_SHIFT * this._scale, PANEL_DELAY, PANEL_ENTER);
        this._wave.grow();
    }

    // Header, then the page from top to bottom. The system panel enters as one block, apart.
    _staggeredActors() {
        const heads = [this._scenesBlock, this._appsBlock, this._allBlock].map(block => block.get_first_child());
        return [this._header, this._suggestion, ...heads, ...this._grid.get_children(),
            ...this._appButtons, ...this._allButtons];
    }

    _animateBack() {
        this._layers.remove_all_transitions();
        this._page.remove_all_transitions();
        const params = {opacity: 255, duration: FADE, mode: Clutter.AnimationMode.EASE_OUT_QUAD};
        this._layers.ease(params);
        this._page.ease(params);
        this._stagger.settle();
        if (this._wave.active)
            this._wave.grow();
    }

    _afterFirstFrame(fn) {
        this._cancelFirstFrame();
        this._frameId = global.stage.connect('after-paint', () => {
            this._cancelFirstFrame();
            fn();
        });
        global.stage.queue_redraw();
    }

    _cancelFirstFrame() {
        if (this._frameId)
            global.stage.disconnect(this._frameId);
        this._frameId = 0;
    }

    // toOrigin: false when something else is about to appear (an app, a scene): a quick fade.
    close({animate = true, toOrigin = true} = {}) {
        if (!this.visible)
            return;
        if (this._closing) {
            if (!animate)
                this._finishClose();
            return;
        }
        this._cancelFirstFrame();
        this._editor.menu?.close(MENU_NO_ANIMATION);
        this._tooltip.hide();
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this._bubble?.setOpen(false);
        const effect = this._effect();
        if (!animate || effect === 'none') {
            this._finishClose();
            return;
        }
        this._closing = true;
        this._stagger.freeze();
        this._page.remove_all_transitions();
        const center = toOrigin ? this._waveCenter() : null;
        if (center) {
            this._wave.setArea(center.x, center.y, this._monitor.width, this._monitor.height);
            this._page.ease({opacity: 0, duration: FADE, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            this._wave.shrink(() => this._finishClose());
        } else {
            this._layers.ease({
                opacity: 0,
                duration: FADE,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onStopped: finished => {
                    if (finished)
                        this._finishClose();
                },
            });
        }
    }

    _finishClose() {
        this._closing = false;
        this._cancelFirstFrame();
        this._layers.remove_all_transitions();
        this._page.remove_all_transitions();
        this._wave.stop();
        this._stagger.reset();
        this._layers.opacity = 255;
        this._page.opacity = 255;
        this.hide();
        this._backdrop.clear();
        this._bubble?.leaveDrawer();
        this._bubble = null;
    }

    _syncBlur() {
        const on = this._settings.get_boolean('saved-scenes-blur');
        this._backdrop.visible = on;
        if (!on)
            this._backdrop.clear();
        else if (this._monitor)
            this._backdrop.rebuild(this._monitor.index, this._monitor.width, this._monitor.height);
    }

    _placeOnPointerMonitor() {
        const monitor = Main.layoutManager.monitors[pointerMonitor()];
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._monitor = monitor;
        this._scale = scale;
        const {width, height} = monitor;
        this.set_position(monitor.x, monitor.y);
        this.set_size(width, height);
        this._layers.set_size(width, height);
        this._background.set_size(width, height);
        this._tint.set_size(width, height);
        this._page.set_size(width, height);

        const margin = MARGIN * scale;
        // The × stays where the bubble is: nothing of the page may lie under it.
        const gutter = this._bubbleGutter(monitor);
        const marginLeft = Math.max(margin, gutter.left);
        const marginRight = Math.max(margin, gutter.right);
        this._folded = width < NARROW * scale || !this._settings.get_boolean('system-panel-visible');
        const panelWidth = PANEL_WIDTH * scale;
        const taken = this._folded ? 0 : panelWidth + PANEL_GAP * scale;
        this._columnWidth = width - marginLeft - marginRight - taken;

        this._header.set_position(margin, HEADER_TOP * scale);
        this._header.place(width - 2 * margin, scale);
        this._header.foldButton.visible = this._folded;

        const top = CONTENT_TOP * scale;
        this._scroll.set_position(marginLeft, top);
        this._scroll.set_size(this._columnWidth + SCROLLBAR_ROOM * scale, height - top);
        const fade = FADE_HEIGHT * scale;
        this._fade.set_position(0, height - fade);
        this._fade.set_size(width, fade);

        this._panelHeight = height - top - PANEL_BOTTOM * scale;
        this._panel.set_position(width - marginRight - panelWidth, top);
        this._panel.width = panelWidth;
        this._panel.height = this._panelHeight;
        // Over the apps, glass would mix with them.
        if (this._folded)
            this._panel.add_style_class_name('over-apps');
        else
            this._panel.remove_style_class_name('over-apps');
        this._setPanelShown(!this._folded);
    }

    _bubbleGutter(monitor) {
        const gutter = {left: 0, right: 0};
        const center = appsBubble()?.center();
        if (!center || center.x < monitor.x || center.x >= monitor.x + monitor.width)
            return gutter;
        const reach = (BUBBLE_REACH + BUBBLE_GAP) * this._scale;
        const x = center.x - monitor.x;
        if (x < monitor.width / 2)
            gutter.left = x + reach;
        else
            gutter.right = monitor.width - x + reach;
        return gutter;
    }

    _setPanelShown(shown) {
        this._panelShown = shown;
        this._panel.visible = shown;
        if (shown && this.visible) {
            this._panel.place(this._panelHeight, this._scale);
            notificationStore()?.markAllRead();
        } else if (!shown && holds(this._panel, global.stage.key_focus))
            this._entry.grab_key_focus();
    }

    // The page follows the monitor it is on, and the preference of the panel.
    _onMonitorsChanged() {
        if (!this.isOpen)
            return;
        if (!Main.layoutManager.monitors.length) {
            this.close({animate: false});
            return;
        }
        this._allStale = true;
        this._placeOnPointerMonitor();
        this._syncBlur();
        this._populate();
        this._bubble?.sync();
    }

    _syncFade() {
        const {value, upper, page_size: page} = this._scroll.vadjustment;
        this._fade.visible = value + page < upper - 1;
    }

    scenesChanged() {
        const shown = this._cards.map(c => c.scene);
        const scenes = this._store.scenes;
        return !this._query && (shown.length !== scenes.length || shown.some((s, i) => s !== scenes[i]));
    }

    // Everything below the search box, for the current text.
    _populate() {
        const query = this._query;
        const scenes = this._scenesForQuery();
        this._suggested = !query && this._settings.get_boolean('saved-scenes-suggestions')
            ? suggest(this._store.data, this._store.usage) : null;
        this._fillSuggestion();
        this._fillSettings(query);
        this._fillApps(query);
        this._fillScenes(scenes);
        this._allBlock.visible = !query;
        if (!query)
            this._fillAllApps();
        this._appsTitle.text = query ? 'Apps' : 'Frecuentes';
        this._seeAll.visible = !query;
        this._scenesBlock.visible = !query || scenes.length > 0 || this._appButtons.length > 0;
        this._appsBlock.visible = this._appButtons.length > 0;
        const nothing = !scenes.length && !this._appButtons.length && !this._settingButtons.length;
        this._noResults.visible = !!query && nothing;
        this._noResults.text = `No hay escenas, apps ni ajustes que coincidan con «${query}»`;
        this._markFirstResult();
        this._scroll.vadjustment.value = 0;
    }

    _fillSettings(query) {
        this._settingsRow.destroy_all_children();
        this._settingButtons = searchSettings(query).filter(s => this._panel.has(s.id)).map(setting => {
            const button = new St.Button({style_class: 'escenas-full-result', can_focus: true, accessible_name: setting.name});
            const box = new St.BoxLayout({style_class: 'escenas-full-result-box'});
            box.add_child(new St.Icon({icon_name: setting.icon, icon_size: 16, y_align: Clutter.ActorAlign.CENTER}));
            box.add_child(new St.Label({text: setting.name, y_align: Clutter.ActorAlign.CENTER}));
            button.set_child(box);
            button.setting = setting;
            button.connect('clicked', () => this._runSetting(setting));
            this._settingsRow.add_child(button);
            return button;
        });
        this._settingsBlock.visible = this._settingButtons.length > 0;
    }

    // Actions run (apagar and reiniciar ask first); controls light up in the panel.
    _runSetting(setting) {
        if (setting.action) {
            this._panel.runAction(setting.id);
            return;
        }
        if (this._folded)
            this._setPanelShown(true);
        this._panel.highlight(setting.id);
    }

    // Enter opens the first result: show which one it is.
    _markFirstResult() {
        const first = this._query ? this._settingButtons[0] ?? this._cards[0] ?? this._appButtons[0] : null;
        for (const a of [...this._settingButtons, ...this._cards, ...this._appButtons]) {
            if (a === first)
                a.add_style_class_name('first-result');
            else
                a.remove_style_class_name('first-result');
        }
    }

    _scenesForQuery() {
        return this._query
            ? searchScenes(this._store.scenes, this._query, w => lookupApp(w.appId)?.get_name() ?? w.appName)
            : this._store.scenes;
    }

    // After a drop: only the cards change, the page stays where it is.
    _refreshCards() {
        this._fillScenes(this._scenesForQuery());
        this._markFirstResult();
    }

    _fillSuggestion() {
        const scene = this._suggested;
        this._suggestion.visible = !!scene;
        if (!scene)
            return;
        this._suggestionTitle.text = `A esta hora sueles abrir ${scene.name}`;
        this._suggestionDetail.text = `${appNames(scene)} · ${layoutSummary(scene.layout)}`;
        this._suggestionOpenLabel.text = `Abrir ${scene.name}`;
    }

    _fillScenes(scenes) {
        this._grid.destroy_all_children();
        const width = CARD_WIDTH * this._scale;
        const height = CARD_HEIGHT * this._scale;
        const gap = CARD_GAP * this._scale;
        const columns = Math.max(1, Math.floor((this._columnWidth + gap) / (width + gap)));
        this._gridLayout.column_spacing = CARD_GAP * this._scale;
        this._gridLayout.row_spacing = CARD_GAP * this._scale;
        this._cards = scenes.map(scene => {
            const card = new SavedSceneCard(scene, width, height, {suggested: scene === this._suggested});
            card.connect('clicked', () => this._activateScene(scene));
            this._tooltip.attach(card.openSwitch, 'Abrir sus apps al hacer clic');
            card.openSwitch.connect('clicked', () => this._store.setOpenApps(scene.id, card.openSwitch.checked));
            card.connect('button-press-event', (a, event) => {
                if (event.get_button() !== Clutter.BUTTON_SECONDARY)
                    return Clutter.EVENT_PROPAGATE;
                this._editor.openCardMenu(card);
                return Clutter.EVENT_STOP;
            });
            card.connect('popup-menu', () => this._editor.openCardMenu(card));
            card.connect('key-focus-in', () => this._ensureVisible(card));
            this._drag.makeDropTarget(card, app => this._store.addApp(scene.id, app));
            return card;
        });
        const items = [...this._cards];
        // Also while searching: that is how an app found by name gets dragged.
        this._newCard = null;
        if (!this._query || this._appButtons.length) {
            this._newCard = new DottedCard(width, height, {
                label: 'Nueva escena',
                hint: 'Arrastra aquí una app',
                iconName: 'view-grid-symbolic',
            });
            this._newCard.connect('clicked', () => this._scrollTo(this._query ? this._appsBlock : this._allBlock));
            this._newCard.connect('key-focus-in', () => this._ensureVisible(this._newCard));
            this._drag.makeDropTarget(this._newCard, app => this._store.createFromApp(app));
            items.push(this._newCard);
        }
        this._saveCard = null;
        if (!this._query) {
            this._saveCard = new DottedCard(width, height, {
                label: 'Guardar la escena actual',
                enabled: captureWindows().length > 0,
            });
            this._saveCard.connect('clicked', () => this._editor.saveCurrent());
            this._saveCard.connect('key-focus-in', () => this._ensureVisible(this._saveCard));
            items.push(this._saveCard);
        }
        items.forEach((item, i) => this._gridLayout.attach(item, i % columns, Math.floor(i / columns), 1, 1));
    }

    _appButton(app, width) {
        const button = new St.Button({style_class: 'escenas-saved-app', can_focus: true, width});
        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const icon = app.create_icon_texture(48);
        icon.x_align = Clutter.ActorAlign.CENTER;
        box.add_child(icon);
        box.add_child(new St.Label({style_class: 'escenas-saved-app-name', text: app.get_name(), x_align: Clutter.ActorAlign.CENTER}));
        button.set_child(box);
        button.app = app;
        button.connect('clicked', () => this._openApp(app));
        button.connect('key-focus-in', () => this._ensureVisible(button));
        this._drag.makeDraggable(button, app);
        return button;
    }

    // A grid of apps in the same columns everywhere.
    _fillAppGrid(grid, layout, apps) {
        grid.destroy_all_children();
        const gap = APP_GAP * this._scale;
        const width = Math.floor((this._columnWidth - (APPS - 1) * gap) / APPS);
        layout.column_spacing = gap;
        layout.row_spacing = gap;
        return apps.map((app, i) => {
            const button = this._appButton(app, width);
            layout.attach(button, i % APPS, Math.floor(i / APPS), 1, 1);
            return button;
        });
    }

    _installedApps() {
        const system = Shell.AppSystem.get_default();
        return system.get_installed().map(info => system.lookup_app(info.get_id()))
            .filter(app => app?.get_app_info()?.should_show());
    }

    // With a search: every match. Without: the most used, topped up in alphabetical
    // order (a new user has no history yet).
    _fillApps(query) {
        const installed = this._installedApps();
        let apps;
        if (query) {
            apps = searchApps(installed, query, this._searchCache);
        } else {
            const used = Shell.AppUsage.get_default().get_most_used().filter(app => app.get_app_info()?.should_show());
            const rest = installed.filter(app => !used.includes(app)).sort(byName);
            apps = [...used, ...rest].slice(0, APPS);
        }
        this._appButtons = this._fillAppGrid(this._appsRow, this._appsLayout, apps);
    }

    // Every installed app. Built once per opening: it does not change as you type.
    _fillAllApps() {
        if (!this._allStale)
            return;
        this._allStale = false;
        this._allButtons = this._fillAppGrid(this._allGrid, this._allLayout, this._installedApps().sort(byName));
    }

    // Where @actor is now, measured from the top of the visible part of the page.
    _offsetInPage(actor) {
        return actor.get_transformed_position()[1] - this._scroll.get_transformed_position()[1];
    }

    _ensureVisible(actor) {
        const adjustment = this._scroll.vadjustment;
        const top = this._offsetInPage(actor);
        const bottom = top + actor.get_transformed_size()[1];
        if (top < 0)
            adjustment.value += top;
        else if (bottom > adjustment.page_size)
            adjustment.value += bottom - adjustment.page_size;
    }

    _scrollTo(actor) {
        this._scroll.vadjustment.value += this._offsetInPage(actor);
    }

    _activateFirst() {
        if (this._settingButtons.length)
            this._runSetting(this._settingButtons[0].setting);
        else if (this._cards.length)
            this._activateScene(this._cards[0].scene);
        else if (this._appButtons.length)
            this._openApp(this._appButtons[0].app);
    }

    // A click on a card: what its switch says. With the strip off there is nowhere for the apps to wait.
    _activateScene(scene) {
        const strip = escenasStrip();
        if (scene.openApps || !strip) {
            this._openScene(scene);
            return;
        }
        this.close();
        strip.shortcuts.show(scene.windows.map(w => w.appId));
        this._store.recordUse(scene.id);
        strip.reveal();
    }

    _openScene(scene, options = {}) {
        this.close({toOrigin: false});
        this._restorer.restore(scene, options);
    }

    _openApp(app) {
        this.close({toOrigin: false});
        this._restorer.openInActiveScene(app);
    }

    // ---------- input ----------

    _onPress(event) {
        const source = global.stage.get_event_actor(event);
        if ((source === this || source === this._scroll) && event.get_button() === Clutter.BUTTON_PRIMARY) {
            this.close();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    destroy() {
        this._drag.destroy();
        this.close({animate: false});
        this._cancelFirstFrame();
        this._editor.destroy();
        Main.layoutManager.disconnect(this._monitorsId);
        this._settings.disconnect(this._panelId);
        this._settings.disconnect(this._blurId);
        super.destroy();
        this._tooltip.destroy();
    }
});
