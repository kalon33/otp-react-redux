#!/usr/bin/env node

/**
 * Postinstall script to apply patches and directly patch compiled files.
 * 
 * Strategy:
 * 1. Apply patches with patch-package (modifies source TypeScript files)
 * 2. For @opentripplanner/trip-details: Directly patch the ESM and lib JavaScript files
 * 3. For @opentripplanner/trip-form: Directly patch the compiled files
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const projectRoot = process.cwd();
const nodeModulesPath = path.join(projectRoot, "node_modules");

console.log("Postinstall patch-compile script starting...");
console.log(`Project root: ${projectRoot}`);

// Step 1: Apply all patches with patch-package.
// This patches the TypeScript SOURCE files. It must not block the compiled-file
// patching below, because the compiled JS is what Vite actually bundles; if
// patch-package fails (e.g. node_modules left in a half-patched state) the
// compiled-file fixes still need to run so the app builds and renders without
// errors (unclosed ternary, missing tbody, invalid DOM nesting, etc.).
console.log("\n1. Applying patches with patch-package...");
// patch-package cannot re-apply a patch on top of a node_modules left in a
// half-patched state by a previous run (e.g. an older version of this same
// patch was applied, so the context lines the current patch expects are gone).
// When that happens patch-package fails with "Failed to apply patch". Detect
// the stale source state up front for the packages we patch, reinstall them
// pristine, then apply all patches on a clean base.
resetStalePatchedPackages();
try {
  const patchOutput = execSync("patch-package", { cwd: projectRoot, encoding: "utf-8", stdio: ["pipe", "pipe", "inherit"], env: { PATH: process.env.PATH + ':' + path.join(nodeModulesPath, '.bin') } });
  console.log(patchOutput);
  console.log("✓ Patches applied successfully");
} catch (error) {
  console.error("\n⚠ patch-package reported an error (see above). Source patches may be partially applied;");
  console.error("   Attempting one recovery reinstall + retry...");
  try {
    resetPackage("@opentripplanner/trip-details");
    resetPackage("@opentripplanner/trip-form");
    resetPackage("@opentripplanner/transitive-overlay");
    const patchOutput2 = execSync("patch-package", { cwd: projectRoot, encoding: "utf-8", stdio: ["pipe", "pipe", "inherit"], env: { PATH: process.env.PATH + ':' + path.join(nodeModulesPath, '.bin') } });
    console.log(patchOutput2);
    console.log("✓ Patches applied successfully after recovery");
  } catch (error2) {
    console.error("\n⚠ patch-package still failing after recovery. Source patches may be partially applied;");
    console.error("   continuing with compiled-file patching. To fix the source patches, remove node_modules and reinstall.");
  }
}

// Step 2: Patch @opentripplanner/trip-details compiled files
console.log("\n2. Patching @opentripplanner/trip-details compiled files...");
try {
  patchTripDetailsCompiled();
} catch (error) {
  console.error("\n✗ Failed to patch @opentripplanner/trip-details compiled files:", error.message);
  console.error(error.stack);
}

// Step 3: Patch @opentripplanner/trip-form compiled files  
console.log("\n3. Patching @opentripplanner/trip-form compiled files...");
try {
  patchTripFormCompiled();
} catch (error) {
  console.error("\n✗ Failed to patch @opentripplanner/trip-form compiled files:", error.message);
  console.error(error.stack);
}

// Clear Vite's dependency optimization cache so the dev server re-bundles the
// (now patched) compiled files instead of serving a stale pre-bundled copy.
// Without this, Vite can keep serving the unpatched trip-details from
// node_modules/.vite after the files were fixed, reproducing runtime warnings.
clearViteDepCache();

console.log("\n✓ Postinstall patch-compile completed!");
console.log("All patched packages have been updated in both source and compiled files.");

/**
 * Patch compiled files for @opentripplanner/trip-details
 */
function patchTripDetailsCompiled() {
  const packageName = "@opentripplanner/trip-details";
  const packagePath = path.join(nodeModulesPath, packageName);
  
  if (!fs.existsSync(packagePath)) {
    console.log("  ⚠ @opentripplanner/trip-details not found, skipping");
    return;
  }

  const esmFile = path.join(packagePath, "esm/components/fares-v2-table.js");
  const libFile = path.join(packagePath, "lib/components/fares-v2-table.js");

  // If the compiled files were left in a partially-patched state by a previous
  // run (e.g. the title ternary opened with "?" but closed with ": undefined"
  // or left unclosed), the regexes below won't match cleanly and the build
  // breaks. Detect that state and reinstall the package fresh so we start
  // from a pristine copy, then apply the transforms deterministically.
  if (needsPackageReset(esmFile, libFile)) {
    console.log("  ↻ Compiled trip-details files are in a stale/partial state; reinstalling pristine package...");
    resetPackage(packageName);
  }

  // Patch ESM file
  if (fs.existsSync(esmFile)) {
    let content = fs.readFileSync(esmFile, "utf-8");
    
    // 1. Add Fragment import
    if (!content.includes('import React, { Fragment }')) {
      content = content.replace(
        'import React from "react";',
        'import React, { Fragment } from "react";'
      );
    }
    
    // 2. Fix title attribute - change from && to ternary (part 1)
    content = content.replace(
      /title: !Number\.isNaN\(originalAmount\) && originalAmount > 0 && index > 0 && intl\.formatMessage\(/g,
      'title: !Number.isNaN(originalAmount) && originalAmount > 0 && index > 0 ? intl.formatMessage('
    );
    
    // 3. Close the title ternary opened in step 2. The compiled output ends the
    //    intl.formatMessage(...) call with a "        })\n      }," sequence before
    //    the TransferIcon child; insert " : null" right after that call so the
    //    ternary (title: COND ? intl.formatMessage(...) : null) is well-formed.
    //    Without this, esbuild fails with "Expected ":" but found "}"".
    content = content.replace(
      /(\n        \})\)\n      \}, (!Number\.isNaN\(originalAmount\) && originalAmount > 0 && index > 0 && )\/\*#__PURE__\*\/React\.createElement\(TransferIcon/g,
      '$1) : null\n      }, $2/*#__PURE__*/React.createElement(TransferIcon'
    );
    
    // 4. Fix the second title attribute (missingFareTotal). The original
    //    source uses `fare?.amount === undefined && intl.formatMessage(...)`, so
    //    when fare.amount IS defined the && short-circuits to `false` and React
    //    warns `Received false for a non-boolean attribute title`. Convert it to
    //    a ternary that yields null when the condition is false. The inner
    //    `id: "otpUi.TripDetails.missingFareTotal"` makes this match unambiguous.
    content = patchMissingFareTitle(content, "React.createElement");

    // 5. Fix var declarations to avoid esbuild errors
    content = content.replace(/var nextRowIndex = currentRowIndex \+ 1;/g, 'const nextRowIndex = currentRowIndex + 1;');
    content = content.replace(/var currentRowIndex = 0;/g, 'let currentRowIndex = 0;');
    
    // 6. Add tbody and cell keys
    const oldPattern = /rows\.map\(function \(r, index\) \{\s*return \/\*#__PURE__\*\/React\.createElement\("tr", \{\s*key: index\s*\}, r\);\s*\}\)/g;
    const newPattern = buildTableReplacement();
    
    content = content.replace(oldPattern, newPattern);
    
    fs.writeFileSync(esmFile, content, "utf-8");
    console.log("  ✓ ESM file patched");
  } else {
    console.log("  ⚠ ESM file not found");
  }

  // Patch lib file
  if (fs.existsSync(libFile)) {
    let content = fs.readFileSync(libFile, "utf-8");
    
    // 1. Fix title attribute - change from && to ternary (part 1)
    content = content.replace(
      /title: !Number\.isNaN\(originalAmount\) && originalAmount > 0 && index > 0 && intl\.formatMessage\(/g,
      'title: !Number.isNaN(originalAmount) && originalAmount > 0 && index > 0 ? intl.formatMessage('
    );
    
    // 2. Close the title ternary opened in step 1. Insert " : null" right after
    //    the intl.formatMessage(...) call so the ternary is well-formed.
    //    Without this, the build fails with "Expected ":" but found "}"".
    content = content.replace(
      /(\n        \})\)\n      \}, (!Number\.isNaN\(originalAmount\) && originalAmount > 0 && index > 0 && )\/\*#__PURE__\*\/_react\.default\.createElement\(TransferIcon/g,
      '$1) : null\n      }, $2/*#__PURE__*/_react.default.createElement(TransferIcon'
    );
    
    // 3. Fix the second title attribute (missingFareTotal) in the lib file.
    //    Same transformation as the ESM file: `&&` ternary that yields null.
    content = patchMissingFareTitle(content, "_react.default.createElement");

    // 4. Fix var declarations to avoid esbuild errors
    content = content.replace(/var nextRowIndex = currentRowIndex \+ 1;/g, 'const nextRowIndex = currentRowIndex + 1;');
    content = content.replace(/var currentRowIndex = 0;/g, 'let currentRowIndex = 0;');
    
    // 5. Fix table rows and wrap with tbody - the lib file uses arrow function syntax with escaped quotes
    // Pattern: rows.map((r, index) => /*#__PURE__*/_react.default.createElement("tr", {    key: index  }, r))
    // We need to match the escaped quotes \"tr\" and wrap the whole thing in tbody
    content = content.replace(
      /rows\.map\(\(r, index\) => \/\*#__PURE__\*\/_react\.default\.createElement\("tr", \{\s*key: index\s*\}, r\)\)/g,
      '/*#__PURE__*/_react.default.createElement("tbody", null, rows.map((r, rowIndex) => /*#__PURE__*/_react.default.createElement("tr", {key: "row-".concat(rowIndex)}, r.map((cell, cellIndex) => /*#__PURE__*/_react.default.createElement(_react.default.Fragment, {key: "cell-".concat(rowIndex, "-").concat(cellIndex)}, cell))))'
    );
    
    fs.writeFileSync(libFile, content, "utf-8");
    console.log("  ✓ lib file patched");
  } else {
    console.log("  ⚠ lib file not found");
  }
}

/**
 * Convert the `missingFareTotal` title attribute from a short-circuiting `&&`
 * expression to a ternary that yields `null` when the condition is false.
 * The original compiled form is:
 *   title: (fare === null || fare === void 0 ? void 0 : fare.amount) === undefined && intl.formatMessage({
 *       id: "otpUi.TripDetails.missingFareTotal"
 *     })
 * which evaluates to `false` (not null) when fare.amount is defined, triggering
 * the React warning `Received false for a non-boolean attribute title`.
 * `createElementFn` is "React.createElement" for ESM or "_react.default.createElement"
 * for lib; it is only used to keep the regex from matching the wrong file.
 */
function patchMissingFareTitle(content, createElementFn) {
  // Open the ternary: `=== undefined && intl.formatMessage({`  ->  `... ? intl.formatMessage({`
  // This exact fragment is unique to the missingFareTotal title (the first
  // title uses `index > 0 && intl.formatMessage(`), so a plain string replace is safe.
  const openNeedle = "=== undefined && intl.formatMessage({";
  if (content.indexOf(openNeedle) === -1) return content;
  content = content.split(openNeedle).join("=== undefined ? intl.formatMessage({");

  // Close the ternary: the formatMessage call ends with a `})` line followed by
  // `}, /*#__PURE__*/<createElementFn>("em", null, (fare...) !== undefined`.
  // Insert ` : null` right after that `})` so the ternary is well-formed.
  const closeNeedleTail = "}, /*#__PURE__*/" + createElementFn + "(\"em\", null, (fare === null || fare === void 0 ? void 0 : fare.amount) !== undefined";
  const closeIdx = content.indexOf(closeNeedleTail);
  if (closeIdx === -1) return content;
  // Walk back from closeIdx to the nearest preceding "          })" (the call end).
  const callEnd = "          })\n";
  const callEndIdx = content.lastIndexOf(callEnd, closeIdx);
  if (callEndIdx === -1) return content;
  const insertionPoint = callEndIdx + callEnd.length - 1; // after the ")"
  content = content.slice(0, insertionPoint) + " : null" + content.slice(insertionPoint);
  return content;
}

function buildTableReplacement() {
  return `/*#__PURE__*/React.createElement("tbody", null, rows.map(function (r, rowIndex) {return /*#__PURE__*/React.createElement("tr", {key: "row-".concat(rowIndex)}, r.map(function (cell, cellIndex) {return /*#__PURE__*/React.createElement(Fragment, {key: "cell-".concat(rowIndex, "-").concat(cellIndex)}, cell);}));}))`;
}



/**
 * Remove Vite's dependency optimization cache (node_modules/.vite) so the dev
 * server re-bundles dependencies from the freshly-patched files. Stale caches
 * can make Vite serve the old (unpatched) compiled output even after the
 * on-disk files were fixed.
 */
function clearViteDepCache() {
  const viteCache = path.join(nodeModulesPath, ".vite");
  if (fs.existsSync(viteCache)) {
    try {
      fs.rmSync(viteCache, { recursive: true, force: true });
      console.log("\n➜ Cleared Vite dependency cache (node_modules/.vite)");
    } catch (e) {
      console.error("\n⚠ Could not clear Vite cache:", e.message);
    }
  }
}

/**
 * Detect whether the compiled trip-details files are in a stale or
 * partially-patched state that the regex transforms cannot fix idempotently.
 * Returns true if the package should be reinstalled fresh before patching.
 */
function needsPackageReset(esmFile, libFile) {
  for (const file of [esmFile, libFile]) {
    if (!fs.existsSync(file)) continue;
    const content = fs.readFileSync(file, "utf-8");
    // A correctly patched file closes the title ternary with ") : null".
    // A stale/partial state has the ternary opened ("? intl.formatMessage")
    // but closed with ": undefined" or not closed at all (still "&& intl").
    const opened = content.includes("? intl.formatMessage(");
    const correctlyClosed = content.includes(") : null\n      },");
    if (opened && !correctlyClosed) return true;
  }
  return false;
}

/**
 * Detect whether the trip-details source (.tsx) or compiled files are in a
 * stale/partially-patched state left by a PREVIOUS run (e.g. an older version
 * of the patch was applied), and reinstall the affected packages pristine so
 * the current patch can apply cleanly. Without this, patch-package fails with
 * "Failed to apply patch" because the context lines it expects are gone.
 *
 * A source file is considered stale when it is NOT in the pristine state but
 * also NOT in the fully-current-patched state (i.e. it shows signs of an older
 * patch). We detect by looking for the missingFareTotal title: pristine source
 * uses the `&&` short-circuit, the current patch turns it into a ternary with
 * `: undefined`. A source missing BOTH markers, or showing the `&&` form but
 * also other (older) patched markers, is treated as stale and reset.
 */
function resetStalePatchedPackages() {
  const checks = [
    {
      name: "@opentripplanner/trip-details",
      file: path.join(nodeModulesPath, "@opentripplanner/trip-details", "src/components/fares-v2-table.tsx"),
      // Pristine source: "fare?.amount === undefined &&" then "intl.formatMessage({"
      // Current patch: "fare?.amount === undefined" then "? intl.formatMessage({"
      // Pristine (unpatched) source: the transferDiscount title still uses the
      // `&&` short-circuit before intl.formatMessage, i.e. "index > 0 &&" then
      // "intl.formatMessage(" on the same logical form (no `?` ternary).
      isPristine: (c) => !c.includes("index > 0\n                ? intl.formatMessage(") && !c.includes("fare?.amount === undefined\n                ? intl.formatMessage({"),
      // Fully current (this patch applied): both titles are ternaries.
      isCurrent: (c) => c.includes("index > 0\n                ? intl.formatMessage(") && c.includes("fare?.amount === undefined\n                ? intl.formatMessage({")
    },
    {
      name: "@opentripplanner/transitive-overlay",
      file: path.join(nodeModulesPath, "@opentripplanner/transitive-overlay", "src/index.tsx"),
      // Pristine source calls addImage directly after loadImage resolves, with
      // neither the duplicate-add guard nor the decode wait added by the patches.
      isPristine: (c) => c.includes("map.addImage(img.id, response.data, img.options);") && !c.includes("maybeDecode") && !c.includes("if (map.hasImage(img.id)) return;"),
      // Current patch waits for the image to decode before addImage.
      isCurrent: (c) => c.includes("maybeDecode")
    }
  ];
  for (const { name, file, isPristine, isCurrent } of checks) {
    if (!fs.existsSync(file)) continue;
    const content = fs.readFileSync(file, "utf-8");
    if (isCurrent(content)) continue;       // already at the current patched state
    if (isPristine(content)) continue;       // pristine, patch will apply cleanly
    // Anything else is a stale/half-patched state from an older patch run.
    console.log(`  ↻ ${name} source is in a stale/partial state; reinstalling pristine...`);
    resetPackage(name);
  }
}

/**
 * Remove and reinstall a package from the yarn/npm cache so the on-disk files
 * are pristine (unpatched). This is needed because yarn does not reset files
 * that were modified in node_modules by a previous postinstall run.
 */
function resetPackage(packageName) {
  const packagePath = path.join(nodeModulesPath, packageName);
  try {
    fs.rmSync(packagePath, { recursive: true, force: true });
  } catch (e) {
    console.error("    could not remove package dir:", e.message);
    return;
  }
  try {
    execSync("yarn install --force", { cwd: projectRoot, stdio: "inherit", env: process.env });
  } catch (e) {
    // Fallback for npm
    try {
      execSync("npm install", { cwd: projectRoot, stdio: "inherit", env: process.env });
    } catch (e2) {
      console.error("    could not reinstall package:", e2.message);
    }
  }
}

/**
 * Patch compiled files for @opentripplanner/trip-form
 */
function patchTripFormCompiled() {
  const packagePath = path.join(nodeModulesPath, "@opentripplanner/trip-form");
  
  if (!fs.existsSync(packagePath)) {
    console.log("  ⚠ @opentripplanner/trip-form not found, skipping");
    return;
  }

  // The ModeSelector3 is in ModeSelector files
  const filesToPatch = [
    path.join(packagePath, "esm/ModeSelector/index.js"),
    path.join(packagePath, "lib/ModeSelector/index.js"),
    path.join(packagePath, "esm/ModeButton/index.js"),
    path.join(packagePath, "lib/ModeButton/index.js")
  ];

  filesToPatch.forEach(file => {
    if (fs.existsSync(file)) {
      let content = fs.readFileSync(file, "utf-8");
      
      // Fix: Replace button.label with button.key
      const replacements = [
        { from: /key: button\.label/g, to: 'key: button.key' },
        { from: /key: label/g, to: 'key: button.key' },
        { from: /"key": button\.label/g, to: '"key": button.key' },
        { from: /'key': button\.label/g, to: "'key': button.key" }
      ];
      
      replacements.forEach(({ from, to }) => {
        content = content.replace(from, to);
      });
      
      fs.writeFileSync(file, content, "utf-8");
      console.log(`  ✓ ${path.basename(file)} patched`);
    }
  });
}
