.PHONY: help build up up-unraid down logs restart shell-bridge shell-opencode test typecheck lint

help:
	@echo "Targets:"
	@echo "  build         - docker compose build"
	@echo "  up            - docker compose up -d"
	@echo "  down          - docker compose down"
	@echo "  restart       - down then up"
	@echo "  logs          - tail compose logs"
	@echo "  shell-bridge  - exec sh in tg-bridge"
	@echo "  shell-opencode- exec sh in opencode"
	@echo "  test          - run tg-bridge unit tests"
	@echo "  typecheck     - tg-bridge tsc --noEmit"

build:
	docker compose -f deploy/compose.yaml build

up:
	docker compose -f deploy/compose.yaml --env-file deploy/.env up -d

up-unraid:
	docker compose -f deploy/compose.yaml --env-file /mnt/user/appdata/opencode/.env up -d

down:
	docker compose -f deploy/compose.yaml down

restart: down up

logs:
	docker compose -f deploy/compose.yaml logs -f --tail=200

shell-bridge:
	docker compose -f deploy/compose.yaml exec tg-bridge sh

shell-opencode:
	docker compose -f deploy/compose.yaml exec opencode sh

test:
	cd tg-bridge && npm test

typecheck:
	cd tg-bridge && npm run typecheck
