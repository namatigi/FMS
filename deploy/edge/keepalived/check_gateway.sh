#!/bin/sh
# keepalived health check: the gateway is healthy when its jsonPTS listener
# answers /healthz AND its local database is ready (/readyz).
curl -fsS --max-time 1 http://127.0.0.1:8100/readyz >/dev/null 2>&1
