#!/bin/bash

# Script to apply patches to node_modules after installation

echo "Applying patches to node_modules..."

# Patch for @opentripplanner/building-blocks dropdown role fix
if [ -f "patches/building-blocks-dropdown-role-fix.patch" ]; then
  echo "Applying building-blocks dropdown role fix..."
  patch -p1 < patches/building-blocks-dropdown-role-fix.patch || {
    echo "Warning: Failed to apply building-blocks dropdown role fix patch"
  }
fi

echo "Patches applied."
