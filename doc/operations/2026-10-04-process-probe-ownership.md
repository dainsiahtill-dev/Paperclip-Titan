# Process probe ownership correction

The full workspace gate exposed two remote process-session probe failures:
replacement files and symbolic links could be removed instead of retained.
The wrapper closed its created file descriptor before comparing the path.
On the local filesystem an immediate unlink/create can reuse the inode and
its coarse change timestamp, so the replacement can falsely match the old
identity.

A controlled temporary filesystem reproduction ran400 cases:164 identity
matches occurred after closing the descriptor, and none while retaining it.
The wrapper now retains the descriptor through identity verification and
conditional cleanup, and closes it on both success and failed identity reads.
Cancellation, directory boundaries and the fail-closed policy stay intact.

The original peer replacement cases failed before the change. All34 wrapper
race tests then passed in22.03s with unchanged assertions and timeouts; server
typecheck passed. Independent review used the exact generated wrapper source
and real temporary files:14 checks passed for descriptor lifetime/one close,
replacement preservation, required skill fallback and unsafe component names.
No provider, protected default service or business file was changed.

The pre-existing gap between the final path identity read and removal remains:
Node does not provide an atomic conditional unlink here. This change prevents
inode reuse while the descriptor is held; it does not claim atomic removal.
