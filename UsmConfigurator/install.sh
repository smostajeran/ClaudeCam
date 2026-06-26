#!/usr/bin/env bash
# Install the USM Configurator into Fusion 360's AddIns folder.
# No dependencies to install. For the richest material assignment, install the
# sibling ClaudeCad add-in too — the builder finds and reuses its CAD engine.
# Usage:  bash install.sh   (run from inside the UsmConfigurator folder)
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

case "$(uname -s)" in
    Darwin)
        DEST="$HOME/Library/Application Support/Autodesk/Autodesk Fusion 360/API/AddIns/UsmConfigurator"
        ;;
    *)
        echo "This script supports macOS. On Windows, run install.ps1 in PowerShell instead." >&2
        exit 1
        ;;
esac

echo "Source:      $SRC"
echo "Destination: $DEST"

if [ "$SRC" != "$DEST" ]; then
    mkdir -p "$DEST"
    (cd "$SRC" && find . \
        -path ./.git -prune -o \
        -name __pycache__ -prune -o \
        -type f -print) | while read -r f; do
        mkdir -p "$DEST/$(dirname "$f")"
        cp "$SRC/$f" "$DEST/$f"
    done
fi

echo
echo "Done — no dependencies to install. In Fusion: Utilities > Add-Ins > Scripts and Add-Ins > select 'UsmConfigurator' > Run."
echo "Then click 'USM Configurator' in the Add-Ins panel to open the dialog."
