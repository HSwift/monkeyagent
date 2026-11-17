# Release

## MonkeyAgent (this fork)

MonkeyAgent releases use their own tag namespace, `ma-v<version>`, so they never
collide with upstream Violentmonkey `v*` tags that arrive via upstream merges.

```bash
$ git checkout master
$ git tag -a ma-v0.2.0 -m "MonkeyAgent 0.2.0"   # ma-v0.2.0-beta => prerelease
$ git push origin ma-v0.2.0
```

`.github/workflows/release-crx.yml` then runs CI, builds the MV3 extension,
signs `MonkeyAgent-v<version>.crx` with the `CRX_PRIVATE_KEY` secret, and
publishes it (plus a `.zip` and `SHA256SUMS.txt`) as a GitHub Release.
The numeric part of the tag becomes the extension's manifest version.

## Upstream Violentmonkey

The upstream store-publishing workflow (`release.yml`) is manual-only in this fork.

Upstream flow (for reference): create a tag and push, GitHub Actions will build the assets and upload them to different stores.

### Prerelease

```bash
$ git checkout master
$ pnpm bump
$ git push origin master --follow-tags
```

### Release

Merge everything that is ready to release to the `release` branch and bump version.

```bash
$ git checkout release
$ git merge master # or git merge v2.13.2
$ pnpm version minor
$ git push origin release --follow-tags
```

Finally merge `release` back to `master`.

```bash
$ git checkout master
$ git merge release
```
