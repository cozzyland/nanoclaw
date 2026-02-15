#!/bin/bash
# NanoClaw dcg Allowlist Management Script
# Usage:
#   ./scripts/dcg-allowlist.sh add "git reset --hard" "Safe for development"
#   ./scripts/dcg-allowlist.sh list
#   ./scripts/dcg-allowlist.sh rebuild

set -e

ALLOWLIST_FILE="container/dcg-config/allowlist.toml"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

case "$1" in
  add)
    if [ -z "$2" ] || [ -z "$3" ]; then
      echo "Usage: $0 add <command> <reason>"
      echo "Example: $0 add 'git reset --hard' 'Safe for development'"
      exit 1
    fi

    COMMAND="$2"
    REASON="$3"

    echo "" >> "$ALLOWLIST_FILE"
    echo "[[allow]]" >> "$ALLOWLIST_FILE"
    echo "exact_command = \"$COMMAND\"" >> "$ALLOWLIST_FILE"
    echo "reason = \"$REASON\"" >> "$ALLOWLIST_FILE"
    echo "added_at = \"$TIMESTAMP\"" >> "$ALLOWLIST_FILE"

    echo "✅ Added to allowlist: $COMMAND"
    echo "📝 Reason: $REASON"
    echo ""
    echo "⚠️  To apply changes, rebuild the container:"
    echo "   ./container/build.sh"
    ;;

  list)
    echo "Current allowlist entries:"
    echo ""
    grep -A 3 "\[\[allow\]\]" "$ALLOWLIST_FILE" | sed 's/^/  /' || echo "  (no entries)"
    ;;

  rebuild)
    echo "🔨 Rebuilding container with updated allowlist..."
    ./container/build.sh
    echo "✅ Container rebuilt successfully"
    ;;

  *)
    echo "NanoClaw dcg Allowlist Manager"
    echo ""
    echo "Usage:"
    echo "  $0 add <command> <reason>    Add command to allowlist"
    echo "  $0 list                       Show current allowlist"
    echo "  $0 rebuild                    Rebuild container with changes"
    echo ""
    echo "Examples:"
    echo "  $0 add 'git reset --hard' 'Safe for development'"
    echo "  $0 add 'rm -rf ./dist' 'Build directory cleanup'"
    echo "  $0 list"
    echo "  $0 rebuild"
    exit 1
    ;;
esac
