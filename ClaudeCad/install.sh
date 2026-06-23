#!/usr/bin/env bash
# Install ClaudeCad into Fusion 360's AddIns folder and vendor the anthropic SDK.
# Usage:  bash install.sh   (run from inside the ClaudeCad folder)
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

case "$(uname -s)" in
    Darwin)
        DEST="$HOME/Library/Application Support/Autodesk/Autodesk Fusion 360/API/AddIns/ClaudeCad"
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
    # Copy everything except VCS/build cruft. No third-party packages are needed —
    # ClaudeCad talks to the Claude API using Python's standard library only.
    (cd "$SRC" && find . \
        -path ./.git -prune -o \
        -name __pycache__ -prune -o \
        -type f -print) | while read -r f; do
        mkdir -p "$DEST/$(dirname "$f")"
        cp "$SRC/$f" "$DEST/$f"
    done
fi

echo
echo "Done. In Fusion: Utilities > Add-Ins > Scripts and Add-Ins > select 'ClaudeCad' > Run."
echo "Then click the gear icon in the panel and paste your Anthropic API key."
