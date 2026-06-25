"""Self-update: pull the latest ClaudeCad/ from GitHub and install it over the add-in.

Uses only the standard library and the GitHub REST API, so it works for both public
repositories and private ones (the latter needs a token — see ``config.get_github_token``).

The install is done safely: download the branch zipball, extract the add-in into a
temporary STAGING folder, VALIDATE it is complete and the version matches, then copy it
over the install while BACKING UP each replaced file so a mid-copy failure rolls back to
the previous working add-in (no half-updated state). The user then restarts the add-in
(Stop, then Run) to load the new code.

Note: artifacts aren't cryptographically signed yet — that needs a release/signing
pipeline. This guards integrity by validating a complete archive and rolling back on
failure, not by signature verification.
"""

import io
import os
import shutil
import tempfile
import urllib.error
import urllib.request
import zipfile

from . import config

_CONTENTS_URL = "https://api.github.com/repos/{repo}/contents/ClaudeCad/VERSION?ref={branch}"
_ZIPBALL_URL = "https://api.github.com/repos/{repo}/zipball/{branch}"

# Files an extracted archive must contain to be considered a valid add-in.
_REQUIRED = ["ClaudeCad.py", "ClaudeCad.manifest", "VERSION", os.path.join("claudecad", "__init__.py")]


def _headers(accept):
    headers = {"User-Agent": "ClaudeCad-Updater", "Accept": accept}
    token = config.get_github_token()
    if token:
        headers["Authorization"] = "Bearer " + token
    return headers


def _get(url, accept, timeout):
    request = urllib.request.Request(url, headers=_headers(accept))
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.read()
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403, 404):
            raise RuntimeError(
                "GitHub returned HTTP {}. The repository '{}' is private or the token is "
                "missing/insufficient. Open Settings and paste a GitHub token with "
                "Contents:Read access (or make the repository public).".format(exc.code, config.REPO)
            )
        raise RuntimeError("GitHub returned HTTP {}.".format(exc.code))
    except urllib.error.URLError as exc:
        raise RuntimeError("Network error: {}.".format(exc.reason))


def remote_version(timeout=30):
    url = _CONTENTS_URL.format(repo=config.REPO, branch=config.UPDATE_BRANCH)
    return _get(url, "application/vnd.github.raw", timeout).decode("utf-8").strip()


def _extract_addin(archive, marker, staging):
    """Extract the add-in subtree (under ``marker``) into ``staging``; return relative paths.

    Zip-slip guarded: entries that would escape ``staging`` are skipped.
    """
    rels = []
    staging = os.path.normpath(staging)
    for name in archive.namelist():
        if not name.startswith(marker) or name.endswith("/"):
            continue
        rel = name[len(marker):]
        if not rel:
            continue
        target = os.path.normpath(os.path.join(staging, *rel.split("/")))
        if target != staging and not target.startswith(staging + os.sep):
            continue
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with archive.open(name) as src, open(target, "wb") as out:
            shutil.copyfileobj(src, out)
        rels.append(os.path.normpath(rel))
    return rels


def _validate_staged(staging, expected_version):
    """Raise unless the staged folder is a complete add-in whose VERSION matches expected."""
    for req in _REQUIRED:
        if not os.path.isfile(os.path.join(staging, req)):
            raise RuntimeError("The update archive is incomplete (missing {}); install aborted.".format(req))
    try:
        with open(os.path.join(staging, "VERSION"), "r", encoding="utf-8") as fh:
            version = fh.read().strip()
    except Exception as exc:
        raise RuntimeError("The update archive's VERSION is unreadable ({}); install aborted.".format(exc))
    if expected_version and version != expected_version:
        raise RuntimeError(
            "The update archive's VERSION '{}' doesn't match the expected '{}'; install aborted.".format(
                version, expected_version))
    return version


def _install_with_backup(staging, dest, rels):
    """Copy staged files over ``dest``, backing up each replaced file; roll back on failure.

    Returns the number of files installed. On any error, every file touched is restored to
    its previous content (or removed if it was newly created), so the add-in is never left
    half-updated.
    """
    dest = os.path.normpath(dest)
    backup = tempfile.mkdtemp(prefix="claudecad_backup_")
    attempted = []  # (rel, target) in order, so we can undo in reverse
    try:
        for rel in rels:
            target = os.path.normpath(os.path.join(dest, rel))
            if target != dest and not target.startswith(dest + os.sep):
                continue  # zip-slip guard against the real install dir
            if os.path.isfile(target):
                saved = os.path.join(backup, rel)
                os.makedirs(os.path.dirname(saved), exist_ok=True)
                shutil.copy2(target, saved)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            attempted.append((rel, target))
            shutil.copy2(os.path.join(staging, rel), target)
        return len(attempted)
    except Exception as exc:
        for rel, target in reversed(attempted):
            saved = os.path.join(backup, rel)
            try:
                if os.path.exists(saved):
                    shutil.copy2(saved, target)       # restore prior content
                elif os.path.exists(target):
                    os.remove(target)                  # it was newly created — remove it
            except Exception:
                pass
        raise RuntimeError("Install failed and was rolled back ({}). Your add-in is unchanged.".format(exc))
    finally:
        shutil.rmtree(backup, ignore_errors=True)


def update(timeout=120):
    """Check for and install the latest version.

    Returns ``(message, updated, version)``. Raises ``RuntimeError`` on failure (with the
    install left unchanged thanks to staging + rollback).
    """
    local = config.get_version()
    latest = remote_version()

    if latest == local:
        return ("You're already on the latest version ({}).".format(local), False, local)

    blob = _get(_ZIPBALL_URL.format(repo=config.REPO, branch=config.UPDATE_BRANCH),
                "application/vnd.github+json", timeout)
    archive = zipfile.ZipFile(io.BytesIO(blob))

    # The zipball's top folder is <owner>-<repo>-<sha>; locate the add-in inside it.
    marker = None
    needle = "/ClaudeCad/ClaudeCad.manifest"
    for name in archive.namelist():
        if name.endswith(needle):
            marker = name[: -len("ClaudeCad.manifest")]  # ".../ClaudeCad/"
            break
    if not marker:
        raise RuntimeError("The update archive did not contain the ClaudeCad add-in.")

    staging = tempfile.mkdtemp(prefix="claudecad_update_")
    try:
        rels = _extract_addin(archive, marker, staging)
        if not rels:
            raise RuntimeError("The update archive was empty; install aborted.")
        _validate_staged(staging, latest)
        count = _install_with_backup(staging, os.path.normpath(config.addin_dir()), rels)
    finally:
        shutil.rmtree(staging, ignore_errors=True)

    return (
        "Updated {} → {} ({} files, staged & verified). Restart the add-in (Stop, then Run "
        "in Scripts and Add-Ins) to load it.".format(local, latest, count),
        True,
        latest,
    )
