#!/bin/bash
# Stop all NanoClaw services

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m' # No Color

echo "Stopping NanoClaw services..."
echo ""

# Stop orchestrator
if pgrep -f "node dist/index.js" > /dev/null 2>&1; then
  pkill -f "node dist/index.js"
  echo -e "${GREEN}✓${NC} Orchestrator stopped"
else
  echo -e "⏭  Orchestrator not running"
fi

# Stop credential proxy
if lsof -i :3001 > /dev/null 2>&1; then
  pkill -f "node dist/credential-proxy.js" || true
  echo -e "${GREEN}✓${NC} Credential Proxy stopped"
else
  echo -e "⏭  Credential Proxy not running"
fi

# Stop egress proxy
if lsof -i :3002 > /dev/null 2>&1; then
  pkill -f "node dist/security/egress-proxy.js" || true
  echo -e "${GREEN}✓${NC} Egress Proxy stopped"
else
  echo -e "⏭  Egress Proxy not running"
fi

echo ""
echo -e "${GREEN}All services stopped${NC}"
