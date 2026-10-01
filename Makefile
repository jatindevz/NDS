.PHONY: help install up down migrate test test-unit test-integration lint typecheck format clean

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies
	npm install

up: ## Start Redis + Postgres via docker compose
	docker compose up -d
	@echo "Waiting for healthchecks..."
	@docker compose ps

down: ## Stop and remove containers (data volumes preserved)
	docker compose down

migrate: ## Apply database schema (idempotent)
	npm run migrate

test: ## Run all tests (integration tests skip if Redis/Postgres are down)
	npm test

test-unit: ## Run unit tests only
	npm run test:unit

test-integration: ## Run integration tests only (requires `make up`)
	npm run test:integration

lint: ## ESLint
	npm run lint

typecheck: ## TypeScript strict typecheck
	npm run typecheck

format: ## Prettier write
	npm run format

clean: ## Remove build artifacts
	rm -rf dist coverage
