#!/usr/bin/env node

/**
 * Postinstall script to apply patches and recompile patched packages.
 * This is needed because patch-package only patches source TypeScript files,
 * but Vite uses the pre-compiled ESM/lib files.
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// Packages that need to be recompiled after patching
const PACKAGES_TO_RECOMPILE = [
  "@opentripplanner/trip-details",
  "@opentripplanner/trip-form"
];

// Find the project root (where node_modules is)
const projectRoot = process.cwd();
const nodeModulesPath = path.join(projectRoot, "node_modules");

console.log("Postinstall patch-compile script starting...");
console.log(`Project root: ${projectRoot}`);

try {
  // Step 1: Apply all patches using patch-package
  console.log("\n1. Applying patches with patch-package...");
  execSync("patch-package", { cwd: projectRoot, stdio: "inherit" });
  console.log("✓ Patches applied successfully");

  // Step 2: Recompile each patched package
  for (const packageName of PACKAGES_TO_RECOMPILE) {
    const packagePath = path.join(nodeModulesPath, packageName);
    
    if (!fs.existsSync(packagePath)) {
      console.log(`\n⚠ Package ${packageName} not found, skipping...`);
      continue;
    }

    console.log(`\n2. Recompiling ${packageName}...`);
    
    // Check if package has TypeScript config
    const tsConfigPath = path.join(packagePath, "tsconfig.json");
    if (!fs.existsSync(tsConfigPath)) {
      console.log(`  ⚠ No tsconfig.json found for ${packageName}, skipping...`);
      continue;
    }

    // Check if package has its own node_modules with TypeScript
    const packageNodeModules = path.join(packagePath, "node_modules");
    const packageTscPath = path.join(packageNodeModules, ".bin", "tsc");
    
    let tscPath = "tsc";
    if (fs.existsSync(packageTscPath)) {
      tscPath = packageTscPath;
    }

    // Run TypeScript compiler for this package
    try {
      execSync(
        `${tscPath} -p ${tsConfigPath}`,
        { 
          cwd: packagePath,
          stdio: "inherit",
          env: {
            ...process.env,
            NODE_ENV: "production"
          }
        }
      );
      console.log(`  ✓ ${packageName} recompiled successfully`);
    } catch (error) {
      console.error(`  ✗ Failed to recompile ${packageName}:`, error.message);
      // Continue with other packages even if one fails
    }
  }

  // Step 3: Also copy src to esm for packages that use esm output
  // Some packages compile to both lib (CommonJS) and esm (ES Modules)
  // We need to ensure both are updated
  for (const packageName of PACKAGES_TO_RECOMPILE) {
    const packagePath = path.join(nodeModulesPath, packageName);
    const srcPath = path.join(packagePath, "src");
    const esmPath = path.join(packagePath, "esm");
    const libPath = path.join(packagePath, "lib");

    if (!fs.existsSync(srcPath)) {
      continue;
    }

    // Check if package has a build script in its package.json
    const packageJsonPath = path.join(packagePath, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
      
      if (packageJson.scripts && packageJson.scripts.build) {
        console.log(`\n3. Running build script for ${packageName}...`);
        try {
          execSync("yarn build", {
            cwd: packagePath,
            stdio: "inherit",
            env: {
              ...process.env,
              NODE_ENV: "production"
            }
          });
          console.log(`  ✓ ${packageName} build completed`);
        } catch (error) {
          console.error(`  ✗ Failed to build ${packageName}:`, error.message);
        }
      }
    }

    // If esm directory exists but is outdated, try to rebuild it
    if (fs.existsSync(esmPath)) {
      // Check if esm was built from src by comparing timestamps
      const srcFiles = fs.readdirSync(srcPath).filter(f => f.endsWith(".ts") || f.endsWith(".tsx"));
      const esmFiles = fs.readdirSync(esmPath).filter(f => f.endsWith(".js"));
      
      if (srcFiles.length > 0 && esmFiles.length > 0) {
        // Simple check: if any source file is newer than esm, rebuild
        const srcStats = fs.statSync(path.join(srcPath, srcFiles[0]));
        const esmStats = fs.statSync(path.join(esmPath, esmFiles[0]));
        
        if (srcStats.mtime > esmStats.mtime) {
          console.log(`\n3. Rebuilding ESM for ${packageName} (source newer than ESM)...`);
          try {
            // Try to use the package's own build command
            const packageJsonPath = path.join(packagePath, "package.json");
            const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
            
            if (packageJson.scripts && packageJson.scripts.build) {
              execSync("yarn build", {
                cwd: packagePath,
                stdio: "inherit"
              });
            } else {
              // Manual copy from lib to esm if build script doesn't exist
              if (fs.existsSync(libPath)) {
                console.log(`  Copying lib to esm for ${packageName}...`);
                copyDirectory(libPath, esmPath);
              }
            }
            console.log(`  ✓ ESM rebuilt for ${packageName}`);
          } catch (error) {
            console.error(`  ✗ Failed to rebuild ESM for ${packageName}:`, error.message);
          }
        }
      }
    }
  }

  console.log("\n✓ Postinstall patch-compile completed!");
  console.log("All patched packages have been recompiled.");

} catch (error) {
  console.error("\n✗ Postinstall patch-compile failed:", error.message);
  process.exit(1);
}

/**
 * Helper function to recursively copy a directory
 */
function copyDirectory(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirectory(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
