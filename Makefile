# FMS developer / operator shortcuts. Requires GNU make, Docker Compose v2,
# Node 20 and Python 3.12. On Windows run from Git Bash or WSL.

COMPOSE   ?= docker compose -f deploy/docker-compose.yml
PROFILES  ?=
REGISTRY  ?= ghcr.io/oxoafrica/fms
TAG       ?= dev
SIM_ARGS  ?=

NODE_PKGS := packages/shared packages/zra-client packages/fiscal-printer \
             services/edge-gateway tools/pts-simulator apps/web apps/mobile

IMAGES := cloud:services/cloud:services/cloud/Dockerfile \
          edge-gateway:.:services/edge-gateway/Dockerfile \
          analytics:services/analytics:services/analytics/Dockerfile \
          web:apps/web:apps/web/Dockerfile \
          migrate:.:deploy/migrate/Dockerfile \
          pts-simulator:.:deploy/pts-simulator/Dockerfile

PROFILE_FLAGS := $(foreach p,$(PROFILES),--profile $(p))

.PHONY: help up up-all down clean logs ps migrate seed test build-images sim sim-fleet sim-fleet-stop config k8s-render

help: ## List targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  %-14s %s\n", $$1, $$2}'

up: ## Start the core stack (PROFILES="edge observability" for more)
	$(COMPOSE) $(PROFILE_FLAGS) up -d --build

up-all: ## Start core + edge + observability
	$(COMPOSE) --profile edge --profile observability up -d --build

down: ## Stop everything (keeps volumes)
	$(COMPOSE) --profile edge --profile observability down

clean: ## Stop everything and delete volumes (DESTROYS local data)
	$(COMPOSE) --profile edge --profile observability down -v

logs: ## Follow logs (SERVICE=ingest-api to filter)
	$(COMPOSE) --profile edge --profile observability logs -f --tail=200 $(SERVICE)

ps: ## Show service status
	$(COMPOSE) --profile edge --profile observability ps

migrate: ## Apply schema migrations only (no seed) to the compose primary
	@# Overrides the service's default "--seed" argument (unknown flags are ignored by db/migrate.mjs).
	$(COMPOSE) run --rm migrate --schema-only

seed: ## Apply migrations + demo seed (dev only)
	$(COMPOSE) run --rm migrate --seed

test: ## Typecheck + test every Node package, then the Django cloud and analytics pytest suites
	@set -e; for p in $(NODE_PKGS); do \
	  if [ -f $$p/package.json ]; then \
	    echo "==> $$p"; \
	    (cd $$p && { [ -f package-lock.json ] && npm ci || npm install; } && \
	      npm run build --if-present && npm run typecheck --if-present && npm test --if-present); \
	  fi; \
	done
	@echo "==> services/cloud"; cd services/cloud && python -m pytest -q
	@if [ -d services/analytics ]; then echo "==> services/analytics"; \
	  cd services/analytics && python -m pytest -q || [ $$? -eq 5 ]; fi

build-images: ## Build all container images (REGISTRY, TAG)
	@set -e; for spec in $(IMAGES); do \
	  name=$${spec%%:*}; rest=$${spec#*:}; ctx=$${rest%%:*}; file=$${rest#*:}; \
	  if [ -f $$file ]; then \
	    echo "==> $(REGISTRY)/$$name:$(TAG)"; \
	    docker build -f $$file -t $(REGISTRY)/$$name:$(TAG) $$ctx; \
	  else echo "skip $$name ($$file missing)"; fi; \
	done

sim: ## Run station LUS-0001 edge gateway + PTS-2 simulator (SIM_ARGS="..." for extra flags)
	SIM_EXTRA_ARGS="$(SIM_ARGS)" $(COMPOSE) --profile edge up -d --build edge-db edge-gateway pts-simulator
	$(COMPOSE) --profile edge logs -f pts-simulator edge-gateway

sim-fleet: ## Add 200 simulated direct-mode stations (dev only) and run their PTS-2 simulators
	$(COMPOSE) exec -T pg-primary sh -c 'psql -v ON_ERROR_STOP=1 -q -U "$$POSTGRES_USER" -d "$$POSTGRES_DB"' < tools/pts-simulator/fleet/stations-200.sql
	$(COMPOSE) --profile fleet up -d pts-fleet

sim-fleet-stop: ## Stop the 200-station simulator (the stations stay in the database)
	$(COMPOSE) --profile fleet rm -sf pts-fleet

config: ## Validate the compose file
	$(COMPOSE) --profile edge --profile fleet --profile observability config -q

k8s-render: ## Render the Kubernetes overlays (validation)
	kubectl kustomize deploy/k8s/overlays/staging > /dev/null
	kubectl kustomize deploy/k8s/overlays/production > /dev/null
	kubectl kustomize deploy/k8s/dr > /dev/null
