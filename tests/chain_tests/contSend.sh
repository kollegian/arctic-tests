#!/bin/zsh
# Total duration in seconds
DURATION=20

# Record start time with sub‐second precision
START=$(date +%s.%N)

while true; do
  NOW=$(date +%s.%N)
  # Compute elapsed time
  ELAPSED=$(echo "$NOW - $START" | bc -l)
  # Exit once we've reached the target duration
  if (( $(echo "$ELAPSED >= $DURATION" | bc -l) )); then
    break
  fi

  # Replace this with whatever command you want to send
  seid tx bank send sei1dg8unurclh6p05tu64nsth5642mm6gx5nt86hk sei1hgrad4um8h8clagusdyw69tu202g4tvaqxy8jd 10000000usei --fees 24200usei --from admin -y

  # Wait for 0.2 seconds
  sleep 0.2
done

