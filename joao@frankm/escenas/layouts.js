// SPDX-FileCopyrightText: 2026 Frank Molina
// SPDX-License-Identifier: GPL-2.0-or-later
// Where each window of a saved scene goes. The thumbnails and the restorer both use this,
// so what the card draws is what you get. No GNOME imports: plain geometry.
export const LAYOUTS = [
    {id: 'free', label: 'Tal cual', summary: 'tal como está'},
    {id: 'auto', label: 'Automático', summary: 'automático'},
    {id: 'main-side', label: 'Principal', summary: 'principal + lateral'},
    {id: 'side-by-side', label: 'Lado a lado', summary: 'lado a lado'},
    {id: 'grid', label: 'Cuadrícula', summary: 'cuadrícula'},
];

export const GAP = 16;
const MAIN_SHARE = 0.62;

export const layoutSummary = id => (LAYOUTS.find(l => l.id === id) ?? LAYOUTS[0]).summary;

// One rectangle per window, same order as @windows (already sorted by 'order').
// @area: {x, y, width, height}. @gap: both the margins and the room between windows.
export function layoutRects(layout, windows, area, gap = GAP) {
    const n = windows.length;
    if (!n)
        return [];
    const left = area.x + gap;
    const top = area.y + gap;
    const innerW = area.width - 2 * gap;
    const innerH = area.height - 2 * gap;
    const box = (x, y, width, height) => ({
        x: Math.round(x), y: Math.round(y),
        width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)),
    });

    if (layout === 'auto' && n === 3) {
        const colW = (innerW - gap) / 2;
        const rowH = (innerH - gap) / 2;
        return [
            box(left, top, colW, innerH),
            box(left + colW + gap, top, colW, rowH),
            box(left + colW + gap, top + rowH + gap, colW, rowH),
        ];
    }
    // All the same size: as many columns as it takes to stay near square. A last row that is
    // not full has its last window stretch to the end of the row.
    if (layout === 'auto') {
        const cols = Math.ceil(Math.sqrt(n));
        const rows = Math.ceil(n / cols);
        const colW = (innerW - gap * (cols - 1)) / cols;
        const rowH = (innerH - gap * (rows - 1)) / rows;
        return windows.map((w, i) => {
            const col = i % cols;
            const span = i === n - 1 ? cols - col : 1;
            return box(left + col * (colW + gap), top + Math.floor(i / cols) * (rowH + gap),
                span * colW + (span - 1) * gap, rowH);
        });
    }
    if (layout === 'main-side' && n > 1) {
        const mainW = (innerW - gap) * MAIN_SHARE;
        const sideW = innerW - gap - mainW;
        const sideH = (innerH - gap * (n - 2)) / (n - 1);
        return windows.map((w, i) => (i === 0
            ? box(left, top, mainW, innerH)
            : box(left + mainW + gap, top + (i - 1) * (sideH + gap), sideW, sideH)));
    }
    if (layout === 'side-by-side') {
        const colW = (innerW - gap * (n - 1)) / n;
        return windows.map((w, i) => box(left + i * (colW + gap), top, colW, innerH));
    }
    if (layout === 'grid') {
        const rows = Math.ceil(n / 2);
        const colW = (innerW - gap) / 2;
        const rowH = (innerH - gap * (rows - 1)) / rows;
        return windows.map((w, i) => {
            const y = top + Math.floor(i / 2) * (rowH + gap);
            return i === n - 1 && n % 2
                ? box(left, y, innerW, rowH)
                : box(left + (i % 2) * (colW + gap), y, colW, rowH);
        });
    }
    if (layout === 'free') {
        return windows.map(w => (w.maximized
            ? box(area.x, area.y, area.width, area.height)
            : box(area.x + w.rect.x * area.width, area.y + w.rect.y * area.height,
                w.rect.w * area.width, w.rect.h * area.height)));
    }
    return [box(left, top, innerW, innerH)];
}

// The same windows ready for @layout: in a computed layout the biggest one becomes the
// first (the main one) and nothing stays maximized. 'free' keeps the stacking order.
export function arrangeFor(layout, windows) {
    const sorted = [...windows].sort((a, b) => a.order - b.order);
    if (layout !== 'free')
        sorted.sort((a, b) => b.rect.w * b.rect.h - a.rect.w * a.rect.h);
    return sorted.map((w, order) => ({...w, order, maximized: layout === 'free' && w.maximized}));
}
