#!/bin/bash
# Consolidated service startup script for NanoClaw
# Starts all required services (orchestrator + credential proxy + egress proxy)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Log file paths
LOG_DIR="$PROJECT_ROOT/logs"
mkdir -p "$LOG_DIR"

ORCHESTRATOR_LOG="$LOG_DIR/orchestrator.log"
CREDENTIAL_PROXY_LOG="$LOG_DIR/credential-proxy.log"
EGRESS_PROXY_LOG="$LOG_DIR/egress-proxy.log"

echo "========================================="
echo "NanoClaw Service Manager"
echo "========================================="
echo ""

# Check if services are already running
check_service() {
  local port=$1
  local name=$2

  if lsof -i :$port > /dev/null 2>&1; then
    echo -e "${YELLOW}⚠️  $name already running on port $port${NC}"
    return 0
  else
    return 1
  fi
}

# Stop existing services
stop_services() {
  echo "Stopping existing services..."

  # Stop orchestrator (check common process names)
  pkill -f "node dist/index.js" 2>/dev/null || true

  # Stop credential proxy
  pkill -f "node dist/credential-proxy.js" 2>/dev/null || true

  # Stop egress proxy
  pkill -f "node dist/security/egress-proxy.js" 2>/dev/null || true

  sleep 2
  echo -e "${GREEN}✓${NC} Services stopped"
  echo ""
}

# Start credential proxy
start_credential_proxy() {
  echo -e "${BLUE}Starting Credential Proxy...${NC}"

  if check_service 3001 "Credential Proxy"; then
    echo "Skipping credential proxy startup"
    return 0
  fi

  CREDENTIAL_PROXY_PORT=3001 \
    nohup node dist/credential-proxy.js \
    > "$CREDENTIAL_PROXY_LOG" 2>&1 &

  CREDENTIAL_PROXY_PID=$!
  echo "PID: $CREDENTIAL_PROXY_PID"
  echo "Logs: $CREDENTIAL_PROXY_LOG"

  # Wait for service to start
  sleep 2

  if lsof -i :3001 > /dev/null 2>&1; then
    echo -e "${GREEN}✓${NC} Credential Proxy started on port 3001"
  else
    echo -e "${RED}✗${NC} Credential Proxy failed to start (check logs)"
    tail -n 20 "$CREDENTIAL_PROXY_LOG"
    return 1
  fi

  echo ""
}

# Start egress proxy
start_egress_proxy() {
  echo -e "${BLUE}Starting Egress Proxy...${NC}"

  if check_service 3002 "Egress Proxy"; then
    echo "Skipping egress proxy startup"
    return 0
  fi

  EGRESS_PROXY_PORT=3002 \
    nohup node dist/security/egress-proxy.js \
    > "$EGRESS_PROXY_LOG" 2>&1 &

  EGRESS_PROXY_PID=$!
  echo "PID: $EGRESS_PROXY_PID"
  echo "Logs: $EGRESS_PROXY_LOG"

  # Wait for service to start
  sleep 2

  if lsof -i :3002 > /dev/null 2>&1; then
    echo -e "${GREEN}✓${NC} Egress Proxy started on port 3002"
  else
    echo -e "${RED}✗${NC} Egress Proxy failed to start (check logs)"
    tail -n 20 "$EGRESS_PROXY_LOG"
    return 1
  fi

  echo ""
}

# Start orchestrator
start_orchestrator() {
  echo -e "${BLUE}Starting Orchestrator...${NC}"

  # Check if already running
  if pgrep -f "node dist/index.js" > /dev/null 2>&1; then
    echo -e "${YELLOW}⚠️  Orchestrator already running${NC}"
    echo "Skipping orchestrator startup"
    return 0
  fi

  nohup node dist/index.js \
    > "$ORCHESTRATOR_LOG" 2>&1 &

  ORCHESTRATOR_PID=$!
  echo "PID: $ORCHESTRATOR_PID"
  echo "Logs: $ORCHESTRATOR_LOG"

  # Wait for service to start
  sleep 2

  if pgrep -f "node dist/index.js" > /dev/null 2>&1; then
    echo -e "${GREEN}✓${NC} Orchestrator started"
  else
    echo -e "${RED}✗${NC} Orchestrator failed to start (check logs)"
    tail -n 20 "$ORCHESTRATOR_LOG"
    return 1
  fi

  echo ""
}

# Main startup sequence
main() {
  # Parse arguments
  RESTART=false
  if [ "$1" = "--restart" ] || [ "$1" = "-r" ]; then
    RESTART=true
  fi

  # Load environment variables from .env if it exists
  if [ -f "$PROJECT_ROOT/.env" ]; then
    echo "Loading environment variables from .env..."
    set -a
    source "$PROJECT_ROOT/.env"
    set +a
    echo -e "${GREEN}✓${NC} Environment variables loaded"
    echo ""
  fi

  # Build project first
  echo "Building project..."
  npm run build
  echo ""

  # Stop services if restart requested
  if [ "$RESTART" = true ]; then
    stop_services
  fi

  # Start services in order
  start_credential_proxy || exit 1
  start_egress_proxy || exit 1
  start_orchestrator || exit 1

  echo "========================================="
  echo -e "${GREEN}All services started successfully!${NC}"
  echo "========================================="
  echo ""
  echo "Service Status:"
  echo "  - Credential Proxy: http://localhost:3001"
  echo "  - Egress Proxy:     http://localhost:3002"
  echo "  - Orchestrator:     Running"
  echo ""
  echo "Logs:"
  echo "  - Orchestrator:     $ORCHESTRATOR_LOG"
  echo "  - Credential Proxy: $CREDENTIAL_PROXY_LOG"
  echo "  - Egress Proxy:     $EGRESS_PROXY_LOG"
  echo ""
  echo "To stop all services:"
  echo "  ./scripts/stop-all-services.sh"
  echo ""
  echo "To view logs:"
  echo "  tail -f $ORCHESTRATOR_LOG"
  echo ""
}

# Run main
main "$@"
