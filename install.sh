#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Frank Molina
# SPDX-License-Identifier: GPL-2.0-or-later
# Installs João into the user's extensions folder.
# DEST=... installs it somewhere else (used by herramientas/probar.sh).
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
UUID="joao@frankm"
DEST="${DEST:-$HOME/.local/share/gnome-shell/extensions/$UUID}"
rm -rf "$DEST"
mkdir -p "$DEST"
cp -r "$UUID/." "$DEST/"
glib-compile-schemas "$DEST/schemas/"
echo "Instalada en: $DEST"
echo "Para activarla:  gnome-extensions enable $UUID"
