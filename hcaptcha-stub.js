// Stub so the hCaptcha library (loaded async, right after this file) always
// has an onload callback to call, even if it finishes loading before
// script.js (deferred, at the end of <body>) has run and defined the real
// one. script.js checks window.__hcaptchaApiReady on startup to catch that
// early call. Kept as its own same-origin file (rather than an inline
// <script> in index.html) so it satisfies the page's CSP without needing
// 'unsafe-inline' or a content hash.
window.onHcaptchaReady = function(){ window.__hcaptchaApiReady = true; };
