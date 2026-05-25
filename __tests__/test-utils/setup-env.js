/**
 * This file performs some actions to setup the browser environment used in each
 * jest test.
 */

window.localStorage = {
  getItem: () => null
}

// jsdom does not implement these object-URL helpers. Some modules reference
// them at import time (e.g. map/blob utilities pulled in transitively by the
// action/selector chain), so polyfill them to allow those modules to load.
if (!window.URL.createObjectURL) {
  window.URL.createObjectURL = () => ''
  window.URL.revokeObjectURL = () => undefined
}
