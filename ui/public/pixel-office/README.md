# Pixel office runtime assets

These published PNGs and `manifest.json` are sufficient to run the office from a
normal repository clone. The UI loads the manifest at `/pixel-office/manifest.json`;
sprite URLs include a SHA256 prefix for cache invalidation.

The manifest records reviewed animation frames, anchors, mirroring and procedural
rig metadata. Single key poses use procedural motion where a complete approved
animation is unavailable. The runtime package contains the PNGs referenced by the
current manifest; earlier source versions remain in the local asset library.

`scripts/sync-pixel-office-assets.py` republishes assets from the project-local
`project-library/resources/pixel-office/` source and approval records. That local
library is intentionally ignored by Git and is needed only when republishing art,
not for installing dependencies, building the UI or running the office. The script
requires Python and Pillow, checks source hashes, and preserves the source PNGs.
