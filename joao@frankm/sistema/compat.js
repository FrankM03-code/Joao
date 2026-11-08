// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// What changed between the GNOME Shell versions João supports, in one place.
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {PACKAGE_VERSION} from 'resource:///org/gnome/shell/misc/config.js';

const MAJOR = Number.parseInt(PACKAGE_VERSION);

// ---------- windows: Meta.MaximizeFlags left maximize() and unmaximize() in 49 ----------

export const isMaximized = win => win.maximized_horizontally && win.maximized_vertically;
export const isPartlyMaximized = win => win.maximized_horizontally || win.maximized_vertically;

const maximizeArgs = () => (MAJOR < 49 ? [Meta.MaximizeFlags.BOTH] : []);

export const maximize = win => win.maximize(...maximizeArgs());
export const unmaximize = win => win.unmaximize(...maximizeArgs());

// ---------- input ----------

// False when something else holds the keyboard. Clutter.GrabState went away in 50.
export const grabHoldsKeyboard = grab => (MAJOR < 50
    ? (grab.get_seat_state() & Clutter.GrabState.KEYBOARD) !== 0
    : !grab.is_revoked());

// ---------- chrome: the input region went away with X11 in 50 ----------

export const CHROME_NO_INPUT = MAJOR < 50 ? {affectsInputRegion: false} : {};

// ---------- menus: PopupMenu.close() takes parameters since 51 ----------

export const MENU_NO_ANIMATION = MAJOR < 51 ? false : {animate: false};

// ---------- shaders: Shell.GLSLEffect gave way to Clutter.ShaderEffect in 51 ----------

// Subclasses have a static SNIPPET = {declarations, code} and set uniforms by name.
export const ShaderEffect = MAJOR < 51
    ? GObject.registerClass(
        class JoaoGlslEffect extends Shell.GLSLEffect {
            vfunc_build_pipeline() {
                const {declarations, code} = this.constructor.SNIPPET;
                this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, declarations, code, false);
            }

            setUniform(name, size, values) {
                this.set_uniform_float(this.get_uniform_location(name), size, values);
            }
        })
    : GObject.registerClass(
        class JoaoShaderEffect extends Clutter.ShaderEffect {
            vfunc_get_static_snippet() {
                const {declarations, code} = this.constructor.SNIPPET;
                return Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, declarations, code);
            }

            setUniform(name, size, values) {
                this.set_uniform_float(name, size, values);
            }
        });
