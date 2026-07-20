#!/bin/sh
# macOS: double-click this file to launch the local save-server.
# Linux/any POSIX shell: `sh start-server.command` works the same way.
cd "$(dirname "$0")"
node save-server.js
echo
echo "Server stopped. Press Enter to close this window."
read _
