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

// Polyfill TextDecoder for jsdom environment
if (typeof TextDecoder === 'undefined') {
  // Use the util module from Node.js to provide TextDecoder
  const { TextDecoder: NodeTextDecoder, TextEncoder: NodeTextEncoder } = require('util')
  global.TextDecoder = NodeTextDecoder
  global.TextEncoder = NodeTextEncoder
}
