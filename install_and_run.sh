#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$SCRIPT_DIR/web-manager-node"

if ! command -v node >/dev/null 2>&1; then
	echo "Error: Node.js is not installed."
	echo "Install Node.js (v18+) and run this script again."
	exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
	echo "Error: npm is not installed."
	echo "Install npm and run this script again."
	exit 1
fi

cd "$APP_DIR"

if [[ ! -d node_modules ]]; then
	echo "Installing dependencies..."
	npm install
fi

echo "Starting Web Manager at http://127.0.0.1:3000"
npm start