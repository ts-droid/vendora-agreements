// Shared browser/server file limits. MB in the UI means 1024 * 1024 bytes.
(function(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.UploadLimits = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  var bytes = 50 * 1024 * 1024;
  return Object.freeze({
    MAX_FILE_BYTES: bytes,
    MAX_FILE_LABEL: '50 MB',
    MAX_REVIEW_BASE64_CHARS: Math.ceil(bytes / 3) * 4,
    // Base64 expands a binary file by a third. Keep room for the benchmark and JSON.
    MAX_REVIEW_BODY_BYTES: Math.ceil(bytes / 3) * 4 + 4 * 1024 * 1024,
    MAX_INLINE_PDF_BYTES: 20 * 1024 * 1024,
    MAX_UNCOMPRESSED_BYTES: 50 * 1024 * 1024
  });
});
