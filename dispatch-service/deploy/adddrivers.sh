#!/usr/bin/env bash
# Create and fully onboard two test drivers.
#
# Sign-in creates the account; everything after that is the onboarding a real
# driver would go through. Doing it in one script because dispatch refuses any
# driver who is not ACTIVE, which is the point of the gate.
set -e
API=${API:-http://localhost:3000}

onboard () {
  local PHONE="$1" FIRST="$2" LAST="$3" HUB="$4" VEH="$5" REG="$6" ZONE="$7"

  local ID
  ID=$(curl -s -X POST "$API/v1/driver/signin" -H 'content-type: application/json' \
    -d "{\"phone\":\"$PHONE\",\"firstName\":\"$FIRST\",\"lastName\":\"$LAST\",\"hubCode\":\"$HUB\"}" \
    | grep -o '"id":"[0-9]*"' | head -1 | cut -d'"' -f4)

  if [ -z "$ID" ]; then echo "  FAILED to create $FIRST $LAST"; return 1; fi

  for d in id_document drivers_licence roadworthy insurance police_clearance bank_confirmation; do
    curl -s -X POST "$API/v1/ops/accounts/$ID/document" -H 'content-type: application/json' \
      -d "{\"docKey\":\"$d\",\"status\":\"VERIFIED\"}" > /dev/null
  done

  curl -s -X PATCH "$API/v1/ops/accounts/$ID" -H 'content-type: application/json' \
    -d "{\"vehicleReg\":\"$REG\",\"vehicleType\":\"$VEH\",\"zone\":\"$ZONE\"}" > /dev/null

  local STATE
  STATE=$(curl -s -X POST "$API/v1/ops/accounts/$ID/onboarding" \
    -H 'content-type: application/json' -d '{"state":"ACTIVE"}' \
    | grep -o '"onboarding":"[A-Z]*"' | cut -d'"' -f4)

  printf "  %-8s %-18s %-10s %-12s %s\n" "$ID" "$FIRST $LAST" "$VEH" "$REG" "$STATE"
}

echo "Driver   Name               Vehicle    Reg          State"
echo "------   ----               -------    ---          -----"
onboard "0821110001" "Sipho"  "Ndlovu"  "MIL" "Motorbike" "CA 481-207" "Milnerton"
onboard "0821110002" "Fatima" "Adams"   "MIL" "Motorbike" "CA 733-914" "Milnerton"

echo
echo "Both are ACTIVE and will receive offers once they sign in and go online."
echo "They sign in on the app with their phone number above."
