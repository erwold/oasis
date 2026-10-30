/** The session share's viewer as the app carries it, for the file it builds: the script and the stylesheet
 *  `npm run build:share` (vite.share.config.ts) wrote to share-viewer-dist/, as text. Imported lazily by the share
 *  dialog only (src/components/shareExport.ts): the app's own pages never load it. */

import js from '../../share-viewer-dist/share-viewer.js?raw'
import css from '../../share-viewer-dist/share-viewer.css?raw'
import type { ViewerBundle } from '../state/shareHtml'

export const VIEWER_BUNDLE: ViewerBundle = { js, css }
