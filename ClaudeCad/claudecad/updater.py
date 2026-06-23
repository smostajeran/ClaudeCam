"""Self-update: pull the latest ClaudeCad/ from GitHub and install it over the add-in.

Uses only the standard library and the GitHub REST API, so it works for both public
repositories and private ones (the latter needs a token — see ``config.get_github_token``).
Downloads the repository zipball for the configured branch, finds the ``ClaudeCad/``
add-in folder inside it, and copies those files over the installed add-in directory. The
user then restarts the add-in (Stop, then Run) to load the new code.
"""

import io
import os
import shutil
import urllib.error
import urllib.request
import zipfile

from . import config

_CONTENTS_URL = "https://api.github.com/repos/{repo}/contents/ClaudeCad/VERSION?ref={branch}"
_ZIPBALL_URL = "https://api.github.com/repos/{repo}/zipball/{branch}"


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


def update(timeout=120):
    """Check for and install the latest version.

    Returns ``(message, updated, version)``. Raises ``RuntimeError`` on failure.
    """
    local = config.get_version()
    latest = remote_version()

    if latest == local:
        return ("You're already on the latest version ({}).".format(local), False, local)

    url = _ZIPBALL_URL.format(repo=config.REPO, branch=config.UPDATE_BRANCH)
    blob = _get(url, "application/vnd.github+json", timeout)

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
