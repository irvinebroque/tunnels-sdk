#!/bin/bash
# Fake cloudflared binary for testing expose() lifecycle.
# Outputs a trycloudflare URL to stderr (matching real cloudflared behavior),
# then stays alive until killed.

if [ -n "$FAKE_CLOUDFLARED_ARGS_FILE" ]; then
  printf '%s\n' "$@" > "$FAKE_CLOUDFLARED_ARGS_FILE"
fi

cleanup() {
  if [ -n "$FAKE_CLOUDFLARED_TERM_FILE" ]; then
    echo 'terminated' > "$FAKE_CLOUDFLARED_TERM_FILE"
  fi
  exit 0
}

trap cleanup TERM INT

registered='{"level":"info","time":"2024-01-15T10:30:00Z","event":"tunnelConnection","message":"Registered tunnel connection connIndex=0 connection=abc123 location=DFW ip=1.2.3.4"}'
url='https://test-tunnel-abc123.trycloudflare.com'
mode="${FAKE_CLOUDFLARED_MODE:-default}"

if [ "$mode" != "never-ready" ]; then
  # Write URL to stderr after a tiny delay (simulates startup)
  sleep 0.05

  if [ "$mode" = "url-only" ]; then
    echo "$url" >&2
  elif [ "$mode" = "url-then-registered" ]; then
    echo "$url" >&2
    sleep 0.15
    if [ -n "$FAKE_CLOUDFLARED_REGISTERED_FILE" ]; then
      echo 'registered' > "$FAKE_CLOUDFLARED_REGISTERED_FILE"
    fi
    echo "$registered" >&2
  else
    if [ -n "$FAKE_CLOUDFLARED_REGISTERED_FILE" ]; then
      echo 'registered' > "$FAKE_CLOUDFLARED_REGISTERED_FILE"
    fi
    echo "$registered" >&2
    echo "$url" >&2
  fi
fi

# Write a PID file so the test can verify we're alive
echo $$ > /tmp/fake-cloudflared-$$.pid

# Stay alive until killed
while true; do
  sleep 0.1
done
