// Stands in for src/ui/localization in the library build. The kernel modules
// that import it only translate strings for popups, and the library never
// shows one, so a key is its own text and no i18n runtime is bundled. The
// build type-checks the kernel against this object: a kernel module that
// starts using another member of the real one fails there, not at run time.
const i18n = {
    t: (key: string) => key
};

export { i18n };
