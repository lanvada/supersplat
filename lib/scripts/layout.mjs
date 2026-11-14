import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Where things are, for the build configs and the scripts alike.
const LIB_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ROOT_DIR = path.dirname(LIB_DIR);
const DIST_DIR = path.join(LIB_DIR, 'dist');
const PAGE_DIST_DIR = path.join(LIB_DIR, 'page/dist');

// The UI's i18n object is the one UI module the kernel imports: as
// './ui/localization' from src and '../ui/localization' from src/tools. The
// library puts a stub in its place, in the bundle and in the type check.
const LOCALIZATION_IMPORT = /^\.\.?\/ui\/localization$/;
const LOCALIZATION_STUB = path.join(LIB_DIR, 'src/localization.ts');

// The consuming site provides exactly one copy of each of these.
const isExternal = (id) => id === 'playcanvas' || /^@playcanvas\/splat-transform(\/|$)/.test(id);

// repository-relative, forward-slashed: the form module ids take in reports and data files
const relative = (file) => path.relative(ROOT_DIR, file).split(path.sep).join('/');

export { DIST_DIR, LIB_DIR, LOCALIZATION_IMPORT, LOCALIZATION_STUB, PAGE_DIST_DIR, ROOT_DIR, isExternal, relative };
