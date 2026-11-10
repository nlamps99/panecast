# cmux DR2 downloads

Public page: https://ningzx.cn/panecast/cmux/

The native app is built from the separate `cmux-dr2-stable` checkout at
upstream stable tag `v0.65.2.2`, with the self-hosted profile and password
login changes. It uses an independent bundle ID and does not update the
user's official cmux installation. Only Apple Silicon is published here.

1. Run the native repository's scoped static/localization checks, focused
   profile/account/auth tests, and tagged Release build. Commit reviewed
   changes locally. Do not push custom changes to the upstream remote.
2. Archive committed source and its native source submodules with
   `python3 distribution/cmux/source.py --repo PATH --output SOURCE.tar.gz`.
3. On the build Mac, run `package.py --app TAGGED_APP --repo SOURCE_REPO
   --source SOURCE.tar.gz --source-commit SHA --output EMPTY_DIRECTORY`.
   The script uses upstream thin/strip/sign helpers, ad-hoc signing, and
   generates versioned artifacts, installer, metadata, and the static site.
4. Mount the DMG read-only, verify the packaged app, and test the installer
   in an isolated directory. The installer verifies the pinned archive
   SHA-256, bundle identity, version, and signature before clearing quarantine.
5. Commit and push this website's changes to its existing branch. Publish:

```sh
python3 distribution/cmux/publish.py --public build/cmux/public \
  --previous-index-sha256 SHA_OF_REVIEWED_LIVE_INDEX
```

The configured `note` host serves the existing Panecast webroot. Publication
touches only its `cmux/` child and the reviewed root index; other platform
downloads and release metadata are preserved. A changed live index or an
attempt to replace a versioned artifact stops the publication. Remote
staging retains the old mutable files for recovery.

After publishing, download the actual HTTPS artifacts and compare every
size and SHA-256 with `release.json`. Check both download pages, the alias
installer, and dr2 health. Keep credentials and server secrets outside all
public directories and source archives. No browser interaction is required
for these HTTP and artifact checks.
