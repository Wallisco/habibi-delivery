/**
 * On staging, every back-office page says so: a red bar across the top that
 * stays put while scrolling, and "[STAGING]" in the browser tab. Staff working
 * in two tabs must never cancel a real order thinking it was a test one.
 */
const BANNER = '<div role="status" aria-label="Staging environment" style="position:fixed;top:0;left:0;right:0;'
  + 'z-index:2147483647;background:#C0442F;color:#fff;text-align:center;padding:9px 12px;'
  + "font:800 14px/1.2 -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;letter-spacing:.6px\">"
  + 'STAGING · test data</div>';
const ROOM = '<style>body{padding-top:44px !important}</style>';

/** The page as staging serves it. Unchanged unless `staging`. */
export function markStaging(html, staging) {
  if (!staging) return html;
  return html
    .replace('<title>', '<title>[STAGING] ')
    .replace('</head>', `${ROOM}</head>`)
    .replace(/<body([^>]*)>/, (tag) => `${tag}${BANNER}`);
}
