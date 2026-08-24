/**
 * One filename rule, applied identically on Windows, macOS and Linux.
 *
 * WHY THIS IS SHARED, AND WHY IT IS STRICT EVERYWHERE.
 *
 * These reports are fetched on three machines running three operating systems,
 * and they have to produce the same files. The old download route got that for
 * free — Chrome sanitised names itself. Writing through a FileSystemDirectory-
 * Handle does not: `getFileHandle()` takes the name as given, and fails on
 * whatever the platform happens to reject.
 *
 * So the rule below is the STRICTEST of the three, applied on all three. A
 * name that is legal on Linux but not on Windows would otherwise produce a
 * file on one machine and an error on another — which is exactly the
 * inconsistency this exists to prevent. Being needlessly strict on Linux costs
 * nothing; being lenient there costs the guarantee.
 *
 * It is deliberately idempotent: the name passes through the content script
 * and again at the disk boundary, and a rule that changed its answer on the
 * second pass would rename the file.
 *
 * Loaded three ways, because three contexts need it and none of them share a
 * module system: `importScripts` in the worker, a `<script>` in the offscreen
 * document, and a content_scripts entry ahead of content.js. Keep it a plain
 * script attaching to `self` — the same shape as lib/diagnostics.js.
 *
 * tools/test-safe-name.js covers every rule here, including that all three
 * consumers really load it.
 */
(function attach(scope) {
  'use strict';

  /** Reserved on Windows even with an extension. Ordinary names elsewhere. */
  const WINDOWS_DEVICE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

  /**
   * Short enough to survive the deepest folder someone might pick.
   *
   * Linux and macOS cap one name at 255 bytes. Windows caps the WHOLE path at
   * 260 by default, and a directory handle never tells us how deep it sits, so
   * the name is the only part we can bound. Shopee's longest real name is
   * around 50 characters, so this never fires in practice — it is here so that
   * if it ever does, it fires the same way on every machine.
   */
  const MAX_LENGTH = 120;

  function stripControlChars(value) {
    let out = '';
    for (const ch of value) {
      const code = ch.charCodeAt(0);
      if (code >= 32 && code !== 127) out += ch;
    }
    return out;
  }

  function safeFileName(name, fallback) {
    let out = stripControlChars(String(name == null ? '' : name))
      // Take the last segment. A forward slash throws in getFileHandle() on
      // every OS; a backslash is a separator on Windows and a legal character
      // on Linux, which is the difference that must not exist.
      .split(/[\\/]/)
      .pop()
      // Illegal on Windows. '+' and spaces are kept on purpose — Shopee's own
      // names are full of them and must not change.
      .replace(/[<>:"|?*]/g, '')
      // A leading dot hides the file on macOS and Linux and does nothing on
      // Windows: same bytes, invisible on two machines out of three.
      .replace(/^\.+/, '')
      // Windows drops trailing dots and spaces silently, so drop them
      // everywhere rather than let one machine keep them.
      .replace(/[. ]+$/, '')
      .trim();

    if (!out) return fallback || 'shopee-report';

    const dot = out.lastIndexOf('.');
    // A leading dot was already stripped, so `dot > 0` means a real extension.
    const stem = dot > 0 ? out.slice(0, dot) : out;
    const ext = dot > 0 ? out.slice(dot) : '';

    if (WINDOWS_DEVICE.test(stem)) return `_${out}`;

    if (out.length > MAX_LENGTH) {
      // Keep the extension: it decides which application opens the file, and a
      // truncated one is worse than a truncated name.
      const room = Math.max(1, MAX_LENGTH - ext.length);
      return stem.slice(0, room).replace(/[. ]+$/, '') + ext;
    }

    return out;
  }

  scope.SRD_safeFileName = safeFileName;
})(typeof self !== 'undefined' ? self : this);
