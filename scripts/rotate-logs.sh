#!/bin/bash
# Rotate NanoClaw logs — keeps last 3 archives, max ~50MB each
# Runs via launchd daily or can be invoked manually

LOGS_DIR="/Users/cozzymini/Code/nanoclaw/nanoclaw/logs"
MAX_SIZE=$((50 * 1024 * 1024))  # 50MB in bytes

rotate_file() {
  local file="$1"
  [ ! -f "$file" ] && return

  local size
  size=$(stat -f%z "$file" 2>/dev/null || echo 0)
  if [ "$size" -lt "$MAX_SIZE" ]; then
    return
  fi

  # Shift archives: .2.gz -> .3.gz, .1.gz -> .2.gz, .0.gz -> .1.gz
  rm -f "${file}.3.gz"
  [ -f "${file}.2.gz" ] && mv "${file}.2.gz" "${file}.3.gz"
  [ -f "${file}.1.gz" ] && mv "${file}.1.gz" "${file}.2.gz"
  [ -f "${file}.0.gz" ] && mv "${file}.0.gz" "${file}.1.gz"

  # Compress current log and truncate
  gzip -c "$file" > "${file}.0.gz"
  : > "$file"

  echo "Rotated $(basename "$file"): ${size} bytes -> $(stat -f%z "${file}.0.gz") compressed"
}

rotate_file "$LOGS_DIR/nanoclaw.log"
rotate_file "$LOGS_DIR/nanoclaw.error.log"
