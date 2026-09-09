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

try {
  // Step 1: Apply all patches using patch-package
  console.log("\n1. Applying patches with patch-package...");
  const patchOutput = execSync("patch-package", { cwd: projectRoot, encoding: "utf-8", env: { PATH: process.env.PATH + ':' + path.join(nodeModulesPath, '.bin') } });
  console.log(patchOutput);
  console.log("✓ Patches applied successfully");

  // Step 2: Patch @opentripplanner/trip-details compiled files
  console.log("\n2. Patching @opentripplanner/trip-details compiled files...");
  patchTripDetailsCompiled();

  // Step 3: Patch @opentripplanner/trip-form compiled files  
  console.log("\n3. Patching @opentripplanner/trip-form compiled files...");
  patchTripFormCompiled();

  console.log("\n✓ Postinstall patch-compile completed!");
  console.log("All patched packages have been updated in both source and compiled files.");

} catch (error) {
  console.error("\n✗ Postinstall patch-compile failed:", error.message);
  console.error(error.stack);
  process.exit(1);
}

/**
 * Patch compiled files for @opentripplanner/trip-details
 */
function patchTripDetailsCompiled() {
  const packagePath = path.join(nodeModulesPath, "@opentripplanner/trip-details");
  
  if (!fs.existsSync(packagePath)) {
    console.log("  ⚠ @opentripplanner/trip-details not found, skipping");
    return;
  }

  const esmFile = path.join(packagePath, "esm/components/fares-v2-table.js");
  const libFile = path.join(packagePath, "lib/components/fares-v2-table.js");

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
    
    // 4. Fix var declarations to avoid esbuild errors
    content = content.replace(/var nextRowIndex = currentRowIndex \+ 1;/g, 'const nextRowIndex = currentRowIndex + 1;');
    content = content.replace(/var currentRowIndex = 0;/g, 'let currentRowIndex = 0;');
    
    // 6. Add tbody and cell keys
    const oldPattern = /rows\.map\(function \(r, index\) \{return \/\*#__PURE__\*\/React\.createElement\("tr", \{key: index\}, r\);\}\)/g;
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
    
    // 3. Fix var declarations to avoid esbuild errors
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

function buildTableReplacement() {
  return `rows.map(function (r, rowIndex) {return /*#__PURE__*/React.createElement("tr", {key: "row-".concat(rowIndex)}, r.map(function (cell, cellIndex) {return /*#__PURE__*/React.createElement(Fragment, {key: "cell-".concat(rowIndex, "-").concat(cellIndex)}, cell);}))}`;
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
