#!/bin/bash
# Simulates realistic traffic against the JWT Pizza Service so every metric on
# the Grafana dashboard has nonzero data. Press Ctrl+C to stop all simulations.
#
# Usage: ./simulateTraffic.sh <host>
# Example: ./simulateTraffic.sh https://pizza-service.yourdomain.click
#
# Requires the demo users created by generatePizzaData.sh (d@jwt.com / diner).

if [ -z "$1" ]; then
  echo "Usage: $0 <host>"
  echo "Example: $0 http://localhost:3000"
  exit 1
fi
host=$1

cleanup() {
  echo "Stopping traffic simulation..."
  kill $(jobs -p) 2>/dev/null
  exit 0
}
trap cleanup SIGINT SIGTERM

json='Content-Type: application/json'

# Menu browsing: steady GET traffic
while true; do
  curl -s "$host/api/order/menu" > /dev/null
  echo "GET menu"
  sleep 3
done &

# Failed logins: auth failures (PUT)
while true; do
  curl -s -X PUT "$host/api/auth" -d '{"email":"unknown@jwt.com", "password":"bad"}' -H "$json" > /dev/null
  echo "Failed login"
  sleep 25
done &

# Franchisee session: login, browse franchises, logout (PUT, GET, DELETE)
while true; do
  token=$(curl -s -X PUT "$host/api/auth" -d '{"email":"f@jwt.com", "password":"franchisee"}' -H "$json" | jq -r '.token')
  echo "Franchisee logged in"
  curl -s "$host/api/franchise?page=0&limit=10" -H "Authorization: Bearer $token" > /dev/null
  sleep 110
  curl -s -X DELETE "$host/api/auth" -H "Authorization: Bearer $token" > /dev/null
  echo "Franchisee logged out"
  sleep 10
done &

# New customers registering (POST auth)
while true; do
  id=$RANDOM$RANDOM
  token=$(curl -s -X POST "$host/api/auth" -d "{\"name\":\"sim diner $id\", \"email\":\"sim$id@jwt.com\", \"password\":\"diner\"}" -H "$json" | jq -r '.token')
  echo "Registered sim$id"
  curl -s "$host/api/order" -H "Authorization: Bearer $token" > /dev/null
  sleep 60
  curl -s -X DELETE "$host/api/auth" -H "Authorization: Bearer $token" > /dev/null
done &

# Diner buying pizzas: successful orders (POST order)
while true; do
  token=$(curl -s -X PUT "$host/api/auth" -d '{"email":"d@jwt.com", "password":"diner"}' -H "$json" | jq -r '.token')
  echo "Diner logged in"
  for i in 1 2 3; do
    curl -s -X POST "$host/api/order" -H "$json" -H "Authorization: Bearer $token" \
      -d '{"franchiseId": 1, "storeId":1, "items":[{ "menuId": 1, "description": "Veggie", "price": 0.05 }, { "menuId": 2, "description": "Pepperoni", "price": 0.0042 }]}' > /dev/null
    echo "Bought pizzas"
    sleep 15
  done
  curl -s -X DELETE "$host/api/auth" -H "Authorization: Bearer $token" > /dev/null
  echo "Diner logged out"
  sleep 15
done &

# Hungry diner: orders over 20 pizzas, which the factory rejects (creation failures + high latency)
items=$(printf '{ "menuId": 1, "description": "Veggie", "price": 0.05 },%.0s' $(seq 1 21))
items="[${items%,}]"
while true; do
  token=$(curl -s -X PUT "$host/api/auth" -d '{"email":"d@jwt.com", "password":"diner"}' -H "$json" | jq -r '.token')
  curl -s -X POST "$host/api/order" -H "$json" -H "Authorization: Bearer $token" \
    -d "{\"franchiseId\": 1, \"storeId\":1, \"items\":$items}" > /dev/null
  echo "Ordered too many pizzas (expected failure)"
  sleep 5
  curl -s -X DELETE "$host/api/auth" -H "Authorization: Bearer $token" > /dev/null
  sleep 295
done &

wait
