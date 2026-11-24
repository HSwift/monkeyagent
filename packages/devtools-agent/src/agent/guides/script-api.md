# Script API

Call scripts directly in the REPL, without a __hosts__ wrapper.

| Call | Result / behavior |
| --- | --- |
| scripts.list() | ARRAY of {id, name, enabled}. |
| scripts.import(id, path) | Imports and binds to a NEW /workspace/ path. Returns {path, revision, size, updatedAt}; read the source afterwards. Never implicitly overwrites a file. |
| scripts.apply(path) | Installs current source, returns {id, name, enabled, revision, version}. version is the declared @version read from the saved snapshot's metadata, or null if absent. Checks for external changes; rejects conflicting new namespace/name. |
| scripts.status(path) | {state:'uninstalled', path, workspaceRevision, version:null, verification:null}, or {state:'installed' \| 'modified', path, scriptId, scriptRevision, fileRevision, workspaceRevision, currentScriptRevision, version, enabled, externalChanged, verification}. No source is echoed. |
| scripts.setEnabled(path, enabled) | Returns {enabled}; invalidates previous verification. |

Script saves in Monkey retain the latest 20 changed code versions per script ID, including Agent installation and manual saves in Monkey's editor. Unchanged saves and enable/disable operations do not create versions. Ordinary workspace writes are current drafts, with revision guards rather than file history. The Changes UI compares an installed script's saved versions with its working draft. Restore to editor only loads a draft; explicit installation applies it, with external-change checks still active.

Installation never refreshes the page. Reload explicitly to exercise @match/@grant/@run-at/GM injection. `browser.verify(path, booleanExpression)` returns {passed, detail, at}; inspect `.passed`. It records the latest check for the installed revision: combine relevant invariants in the final check, rather than treating a later pass as proof an earlier failure was fixed.

`workspaceRevision` is the current workspace file revision; `fileRevision` identifies the workspace revision last installed. `scriptRevision` is the recorded installation revision; `currentScriptRevision` is read from Monkey now. `version` is read from the current installed snapshot, never the source's intended next version. A status of installed means the workspace revision matches its recorded installed revision: inspect externalChanged and enabled separately. Declared @version is metadata, not proof the current document executed that version.

`verification` is always explicit: null when unavailable, otherwise {passed, detail, at}. It is NOT `.verified`. Workspace modifications, external revision changes and disabled scripts make the returned verification null. This is only the latest stored assertion, not an aggregate test suite; it does not track the current document's navigation. A prior pass does not verify a new page or prove every earlier failure resolved. Saved operation records retain earlier results.

The caller supplies the verification expression and determines whether it covers the task. Check the actual requested behavior and preserved page behavior; the harness does not infer them from an arbitrary boolean. Unknown/interrupted operation outcomes require inspecting state before replaying mutations.
