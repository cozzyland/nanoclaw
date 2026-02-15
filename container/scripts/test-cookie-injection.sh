#!/bin/bash

# Test script for cookie injection workflow
set -e

echo "Testing Cookie Injection Script"
echo ""

# Create test cookie file (Cookie-Editor format)
TEST_COOKIE_FILE="/tmp/test-cookies.json"
cat > "$TEST_COOKIE_FILE" <<'EOF'
[
  {
    "name": "session_token",
    "value": "test_abc123",
    "domain": ".example.com",
    "path": "/",
    "secure": true,
    "httpOnly": true,
    "sameSite": "lax",
    "expirationDate": 1735689600
  },
  {
    "name": "user_id",
    "value": "12345",
    "domain": ".example.com",
    "path": "/",
    "secure": false,
    "httpOnly": false,
    "sameSite": "no_restriction"
  }
]
EOF

echo "Created test cookie file: $TEST_COOKIE_FILE"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_FILE="/tmp/test-state.json"

node "$SCRIPT_DIR/inject-cookies.js" "$TEST_COOKIE_FILE" "$OUTPUT_FILE"

if [ -f "$OUTPUT_FILE" ]; then
  echo ""
  echo "Test passed!"
  echo ""
  echo "Output:"
  cat "$OUTPUT_FILE"
  echo ""

  # Verify it's valid Playwright storageState format
  node -e "
    const s = require('$OUTPUT_FILE');
    if (!s.cookies || !Array.isArray(s.cookies) || !('origins' in s)) {
      console.error('Invalid storageState format');
      process.exit(1);
    }
    if (s.cookies[0].sameSite !== 'Lax') {
      console.error('sameSite not converted: ' + s.cookies[0].sameSite);
      process.exit(1);
    }
    if (s.cookies[1].sameSite !== 'None') {
      console.error('no_restriction not mapped to None: ' + s.cookies[1].sameSite);
      process.exit(1);
    }
    console.log('Format validation passed');
  "

  rm "$TEST_COOKIE_FILE" "$OUTPUT_FILE"
  echo "Cleaned up test files"
else
  echo "Test failed: output file not created"
  exit 1
fi
