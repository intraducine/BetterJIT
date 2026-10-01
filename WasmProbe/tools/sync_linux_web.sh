#!/bin/bash
# Copies fexwasm's guest-kernel page (js/linux/web) and what it loads into
# Web/js, keeping their relative paths, and bundles the kernel for workers.
set -euo pipefail
cd "$(dirname "$0")/.."
F=../fexwasm
mkdir -p Web/js/linux/web
cp "$F/js/runtime.js" Web/js/runtime.js
cp "$F/js/linux/thread_core.js" "$F/js/linux/compositor.js" Web/js/linux/
cp "$F"/js/linux/web/*.html "$F"/js/linux/web/*.js Web/js/linux/web/
node "$F/tools/bundle_kernel.js" > Web/js/linux/web/linux-kernel.js
mkdir -p Web/js/probe
cp "$F"/js/probe/*.html Web/js/probe/
