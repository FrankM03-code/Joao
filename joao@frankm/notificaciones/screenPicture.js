// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// A still picture of the whole screen, for the glass of the island and of the bubble's list. Why a
// picture and not a live copy or Shell.BlurMode.BACKGROUND: see island.js.
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';

export async function screenPicture() {
    const shooter = new Shell.Screenshot();
    const [content] = await new Promise((resolve, reject) => {
        shooter.screenshot_stage_to_content((o, result) => {
            try {
                resolve(o.screenshot_stage_to_content_finish(result));
            } catch (e) {
                reject(e);
            }
        });
    });
    return new Clutter.Actor({content, width: global.stage.width, height: global.stage.height});
}
