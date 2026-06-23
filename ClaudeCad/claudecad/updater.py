"""Self-update: pull the latest ClaudeCad/ from GitHub and install it over the add-in.

Uses only the standard library. Downloads the repository zipball for the configured
branch, finds the ``ClaudeCad/`` add-in folder inside it, and copies those files over the
installed add-in directory. The user then restarts the add-in (Stop, then Run) to load
the new code — Python modules already imported this session stay in memory until reload.
"""

import io
import os
import shutil
import urllib.error
import urllib.request
import zipfile

from . import config

_RAW_VERSION_URL = "https://raw.githubusercontent.com/{repo}/{branch}/ClaudeCad/VERSION"
_ZIPBALL_URL = "https://api.github.com/repos/{repo}/zipball/{branch}"


def _headers():
    headers = {"User-Agent": "ClaudeCad-Updater"}
    token = config.get_github_token()
    if token:
        headers["Authorization"] = "Bearer " + token
    return headers


def remote_version(timeout=30):
    url = _RAW_VERSION_URL.format(repo=config.REPO, branch=config.UPDATE_BRANCH)
    request = urllib.request.Request(url, headers=_headers())
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read().decode("utf-8").strip()


def update(timeout=120):
    """Check for and install the latest version.

    Returns ``(message, updated, version)``. Raises on network/IO failure.
    """
    local = config.get_version()
    try:
        latest = remote_version()
    except Exception as exc:
        raise RuntimeError("Could not check the latest version: {}".format(exc))

    if latest == local:
        return ("You're already on the latest version ({}).".format(local), False, local)

    url = _ZIPBALL_URL.format(repo=config.REPO, branch=config.UPDATE_BRANCH)
    request = urllib.request.Request(url, headers=_headers())
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            blob = response.read()
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403, 404):
            raise RuntimeError(
                "Download failed (HTTP {}). If the repository is private, add a "
                "\"github_token\" to ~/.claudecad/config.json.".format(exc.code)
            )
        raise RuntimeError("Download failed (HTTP {}).".format(exc.code))

    archive = zipfile.ZipFile(io.BytesIO(blob))
    names = archive.namelist()

    # The zipball's top folder is named <owner>-<repo>-<sha>; locate the add-in inside it.
    marker = None
    needle = "/ClaudeCad/ClaudeCad.manifest"
    for name in names:
        if name.endswith(needle):
            marker = name[: -len("ClaudeCad.manifest")]  # ".../ClaudeCad/"
            break
    if not marker:
        raise RuntimeError("The update archive did not contain the ClaudeCad add-in.")

    dest = config.addin_dir()
    count = 0
    for name in names:
        if not name.startswith(marker) or name.endswith("/"):
            continue
        rel = name[len(marker):]
        if not rel:
            continue
        target = os.path.join(dest, *rel.split("/"))
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with archive.open(name) as src, open(target, "wb") as out:
            shutil.copyfileobj(src, out)
        count += 1

    return (
        "Updated {} → {} ({} files). Restart the add-in (Stop, then Run in "
        "Scripts and Add-Ins) to load it.".format(local, latest, count),
        True,
        latest,
    )
