#!/usr/bin/env bash
# 10 test deliveries, all dropoffs within 250 m of Milnerton Galleria.
# createdAt:0 backdates each order so the ready gate releases it immediately.
set -e
API=${API:-http://localhost:3000}

curl -s -X POST $API/v1/keychat/jobs -H 'content-type: application/json' \
  -d '{"externalId": "KC-TEST-1001", "storeId": "MILNERTON-GALLERIA", "zone": "Milnerton", "pickup": {"lat": -33.8329992, "lng": 18.5309754, "name": "Milnerton Galleria"}, "dropoff": {"lat": -33.832472, "lng": 18.5311103, "name": "43 Loxton Rd, Milnerton"}, "customerCharge": 40, "tip": 0, "bagCount": 1, "prepMinutes": 8, "createdAt": 0}' | grep -o '"jobId":"[^"]*"'
curl -s -X POST $API/v1/keychat/jobs -H 'content-type: application/json' \
  -d '{"externalId": "KC-TEST-1002", "storeId": "MILNERTON-GALLERIA", "zone": "Milnerton", "pickup": {"lat": -33.8329992, "lng": 18.5309754, "name": "Milnerton Galleria"}, "dropoff": {"lat": -33.8325243, "lng": 18.5316103, "name": "21 Bosmansdam Rd, Milnerton"}, "customerCharge": 40, "tip": 12, "bagCount": 2, "prepMinutes": 12, "createdAt": 0}' | grep -o '"jobId":"[^"]*"'
curl -s -X POST $API/v1/keychat/jobs -H 'content-type: application/json' \
  -d '{"externalId": "KC-TEST-1003", "storeId": "MILNERTON-GALLERIA", "zone": "Milnerton", "pickup": {"lat": -33.8329992, "lng": 18.5309754, "name": "Milnerton Galleria"}, "dropoff": {"lat": -33.8329072, "lng": 18.5320294, "name": "52 Koeberg Rd, Milnerton"}, "customerCharge": 40, "tip": 20, "bagCount": 1, "prepMinutes": 14, "createdAt": 0}' | grep -o '"jobId":"[^"]*"'
curl -s -X POST $API/v1/keychat/jobs -H 'content-type: application/json' \
  -d '{"externalId": "KC-TEST-1004", "storeId": "MILNERTON-GALLERIA", "zone": "Milnerton", "pickup": {"lat": -33.8329992, "lng": 18.5309754, "name": "Milnerton Galleria"}, "dropoff": {"lat": -33.8335247, "lng": 18.5320712, "name": "85 Ixia St, Milnerton"}, "customerCharge": 40, "tip": 8, "bagCount": 1, "prepMinutes": 10, "createdAt": 0}' | grep -o '"jobId":"[^"]*"'
curl -s -X POST $API/v1/keychat/jobs -H 'content-type: application/json' \
  -d '{"externalId": "KC-TEST-1005", "storeId": "MILNERTON-GALLERIA", "zone": "Milnerton", "pickup": {"lat": -33.8329992, "lng": 18.5309754, "name": "Milnerton Galleria"}, "dropoff": {"lat": -33.8341153, "lng": 18.5315736, "name": "8 Pienaar Rd, Milnerton"}, "customerCharge": 40, "tip": 25, "bagCount": 3, "prepMinutes": 22, "createdAt": 0}' | grep -o '"jobId":"[^"]*"'
curl -s -X POST $API/v1/keychat/jobs -H 'content-type: application/json' \
  -d '{"externalId": "KC-TEST-1006", "storeId": "MILNERTON-GALLERIA", "zone": "Milnerton", "pickup": {"lat": -33.8329992, "lng": 18.5309754, "name": "Milnerton Galleria"}, "dropoff": {"lat": -33.8343612, "lng": 18.5306269, "name": "11 Sandown Rd, Milnerton"}, "customerCharge": 40, "tip": 0, "bagCount": 1, "prepMinutes": 9, "createdAt": 0}' | grep -o '"jobId":"[^"]*"'
curl -s -X POST $API/v1/keychat/jobs -H 'content-type: application/json' \
  -d '{"externalId": "KC-TEST-1007", "storeId": "MILNERTON-GALLERIA", "zone": "Milnerton", "pickup": {"lat": -33.8329992, "lng": 18.5309754, "name": "Milnerton Galleria"}, "dropoff": {"lat": -33.8340451, "lng": 18.529577, "name": "70 Racecourse Rd, Milnerton"}, "customerCharge": 40, "tip": 15, "bagCount": 2, "prepMinutes": 16, "createdAt": 0}' | grep -o '"jobId":"[^"]*"'
curl -s -X POST $API/v1/keychat/jobs -H 'content-type: application/json' \
  -d '{"externalId": "KC-TEST-1008", "storeId": "MILNERTON-GALLERIA", "zone": "Milnerton", "pickup": {"lat": -33.8329992, "lng": 18.5309754, "name": "Milnerton Galleria"}, "dropoff": {"lat": -33.8331804, "lng": 18.5288997, "name": "14 Blaauwberg Rd, Milnerton"}, "customerCharge": 40, "tip": 30, "bagCount": 1, "prepMinutes": 11, "createdAt": 0}' | grep -o '"jobId":"[^"]*"'
curl -s -X POST $API/v1/keychat/jobs -H 'content-type: application/json' \
  -d '{"externalId": "KC-TEST-1009", "storeId": "MILNERTON-GALLERIA", "zone": "Milnerton", "pickup": {"lat": -33.8329992, "lng": 18.5309754, "name": "Milnerton Galleria"}, "dropoff": {"lat": -33.832047, "lng": 18.5289899, "name": "48 Vasco Blvd, Milnerton"}, "customerCharge": 40, "tip": 10, "bagCount": 1, "prepMinutes": 13, "createdAt": 0}' | grep -o '"jobId":"[^"]*"'
curl -s -X POST $API/v1/keychat/jobs -H 'content-type: application/json' \
  -d '{"externalId": "KC-TEST-1010", "storeId": "MILNERTON-GALLERIA", "zone": "Milnerton", "pickup": {"lat": -33.8329992, "lng": 18.5309754, "name": "Milnerton Galleria"}, "dropoff": {"lat": -33.8311035, "lng": 18.5299593, "name": "76 Freedom Way, Milnerton"}, "customerCharge": 40, "tip": 18, "bagCount": 2, "prepMinutes": 18, "createdAt": 0}' | grep -o '"jobId":"[^"]*"'

echo "10 jobs created"
